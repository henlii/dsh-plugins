// dsh-vision-fallback host half — 主模型非视觉时回退到配置的视觉模型。
//
// 官方 agent/request waterfall 是每次 LLM 请求的模型选择点（default-model
// 在此注入会话模型）。本插件在 next() 之后检查最终选定的模型：若请求消息
// 含图片且该模型不支持 image 模态，则替换为配置的视觉模型（provider/model
// 来自 settings 命名空间，客户端卡片在「插件配置」里从内置供应商模型目录
// 选择）。视觉模型不支持 reasoningEffort 时一并去掉，避免 prepareCall 拒绝。

import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

const name = "dsh-vision-fallback";
const inject = ["llm", "webServer"];
const SETTINGS_NS = settingsNamespace("dsh-vision-fallback");
const MODELS_ROUTE = "/api/dsh-vision-fallback/models";
const SettingsSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.string(),
  model: z.string(),
});

/** 递归检查内容块是否含图片（含 tool-result 嵌套）。 */
function contentHasImage(content) {
  if (!Array.isArray(content)) return false;
  return content.some((block) =>
    (block !== null && typeof block === "object" && block.type === "image") ||
    (block !== null && typeof block === "object" && block.type === "tool-result" && contentHasImage(block.content))
  );
}

function apply(ctx) {
  let source = () => ({ enabled: false, provider: "", model: "" });
  installSettingsSection(ctx, SETTINGS_NS, SettingsSchema, { enabled: false }, {
    setSource(current) { source = current; },
    onChange() {},
  });

  ctx.on("agent/request", async ({ agent }, next) => {
    const resolved = await next();
    const { enabled, provider, model } = source();
    if (!enabled || !provider || !model) return resolved;
    // 已是配置的视觉模型 → 不重复切换。
    if (resolved.provider === provider && resolved.model === model) return resolved;
    // 请求消息不含图片 → 无需回退。
    const messages = agent && agent.session ? agent.session.deriveMessages() : [];
    if (!messages.some((message) => contentHasImage(message.content))) return resolved;
    // 替换为配置的视觉模型；视觉模型不支持 reasoningEffort 时去掉。
    // 注意：不依赖 resolveModelInfo 判断主模型是否视觉——cpa 这类非 catalog
    // 路由的模型会继承 route 的 defaultInput（含 image），解析结果不可靠。
    try {
      const vinfo = await ctx.llm.resolveModelInfo(provider, model);
      if (resolved.reasoningEffort !== void 0 && vinfo.reasoning === void 0) {
        const { reasoningEffort: _dropped, ...rest } = resolved;
        return { ...rest, provider, model };
      }
      return { ...resolved, provider, model };
    } catch {
      /* 视觉模型不可用 → 保持原模型 */
      return resolved;
    }
  });

  // 视觉模型目录：client 卡片从这里选回退模型。llm.models 的 wire 视图不含
  // inputModalities，所以宿主按能力过滤后只返回支持 image 的模型。
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
            try {
              models = await ctx.llm.listModels(providerInfo.id);
            } catch {
              continue;
            }
            const vision = [];
            for (const model of models) {
              let info;
              try {
                info = await ctx.llm.resolveModelInfo(providerInfo.id, model.id);
              } catch {
                continue;
              }
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

export { name, inject, apply };
