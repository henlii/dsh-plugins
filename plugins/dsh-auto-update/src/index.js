// dsh-auto-update host half — 一键更新 DeepSeek Harness 运行时。
//
// 官方 dsh 没有自更新命令，升级只能手动 pnpm/npm 全局装新版；本插件在
// web 设置面板提供「检查更新 / 升级到预览版 / 回退到正式版」按钮，把
// 后台升级做成带护栏的流程：
//
//   1. 升级在**独立子进程**里跑（detached node scripts/upgrade.mjs），
//      不阻塞宿主进程：npm/pnpm 全局安装期间 web 服务照常响应。
//   2. 安装完成后**先验证**（新版本 package.json 版本号 + bin 语法），
//      验证通过才请求重启；失败则保持旧版本继续运行。
//   3. 重启延迟数秒发出，先让 HTTP 响应落地；systemd 部署用
//      `systemctl restart`（Restart=on-failure 兜底），非 systemd 只提示
//      手动重启，绝不自杀式退出。
//   4. 每次升级前把当前版本写入状态文件，另写一个可执行回退脚本
//      （rollback.<ext>），万一新版本启动失败可一键退回。
//   5. 并发护栏：upgrade 进行中时拒绝新的 upgrade 请求。
//
// 状态文件与回退脚本写在 DSH_HOME（默认 ~/.dsh），跨平台路径。
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

const name = "dsh-auto-update";
const inject = ["webServer"];
const NS = settingsNamespace("dsh-auto-update");
const SettingsSchema = z.object({});

const PKG = "@deepseek-ai/dsh";
const REGISTRY = "https://registry.npmjs.org/";
const STATUS_ROUTE = "/api/dsh-auto-update/status";
const UPGRADE_ROUTE = "/api/dsh-auto-update/upgrade";
const FETCH_TIMEOUT_MS = 8000;
const BODY_LIMIT = 16384;

// ── 部署形态探测 ──────────────────────────────────────────────────────────
// 运行入口（process.argv[1]）在 node_modules/@deepseek-ai/dsh 里说明是
// npm/pnpm 全局安装，可安全升级；在 asar/内嵌目录则是 dsh-desktop
// （自带更新机制，不由本插件管）。
function deploymentKind(argv1) {
  if (!argv1) return { kind: "unknown", global: false, argv1: "" };
  const p = String(argv1).replace(/\\/g, "/");
  if (p.includes("node_modules/@deepseek-ai/dsh/")) {
    const pnpm = p.includes("/.pnpm/") || p.includes("/global/");
    return { kind: pnpm ? "pnpm-global" : "npm-global", global: true, argv1: p };
  }
  return { kind: "desktop-or-local", global: false, argv1: p };
}

function packageManager(guess, cfg) {
  if (typeof cfg.packageManager === "string" && (cfg.packageManager === "pnpm" || cfg.packageManager === "npm")) {
    return cfg.packageManager;
  }
  return guess === "pnpm-global" ? "pnpm" : "npm";
}

// 当前版本：从运行入口解析出 @deepseek-ai/dsh/package.json。
function currentVersion(argv1) {
  if (!argv1) return null;
  const p = String(argv1).replace(/\\/g, "/");
  const marker = "node_modules/@deepseek-ai/dsh/";
  const idx = p.indexOf(marker);
  if (idx === -1) return null;
  try {
    return JSON.parse(readFileSync(`${p.slice(0, idx)}${marker}package.json`, "utf8")).version || null;
  } catch {
    return null;
  }
}

// dist-tags 探测：latest（正式版）/ next（预览版）。带 60s 内存缓存，
// 卡片轮询时不会每次都打 npm registry。
let tagsCache = { at: 0, tags: null, error: null };
async function fetchDistTags() {
  const now = Date.now();
  if (now - tagsCache.at < 60000) {
    if (tagsCache.error !== null) throw tagsCache.error;
    return tagsCache.tags;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${REGISTRY}${PKG}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`registry ${res.status}`);
    const doc = await res.json();
    const tags = (doc && doc["dist-tags"]) || {};
    tagsCache = { at: now, tags: { latest: tags.latest || null, next: tags.next || null }, error: null };
    return tagsCache.tags;
  } catch (err) {
    tagsCache = { at: now, tags: null, error: err instanceof Error ? err : new Error(String(err)) };
    throw tagsCache.error;
  } finally {
    clearTimeout(timer);
  }
}

// systemd 下生成 `systemctl restart <unit>`；非 systemd 返回 ""（不自动重启）。
// is-system-running 在 degraded（部分非关键 unit 失败）时也返回非零，故只
// 以目标 unit 是否可管理为准：unit 存在且当前有 Supervisor（systemd 会话）
// 即可安全重启。
function defaultRestartCommand() {
  try {
    if (process.platform === "win32" || process.platform === "darwin") return "";
    const hasSystemd = spawnSync("systemctl", ["show", "-p", "LoadState", "--value", "dsh"], { encoding: "utf8" });
    if (hasSystemd.status !== 0 || !hasSystemd.stdout.toString().includes("loaded")) return "";
    const active = spawnSync("systemctl", ["is-active", "dsh"], { stdio: "ignore" });
    return active.status === 0 ? "systemctl restart dsh" : "";
  } catch {
    return "";
  }
}

function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function apply(ctx, config) {
  installSettingsSection(ctx, NS, SettingsSchema, {}, {
    setSource() {},
    onChange() {}
  });

  const webServer = ctx.get("webServer");
  if (webServer === void 0) return;

  const cfg = config !== null && typeof config === "object" ? config : {};
  const argv1 = process.argv[1];
  const deploy = deploymentKind(argv1);
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? String(process.env.DSH_HOME)
    : join(homedir(), ".dsh");
  const statePath = join(dshHome, "dsh-auto-update.json");
  const rollbackPath = join(dshHome, process.platform === "win32" ? "dsh-auto-update-rollback.cmd" : "dsh-auto-update-rollback.sh");
  const scriptPath = fileURLToPath(new URL("../scripts/upgrade.mjs", import.meta.url));
  const pm = packageManager(deploy.kind, cfg);
  const restart = typeof cfg.restartCommand === "string" && cfg.restartCommand.length > 0
    ? cfg.restartCommand
    : defaultRestartCommand();

  let upgrading = false;

  const readState = () => {
    try {
      const raw = JSON.parse(readFileSync(statePath, "utf8"));
      if (raw !== null && typeof raw === "object") return raw;
    } catch { /* 首次运行 */ }
    return {};
  };

  const handleStatus = async (_req, res) => {
    let tags = null;
    let tagsError = null;
    try {
      tags = await fetchDistTags();
    } catch (err) {
      tagsError = err instanceof Error ? err.message : String(err);
    }
    const current = deploy.global ? currentVersion(deploy.argv1) : null;
    const state = readState();
    // 回退目标：升级前的版本（状态文件 previous）。
    const rollbackTo = typeof state.previous === "string" && state.previous.length > 0 ? state.previous : null;
    sendJson(res, 200, {
      ok: true,
      managed: deploy.global,
      kind: deploy.kind,
      packageManager: pm,
      dshHome,
      current,
      tags,
      tagsError,
      upgrading,
      restart: restart.length > 0,
      rollback: Boolean(rollbackTo),
      previous: rollbackTo
    });
  };

  const handleUpgrade = async (req, res) => {
    if (!deploy.global) {
      sendJson(res, 409, { ok: false, error: "当前部署形态不支持命令行升级（dsh-desktop 请用其内置更新）" });
      return;
    }
    if (upgrading) {
      sendJson(res, 409, { ok: false, error: "升级进行中，请稍候" });
      return;
    }
    let body = null;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid JSON body" });
      return;
    }
    const target = typeof body.target === "string" ? body.target.trim() : "";
    // 允许：latest / next / 具体版本号（回退到正式版 = 'latest'）。
    if (target !== "latest" && target !== "next" && !/^\d+\.\d+\.\d+/.test(target)) {
      sendJson(res, 400, { ok: false, error: "target 必须是 latest / next / 版本号" });
      return;
    }
    if ((target === "latest" || target === "next") && !(target in (await fetchDistTags().catch(() => ({}))))) {
      sendJson(res, 409, { ok: false, error: "registry 不可达或 dist-tag 不存在，未开始升级" });
      return;
    }
    const current = currentVersion(deploy.argv1);
    const state = readState();
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      // previous 记录升级前版本（回退锚点）；pending 记录本次目标。
      writeFileSync(statePath, JSON.stringify({
        ...state,
        previous: state.pending ? state.previous : (current || state.previous || null),
        pending: { target, from: current || null, pm, restart, startedAt: Date.now() }
      }, null, 2));
    } catch {
      sendJson(res, 500, { ok: false, error: "无法写入状态文件" });
      return;
    }
    upgrading = true;
    const child = spawn(process.execPath, [scriptPath, target, statePath, rollbackPath, pm, restart], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    child.on("exit", () => { upgrading = false; });
    sendJson(res, 200, { ok: true, target, pm, restart, note: "升级已在后台启动，完成后自动重启服务" });
  };

  ctx.effect(() => webServer.register({
    kind: "exact",
    path: STATUS_ROUTE,
    handler: handleStatus
  }), "dsh-auto-update: status route");
  ctx.effect(() => webServer.register({
    kind: "exact",
    path: UPGRADE_ROUTE,
    handler: handleUpgrade
  }), "dsh-auto-update: upgrade route");
}

export { name, inject, apply };