// dsh-web-mobile 手机代理的路由级检查（不依赖 dsh 宿主）。
// 起一个模拟 dsh BrowserAuth 的 stub 上游，验证代理内部换取并缓存上游 dsh-auth-*
// cookie、自动注入 HTTP/WS 请求、剥离上游 Set-Cookie、密钥轮换刷新、并发去重、
// 端口切换失效、异常断连防崩溃及无密码 503。

import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMobileProxy } from "../src/proxy.js";

function firstCookie(headerValue, name) {
  for (const part of String(headerValue ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

function sendRawUpgrade(port, path, headers = {}, earlyPayload = "") {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1");
    let settled = false;
    let buf = Buffer.alloc(0);
    let headerEnd = -1;
    let pingSent = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    };

    socket.setTimeout(3000, () => finish(reject, new Error("raw upgrade timeout")));
    socket.on("error", (err) => finish(reject, err));
    socket.on("connect", () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
      ];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n${earlyPayload}`);
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (headerEnd === -1) {
        headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const headText = buf.subarray(0, headerEnd).toString("utf8");
        const statusLine = headText.split("\r\n")[0];
        if (!statusLine.startsWith("HTTP/1.1 101")) {
          finish(resolve, { headText, echo: "" });
          return;
        }
        if (earlyPayload === "" && !pingSent) {
          pingSent = true;
          socket.write("ping");
        }
      }
      if (headerEnd !== -1) {
        const bodyText = buf.subarray(headerEnd + 4).toString("utf8");
        const expected = earlyPayload !== "" ? `echo:${earlyPayload}` : "echo:ping";
        if (bodyText.includes(expected)) {
          finish(resolve, { headText: buf.subarray(0, headerEnd).toString("utf8"), echo: bodyText });
        }
      }
    });
    socket.on("end", () => {
      if (!settled) {
        const headText = headerEnd === -1 ? buf.toString("utf8") : buf.subarray(0, headerEnd).toString("utf8");
        const echo = headerEnd === -1 ? "" : buf.subarray(headerEnd + 4).toString("utf8");
        finish(resolve, { headText, echo });
      }
    });
  });
}

let currentVal = "val-1";
let exchangeCount = 0;
let exchangeDelayMs = 0;
let suppressMintCookie = false;
const seen = [];
const wsSeen = [];

const upstream = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/" && url.searchParams.get("token") === "tok-123") {
    exchangeCount += 1;
    if (exchangeDelayMs > 0) await new Promise((r) => setTimeout(r, exchangeDelayMs));
    if (suppressMintCookie) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("exchange refused");
      return;
    }
    res.writeHead(303, {
      location: "./",
      "set-cookie": `dsh-auth-mock=${currentVal}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
    });
    res.end();
    return;
  }

  const presented = firstCookie(req.headers.cookie, "dsh-auth-mock");
  if (presented !== currentVal) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    res.end("dsh web authentication required");
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  seen.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });

  if (req.url.startsWith("/plain")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.url.startsWith("/api/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "set-cookie": ["dsh-auth-mock=leaked-from-200; Path=/; HttpOnly", "app_pref=1; Path=/"],
  });
  res.end("<!doctype html><html><head></head><body>x</body></html>");
});

upstream.on("upgrade", (req, socket, head) => {
  wsSeen.push({ url: req.url, headers: req.headers });
  const presented = firstCookie(req.headers.cookie, "dsh-auth-mock");
  if (presented !== currentVal) {
    socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n", () => socket.destroy());
    return;
  }
  if (req.url?.startsWith("/deny-ws")) {
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n", () => socket.destroy());
    return;
  }
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Accept: fake-accept",
      "Set-Cookie: dsh-auth-mock=ws-should-strip; Path=/; HttpOnly",
      "Set-Cookie: ws_pref=1; Path=/",
      "",
      "",
    ].join("\r\n")
  );
  if (head.length > 0) socket.write(Buffer.concat([Buffer.from("echo:"), head]));
  socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
  socket.on("end", () => socket.end());
  socket.on("error", () => socket.destroy());
});

await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;

const secretDir = mkdtempSync(join(tmpdir(), "dshm-proxy-"));
try {
  const askedHosts = [];
  const mutableUpstream = { host: "127.0.0.1", port: upstreamPort };
  const proxy = createMobileProxy({
    listenHost: "127.0.0.1",
    port: 0,
    upstream: mutableUpstream,
    password: "s3cret",
    secretFile: join(secretDir, "secret"),
    launchToken: () => "tok-123",
    requestRejection: (request) => {
      askedHosts.push(request.headers.host);
      return firstCookie(request.headers.cookie, "dsh-auth-mock") === currentVal ? void 0 : 401;
    },
  });
  const address = await proxy.listen();
  const base = `http://127.0.0.1:${address.port}`;

  // 1. 未认证 GET / → 303 到登录页，不触发上游换取。
  seen.length = 0;
  let res = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(res.status, 303);
  assert.match(String(res.headers.get("location")), /^\/__mobile\/auth\?next=/);
  assert.equal(seen.length, 0, "未认证请求不应到上游");
  assert.equal(exchangeCount, 0, "未认证请求不应触发 token 换取");

  // 2. 未认证 API 请求 → 401 JSON。
  res = await fetch(`${base}/api/session/list`, { method: "POST", redirect: "manual" });
  assert.equal(res.status, 401);

  // 3. 错密码 → failed=1；正确密码 → 种 SameSite=Lax 的 dsh_mobile_auth。
  res = await fetch(`${base}/__mobile/auth`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=wrong",
  });
  assert.equal(res.status, 303);
  assert.match(String(res.headers.get("location")), /failed=1/);

  res = await fetch(`${base}/__mobile/auth`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=s3cret",
  });
  assert.equal(res.status, 303);
  const setCookie = String(res.headers.get("set-cookie"));
  assert.match(setCookie, /^dsh_mobile_auth=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = setCookie.split(";")[0];

  // 4. 首次已认证 GET /（仅带 dsh_mobile_auth，模拟不存上游 cookie 的 iOS）：
  //    直接返回 200，不出现 303、不下发 dsh-auth-*，保留非 dsh-auth-* Cookie。
  seen.length = 0;
  res = await fetch(`${base}/`, { redirect: "manual", headers: { cookie, accept: "text/html" } });
  assert.equal(res.status, 200, "首次已认证 GET / 应直接 200，不得透传 303");
  assert.equal(exchangeCount, 1);
  const clientSetCookies = res.headers.getSetCookie();
  assert.ok(!clientSetCookies.some((c) => c.startsWith("dsh-auth-")), "不得向浏览器下发上游 dsh-auth-* cookie");
  assert.ok(clientSetCookies.some((c) => c.startsWith("app_pref=1")), "无关 cookie 应保留透传");
  const first = seen[0];
  assert.equal(first.headers.host, `127.0.0.1:${upstreamPort}`, "Host 应改写为上游回环 authority");
  assert.equal(first.headers.origin, `http://127.0.0.1:${upstreamPort}`);
  assert.equal(first.headers["sec-fetch-site"], "same-origin");
  assert.match(first.url, /^\/\?dsh-desktop-mode=compatibility&dsh-desktop-platform=[a-z0-9]+$/);
  assert.equal(firstCookie(first.headers.cookie, "dsh-auth-mock"), "val-1");
  const html = await res.text();
  assert.match(html, /data-dshm-proxy-polyfill/);
  assert.match(html, /data-dshm-proxy-owns-host/);
  assert.equal(html.match(/data-dshm-proxy-polyfill/g).length, 1);

  // 5. 二次 GET /（仍不带任何 dsh-auth-*）：命中缓存直接 200，不再换取。
  seen.length = 0;
  askedHosts.length = 0;
  res = await fetch(`${base}/`, { redirect: "manual", headers: { cookie, accept: "text/html" } });
  assert.equal(res.status, 200);
  assert.equal(exchangeCount, 1, "缓存有效时不得重复换取");
  assert.equal(askedHosts[0], `127.0.0.1:${upstreamPort}`, "栅栏判定应收到上游回环 Host");

  // 6. 浏览器携带残留的过期 dsh-auth-mock=STALE 与其他 cookie：剥离旧值并保留其他 cookie。
  seen.length = 0;
  res = await fetch(`${base}/`, {
    redirect: "manual",
    headers: { cookie: `${cookie}; dsh-auth-mock=STALE; keep=yes`, accept: "text/html" },
  });
  assert.equal(res.status, 200);
  assert.ok(!String(seen[0].headers.cookie).includes("STALE"), "旧 dsh-auth-* cookie 必须剥离");
  assert.equal(firstCookie(seen[0].headers.cookie, "keep"), "yes");
  assert.equal(firstCookie(seen[0].headers.cookie, "dsh-auth-mock"), "val-1");

  // 7. 组合请求双问号原样转发，不加桌面兼容参数。
  seen.length = 0;
  res = await fetch(`${base}/plugins/??@x/client.js&rev=1`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, "/plugins/??@x/client.js&rev=1");

  // 8. WebSocket 热路径（缓存有效时零换取）与非 101（403）返回。
  const hotWsBefore = exchangeCount;
  const hotWs = await sendRawUpgrade(address.port, "/api/remote.mux", { Cookie: cookie });
  assert.match(hotWs.headText, /^HTTP\/1\.1 101 Switching Protocols/m);
  assert.equal(hotWs.echo, "echo:ping");
  assert.equal(exchangeCount, hotWsBefore, "WS 热路径不应再次换取 token");

  const deniedWs = await sendRawUpgrade(address.port, "/deny-ws", { Cookie: cookie });
  assert.match(deniedWs.headText, /^HTTP\/1\.1 403 Forbidden/);

  // 9. 上游密钥轮换（requestRejection 返回 401）：自动刷新换取并直接 200。
  currentVal = "val-2";
  seen.length = 0;
  res = await fetch(`${base}/`, { redirect: "manual", headers: { cookie, accept: "text/html" } });
  assert.equal(res.status, 200);
  assert.equal(exchangeCount, 2, "requestRejection 返回 401 后应重新换取");
  assert.equal(firstCookie(seen[0].headers.cookie, "dsh-auth-mock"), "val-2");

  // 10. 上游端口切换触发 upstreamCookieAuthority 失效并重新换取。
  const upstream2 = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/" && url.searchParams.get("token") === "tok-123") {
      exchangeCount += 1;
      res.writeHead(303, {
        location: "./",
        "set-cookie": `dsh-auth-mock=${currentVal}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
      });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`port2:${req.headers.host}`);
  });
  await new Promise((resolve) => upstream2.listen(0, "127.0.0.1", resolve));
  const upstream2Port = upstream2.address().port;
  mutableUpstream.port = upstream2Port;
  const beforePortSwitch = exchangeCount;
  res = await fetch(`${base}/plain`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), `port2:127.0.0.1:${upstream2Port}`);
  assert.equal(exchangeCount, beforePortSwitch + 1, "上游端口变更后必须失效旧缓存并重换");
  mutableUpstream.port = upstreamPort;
  upstream2.closeAllConnections?.();
  await new Promise((resolve) => upstream2.close(resolve));
  await proxy.close();

  // 11. 无 requestRejection 回调的代理：上游轮换回 401 时 GET 重试一次成功；换取失败时只重试一次回 401 不死循环。
  const noPredicateProxy = createMobileProxy({
    listenHost: "127.0.0.1",
    port: 0,
    upstream: { host: "127.0.0.1", port: upstreamPort },
    password: "s3cret",
    secretFile: join(secretDir, "secret-nopred"),
    launchToken: () => "tok-123",
  });
  const noPredAddr = await noPredicateProxy.listen();
  const noPredBase = `http://127.0.0.1:${noPredAddr.port}`;
  const npLogin = await fetch(`${noPredBase}/__mobile/auth`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=s3cret",
  });
  const npCookie = String(npLogin.headers.get("set-cookie")).split(";")[0];
  res = await fetch(`${noPredBase}/plain`, { headers: { cookie: npCookie } });
  assert.equal(res.status, 200);
  const beforeRotateExchanges = exchangeCount;
  currentVal = "val-3";
  res = await fetch(`${noPredBase}/plain`, { headers: { cookie: npCookie } });
  assert.equal(res.status, 200, "无 requestRejection 时 GET 遇 401 应自动重换并重试成功");
  assert.equal(exchangeCount, beforeRotateExchanges + 1);

  currentVal = "val-4";
  suppressMintCookie = true;
  const beforeFailExchanges = exchangeCount;
  res = await fetch(`${noPredBase}/plain`, { headers: { cookie: npCookie } });
  assert.equal(res.status, 401, "换取失败时 GET 应有限中止并返回 401，不能无限重试");
  assert.equal(exchangeCount, beforeFailExchanges + 1);
  suppressMintCookie = false;
  await noPredicateProxy.close();

  // 12. 冷启动 5 路并发 GET /plain 只触发 1 次换取。
  const coldProxy = createMobileProxy({
    listenHost: "127.0.0.1",
    port: 0,
    upstream: { host: "127.0.0.1", port: upstreamPort },
    password: "s3cret",
    secretFile: join(secretDir, "secret-cold"),
    launchToken: () => "tok-123",
    requestRejection: (request) =>
      firstCookie(request.headers.cookie, "dsh-auth-mock") === currentVal ? void 0 : 401,
  });
  const coldAddr = await coldProxy.listen();
  const coldBase = `http://127.0.0.1:${coldAddr.port}`;
  const coldLogin = await fetch(`${coldBase}/__mobile/auth`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=s3cret",
  });
  const coldCookie = String(coldLogin.headers.get("set-cookie")).split(";")[0];
  const beforeBurst = exchangeCount;
  exchangeDelayMs = 30;
  const burstResults = await Promise.all(
    Array.from({ length: 5 }, () => fetch(`${coldBase}/plain`, { headers: { cookie: coldCookie } }))
  );
  exchangeDelayMs = 0;
  for (const r of burstResults) assert.equal(r.status, 200);
  assert.equal(exchangeCount, beforeBurst + 1, "冷启动并发请求必须共享同一次 token 换取");
  await coldProxy.close();

  // 13. 冷启动 WebSocket upgrade（含 pause 窗口内紧跟的首批帧数据）：自动换取并回显，剥离 dsh-auth-* Set-Cookie。
  const wsProxy = createMobileProxy({
    listenHost: "127.0.0.1",
    port: 0,
    upstream: { host: "127.0.0.1", port: upstreamPort },
    password: "s3cret",
    secretFile: join(secretDir, "secret-ws"),
    launchToken: () => "tok-123",
    requestRejection: (request) =>
      firstCookie(request.headers.cookie, "dsh-auth-mock") === currentVal ? void 0 : 401,
  });
  const wsAddr = await wsProxy.listen();
  const wsBase = `http://127.0.0.1:${wsAddr.port}`;
  const wsLogin = await fetch(`${wsBase}/__mobile/auth`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=s3cret",
  });
  const wsCookie = String(wsLogin.headers.get("set-cookie")).split(";")[0];
  const beforeWsExchanges = exchangeCount;
  wsSeen.length = 0;
  exchangeDelayMs = 25;
  const wsRes = await sendRawUpgrade(wsAddr.port, "/api/remote.mux", { Cookie: wsCookie }, "early-frame");
  exchangeDelayMs = 0;
  assert.match(wsRes.headText, /^HTTP\/1\.1 101 Switching Protocols/m);
  assert.ok(!wsRes.headText.includes("dsh-auth-mock="), "WS 响应不得透传 dsh-auth-*");
  assert.ok(wsRes.headText.includes("ws_pref=1"), "WS 响应应保留其他 Set-Cookie");
  assert.equal(wsRes.echo, "echo:early-frame");
  assert.equal(exchangeCount, beforeWsExchanges + 1);
  assert.equal(firstCookie(wsSeen[0].headers.cookie, "dsh-auth-mock"), currentVal);
  await wsProxy.close();

  // 14. 换取延迟下冷启动大请求体 POST：完整透传请求体。
  const coldPostProxy = createMobileProxy({
    listenHost: "127.0.0.1",
    port: 0,
    upstream: { host: "127.0.0.1", port: upstreamPort },
    password: "s3cret",
    secretFile: join(secretDir, "secret-coldpost"),
    launchToken: () => "tok-123",
  });
  const cpAddr = await coldPostProxy.listen();
  const cpBase = `http://127.0.0.1:${cpAddr.port}`;
  const cpLogin = await fetch(`${cpBase}/__mobile/auth`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=s3cret",
  });
  const cpCookie = String(cpLogin.headers.get("set-cookie")).split(";")[0];
  seen.length = 0;
  const bigPayload = JSON.stringify({ pad: "x".repeat(64 * 1024) });
  exchangeDelayMs = 25;
  const cpRes = await fetch(`${cpBase}/api/test`, {
    method: "POST",
    headers: { cookie: cpCookie, "content-type": "application/json" },
    body: bigPayload,
  });
  exchangeDelayMs = 0;
  assert.equal(cpRes.status, 200);
  assert.equal(seen[0].body, bigPayload);
  await coldPostProxy.close();

  // 15. 上游不可达时的 WS 502 兜底。
  const deadProxy = createMobileProxy({
    listenHost: "127.0.0.1",
    port: 0,
    upstream: { host: "127.0.0.1", port: 1 },
    password: "s3cret",
    secretFile: join(secretDir, "secret-dead"),
    launchToken: () => "",
  });
  const deadAddr = await deadProxy.listen();
  const deadLogin = await fetch(`http://127.0.0.1:${deadAddr.port}/__mobile/auth`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=s3cret",
  });
  const deadCookie = String(deadLogin.headers.get("set-cookie")).split(";")[0];
  const deadWs = await sendRawUpgrade(deadAddr.port, "/api/remote.mux", { Cookie: deadCookie });
  assert.match(deadWs.headText, /^HTTP\/1\.1 502 Bad Gateway/);
  await deadProxy.close();

  // 16. 未配置密码：返回 503 且拒绝登录与 WS，保存密码后立即生效。
  let livePassword = "";
  const unset = createMobileProxy({
    listenHost: "127.0.0.1",
    port: 0,
    upstream: { host: "127.0.0.1", port: upstreamPort },
    password: () => livePassword,
    secretFile: join(secretDir, "secret-unset"),
  });
  const unsetAddress = await unset.listen();
  const unsetBase = `http://127.0.0.1:${unsetAddress.port}`;

  seen.length = 0;
  let unsetRes = await fetch(`${unsetBase}/`, { redirect: "manual", headers: { accept: "text/html" } });
  assert.equal(unsetRes.status, 503);
  assert.match(await unsetRes.text(), /未配置访问密码/);
  assert.equal(seen.length, 0, "没有密码时请求不应到上游");

  unsetRes = await fetch(`${unsetBase}/__mobile/auth`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=",
  });
  assert.equal(unsetRes.status, 503);
  assert.equal(unsetRes.headers.get("set-cookie"), null, "空密码不得签发 cookie");

  const unsetWs = await sendRawUpgrade(unsetAddress.port, "/api/remote.mux");
  assert.match(unsetWs.headText, /^HTTP\/1\.1 503 /);

  livePassword = "s3cret";
  unsetRes = await fetch(`${unsetBase}/__mobile/auth`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=s3cret",
  });
  assert.equal(unsetRes.status, 303);
  assert.match(String(unsetRes.headers.get("set-cookie")), /^dsh_mobile_auth=/);
  await unset.close();

  upstream.closeAllConnections?.();
  await new Promise((resolve) => upstream.close(resolve));
  console.log("dsh-web-mobile proxy checks: OK");
} finally {
  rmSync(secretDir, { recursive: true, force: true });
}
