#!/usr/bin/env node
// dsh-vision-fallback 核心逻辑冒烟检查：
//  1. 纯函数：sniffMediaType / contentHasImage / textBlocksOf / attachmentObjectPath
//  2. 预分析时序：inbox 同步 remove → 视觉分析 → followup 替换消息；失败时放回原消息
//  3. vision_inspect 工具：路径输入 → 分析 → 返回文本；带上下文截断
// 以真实 cordis Context + stub 服务运行，不依赖线上 dsh 实例。
import { strict as assert } from "node:assert";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { _test } from "../src/index.js";

// ── 1. 纯函数 ──────────────────────────────────────────────────────────
const { sniffMediaType, contentHasImage, textBlocksOf, imageBlocksOf, imageMarks, attachmentObjectPath, buildVisionMessages } = _test;

// 1x1 PNG（最小合法文件头）
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
]);
assert.equal(sniffMediaType(PNG_BYTES), "image/png");
assert.equal(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
assert.equal(sniffMediaType(new Uint8Array([1, 2, 3])), void 0);

const ref = { attachmentId: "sha256:" + "a".repeat(64), mediaType: "image/png", bytes: 10, width: 100, height: 50 };
const imageBlock = { type: "image", attachment: ref };
assert.equal(contentHasImage([{ type: "text", text: "x" }, imageBlock]), true);
assert.equal(contentHasImage([{ type: "tool-result", content: [imageBlock] }]), true);
assert.equal(contentHasImage([{ type: "text", text: "x" }]), false);
assert.deepEqual(textBlocksOf([{ type: "text", text: "a" }, imageBlock]).map((b) => b.text), ["a"]);
assert.deepEqual(imageBlocksOf([{ type: "text", text: "a" }, imageBlock]).length, 1);
assert.match(imageMarks([imageBlock])[0], /^\[图片: sha256:a{64}（100x50px）（本地路径：.*）\]$/);
assert.equal(attachmentObjectPath("sha256:" + "b".repeat(64)),
  join(process.env.DSH_HOME || join(homedir(), ".dsh"), "attachments", "v1", "objects", "bb", "b".repeat(64)));

// ── 2. 预分析时序 ─────────────────────────────────────────────────────
const ctx = new Context();
const events = { removed: null, followed: [], original: null };
const fakeInbox = { remove(id) { events.removed = id; return true; } };
const imageMsg = {
  id: "msg-1",
  role: "user",
  content: [{ type: "text", text: "看看这张图" }, imageBlock],
  source: { kind: "user" }
};
let streamBehavior = "ok";
const analysisText = "这是一张 1x1 的测试图片。";
const agent = {
  inbox: fakeInbox,
  session: { deriveMessages: () => [] },
  followup(msg) { events.followed.push(msg); }
};

// llm stub：ok → 返回一段分析文本；fail → 抛错
ctx.effect(() => {
  ctx.provide("llm", {
    stream: async function* () {
      if (streamBehavior === "fail") throw new Error("upstream down");
      yield { type: "text-delta", index: 0, text: analysisText };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  });
});

_test.installPreanalyze(ctx, () => ({
  enabled: true, preanalyze: true, provider: "cpa", model: "vision", maxContextTokens: 8000
}));
ctx.emit("agent/inbox/inserted", { agent, message: imageMsg });

// 同步 remove 已发生
assert.equal(events.removed, "msg-1", "含图消息必须先被移除");
assert.equal(events.followed.length, 0, "分析完成前不得产生替换消息");

// 等待异步分析完成
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(events.followed.length, 1, "分析完成后必须 followup 一条替换消息");
const replaced = events.followed[0];
assert.equal(replaced.role, "user");
const text = replaced.content[0].text;
assert.ok(text.includes("（原消息）\n看看这张图"), "替换消息必须包含原文本");
assert.ok(text.includes("（消息附图）"), "替换消息必须包含图片标识");
assert.ok(text.includes("（图片分析）"), "替换消息必须包含分析结果");
assert.ok(text.includes(analysisText), "分析结果必须进入替换消息");
assert.ok(text.includes("sha256:a".repeat(1) + "".padEnd(63, "a")), "图片标识必须可被工具再次定位");

// 失败路径：分析抛错 → 放回原消息
events.followed.length = 0;
streamBehavior = "fail";
const failMsg = { id: "msg-2", role: "user", content: [{ type: "text", text: "x" }, imageBlock], source: { kind: "user" } };
ctx.emit("agent/inbox/inserted", { agent, message: failMsg });
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(events.followed.length, 1, "分析失败必须放回原消息（不丢用户输入）");
assert.equal(events.followed[0], failMsg, "放回的必须是原消息对象");

// ── 3. 上下文截断（不含图消息进文本上下文；只保留最近的） ─────────────
const history = Array.from({ length: 10 }, (_, i) => ({
  role: "user",
  content: [{ type: "text", text: `历史消息第${i}条内容很长很长很长很长很长很长很长很长很长很长很长` }]
}));
const truncAgent = { session: { deriveMessages: () => history } };
const msgs = buildVisionMessages(ctx, truncAgent, imageMsg, "", { maxContextTokens: 60 });
const contextMsg = msgs.find((m) => m.content.some((b) => b.type === "text" && b.text.includes("相关对话上下文")));
assert.ok(contextMsg, "有历史时必须组装上下文消息");
const ctxText = contextMsg.content[0].text;
assert.ok(ctxText.includes("历史消息第9条"), "必须保留最近的消息");
assert.ok(!ctxText.includes("历史消息第0条"), "超出预算的最旧消息必须被截断");
assert.ok(msgs.every((m) => !contentHasImage(m.content)) === false || msgs.some((m) => contentHasImage(m.content)), "图片消息自身保留图片块");

// ── 4. vision_inspect 工具冒烟（路径输入） ────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "dsh-vf-"));
const pngPath = join(tmp, "fixture.png");
writeFileSync(pngPath, Buffer.from(PNG_BYTES));
try {
  ctx.effect(() => {
    ctx.provide("attachments", {
      async saveImages(inputs) {
        return inputs.map((input, i) => ({
          attachmentId: `sha256:${"c".repeat(64 - i)}${String(i)}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
          name: input.name
        }));
      }
    });
    ctx.provide("tools", { register: () => () => {} });
  });

  let toolDef = null;
  const fakeTools = {
    register(def) { toolDef = def; return () => {}; }
  };
  // 需要单独的 ctx：installTool 在注册时立即读 tools
  const toolCtx = new Context();
  toolCtx.effect(() => {
    toolCtx.provide("tools", fakeTools);
    toolCtx.provide("llm", {
      stream: async function* () {
        yield { type: "text-delta", index: 0, text: "工具分析结果 OK" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    });
    toolCtx.provide("attachments", {
      async saveImages(inputs) {
        return inputs.map((input) => ({
          attachmentId: `sha256:${"d".repeat(64)}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
          name: input.name
        }));
      }
    });
  });
  _test.installTool(toolCtx, () => ({
    enabled: true, preanalyze: true, provider: "cpa", model: "vision", maxContextTokens: 8000
  }));
  assert.ok(toolDef, "工具必须注册");
  assert.equal(toolDef.name, "vision_inspect");

  const outcome = await toolDef.execute(
    { image: pngPath, instructions: "读出图中文字" },
    { agent: { session: { deriveMessages: () => [] } }, signal: void 0 }
  );
  assert.equal(outcome, "工具分析结果 OK", "工具必须返回视觉模型文本");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("vision-fallback smoke: ok");
