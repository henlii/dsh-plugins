// dsh-vision-fallback host half — 图片消息预分析 + 可主动调用的图片识别工具。
//
// 三种能力（设置项控制）：
//
// 1. 预分析（preanalyze，默认开）：收到含图消息时，拦截 inbox（消息尚未进入
//    会话），保留原消息（图片留在会话，用户可查看），异步用配置的视觉模型
//    分析图片，把「原文本 + 图片标识/路径 + 分析结果」作为追加消息 followup
//    回 inbox。模型请求侧，官方 adapter 会把图片投影为占位文本（非视觉模型），
//    图片字节不进上下文；分析结果文本（含图片标识）进入上下文，主模型可用。
// 2. 识别工具（vision_inspect，常注册）：主 agent 可主动调用，对指定图片做
//    识别/提问，带上下文 + 可选指令。结果不理想可二次调用（换指令再问），
//    即「固定文令的子智能体 + 主 agent 发指令」语义。
// 3. 回退（preanalyze 关闭时兜底）：agent/request 瀑布检测当前 turn 含图时
//    切换到视觉模型；纯文本轮次自动切回主模型，避免污染会话模型选择。

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";

const name = "dsh-vision-fallback";
const inject = ["llm", "webServer", "tools"];
const SETTINGS_NS = settingsNamespace("dsh-vision-fallback");
const MODELS_ROUTE = "/api/dsh-vision-fallback/models";
const TOOL_NAME = "vision_inspect";
const ANALYZE_TIMEOUT_MS = 90000;
const IMAGE_ID_RE = /^sha256:[a-f0-9]{64}$/;

const SettingsSchema = z.object({
  enabled: z.boolean().default(false),
  preanalyze: z.boolean().default(true),
  provider: z.string(),
  model: z.string(),
  // 预分析/工具调用时上下文截断上限（token 估算）。不压缩主会话。
  maxContextTokens: z.number().min(512).max(128000).default(8000),
});

/** 递归检查内容块是否含图片（含 tool-result 嵌套）。 */
function contentHasImage(content) {
  if (!Array.isArray(content)) return false;
  return content.some((block) =>
    (block !== null && typeof block === "object" && block.type === "image") ||
    (block !== null && typeof block === "object" && block.type === "tool-result" && contentHasImage(block.content))
  );
}

/** 提取内容块中的图片块（含 tool-result 嵌套）。 */
function imageBlocksOf(content) {
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (block !== null && typeof block === "object") {
      if (block.type === "image") out.push(block);
      else if (block.type === "tool-result") out.push(...imageBlocksOf(block.content));
    }
  }
  return out;
}

/** 提取消息中的纯文本块。 */
function textBlocksOf(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block !== null && typeof block === "object" && block.type === "text");
}

/** 粗略 token 估算（按 3 字符/token 的保守系数）。 */
function estimateTokens(text) {
  return Math.ceil(text.length / 3);
}

/** 图片块的附件引用。 */
function refOf(block) {
  const ref = block && block.attachment;
  return ref && ref.attachmentId !== void 0 ? ref : void 0;
}

/** 图片标识（sha256:… + 尺寸 + 本地对象路径）。路径供智能体/用户直接取图。 */
function imageMarks(imageBlocks) {
  return imageBlocks.map((block, i) => {
    const ref = refOf(block);
    if (!ref) return `[图片${imageBlocks.length > 1 ? ` ${i + 1}` : ""}]`;
    const dims = ref.width ? `${ref.width}x${ref.height}` : "";
    const path = attachmentObjectPath(ref.attachmentId);
    return `[图片${imageBlocks.length > 1 ? ` ${i + 1}` : ""}: ${String(ref.attachmentId)}${dims ? `（${dims}px）` : ""}${path ? `（本地路径：${path}）` : ""}]`;
  });
}

/** 收集消息的全部图片 attachmentId。 */
function imageIdsOf(message) {
  return imageBlocksOf(message.content).map((block) => refOf(block)).filter(Boolean)
    .map((ref) => String(ref.attachmentId));
}

/**
* 附件对象在本地的绝对路径（attachment-local 布局：
* <dsh-home>/attachments/v1/objects/<sha256 前 2 位>/<sha256>）。
*/
function attachmentObjectPath(attachmentId) {
  const id = String(attachmentId).replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(id)) return void 0;
  return join(resolveDshHome(), "attachments", "v1", "objects", id.slice(0, 2), id);
}

/** 按文件头魔数探测图片格式（PNG/JPEG/WebP/GIF）。 */
function sniffMediaType(data) {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return "image/webp";
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return "image/gif";
  return void 0;
}

/**
* 组装一次带上下文的视觉分析请求：
*   messages = [含图分析主消息] + [截断后的历史文本上下文] + [任务指令消息]。
* 历史只取纯文本消息，按 maxContextTokens 估算截断（保留最近内容）。
* 主会话历史本身不被修改；图片消息不进文本上下文。
*/
function buildVisionMessages(ctx, agent, imageMessage, instruction, config) {
  const imageBlocks = imageBlocksOf(imageMessage.content);
  const marks = imageMarks(imageBlocks);
  const textBlocks = textBlocksOf(imageMessage.content);
  const content = [
    ...imageBlocks,
    ...textBlocks,
    ...(marks.length > 0 ? [{ type: "text", text: `图片标识：${marks.join(" ")}` }] : [])
  ];
  const messages = [createUserMessage({
    content,
    source: { kind: "plugin", plugin: "dsh-vision-fallback" }
  })];

  // 历史明文上下文（截断，保留最近）。
  const session = agent && agent.session;
  if (session && typeof session.deriveMessages === "function") {
    const history = session.deriveMessages().filter((m) => m.role === "user" || m.role === "assistant");
    if (history.length > 0) {
      let budget = config.maxContextTokens;
      const kept = [];
      for (let i = history.length - 1; i >= 0; i -= 1) {
        const m = history[i];
        if (contentHasImage(m.content)) continue; // 含图消息不进文本上下文
        const text = textBlocksOf(m.content).map((b) => b.text).join("\n");
        if (!text) continue;
        if (estimateTokens(text) > budget) break;
        budget -= estimateTokens(text);
        kept.unshift(m);
      }
      if (kept.length > 0) {
        const joined = kept.map((m) => `${m.role === "assistant" ? "助手" : "用户"}：${textBlocksOf(m.content).map((b) => b.text).join("\n")}`).join("\n\n");
        messages.push(createUserMessage({
          content: [{ type: "text", text: `[相关对话上下文]\n${joined}` }],
          source: { kind: "plugin", plugin: "dsh-vision-fallback" }
        }));
      }
    }
  }

  const instructionText = instruction && instruction.trim()
    ? instruction.trim()
    : "请详细描述图片内容：主体、布局、文字（逐字转录）、颜色、数量等所有对后续任务有用的细节。";
  messages.push(createUserMessage({
    content: [{ type: "text", text: `任务：${instructionText}\n请直接输出分析结果（纯文本，不要客套，不要提问）。` }],
    source: { kind: "plugin", plugin: "dsh-vision-fallback" }
  }));
  return messages;
}

const VISION_SYSTEM = "你是图片分析子智能体。职责：按任务指令分析指定图片并输出纯文本结果。规则：描述要具体、可被纯文本模型直接使用；图片内的文字必须逐字转录；不确定的内容标注出来；不要输出与任务无关的寒暄。";

/** 用视觉模型跑一次带上下文的识别，返回文本。失败抛错。 */
async function runVisionAnalysis(ctx, agent, imageMessage, instruction, config, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const messages = buildVisionMessages(ctx, agent, imageMessage, instruction, config);
    const stream = ctx.llm.stream({
      provider: config.provider,
      model: config.model,
      messages,
      system: VISION_SYSTEM,
      signal: controller.signal
    });
    let text = "";
    for await (const chunk of stream) {
      if (chunk.type === "text-delta") text += chunk.text;
      if (chunk.type === "finish" && chunk.reason.kind === "error") {
        throw new Error(`视觉模型调用失败：${(chunk.reason.failure && chunk.reason.failure.message) || "未知错误"}`);
      }
    }
    if (!text.trim()) throw new Error("视觉模型未返回分析结果");
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
* 预分析模式：含图消息进入 inbox 后，同步移除，异步分析，替换回 inbox。
* 严格时序保证图片块绝不进入会话历史（→ 图片字节永不进模型上下文）：
*   1. inbox 事件触发时消息尚未被 claim，同步 remove 原消息；
*   2. 用视觉模型分析（带截断后的历史纹理上下文）；
*   3. 「原文本 + 图片标识/本地路径 + 分析结果」作为纯文本消息 followup 回
*      inbox，随本轮正常进入会话。
* 附件数据留在存储层不删除（路径/标识可找回）；分析失败时原消息放回 inbox，
* 不丢用户输入。
*/
function installPreanalyze(ctx, getConfig) {
  ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    const config = getConfig();
    if (!config.enabled || !config.preanalyze || !config.provider || !config.model) return;
    if (!contentHasImage(message.content)) return;
    const inbox = agent && agent.inbox;
    if (!inbox || typeof inbox.remove !== "function" || typeof agent.followup !== "function") return;

    // 同步移除：driver 在分析完成前不可能 claim 到含图消息。
    if (!inbox.remove(message.id)) return;

    const marks = imageMarks(imageBlocksOf(message.content));
    const descLines = marks.map((mark) => {
      const idMatch = mark.match(IMAGE_ID_RE);
      const path = idMatch ? attachmentObjectPath(idMatch[0]) : void 0;
      return `${mark}${path ? `（本地路径：${path}）` : ""}`;
    });
    const preText = textBlocksOf(message.content).map((b) => b.text).join("\n");

    void (async () => {
      try {
        const analysis = await runVisionAnalysis(ctx, agent, message, "", config, void 0);
        const extra = createUserMessage({
          content: [{
            type: "text",
            text: [
              ...(preText ? [`（原消息）\n${preText}`] : []),
              ...(descLines.length > 0 ? [`（消息附图）\n${descLines.join("\n")}`] : []),
              `（图片分析）\n${analysis}`,
              "（以上图片分析由视觉子智能体生成；如需对图片进一步提问，可调用 vision_inspect 工具）"
            ].join("\n\n")
          }],
          source: { kind: "plugin", plugin: "dsh-vision-fallback" }
        });
        agent.followup(extra);
      } catch (err) {
        // 分析失败：放回原消息，不丢用户输入。
        ctx.logger?.warn?.("dsh-vision-fallback: 预分析失败，放回原消息：%s", err instanceof Error ? err.message : String(err));
        try { agent.followup(message); } catch { /* 放回失败则消息丢失，仅记录 */ }
      }
    })();
  });
}

/**
* 从 agent 会话历史中按 attachmentId 找图片块。
* 仅预分析关闭（回退模式）时图片块才存在于会话历史中；预分析模式下
* 走本地文件解析链（resolveImageMessage）。
*/
function findImageBlock(agent, attachmentId) {
  if (!agent || !agent.session) return void 0;
  let messages = [];
  try { messages = agent.session.deriveMessages(); } catch { messages = []; }
  for (const message of messages) {
    for (const block of imageBlocksOf(message.content)) {
      const ref = refOf(block);
      if (ref && String(ref.attachmentId) === String(attachmentId)) return ref;
    }
  }
  return void 0;
}

/**
* 把工具输入解析成含图消息（供视觉模型调用）：
*   - 会话历史中找到该 attachmentId 的图 → 直接用原 ref（回退模式）；
*   - 否则按 sha256 → 本地对象路径 / 用户给的路径 读取字节，重存附件服务
*     （内容寻址去重：同一字节返回同一 attachmentId，且元数据完整）。
*/
async function resolveImageMessage(ctx, agent, imageArg) {
  const attachments = ctx.get("attachments");
  if (!attachments || typeof attachments.saveImages !== "function") {
    throw new Error("vision_inspect: 附件服务不可用");
  }
  if (IMAGE_ID_RE.test(imageArg)) {
    const ref = findImageBlock(agent, imageArg);
    if (ref) {
      return createUserMessage({
        content: [{ type: "image", attachment: ref }, { type: "text", text: "" }],
        source: { kind: "plugin", plugin: "dsh-vision-fallback" }
      });
    }
    const objectPath = attachmentObjectPath(imageArg);
    if (!objectPath) throw new Error(`vision_inspect: 无法解析图片标识 ${imageArg}`);
    try {
      const data = await readFile(objectPath);
      const mediaType = sniffMediaType(data);
      if (!mediaType) throw new Error(`vision_inspect: 无法识别文件格式：${objectPath}`);
      const saved = await attachments.saveImages([{ data, mediaType, name: `${imageArg.slice(7, 15)}.${mediaType.split("/")[1]}` }]);
      return createUserMessage({
        content: [{ type: "image", attachment: saved[0] }, { type: "text", text: `图片对象：${objectPath}` }],
        source: { kind: "plugin", plugin: "dsh-vision-fallback" }
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("vision_inspect")) throw err;
      throw new Error(`vision_inspect: 读取图片对象失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // 路径输入：读文件并由附件服务校验/归一化。
  const resolvedPath = resolve(imageArg);
  const data = await readFile(resolvedPath);
  const mediaType = sniffMediaType(data);
  if (!mediaType) throw new Error(`vision_inspect: 无法识别文件格式：${resolvedPath}`);
  const saved = await attachments.saveImages([{
    data,
    mediaType,
    name: resolvedPath.split(/[\\/]/).pop()
  }]);
  return createUserMessage({
    content: [{ type: "image", attachment: saved[0] }, { type: "text", text: `本地图片：${resolvedPath}` }],
    source: { kind: "plugin", plugin: "dsh-vision-fallback" }
  });
}

/**
* 注册 vision_inspect 工具：主 agent 主动调用，带上下文 + 可选指令的
* 图片识别。可重复调用（换指令再问）——子智能体语义。
*/
function installTool(ctx, getConfig) {
  const tools = ctx.get("tools");
  if (!tools || typeof tools.register !== "function") return;
  ctx.effect(() => tools.register(defineTool({
    name: TOOL_NAME,
    description: "调用视觉子智能体识别一张图片。image 填图片标识（sha256:…，来自消息中的图片标记），或图片的本地绝对路径。可选 instructions 给子智能体下任务（如『读取图中表格』『描述整体布局』）；不传则默认详细描述。可选 context 补充主会话上下文之外的信息。识别结果返回纯文本。对结果不满意可再次调用并换用更具体的指令。",
    parameters: {
      image: { type: "string", required: true, description: "图片标识 sha256:…（推荐，来自消息图片标记）或图片本地绝对路径" },
      instructions: { type: "string", description: "给视觉子智能体的具体任务指令；缺省为详细描述图片" },
      context: { type: "string", description: "补充上下文信息（可选），会连同最近会话历史一起提供给子智能体" }
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }]
    },
    async execute(args, exec) {
      const config = getConfig();
      if (!config.enabled || !config.provider || !config.model) {
        throw new Error("dsh-vision-fallback 未启用或未配置视觉模型");
      }
      const imageArg = String(args.image || "").trim();
      if (!imageArg) throw new Error("vision_inspect: 缺少 image 参数");
      const signal = exec && exec.signal ? exec.signal : void 0;

      const imageMessage = await resolveImageMessage(ctx, exec.agent, imageArg);

      const instruction = typeof args.instructions === "string" ? args.instructions : "";
      const extraContext = typeof args.context === "string" && args.context.trim() ? args.context.trim() : "";
      const text = await runVisionAnalysis(ctx, exec.agent, imageMessage, instruction, config, signal);
      return extraContext ? `${text}\n\n[补充上下文]\n${extraContext}` : text;
    }
  })), `dsh-vision-fallback: ${TOOL_NAME} tool`);
}

/**
* 回退模式（preanalyze 关闭时）：agent/request 检测当前 turn 含图 →
* 切视觉模型；纯文本轮次恰是视觉模型 → 切回主模型。
*/
function installFallback(ctx, getConfig) {
  ctx.on("agent/request", async ({ agent, turn }, next) => {
    const resolved = await next();
    const config = getConfig();
    if (!config.enabled || config.preanalyze || !config.provider || !config.model) return resolved;
    const needsVision = currentTurnHasImage(agent, turn);
    if (needsVision) {
      if (resolved.provider === config.provider && resolved.model === config.model) return resolved;
      return { ...resolved, provider: config.provider, model: config.model };
    }
    if (resolved.provider === config.provider && resolved.model === config.model) {
      const defaultModel = ctx.get("agentDefaultModel");
      if (defaultModel && typeof defaultModel.currentSelection === "function") {
        const main = defaultModel.currentSelection();
        if (main && main.provider && main.model) {
          return { ...resolved, provider: main.provider, model: main.model };
        }
      }
    }
    return resolved;
  });
}

/** 只扫「当前 turn」的消息是否含图（避免历史图片污染判定）。 */
function currentTurnHasImage(agent, turn) {
  const session = agent && agent.session;
  if (!session || !Array.isArray(session.log)) return false;
  const log = session.log;
  let start = -1;
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const event = log[i];
    if (event !== null && typeof event === "object" && event.type === "turn/start" &&
        event.data !== null && typeof event.data === "object" && event.data.turn === turn) {
      start = i;
      break;
    }
  }
  if (start === -1) return false;
  for (let i = start; i < log.length; i += 1) {
    const event = log[i];
    if (event === null || typeof event !== "object") continue;
    if (event.type === "user/message" && contentHasImage(event.data && event.data.content)) return true;
    if (event.type === "tool/result" && contentHasImage(event.data && event.data.message && event.data.message.content)) return true;
  }
  return false;
}

function apply(ctx) {
  let source = () => ({ enabled: false, preanalyze: true, provider: "", model: "", maxContextTokens: 8000 });
  installSettingsSection(ctx, SETTINGS_NS, SettingsSchema, { enabled: false }, {
    setSource(current) { source = current; },
    onChange() {},
  });
  const getConfig = () => source();

  installPreanalyze(ctx, getConfig);
  installTool(ctx, getConfig);
  installFallback(ctx, getConfig);

  // 视觉模型目录：client 卡片从这里选回退模型。
  const webServer = ctx.get("webServer");
  if (webServer !== void 0) {
    ctx.effect(() => webServer.register({
      kind: "exact",
      path: MODELS_ROUTE,
      handler: async (req, res) => {
        const sendJson = (status, body) => {
          res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(body));
        };
        try {
          const groups = [];
          for (const providerInfo of ctx.llm.listProviders()) {
            let models;
            try { models = await ctx.llm.listModels(providerInfo.id); } catch { continue; }
            const vision = [];
            for (const model of models) {
              let info;
              try { info = await ctx.llm.resolveModelInfo(providerInfo.id, model.id); } catch { continue; }
              if (info.inputModalities !== void 0 && info.inputModalities.includes("image")) {
                vision.push({ id: model.id, name: model.name });
              }
            }
            if (vision.length > 0) groups.push({ id: providerInfo.id, name: providerInfo.name, models: vision });
          }
          sendJson(200, { ok: true, groups });
        } catch (err) {
          sendJson(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    }), "dsh-vision-fallback: models route");
  }
}

export { name, inject, apply, _test };

/** 供冒烟测试调用的内部实现（非插件 API，勿在插件外依赖）。 */
const _test = {
  attachmentObjectPath,
  buildVisionMessages,
  contentHasImage,
  imageBlocksOf,
  imageIdsOf,
  imageMarks,
  installPreanalyze,
  installTool,
  resolveImageMessage,
  runVisionAnalysis,
  sniffMediaType,
  textBlocksOf,
};
