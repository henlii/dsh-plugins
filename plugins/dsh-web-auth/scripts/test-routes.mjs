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
    // 回显权威字段：用来断言官方 RPC 通道保持真实 authority（不被回环改写）。
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", host: req.headers.host, peer: req.socket.remoteAddress }));
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
// 模拟 dsh 0.2.1-rc.2 起的 webserver host schema：只接受具体 IP 字面量，拒绝通配。
// 面板的候选列表按这个 schema 过滤，避免写出一个服务起不来的 host（实测事故就是
// patch 里残留 `host: 0.0.0.0` 让 required 插件 webserver 直接激活失败）。
webServer.constructor = {
  Config(value) {
    if (value.host === "0.0.0.0" || value.host === "::") {
      throw new Error(`webserver: host ${JSON.stringify(value.host)} is an unspecified (wildcard) address`);
    }
    return value;
  }
};
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
// 官方的 connection 行：绑定地址同步写入它的 trustedHosts。
const connectionEntry = {
  options: {
    id: "connection",
    name: "@deepseek-ai/dsh-client-connection",
    config: { trustedHosts: ["100.99.31.9"], recovery: { generationReadyWarnMs: 10000 } }
  }
};
const edits = [];
let editorAvailable = true;
let editError = null;
const configEditor = {
  documentPath: join(testHome, "profiles", "web", "cordis.patch.yml"),
  entries: () => [webserverEntry, connectionEntry],
  async edit(entry, change) {
    if (editError !== null) throw editError;
    edits.push({ id: entry.options.id, next: change(entry.options.config, {}) });
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

plugin.apply(ctx, { password: "s3cret", mobile: { enabled: false } });
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
assert.equal(r.body.ok, true);
assert.equal(r.body.host, "127.0.0.1");
assert.equal(r.body.port, 3080);
assert.equal(r.body.editable, true);
assert.equal(r.body.reason, null);
assert.equal(r.body.patchPath, configEditor.documentPath);
// 候选地址 = 本机网卡 + 回环，逐个过 host schema；通配不在其中。
assert.ok(Array.isArray(r.body.hosts), "GET 应给出候选绑定地址");
assert.ok(r.body.hosts.includes("127.0.0.1"), "回环应在候选里");
assert.ok(!r.body.hosts.includes("0.0.0.0"), "schema 拒绝的通配地址不应出现在候选里");
const lanHost = r.body.hosts.find((value) => value !== "127.0.0.1" && value !== "::1");
assert.ok(typeof lanHost === "string" && lanHost.length > 0, "本机应至少有一个非回环地址");

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

// host schema 现在就拒的值必须在写盘之前挡住（否则服务整个起不来）。
r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "0.0.0.0", port: 3080 }) });
assert.equal(r.res.status, 400);

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

// 只改绑定地址：同步 connection.trustedHosts；端口那一行的 !!js 表达式必须原样保留
// （写死等于废掉 --port）。
edits.length = 0;
r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: lanHost, port: 3080 }) });
assert.equal(r.res.status, 200);
assert.equal(edits.length, 2, "绑定地址变化时先写 connection.trustedHosts，再写 webserver");
const connectionEdit = edits.find((item) => item.id === "connection");
assert.ok(connectionEdit.next.trustedHosts.includes(lanHost), "新绑定地址应写入 trustedHosts");
assert.ok(!connectionEdit.next.trustedHosts.includes("127.0.0.1"), "旧地址不应残留");
const webserverEdit = edits.find((item) => item.id === "webserver");
assert.equal(webserverEdit.next.host, lanHost);
assert.deepEqual(webserverEdit.next.port, RAW_PORT);
assert.equal(webserverEdit.next.compression, "gzip", "未改动的键要原样带回");
assert.equal(r.body.trustedHosts.applied, true);

// 改端口：绑定地址不动，不碰 trustedHosts。
const free = await freePort();
edits.length = 0;
r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "127.0.0.1", port: free }) });
assert.equal(r.res.status, 200);
assert.equal(edits.length, 1);
assert.equal(edits[0].id, "webserver");
assert.equal(edits[0].next.port, free);
assert.equal(edits[0].next.host, "127.0.0.1");

// 端口 0 = 系统分配：允许，且不预检。
edits.length = 0;
r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "127.0.0.1", port: 0 }) });
assert.equal(r.res.status, 200);
assert.equal(edits[0].id, "webserver");
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
  body: JSON.stringify({ host: lanHost, port: free2 })
});
assert.equal(r.res.status, 200);
assert.equal(edits.length, 2);
const authedWebserver = edits.find((item) => item.id === "webserver");
const authedConnection = edits.find((item) => item.id === "connection");
assert.equal(authedWebserver.next.host, lanHost);
assert.equal(authedWebserver.next.port, free2);
assert.ok(authedConnection.next.trustedHosts.includes(lanHost));

// ── 旧版 dsh：host schema 放行通配时通配仍应可选 ─────────────────────────────

webServer.constructor = { Config: (value) => value };
r = await callApi("/api/dsh-web-auth/bind");
assert.ok(r.body.hosts.includes("0.0.0.0"), "schema 放行时通配应留在候选里");
edits.length = 0;
r = await callApi("/api/dsh-web-auth/bind", { method: "POST", body: JSON.stringify({ host: "0.0.0.0", port: 3080 }) });
assert.equal(r.res.status, 200);
assert.equal(edits.length, 1, "通配绑定推导不出 authority，不写 trustedHosts");
assert.equal(edits[0].id, "webserver");
assert.equal(edits[0].next.host, "0.0.0.0");
assert.equal(r.body.trustedHosts.reason, "wildcard bind has no reachable authority");
delete webServer.constructor;

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

// ── 自围栏路由回环外观；依赖宿主 fence 的路由保持真实 authority ─────────────
// 看板/技能中心在自己的路由上围栏「回环 socket + 回环 Host」，不查宿主 cookie，
// 改写 Host 安全。dsh-update 这类调 connection.requestRejection 的路由必须保留
// 真实 Host：宿主 cookie 名与签名负载都绑定真实 authority，改写后必然 401。

const seen = [];
function captureRoute(path) {
  webServer.register({
    kind: "exact",
    path,
    handler: async (req, res) => {
      seen.push({
        path,
        host: req.headers.host,
        peer: req.socket.remoteAddress,
        site: req.headers["sec-fetch-site"],
        origin: req.headers.origin
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }
  });
}
captureRoute("/api/task-board/state");
captureRoute("/api/dsh-update/status");

// 未登录的远程请求仍在密码门之后，到不了插件路由。
seen.length = 0;
r = await callApi("/api/task-board/state", { peer: "192.0.2.9" });
assert.equal(r.res.status, 401);
assert.equal(seen.length, 0, "未认证请求不应到达插件路由");

// 内置清单命中（看板）：插件看到回环 socket、回环 Host 与同源标记。
seen.length = 0;
r = await callApi("/api/task-board/state", { peer: "192.0.2.9", headers: { cookie } });
assert.equal(r.res.status, 200);
assert.equal(seen.length, 1);
assert.equal(seen[0].host, "127.0.0.1:3080", "自围栏路由应看到回环 Host");
assert.equal(seen[0].peer, "127.0.0.1", "socket peer 应被影子为回环");
assert.equal(seen[0].site, "same-origin");
assert.equal(seen[0].origin, "http://127.0.0.1:3080");

// 未列入清单、依赖宿主 authority cookie 的路由（dsh-update）：真实 Host / peer。
seen.length = 0;
r = await callApi("/api/dsh-update/status", {
  peer: "192.0.2.9",
  headers: { cookie, host: "192.0.2.9:3080" }
});
assert.equal(r.res.status, 200);
assert.equal(seen[0].host, "192.0.2.9:3080", "依赖宿主 fence 的路由不能被改写为回环 Host");
assert.equal(seen[0].peer, "192.0.2.9", "依赖宿主 fence 的路由应看到真实 peer");

// 官方 /api 前缀（RPC 通道）：保持真实 Host 与 peer，不被重写。
r = await callApi("/api/unknown-rpc-endpoint", {
  peer: "192.0.2.9",
  headers: { cookie, host: "192.0.2.9:3080" }
});
assert.equal(r.res.status, 404);
assert.equal(r.body.host, "192.0.2.9:3080", "官方 /api 前缀不应被改写为回环 Host");
assert.equal(r.body.peer, "192.0.2.9", "官方 /api 前缀应看到真实 peer");

// 回环直连本就免密免改写。
seen.length = 0;
r = await callApi("/api/task-board/state", { peer: "127.0.0.1", headers: { host: "127.0.0.1:3080" } });
assert.equal(r.res.status, 200);
assert.equal(seen[0].host, "127.0.0.1:3080");
assert.equal(seen[0].peer, "127.0.0.1");

console.log("dsh-web-auth route checks: OK");
