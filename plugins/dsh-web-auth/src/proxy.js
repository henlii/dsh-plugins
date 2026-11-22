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
// 手机浏览器只持有本代理签发的密码 cookie（SameSite=Lax）；上游 127.0.0.1 的启动
// token 换 cookie（dsh-auth-*，SameSite=Strict）由本代理在服务端内部完成并缓存，
// 转发 HTTP 与 WebSocket 时自动注入，避免 iOS/WebKit 在 303 重定向链丢 cookie 死循环。
//
// 实现是独立写的：同类插件（dsh-pocket，GPL-2.0）提供了思路参考，但没有复制
// 它的代码。

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname } from "node:path";

const AUTH_COOKIE = "dsh_mobile_auth";
const AUTH_PATH = "/__mobile/auth";
const UPSTREAM_COOKIE_PREFIX = "dsh-auth-";
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

function extractUpstreamAuthCookie(setCookieHeader) {
  const list = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : typeof setCookieHeader === "string"
      ? [setCookieHeader]
      : [];
  for (const item of list) {
    const pair = String(item ?? "").split(";")[0].trim();
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (name.startsWith(UPSTREAM_COOKIE_PREFIX) && value !== "") {
      return `${name}=${value}`;
    }
  }
  return "";
}

// 剥离浏览器残留的旧 dsh-auth-*（dsh 只读取首个同名 cookie），再追加代理托管的值。
function mergeUpstreamCookie(rawCookie, upstreamCookie) {
  const existing = String(rawCookie ?? "");
  if (upstreamCookie === "") return existing;
  const kept = [];
  for (const part of existing.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const at = trimmed.indexOf("=");
    const name = (at === -1 ? trimmed : trimmed.slice(0, at)).trim();
    if (name.startsWith(UPSTREAM_COOKIE_PREFIX)) continue;
    kept.push(trimmed);
  }
  kept.push(upstreamCookie);
  return kept.join("; ");
}

function isUpstreamAuthSetCookie(entry) {
  return /^\s*dsh-auth-/.test(String(entry ?? ""));
}

function stripUpstreamAuthSetCookie(headers) {
  const raw = headers["set-cookie"];
  if (raw === undefined) return;
  const list = Array.isArray(raw) ? raw : [raw];
  const kept = list.filter((item) => !isUpstreamAuthSetCookie(item));
  if (kept.length === 0) {
    delete headers["set-cookie"];
  } else {
    headers["set-cookie"] = Array.isArray(raw) ? kept : kept[0];
  }
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

// 未配置密码时手机入口不提供登录，只说明原因：构造期不抛错（那会让整个插件半边
// 挂载失败，连本机回环都进不去设置页），改成每个请求回 503。
function noPasswordPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dsh 手机访问</title>
<style>html,body{margin:0;height:100%;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#111418;color:#e8eaed}body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}main{width:100%;max-width:24rem}h1{font-size:1.1rem;margin:0 0 1rem}p{color:#9aa0a6;font-size:.85rem;margin:0 0 .75rem}code{background:#1a1d21;padding:.1rem .3rem;border-radius:.25rem}</style></head>
<body><main><h1>服务端未配置访问密码</h1><p>这台电脑上的 dsh-web-auth 还没有设置访问密码，手机入口暂时不可用。</p><p>在服务机本机打开 <code>http://127.0.0.1</code> 的设置 → 访问认证里设置密码；或在 profile 里给 <code>web-auth</code> 配 <code>password</code> / <code>passwordFile</code>。设置后本页立即生效，无需重启。</p></main></body></html>`;
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
 * @param {(request: object) => number | undefined} [options.requestRejection]
 *   上游栅栏判定：传请求（头已按转发改写），回 401 表示需要启动 token。
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
    requestRejection,
    inject = (html) => html,
    log = (message) => console.log(`dsh-mobile-proxy: ${message}`)
  } = options;
  if (!upstream) throw new Error("dsh-web-mobile: upstream is required");
  // password 允许传函数：密码文件改完立即生效，旧 cookie 自动失效。
  const passwordNow = () => (typeof password === "function" ? password() : password);
  // 空密码不构成可用的凭据：构造期不抛错（见 noPasswordPage），运行期一律 503。
  // 密码在面板里保存后 passwordNow() 立刻非空，手机入口随之可用，不需要重启。
  // 非字符串（配置写错成对象等）按未配置处理，不要 String() 成 "[object Object]"。
  const configuredNow = () => {
    const current = passwordNow();
    return typeof current === "string" && current.length > 0;
  };

  const secret = readSecret(secretFile);
  const expectedNow = () => tokenFor(String(passwordNow()), secret);
  // port 可能在上游 listen 之后才确定（插件先于监听启动代理），每次取实时值。
  const authority = () => `127.0.0.1:${String(upstream.port)}`;

  let upstreamCookie = "";
  let upstreamCookieAuthority = "";
  let cookieEpoch = 0;
  let mintInFlight = null;
  let mintInFlightAuthority = "";
  const upgradedSockets = new Set();

  const authorized = (req) => safeEqual(cookieValue(req.headers.cookie, AUTH_COOKIE), expectedNow());

  const forwardHeaders = (req, keepUpgrade = false, managedCookie = "") => {
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
    if (managedCookie !== "") {
      headers.cookie = mergeUpstreamCookie(headers.cookie, managedCookie);
    }
    return headers;
  };

  // 桌面壳（Electron）的宿主要求非渲染器请求带上这两个标记才放行：没有它们，
  // decideDesktopBrowserAccess 会把它当成渲染器请求，而浏览器没有渲染器 token，
  // 直接拒成 401 / "reopen the URL printed by dsh web"。web profile 会忽略它们。
  //
  // `/plugins/??a&b` 是打包器的组合请求语法，`&` 分隔的每一项都是模块名；
  // 追加这两个参数会被当成模块名去解析，宿主回 404，整个客户端模块系统加载失败
  // （页面报 `HTML did not preload .../client.js`）。所以组合请求一律不加。
  const isBundleRequest = (pathname) => pathname === "/plugins" || pathname.startsWith("/plugins/");

  const withDesktopCompat = (url) => {
    if (url.includes("dsh-desktop-mode=")) return url;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}dsh-desktop-mode=compatibility&dsh-desktop-platform=${encodeURIComponent(process.platform)}`;
  };

  // 仅清除与失败值相同的缓存，避免延迟到达的 401 抹掉另一路已刷新的有效 cookie。
  const invalidateUpstreamCookie = (failedCookie) => {
    if (failedCookie !== "" && upstreamCookie === failedCookie) {
      upstreamCookie = "";
      upstreamCookieAuthority = "";
    }
  };

  // 用宿主自己的栅栏谓词离线核验缓存的上游 cookie 是否仍有效（30 天过期、密钥轮换或端口变化）。
  const hasValidUpstreamCookie = () => {
    const currentAuthority = authority();
    if (upstreamCookie === "" || upstreamCookieAuthority !== currentAuthority) return false;
    if (typeof requestRejection !== "function") return true;
    try {
      const rejection = requestRejection({
        method: "GET",
        url: "/",
        headers: {
          host: currentAuthority,
          origin: `http://${currentAuthority}`,
          "sec-fetch-site": "same-origin",
          cookie: upstreamCookie,
        },
      });
      return rejection !== 401;
    } catch {
      return true;
    }
  };

  // 代理在后端向 127.0.0.1 上游用启动 token 换取 dsh-auth-*，不把 303 + SameSite=Strict
  // 透传给手机浏览器，彻底避开 iOS/WebKit 的重定向丢 cookie 死循环。
  const mintUpstreamCookie = (targetAuthority, epoch) => {
    let token = "";
    try {
      token = launchToken();
    } catch (error) {
      log(`upstream launch token failed: ${error instanceof Error ? error.message : String(error)}`);
      return Promise.resolve("");
    }
    if (typeof token !== "string" || token === "") return Promise.resolve("");
    const path = withDesktopCompat(`/?token=${encodeURIComponent(token)}`);
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let exchangeReq;
      try {
        exchangeReq = httpRequest(
          {
            host: upstream.host,
            port: upstream.port,
            method: "GET",
            path,
            headers: {
              host: targetAuthority,
              origin: `http://${targetAuthority}`,
              "sec-fetch-site": "same-origin",
              accept: "text/html",
            },
          },
          (exchangeRes) => {
            exchangeReq.setTimeout(0);
            const minted = extractUpstreamAuthCookie(exchangeRes.headers["set-cookie"]);
            exchangeRes.on("error", () => {});
            exchangeRes.resume();
            if (minted !== "" && epoch === cookieEpoch && targetAuthority === authority()) {
              upstreamCookie = minted;
              upstreamCookieAuthority = targetAuthority;
            }
            done(minted);
          }
        );
      } catch (error) {
        log(`upstream cookie exchange failed: ${error instanceof Error ? error.message : String(error)}`);
        done("");
        return;
      }
      exchangeReq.setTimeout(5000, () => {
        exchangeReq.destroy(new Error("launch-token exchange timed out"));
      });
      exchangeReq.on("error", (error) => {
        if (!settled) log(`upstream cookie exchange failed: ${error.message}`);
        done("");
      });
      exchangeReq.end();
    });
  };

  const ensureUpstreamCookie = (forceRefresh = false) => {
    if (forceRefresh) {
      cookieEpoch += 1;
      upstreamCookie = "";
      upstreamCookieAuthority = "";
      mintInFlight = null;
      mintInFlightAuthority = "";
    } else if (hasValidUpstreamCookie()) {
      return Promise.resolve(upstreamCookie);
    } else {
      upstreamCookie = "";
      upstreamCookieAuthority = "";
    }
    const targetAuthority = authority();
    if (mintInFlight === null || mintInFlightAuthority !== targetAuthority) {
      const epoch = cookieEpoch;
      const inFlight = mintUpstreamCookie(targetAuthority, epoch).finally(() => {
        if (mintInFlight === inFlight) {
          mintInFlight = null;
          mintInFlightAuthority = "";
        }
      });
      mintInFlight = inFlight;
      mintInFlightAuthority = targetAuthority;
    }
    return mintInFlight;
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
    let activeUpstreamReq = null;
    let clientAborted = false;
    req.on("error", () => {
      clientAborted = true;
      activeUpstreamReq?.destroy();
      if (!res.destroyed) res.destroy();
    });
    res.on("close", () => {
      if (!res.writableFinished) {
        clientAborted = true;
        activeUpstreamReq?.destroy();
      }
    });

    try {
      let url;
      try {
        url = new URL(req.url ?? "/", "http://placeholder");
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("bad request");
        return;
      }
      const pathname = url.pathname;

      // 没有密码就没有可验证的凭据：连登录页也不给，避免空密码被当成"密码对了"。
      if (!configuredNow()) {
        res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(noPasswordPage());
        return;
      }

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
            if (!res.writableEnded && !res.destroyed) {
              res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
              res.end("payload too large");
            }
            return;
          }
          // 读 body 期间密码可能被清空（密码文件被删）：入口那次判定已经过去，这里
          // 取一次快照，空密码不允许登录，也不按空密码签发 cookie。
          const current = passwordNow();
          if (typeof current !== "string" || current.length === 0) {
            res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            res.end(noPasswordPage());
            return;
          }
          const submitted = new URLSearchParams(body).get("password") ?? "";
          if (!safeEqual(submitted, current)) {
            const next = parseNext(url.searchParams.get("next"));
            res.writeHead(303, { location: `${AUTH_PATH}?failed=1${next === "" ? "" : `&next=${encodeURIComponent(next)}`}` });
            res.end();
            return;
          }
          const next = parseNext(url.searchParams.get("next")) || "/";
          res.writeHead(303, {
            "set-cookie": `${AUTH_COOKIE}=${tokenFor(current, secret)}; Max-Age=${String(COOKIE_MAX_AGE)}; Path=/; HttpOnly; SameSite=Lax`,
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
      if (!isBundleRequest(pathname)) target = withDesktopCompat(target);
      const wantsHtmlResponse = wantsHtml(req);
      const canRetryMethod = req.method === "GET" || req.method === "HEAD";

      const forwardHttp = (managedCookie, canRetry) => {
        if (clientAborted || res.writableEnded || res.destroyed) return;
        const headers = forwardHeaders(req, false, managedCookie);
        if (wantsHtmlResponse) delete headers["accept-encoding"];

        let upstreamReq;
        try {
          upstreamReq = httpRequest(
            { host: upstream.host, port: upstream.port, method: req.method, path: target, headers },
            (upstreamRes) => {
              if (upstreamRes.statusCode === 401) {
                let tokenAvailable = false;
                try {
                  tokenAvailable = launchToken() !== "";
                } catch {
                  tokenAvailable = false;
                }
                if (canRetry && tokenAvailable) {
                  upstreamRes.on("error", () => {});
                  upstreamRes.resume();
                  void ensureUpstreamCookie(true).then(
                    (refreshed) => {
                      if (clientAborted || res.writableEnded || res.destroyed) return;
                      if (refreshed !== "") {
                        forwardHttp(refreshed, false);
                      } else {
                        invalidateUpstreamCookie(managedCookie);
                        forwardHttp("", false);
                      }
                    },
                    () => {
                      if (!clientAborted && !res.headersSent && !res.writableEnded && !res.destroyed) {
                        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
                        res.end("dsh-web-mobile: upstream cookie refresh failed");
                      }
                    }
                  );
                  return;
                }
                invalidateUpstreamCookie(managedCookie);
              }

              const type = String(upstreamRes.headers["content-type"] ?? "");
              if (wantsHtmlResponse && type.includes("text/html")) {
                const chunks = [];
                upstreamRes.on("data", (chunk) => chunks.push(chunk));
                upstreamRes.on("error", () => {
                  if (!res.headersSent && !res.writableEnded && !res.destroyed) {
                    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
                    res.end("dsh-web-mobile: upstream response error");
                  } else {
                    res.destroy();
                  }
                });
                upstreamRes.on("end", () => {
                  if (clientAborted || res.writableEnded || res.destroyed) return;
                  let html = Buffer.concat(chunks).toString("utf8");
                  html = htmlInject(html);
                  const body = Buffer.from(html, "utf8");
                  const out = { ...upstreamRes.headers };
                  stripUpstreamAuthSetCookie(out);
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
              stripUpstreamAuthSetCookie(out);
              // 逐跳头交给 Node 重新决定，原样转发会与 pipe 的 chunked 编码冲突。
              delete out["transfer-encoding"];
              res.writeHead(upstreamRes.statusCode ?? 502, out);
              upstreamRes.on("error", () => res.destroy());
              upstreamRes.pipe(res);
            }
          );
        } catch (error) {
          if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
            res.end(`dsh-web-mobile: upstream unreachable (${error instanceof Error ? error.message : String(error)})`);
          }
          return;
        }
        activeUpstreamReq = upstreamReq;
        upstreamReq.on("error", (error) => {
          if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
            res.end(`dsh-web-mobile: upstream unreachable (${error.message})`);
          }
        });
        if (canRetryMethod) {
          req.resume();
          upstreamReq.end();
        } else {
          req.pipe(upstreamReq);
        }
      };

      const managedCookie = await ensureUpstreamCookie();
      if (clientAborted || req.destroyed || res.writableEnded || res.destroyed) return;
      forwardHttp(managedCookie, canRetryMethod);
    } catch (error) {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`dsh-web-mobile: proxy error (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const closeUpgradeSocket = (responseText) => {
      if (socket.destroyed || socket.writableEnded) return;
      socket.end(responseText, () => socket.destroy());
    };
    socket.on("error", () => socket.destroy());

    if (!configuredNow()) {
      closeUpgradeSocket("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    if (!authorized(req)) {
      closeUpgradeSocket("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
      return;
    }

    upgradedSockets.add(socket);
    let activeUpstreamReq = null;
    let upstreamSocketRef = null;
    let upgraded = false;
    socket.once("close", () => {
      upgradedSockets.delete(socket);
      upstreamSocketRef?.destroy();
      if (!upgraded) activeUpstreamReq?.destroy();
    });

    const openUpstream = (managedCookie) => {
      if (socket.destroyed) return;
      let upstreamReq;
      try {
        upstreamReq = httpRequest({
          host: upstream.host,
          port: upstream.port,
          method: req.method,
          path: req.url ?? "/",
          headers: forwardHeaders(req, true, managedCookie)
        });
      } catch {
        closeUpgradeSocket("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      activeUpstreamReq = upstreamReq;
      upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
        activeUpstreamReq = null;
        if (socket.destroyed) {
          upstreamSocket.destroy();
          return;
        }
        upgraded = true;
        upstreamSocketRef = upstreamSocket;
        const lines = [`HTTP/1.1 ${String(upstreamRes.statusCode ?? 101)} ${upstreamRes.statusMessage ?? "Switching Protocols"}`];
        for (let index = 0; index < upstreamRes.rawHeaders.length; index += 2) {
          const headerName = upstreamRes.rawHeaders[index];
          const headerValue = upstreamRes.rawHeaders[index + 1];
          if (headerName.toLowerCase() === "set-cookie" && isUpstreamAuthSetCookie(headerValue)) {
            continue;
          }
          lines.push(`${headerName}: ${headerValue}`);
        }
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (upstreamHead !== undefined && upstreamHead.length > 0) socket.write(upstreamHead);
        if (head !== undefined && head.length > 0) upstreamSocket.write(head);
        upstreamSocket.on("error", () => socket.destroy());
        upstreamSocket.on("close", (hadError) => {
          if (hadError || socket.writableFinished) {
            socket.destroy();
            return;
          }
          socket.once("finish", () => socket.destroy());
          if (!socket.writableEnded) socket.end();
        });
        upstreamSocket.pipe(socket).pipe(upstreamSocket);
        socket.resume();
      });
      upstreamReq.on("response", (upstreamRes) => {
        activeUpstreamReq = null;
        if (upstreamRes.statusCode === 401) {
          invalidateUpstreamCookie(managedCookie);
        }
        upstreamRes.on("error", () => {});
        upstreamRes.resume();
        const statusCode = upstreamRes.statusCode ?? 502;
        const statusMessage = upstreamRes.statusMessage || "Bad Gateway";
        closeUpgradeSocket(`HTTP/1.1 ${String(statusCode)} ${statusMessage}\r\ncontent-length: 0\r\n\r\n`);
      });
      upstreamReq.on("error", () => {
        activeUpstreamReq = null;
        closeUpgradeSocket("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
      });
      upstreamReq.end();
    };

    if (hasValidUpstreamCookie()) {
      openUpstream(upstreamCookie);
      return;
    }
    socket.pause();
    void ensureUpstreamCookie().then(
      openUpstream,
      () => closeUpgradeSocket("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n")
    );
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
        for (const socket of upgradedSockets) socket.destroy();
      });
    }
  };
}
