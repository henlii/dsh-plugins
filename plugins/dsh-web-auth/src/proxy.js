// dsh-web-mobile proxy half — 手机入口用的小型反向代理。
//
// 为什么需要它：dsh 的浏览器栅栏把一切都绑在页面的 authority 上。手机经局域网
// 地址打开时不是回环，壳把页面当成远程查看器：设置镜像退化成 memory scope，
// 部分面板直接不肯开。桌面壳的解法是把自己的请求代理进回环 authority；这个
// 代理为手机浏览器做同一件事——监听一个局域网/tailnet 地址，把 Host / Origin /
// Referer 改成上游认的回环 authority，HTTP 与 WebSocket upgrade 都转发。认证
// 是这里自己签发的密码 cookie，上游永远看不到匿名请求。
//
// 上游地址用 web server 的真实绑定地址（可能是局域网 IP，不是 127.0.0.1）；
// 改写后的 Host 固定为回环，让栅栏与浏览器会话 cookie 认同一个 authority。
//
// 实现是独立写的：同类插件（dsh-pocket，GPL-2.0）提供了思路参考，但没有复制
// 它的代码。

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname } from "node:path";

const AUTH_COOKIE = "dsh_mobile_auth";
const AUTH_PATH = "/__mobile/auth";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const MAX_FORM_BYTES = 4096;

// 逐跳头不跨代理转发；upgrade 请求要保留 connection/upgrade，单独处理。
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// 非安全上下文（http://<LAN-IP>:3081）里浏览器缺两个 API，缺了 dsh 客户端会直接
// 抛错：crypto.randomUUID（连接层 mint RPC id）与 AbortSignal.any（发送消息）。
// 只在缺失时补，不覆盖原生实现。
const POLYFILL = `<script data-dshm-proxy-polyfill>!function(){try{var c=self.crypto;if(c&&typeof c.randomUUID!=="function"){c.randomUUID=function(){var b=new Uint8Array(16);c.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var s="";for(var i=0;i<16;i++){s+=(b[i]+256).toString(16).slice(1);}return s.slice(0,8)+"-"+s.slice(8,12)+"-"+s.slice(12,16)+"-"+s.slice(16,20)+"-"+s.slice(20);};}}catch(e){}try{if(self.AbortSignal&&typeof self.AbortSignal.any!=="function"){self.AbortSignal.any=function(list){var c=new AbortController();var a=Array.prototype.slice.call(list||[]);for(var i=0;i<a.length;i++){(function(sig){if(sig.aborted){c.abort(sig.reason);return;}sig.addEventListener("abort",function(){c.abort(sig.reason);},{once:true});})(a[i]);if(c.signal.aborted)break;}return c.signal;};}}catch(e){}}();</script>`;

// 客户端把「设置能不能写」绑在页面是不是回环上（transport.ownsHost 或
// isLoopbackHostname(location.hostname)）。手机页面 hostname 永远不是回环，
// 于是设置镜像退化成 memory。请求能走到这里说明已经过了本代理的密码，给页面
// 补上 ownsHost 即可；宿主自己给了 transport 就改写它，没给就补最小对象
// （客户端只用这个字段的 isLoopback 一个消费者）。
const OWN_HOST_SHIM = `<script data-dshm-proxy-owns-host>!function(){try{var K="__DSH_TRANSPORT__",g=self;function fix(t){if(!t||typeof t!=="object")return t;try{if(typeof t.createApiClient!=="function"){t.createApiClient=function(){return null;};}}catch(e){}try{if(t.ownsHost!==true){t.ownsHost=true;}}catch(e){}return t;}var cur=fix(g[K]===undefined?{ownsHost:true}:g[K]);try{Object.defineProperty(g,K,{configurable:true,enumerable:true,get:function(){return cur;},set:function(t){cur=fix(t);}});}catch(e){}}catch(e){}}();</script>`;

function readSecret(file) {
  try {
    const value = readFileSync(file);
    if (value.length >= 32) return value;
  } catch {
    /* 首次运行或文件损坏：重新生成 */
  }
  const secret = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function tokenFor(password, secret) {
  return createHash("sha256").update(password).update("\0").update(secret).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return "";
}

function hasDshAuthCookie(header) {
  return /(?:^|;\s*)dsh-auth-/.test(String(header ?? ""));
}

function readBody(req, limit = MAX_FORM_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function loginPage(next, failed) {
  const action = next === "" ? AUTH_PATH : `${AUTH_PATH}?next=${encodeURIComponent(next)}`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>dsh 手机访问</title>
<style>html,body{margin:0;height:100%;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#111418;color:#e8eaed}body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}form{width:100%;max-width:22rem}h1{font-size:1.1rem;margin:0 0 1rem}p{color:#9aa0a6;font-size:.85rem;margin:0 0 1rem}input{width:100%;box-sizing:border-box;padding:.75rem;border-radius:.5rem;border:1px solid #3c4043;background:#1a1d21;color:inherit;font-size:1rem}button{margin-top:.75rem;width:100%;padding:.75rem;border:0;border-radius:.5rem;background:#2f6feb;color:#fff;font-size:1rem}button:active{background:#2558c4}.err{color:#f28b82}</style></head>
<body><form method="post" action="${action}"><h1>dsh 手机访问</h1>${failed ? '<p class="err">密码不对，再试一次。</p>' : "<p>输入这台电脑上设置的访问密码。</p>"}<input type="password" name="password" autocomplete="current-password" autofocus required minlength="1"><button type="submit">进入</button></form></body></html>`;
}

function parseNext(raw) {
  if (typeof raw !== "string" || raw === "") return "";
  try {
    const url = new URL(raw, "http://placeholder");
    return url.origin === "http://placeholder" ? `${url.pathname}${url.search}` : "";
  } catch {
    return "";
  }
}

/**
 * @param {object} options
 * @param {string} options.listenHost 监听地址（LAN / tailnet / 0.0.0.0）。
 * @param {number} options.port 监听端口。
 * @param {{host: string, port: number}} options.upstream web server 的真实绑定地址。
 * @param {string} options.password 访问密码。
 * @param {string} options.secretFile cookie 签名密钥文件。
 * @param {() => string} [options.launchToken] 上游浏览器会话启动 token。
 * @param {(html: string) => string} [options.inject] 额外的 HTML 注入（在 polyfill 之后）。
 * @param {(message: string) => void} [options.log]
 */
export function createMobileProxy(options) {
  const {
    listenHost = "0.0.0.0",
    port = 3081,
    upstream,
    password,
    secretFile,
    launchToken = () => "",
    inject = (html) => html,
    log = (message) => console.log(`dsh-mobile-proxy: ${message}`)
  } = options;
  if (!upstream) throw new Error("dsh-web-mobile: upstream is required");
  // password 允许传函数：密码文件改完立即生效，旧 cookie 自动失效。
  const passwordNow = () => (typeof password === "function" ? password() : password);
  if (typeof passwordNow() !== "string" || passwordNow() === "") throw new Error("dsh-web-mobile: password is required");

  const secret = readSecret(secretFile);
  const expectedNow = () => tokenFor(String(passwordNow()), secret);
  // port 可能在上游 listen 之后才确定（插件先于监听启动代理），每次取实时值。
  const authority = () => `127.0.0.1:${String(upstream.port)}`;

  const authorized = (req) => safeEqual(cookieValue(req.headers.cookie, AUTH_COOKIE), expectedNow());

  const forwardHeaders = (req, keepUpgrade = false) => {
    const headers = { ...req.headers };
    for (const name of HOP_BY_HOP) {
      if (keepUpgrade && (name === "connection" || name === "upgrade")) continue;
      delete headers[name];
    }
    const origin = authority();
    headers.host = origin;
    headers.origin = `http://${origin}`;
    if (typeof headers.referer === "string") headers.referer = `http://${origin}/`;
    headers["sec-fetch-site"] = "same-origin";
    return headers;
  };

  // 桌面壳（Electron）的宿主要求非渲染器请求带上这两个标记才放行：没有它们，
  // decideDesktopBrowserAccess 会把它当成渲染器请求，而浏览器没有渲染器 token，
  // 直接拒成 401 / "reopen the URL printed by dsh web"。web profile 会忽略它们。
  // 前提仍是桌面端打开了「浏览器访问」（dsh-desktop.openBrowser）。
  const withDesktopCompat = (url) => {
    if (url.includes("dsh-desktop-mode=")) return url;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}dsh-desktop-mode=compatibility&dsh-desktop-platform=${encodeURIComponent(process.platform)}`;
  };

  const wantsHtml = (req) => req.method === "GET" && /text\/html/i.test(String(req.headers.accept ?? ""));

  const htmlInject = (html) => {
    let out = html;
    if (!out.includes("data-dshm-proxy-polyfill") && out.includes("<head>")) {
      out = out.replace("<head>", `<head>${POLYFILL}${OWN_HOST_SHIM}`);
    }
    return inject(out);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const pathname = url.pathname;

    if (pathname === AUTH_PATH) {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(loginPage(parseNext(url.searchParams.get("next")), url.searchParams.get("failed") === "1"));
        return;
      }
      if (req.method === "POST") {
        let body = "";
        try {
          body = await readBody(req);
        } catch {
          res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
          res.end("payload too large");
          return;
        }
        const submitted = new URLSearchParams(body).get("password") ?? "";
        if (!safeEqual(submitted, String(passwordNow()))) {
          const next = parseNext(url.searchParams.get("next"));
          res.writeHead(303, { location: `${AUTH_PATH}?failed=1${next === "" ? "" : `&next=${encodeURIComponent(next)}`}` });
          res.end();
          return;
        }
        const next = parseNext(url.searchParams.get("next")) || "/";
        res.writeHead(303, {
          "set-cookie": `${AUTH_COOKIE}=${expectedNow()}; Max-Age=${String(COOKIE_MAX_AGE)}; Path=/; HttpOnly; SameSite=Lax`,
          location: next,
          "cache-control": "no-store"
        });
        res.end();
        return;
      }
      res.writeHead(405, { allow: "GET, POST" });
      res.end();
      return;
    }

    if (!authorized(req)) {
      if (req.method === "GET" || req.method === "HEAD") {
        const next = `${pathname}${url.search}`;
        res.writeHead(303, { location: `${AUTH_PATH}?next=${encodeURIComponent(next)}`, "cache-control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "dsh-web-mobile: authentication required" }));
      return;
    }

    // 直接转发原始路径：客户端组合请求是 `/plugins/??pkg/client.js&rev=...`，
    // 用 URL 重建会把双问号压成一个，宿主按组合语法解析失败 → 404。
    let target = req.url ?? "/";
    if (req.method === "GET" && pathname === "/" && !hasDshAuthCookie(req.headers.cookie)) {
      const token = launchToken();
      if (token !== "") target = `/?token=${encodeURIComponent(token)}`;
    }

    target = withDesktopCompat(target);
    const wantsHtmlResponse = wantsHtml(req);
    const headers = forwardHeaders(req);
    if (wantsHtmlResponse) delete headers["accept-encoding"];

    const upstreamReq = httpRequest(
      { host: upstream.host, port: upstream.port, method: req.method, path: target, headers },
      (upstreamRes) => {
        const type = String(upstreamRes.headers["content-type"] ?? "");
        if (wantsHtmlResponse && type.includes("text/html")) {
          const chunks = [];
          upstreamRes.on("data", (chunk) => chunks.push(chunk));
          upstreamRes.on("end", () => {
            let html = Buffer.concat(chunks).toString("utf8");
            html = htmlInject(html);
            const body = Buffer.from(html, "utf8");
            const out = { ...upstreamRes.headers };
            delete out["content-encoding"];
            delete out["content-length"];
            delete out["transfer-encoding"];
            out["content-length"] = String(body.length);
            res.writeHead(upstreamRes.statusCode ?? 502, out);
            res.end(body);
          });
          return;
        }
        const out = { ...upstreamRes.headers };
        // 逐跳头交给 Node 重新决定，原样转发会与 pipe 的 chunked 编码冲突。
        delete out["transfer-encoding"];
        res.writeHead(upstreamRes.statusCode ?? 502, out);
        upstreamRes.pipe(res);
      }
    );
    upstreamReq.on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`dsh-web-mobile: upstream unreachable (${error.message})`);
      }
    });
    req.pipe(upstreamReq);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!authorized(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    const upstreamReq = httpRequest({
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      path: req.url ?? "/",
      headers: forwardHeaders(req, true)
    });
    upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${String(upstreamRes.statusCode ?? 101)} ${upstreamRes.statusMessage ?? "Switching Protocols"}`];
      for (let index = 0; index < upstreamRes.rawHeaders.length; index += 2) {
        lines.push(`${upstreamRes.rawHeaders[index]}: ${upstreamRes.rawHeaders[index + 1]}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead !== undefined && upstreamHead.length > 0) socket.write(upstreamHead);
      if (head !== undefined && head.length > 0) upstreamSocket.write(head);
      upstreamSocket.on("error", () => socket.destroy());
      socket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstreamReq.on("error", () => {
      socket.write("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
      socket.destroy();
    });
    upstreamReq.end();
  });

  return {
    get authority() {
      return authority();
    },
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(port, listenHost, () => {
          server.removeListener("error", onError);
          const address = server.address();
          log(`listening on ${listenHost}:${typeof address === "object" && address !== null ? address.port : String(port)} → ${upstream.host}:${String(upstream.port)}`);
          resolve(address);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  };
}
