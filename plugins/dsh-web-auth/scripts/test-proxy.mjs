// dsh-web-mobile 手机代理的路由级检查（不依赖 dsh 宿主）。
// 起一个 stub 上游记录收到的头，再起代理，验证认证、头改写、launch token 注入
// 与 HTML 注入四条契约。

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMobileProxy } from "../src/proxy.js";

const seen = [];
const upstream = createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  if (req.url.startsWith("/plain")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><html><head></head><body>x</body></html>");
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;

const secretDir = mkdtempSync(join(tmpdir(), "dshm-proxy-"));
const proxy = createMobileProxy({
  listenHost: "127.0.0.1",
  port: 0,
  upstream: { host: "127.0.0.1", port: upstreamPort },
  password: "s3cret",
  secretFile: join(secretDir, "secret"),
  launchToken: () => "tok-123"
});
const address = await proxy.listen();
const base = `http://127.0.0.1:${address.port}`;

// 未认证的页面请求 → 跳登录页，且不会打到上游。
seen.length = 0;
let res = await fetch(`${base}/`, { redirect: "manual" });
assert.equal(res.status, 303);
assert.match(String(res.headers.get("location")), /^\/__mobile\/auth\?next=/);
assert.equal(seen.length, 0, "未认证请求不应到上游");

// 未认证的 API 请求 → 401 JSON。
res = await fetch(`${base}/api/session/list`, { method: "POST", redirect: "manual" });
assert.equal(res.status, 401);

// 错密码 → 回登录页并标记失败。
res = await fetch(`${base}/__mobile/auth`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: "password=wrong"
});
assert.equal(res.status, 303);
assert.match(String(res.headers.get("location")), /failed=1/);

// 正确密码 → 种 cookie 并跳回。
res = await fetch(`${base}/__mobile/auth`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: "password=s3cret"
});
assert.equal(res.status, 303);
const setCookie = String(res.headers.get("set-cookie"));
assert.match(setCookie, /^dsh_mobile_auth=/);
assert.match(setCookie, /HttpOnly/);
const cookie = setCookie.split(";")[0];

// 已认证的首页：改写 Host/Origin/sec-fetch-site，并注入上游 launch token。
seen.length = 0;
res = await fetch(`${base}/`, { headers: { cookie, accept: "text/html" } });
assert.equal(res.status, 200);
const first = seen[0];
assert.equal(first.headers.host, `127.0.0.1:${upstreamPort}`, "Host 应改写为上游回环 authority");
assert.equal(first.headers.origin, `http://127.0.0.1:${upstreamPort}`);
assert.equal(first.headers["sec-fetch-site"], "same-origin");
assert.match(first.url, /^\/\?token=tok-123&dsh-desktop-mode=compatibility&dsh-desktop-platform=[a-z0-9]+$/, "首次 GET / 应带上游启动 token 与桌面兼容标记");

// 浏览器已持有宿主 cookie：不再注入 token。
seen.length = 0;
res = await fetch(`${base}/`, { headers: { cookie: `${cookie}; dsh-auth-abc=1`, accept: "text/html" } });
assert.equal(res.status, 200);
assert.ok(seen[0].url.startsWith("/?dsh-desktop-mode=compatibility"), "已有 dsh-auth cookie 时不再注入 token，但仍补桌面兼容标记");

// HTML 注入两个垫片，且只注入一次。
const html = await res.text();
assert.match(html, /data-dshm-proxy-polyfill/);
assert.match(html, /data-dshm-proxy-owns-host/);
assert.equal(html.match(/data-dshm-proxy-polyfill/g).length, 1);

// 客户端组合请求的双问号必须原样转发（`/plugins/??pkg/client.js&rev=…`）；
// 用 URL 重建会把它们压成一个，宿主 404、整页客户端模块加载失败。
seen.length = 0;
res = await fetch(`${base}/plugins/??@x/client.js&rev=1`, { headers: { cookie: `${cookie}; dsh-auth-probe=1` } });
assert.equal(res.status, 200);
assert.ok(seen[0].url.startsWith("/plugins/??@x/client.js&rev=1&dsh-desktop-mode=compatibility"), "组合请求的双问号与顺序必须保留");

// 非 HTML 响应原样透传。
seen.length = 0;
res = await fetch(`${base}/plain`, { headers: { cookie } });
assert.equal(res.status, 200);
assert.equal(await res.text(), "ok");
assert.equal(seen[0].headers.host, `127.0.0.1:${upstreamPort}`);

await proxy.close();
// fetch 的 keep-alive 连接会让 close 一直等回调，先断开再关。
upstream.closeAllConnections?.();
await new Promise((resolve) => upstream.close(resolve));
console.log("dsh-web-mobile proxy checks: OK");
