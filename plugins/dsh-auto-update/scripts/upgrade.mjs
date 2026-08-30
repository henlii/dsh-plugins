// dsh-auto-update 升级执行器（detached 子进程，由 src/index.js spawn）。
//
// 用法：node upgrade.mjs <target> <statePath> <rollbackPath> <pm> <restart>
//   target      latest / next / 具体版本号
//   statePath   $DSH_HOME/dsh-auto-update.json（与宿主共享）
//   rollbackPath 回退脚本输出路径
//   pm          pnpm | npm
//   restart     systemd restart 命令；空串 = 不自动重启
//
// 护栏（防升级卡死/崩溃）：
//   * 全程独立进程、不碰宿主；
//   * 安装带超时，超时 kill 并回写 failed（宿主继续跑旧版）；
//   * 安装成功后校验新版本 package.json 版本号与 bin 语法，失败回写 failed；
//   * 全部通过才把 pending 提升为 last，然后延迟重启；
//   * 每次升级前写回退脚本 rollback.<ext>：装回 previous + 重启。
import { createRequire } from "node:module";
import { spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

const [target, statePath, rollbackPath, pm, restart] = process.argv.slice(2);
const PKG = "@deepseek-ai/dsh";
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

const require = createRequire(import.meta.url);
const log = (...args) => process.stderr.write(args.join(" ") + "\n");

// ── 状态读写 ──────────────────────────────────────────────────────────────
function readState() {
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (raw !== null && typeof raw === "object") return raw;
  } catch { /* 首次 */ }
  return {};
}
function writeState(state) {
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (err) {
    log("状态写入失败：", err?.message ?? String(err));
  }
}

// ── 跨平台命令执行 ─────────────────────────────────────────────────────
// Windows 上 pnpm/npm/systemctl 都是 .cmd 垫片，spawn 直接跑会 ENOENT，
// 统一经 cmd /c 或 sh -c 包一层。
function runSync(argv) {
  if (process.platform === "win32") {
    return spawnSync("cmd", ["/d", "/s", "/c", argv.map(quoteWin).join(" ")], { encoding: "utf8" });
  }
  return spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
}
function runDetached(command) {
  const child = process.platform === "win32"
    ? spawn("cmd", ["/d", "/s", "/c", command], { detached: true, stdio: "ignore" })
    : spawn("sh", ["-c", command], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}
function quoteWin(arg) {
  return /[\s"]/.test(arg) ? `"${String(arg).replace(/"/g, '\\"')}"` : String(arg);
}

// ── 全局安装目录与版本解析 ──────────────────────────────────────────────
function globalNodeModules(pm) {
  const r = runSync([pm, pm === "pnpm" ? "root" : "prefix", "-g"]);
  if (r.status !== 0 || !r.stdout) throw new Error(`${pm} root/prefix -g 失败`);
  const base = r.stdout.trim().replace(/\\/g, "/");
  return pm === "npm" ? join(base, "node_modules") : base;
}

function readGlobalVersion(pm) {
  const nm = globalNodeModules(pm);
  const pkgPath = join(nm, PKG.replace("/", "/"), "package.json");
  if (!existsSync(pkgPath)) throw new Error(`找不到 ${PKG}（${pkgPath}）`);
  return JSON.parse(readFileSync(pkgPath, "utf8")).version;
}

// ── 安装（带超时）────────────────────────────────────────────────────────
function install(pm, targetSpecifier) {
  const argv = [pm === "pnpm" ? "add" : "install", "-g", `${PKG}@${targetSpecifier}`];
  log("安装：", argv.join(" "));
  return new Promise((resolve, reject) => {
    const child = process.platform === "win32"
      ? spawn("cmd", ["/d", "/s", "/c", argv.map(quoteWin).join(" ")], { stdio: "inherit" })
      : spawn(argv[0], argv.slice(1), { stdio: "inherit" });
    const timer = setTimeout(() => {
      log("安装超时，终止子进程");
      child.kill("SIGKILL");
      reject(new Error(`安装超时（${INSTALL_TIMEOUT_MS / 1000}s）`));
    }, INSTALL_TIMEOUT_MS);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${pm} 安装退出码 ${code}`));
    });
  });
}

// ── 校验新版本可加载 ────────────────────────────────────────────────────
function verify(pm, expected) {
  const version = readGlobalVersion(pm);
  if (typeof expected === "string" && expected !== "latest" && expected !== "next" && version !== expected) {
    throw new Error(`版本不匹配：期望 ${expected}，实际 ${version}`);
  }
  const nm = globalNodeModules(pm);
  const pkgPath = join(nm, PKG.replace("/", "/"), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const binPath = pkg.bin && (typeof pkg.bin === "string" ? pkg.bin : pkg.bin.dsh);
  if (!binPath) throw new Error("新版本缺少 bin.dsh 入口");
  // npm 全局：node_modules/@deepseek-ai/dsh/bin；pnpm 全局：实包目录 + bin。
  const pkgDir = pkgPath.slice(0, pkgPath.lastIndexOf("/"));
  const target = join(pkgDir, binPath);
  const check = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
  if (check.status !== 0) throw new Error(`新版本 bin 语法校验失败：${check.stderr || "未知错误"}`);
  return version;
}

// ── 回退脚本 ─────────────────────────────────────────────────────────────
function writeRollback(previous) {
  const script = process.platform === "win32"
    ? `@echo off\r\n${pm} ${pm === "pnpm" ? "add" : "install"} -g ${PKG}@${previous}\r\necho rollback done, restart your service now\r\n`
    : `#!/bin/sh\nset -e\n${pm} ${pm === "pnpm" ? "add" : "install"} -g ${PKG}@${previous}\n${restart || "echo 'restart your service manually'"}\n`;
  writeFileSync(rollbackPath, script);
  try { chmodSync(rollbackPath, 0o755); } catch { /* Windows 无意义 */ }
  log("回退脚本已写：", rollbackPath);
}

// ── 延迟重启 ─────────────────────────────────────────────────────────────
function scheduleRestart(command) {
  if (!command) {
    log("未配置自动重启命令（非 systemd 环境），请手动重启服务");
    return;
  }
  // 延迟 4s：先让 HTTP 响应落地，再切进程。
  setTimeout(() => {
    log("执行重启：", command);
    runDetached(command);
  }, 4000);
}

// ── 主流程 ───────────────────────────────────────────────────────────────
async function main() {
  const state = readState();
  const previous = typeof state.previous === "string" && state.previous.length > 0 ? state.previous : null;
  try {
    writeRollback(previous || "latest");
  } catch (err) {
    log("回退脚本写入失败（不阻断升级）：", err?.message ?? String(err));
  }
  try {
    await install(pm, target);
    const installed = verify(pm, target);
    log("安装并校验通过：", installed);
    writeState({
      ...state,
      previous: previous || installed, // previous 只在首次升级时记录
      pending: { ...(state.pending || {}), installed, doneAt: Date.now() },
      last: { target, installed, at: Date.now(), source: "auto-update" }
    });
    scheduleRestart(restart);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("升级失败：", message);
    writeState({
      ...state,
      pending: null,
      last: {
        target, installed: null, at: Date.now(), error: message, source: "auto-update"
      }
    });
    process.exit(1);
  }
}

void main();