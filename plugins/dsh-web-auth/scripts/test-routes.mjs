// dsh-web-auth bind route checks: mount the host half into a minimal stub
// context and drive its HTTP routes directly.
//
// 覆盖：绑定状态的读取、输入校验（host 白名单 / 端口范围）、端口占用预检、
// configEditor.edit 回调「没动的键原样保留（含 !!js 表达式）」、写入失败把原因
// 带回面板，以及路由确实落在密码门之后（回环免密 / 非回环无 cookie 401 /
// 登录后放行）。不启动 dsh，也不碰正在跑的实例。
//
// Run: node scripts/test-routes.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 先把 DSH_HOME 指向临时目录再导入插件：token 与密码文件的默认路径在模块加载
// 时算出来，否则这次测试会往运维真实的 DSH home 里写文件。
const testHome = mkdtempSync(join(tmpdir(), "dsh-web-auth-test-"));
process.env.DSH_HOME = testHome;
process.on("exit", () => {
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const plugin = await import("../src/index.js");

// ── stub cordis context ─────────────────────────────────────────────────────

const EXACT = new Map();
// 官方 connection 行注册的 /api 前缀在插件 apply 之前就存在，插件的 sweep 会把它
// 一起包进门后；/api/auth/* 由 authorizeHttp 直接交给插件自己的 handler。
const PREFIXES = new Map([["/api", {
  kind: "prefix",
  path: "/api",
  handler: async (req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }
}]]);

const webServer = {
  port: 3080,
  host: "127.0.0.1",
  exact: EXACT,
  prefixes: PREFIXES,
  upgrades: new Map(),
  fallback: undefined,
  register(route) {
    EXACT.set(route.path, route);
    return () => EXACT.delete(route.path);
  },
  registerUpgrade() {
    return () => {};
  },
  registerFallback(handler) {
    this.fallback = handler;
    return () => {};
  },
  tapIndex() {
    return () => {};
  }
};

const RAW_PORT = { __jsExpr: "ctx.webStartup.port ?? 3080" };
const entryConfig = {
  host: "127.0.0.1",
  port: RAW_PORT,
  compression: "gzip",
  compressionLevel: 1,
  compressionThresholdBytes: 1024
};
const webserverEntry = {
  options: { id: "webserver", name: "@deepseek-ai/dsh-host-webserver", config: entryConfig }
};
const edits = [];
let editorAvailable = true;
let editError = null;
const configEditor = {
  documentPath: join(testHome, "profiles", "web", "cordis.patch.yml"),
  entries: () => [webserverEntry],
  async edit(entry, change) {
    if (editError !== null) throw editError;
    edits.push({ next: change(entry.options.config, {}) });
  }
};

const services = { webServer, configEditor };
const intervals = [];
const ctx = {
  get(name) {
    if (name === "configEditor" && !editorAvailable) return void 0;
    return services[name];
  },
  effect(fn) {
    const dispose = fn();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
  interval(fn, ms) {
    intervals.push({ fn, ms });
    return () => {};
  }
};

plugin.apply(ctx, { password: "s3cret" });
assert.ok(EXACT.has("/api/dsh-web-auth/bind"), "bind 路由应已注册");
assert.equal(intervals.length, 1, "token 清扫定时器应已挂上");

// ── stub HTTP request/response ──────────────────────────────────────────────

function makeRes() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(text) {
      this.body = text || "";
    },
    once() {}
  };
}

function makeReq({ method = "GET", url = "/", headers = {}, body = null, peer = "127.0.0.1" }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: peer };
  req.resume = () => {};
  // 路由通过 'data'/'end' 读 body，推到下一个 tick，等 handler 挂好监听。
  setImmediate(() => {
    if (body !== null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

/** 走真实的注册表：/api/auth/* 与未命中的路径落到 /api 前缀，其余走 exact。 */
async function callApi(pathname, options = {}) {
  const route = EXACT.get(pathname) ?? PREFIXES.get("/api");
  const req = makeReq({ ...options, url: pathname });
  const res = makeRes();
  await route.handler(req, res);
  let body = null;
  try {
    body = res.body.length > 0 ? JSON.parse(res.body) : null;
  } catch {
    /* 非 JSON 响应保持 null */
  }
  return { res, body };
}

const freePort = () => new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const port = probe.address().port;
    probe.close(() => resolve(port));
  });
});

// ── 读取绑定状态 ────────────────────────────────────────────────────────────

let r = await callApi("/api/dsh-web-auth/bind");
assert.equal(r.res.status, 200);
assert.deepEqual(r.body, {
  ok: true,
  host: "127.0.0.1",
  port: 3080,
  editable: true,
  reason: null,
  patchPath: configEditor.documentPath
});

// 非回环、没登录：路由在密码门之后。
r = await callApi("/api/dsh-web-auth/bind", { peer: "192.0.2.9" });
assert.equal(r.res.status, 401);

// 方法围栏。
r = await callApi("/api/dsh-web-auth/bind", { method: "PUT" });
assert.equal(r.res.status, 405);

// ── 输入校验：非法输入不碰磁盘 ──────────────────────────────────────────────

edits.length = 0;
r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "192.168.1.5", port: 3080 }) });
assert.equal(r.res.status, 400);
assert.match(r.body.error, /绑定地址/);

r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "127.0.0.1", port: "abc" }) });
assert.equal(r.res.status, 400);

r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "127.0.0.1", port: 65536 }) });
assert.equal(r.res.status, 400);

r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "127.0.0.1", port: 3080.5 }) });
assert.equal(r.res.status, 400);

r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "127.0.0.1" }) });
assert.equal(r.res.status, 400);
assert.equal(edits.length, 0, "被拒绝的请求不应写配置");

// ── 端口占用预检 ────────────────────────────────────────────────────────────

const holder = createServer();
const heldPort = await new Promise((resolve) => holder.listen(0, "127.0.0.1", () => resolve(holder.address().port)));
r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "127.0.0.1", port: heldPort }) });
assert.equal(r.res.status, 409);
assert.match(r.body.error, /不可用/);
assert.equal(edits.length, 0);
await new Promise((resolve) => holder.close(resolve));

// ── 写入前的 next config ────────────────────────────────────────────────────

// 只改绑定地址：端口那一行的 !!js 表达式必须原样保留（写死等于废掉 --port）。
edits.length = 0;
r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "0.0.0.0", port: 3080 }) });
assert.equal(r.res.status, 200);
assert.equal(edits.length, 1);
assert.equal(edits[0].next.host, "0.0.0.0");
assert.deepEqual(edits[0].next.port, RAW_PORT);
assert.equal(edits[0].next.compression, "gzip", "未改动的键要原样带回");

// 改端口：写死字面量，绑定地址不动。
const free = await freePort();
edits.length = 0;
r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "127.0.0.1", port: free }) });
assert.equal(r.res.status, 200);
assert.equal(edits[0].next.port, free);
assert.equal(edits[0].next.host, "127.0.0.1");

// 端口 0 = 系统分配：允许，且不预检。
edits.length = 0;
r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "127.0.0.1", port: 0 }) });
assert.equal(r.res.status, 200);
assert.equal(edits[0].next.port, 0);

// ── 登录后的非回环请求放行 ──────────────────────────────────────────────────

r = await callApi("/api/auth/login", { method: "POST", peer: "192.0.2.9", body: JSON.stringify({ password: "s3cret" }) });
assert.equal(r.res.status, 200);
const cookie = String(r.res.headers["set-cookie"]).split(";")[0];

const free2 = await freePort();
edits.length = 0;
r = await callApi("/api/dsh-web-auth/bind", {
  method: "POST",
  peer: "192.0.2.9",
  headers: { cookie },
  body: JSON.stringify({ host: "0.0.0.0", port: free2 })
});
assert.equal(r.res.status, 200);
assert.equal(edits.length, 1);
assert.equal(edits[0].next.host, "0.0.0.0");
assert.equal(edits[0].next.port, free2);

// ── 宿主侧不可用 / 写入失败 ─────────────────────────────────────────────────

editorAvailable = false;
r = await callApi("/api/dsh-web-auth/bind");
assert.equal(r.body.editable, false);
assert.match(r.body.reason, /configEditor/);
r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "127.0.0.1", port: 3080 }) });
assert.equal(r.res.status, 503);
editorAvailable = true;

editError = new Error('Configuration for "webserver" is overridden by a home patch or command-line overlay');
r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "127.0.0.1", port: 3080 }) });
assert.equal(r.res.status, 500);
assert.match(r.body.error, /home patch/);
editError = null;

console.log("dsh-web-auth route checks: OK");
