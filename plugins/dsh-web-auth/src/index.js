// dsh-web-auth host half — password gate + loopback trust rewrite.
//
// Why this exists: dsh web binds a reachable interface address (Route B) so LAN/
// Tailscale devices reach /api directly, but dsh pins the privileged configuration plane
// (settings/credentials/agentPreset/llm.discoverModels/... — PRIVILEGED_METHODS
// in dsh-client-connection) to loopback Host. This plugin wraps the webserver
// /api route and every WebSocket upgrade: non-loopback peers must present a
// password-issued HttpOnly cookie; once authorized the request's Host/Origin/
// Referer are rewritten to loopback so the original handlers (fence + privileged
// checks) pass. Loopback peers are exempt. The fence is not replaced, only
// preceded by a real authentication layer, exactly what the official comment
// on PRIVILEGED_METHODS asks for ("until a real authentication layer exists").
//
// Configuration:
//   password       — static password (the profile patch binds it to the
//                    DSH_WEB_AUTH_PASSWORD env var). If unset, the plugin reads
//                    `passwordFile` on every login attempt, so editing that
//                    file changes the password live without a restart.
//   passwordFile   — optional live-editable password file; WINS over `password`
//                    when present and non-empty. Default: <dsh-config>/web-auth.password
//   tokenTtlHours  — session token lifetime (default 12).
//   tokenFile      — issued-token persistence so cookies survive service
//                    restarts. Default: <dsh-config>/web-auth-tokens.json
//   <dsh-config>   — DSH_HOME if set, else %APPDATA%/dsh on Windows, else
//                    ~/.config/dsh (XDG).
//
// Panel control: the client half renders the web server's bind address and port
// under the password card (and in a Plugins tab inside Settings). Both go
// through the official `configEditor` service, which persists the webserver
// row's next config into the current profile's patch and reconciles it through
// the Loader — host/port are composition-time facts with no runtime rebind API.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { createMobileProxy } from "./proxy.js";

const name = "dsh-web-auth";
const inject = ["webServer", "timer"];
const SETTINGS_DOCUMENT_ROUTE = "/api/dsh-web-auth/settings-document";
const COOKIE_NAME = "dsh_web_auth";
const AUTH_PREFIX = "/api/auth/";
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// 跨平台默认配置目录：dsh 官方约定 DSH_HOME（默认 ~/.dsh），否则按平台惯例：
// Windows → %APPDATA%/dsh，macOS/Linux → ~/.config/dsh（XDG）。
function defaultConfigDir() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME;
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "dsh");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "dsh");
}

const DEFAULT_TOKEN_FILE = join(defaultConfigDir(), "web-auth-tokens.json");
const DEFAULT_PASSWORD_FILE = join(defaultConfigDir(), "web-auth.password");

// 手机入口的首次绘制注入：viewport meta（safe-area 生效）+ 窄屏兜底（避免先画
// 52px 侧栏轨道再回流）。这些与移动端布局客户端半边配套，从 dsh-web-mobile 迁入。
const MOBILE_HEAD = [
  '<meta data-dshm-head name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />',
  '<meta name="mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  "<style data-dshm-critical>",
  "@media (max-width:1023.98px){",
  '[class$="frame"]{grid-template-columns:0px minmax(0px,1fr) minmax(0px,0px)!important}',
  "}",
  "</style>",
].join("");

function injectMobileHead(html) {
  if (html.includes("data-dshm-head")) return html;
  let out = html.replace(/<meta[^>]+name=["']viewport["'][^>]*>/i, "");
  out = out.includes("<head>") ? out.replace("<head>", `<head>${MOBILE_HEAD}`) : `${MOBILE_HEAD}${out}`;
  return out;
}

// Login throttle. The password is a deployment secret with enough entropy that
// guessing is impractical over a network, but an unthrottled endpoint still
// lets a weak or reused password fall to a dictionary in seconds. Track
// failures per peer address in a sliding window, lock the peer at the
// threshold, and keep a coarser global lock so spoofed/distributed sources
// cannot sidestep the per-peer one.
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_LOCK_MS = 60 * 1000;
const LOGIN_GLOBAL_MAX_FAILURES = 30;
const LOGIN_GLOBAL_LOCK_MS = 5 * 60 * 1000;

// Browser-side UUID polyfill: `crypto.randomUUID` only exists in secure
// contexts, and a page served over plain HTTP on a LAN/Tailscale IP is not
// one. dsh's client code calls crypto.randomUUID() for message/RPC ids and
// the settings provider directory (dsh-client-ui-settings-models) fails
// loudly without it. The polyfill no-ops where the real API exists, so it is
// safe to inject into every served index.html. `getRandomValues` is available
// in insecure contexts, which is all the RFC-4122 v4 fallback needs.
const UUID_POLYFILL = `<script data-dsh-uuid-polyfill>(function(){var c=globalThis.crypto;if(!c||typeof c.randomUUID==="function")return;if(typeof c.getRandomValues!=="function")return;Object.defineProperty(c,"randomUUID",{configurable:true,writable:true,value:function randomUUID(){var b=new Uint8Array(16);c.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h=Array.from(b,function(x){return x.toString(16).padStart(2,"0")}).join("");return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20);}});})();</script>`;

function injectUuidPolyfill(html) {
  if (html.includes("data-dsh-uuid-polyfill")) return html;
  if (html.includes("<head>")) return html.replace("<head>", `<head>${UUID_POLYFILL}`);
  const tagged = html.replace(/<head(\s[^>]*)>/i, `<head$1>${UUID_POLYFILL}`);
  return tagged === html ? UUID_POLYFILL + html : tagged;
}

// Client-side loopback predicate patch for dsh-client-connection's bundle.
//
// The connection's client half sets `connection.isLoopback` from the page
// origin hostname, and the settings UI gates on it: loopback pages use the
// real "host" settings scope while non-loopback pages fall back to an
// ephemeral "memory" scope (so built-in plugin/settings sections do not
// render over LAN). The deployment is password-authenticated, so LAN/Tailscale
// pages should behave like the loopback page. This string-patch adds the
// deployment's own hostnames (derived from `webStartup.trustedHosts` plus the
// optional `lanHosts` config) to the client-side predicate. It only affects
// client-side UI state — server-side auth still keys on the real socket
// peer address, never on this predicate.
const CONNECTION_CLIENT_ID = "@deepseek-ai/dsh-client-connection";
const CONNECTION_NEEDLE = 'if (hostname === "localhost" || hostname === "[::1]") return true;';

/** Escape a hostname for safe interpolation into the patch string. */
function escapeHostnameLiteral(hostname) {
  return String(hostname).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
* Build the patched loopback predicate from an ordered hostname list.
* @param js - the raw connection client bundle.
* @param hostnames - extra non-loopback hostnames to treat as loopback.
* @returns the patched bundle (unchanged when no hostname applies).
*/
function patchConnectionClient(js, hostnames) {
  const extra = [...new Set(hostnames.filter((hostname) => typeof hostname === "string" && hostname.length > 0))];
  if (extra.length === 0) return js;
  const patch = `if (hostname === "localhost" || hostname === "[::1]"${extra.map((hostname) => ` || hostname === "${escapeHostnameLiteral(hostname)}"`).join("")}) return true;`;
  return js.includes(CONNECTION_NEEDLE) ? js.replace(CONNECTION_NEEDLE, patch) : js;
}

/** Strip a trailing :port from a bare authority; IPv6 literals are skipped. */
function hostnameOfAuthority(authority) {
  const value = String(authority);
  if (value.startsWith("[")) return "";
  const colon = value.indexOf(":");
  return (colon === -1 ? value : value.slice(0, colon)).toLowerCase();
}

function peerAddress(req) {
  const addr = req.socket && req.socket.remoteAddress;
  if (typeof addr !== "string") return "";
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

function isLoopbackPeer(req) {
  const addr = req.socket && req.socket.remoteAddress;
  return typeof addr === "string" && LOOPBACK_PEERS.has(addr);
}

function pathnameOf(req) {
  try {
    return new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return "";
  }
}

// Normalize a request for the privileged Host plane without changing its
// authority.
//
// The Host/Origin fence rejects `sec-fetch-site: cross-site` and any Origin
// that disagrees with Host, and the official browser cookie is bound to the
// authority it was minted for. Rewriting Host to loopback would therefore both
// invent a second authority (breaking the cookie the LAN browser actually
// holds) and defeat the fence's own purpose. Keep the browser's real authority
// and only clear the cross-site markers the privileged methods reject.
function normalizePrivilegedRequest(req, _port) {
  if (typeof req.headers.host === "string" && typeof req.headers.origin !== "string") {
    req.headers.origin = `http://${req.headers.host}`;
  }
  if (typeof req.headers.referer === "string" && typeof req.headers.host === "string") {
    req.headers.referer = req.headers.referer.replace(/^https?:\/\/[^/]+/i, `http://${req.headers.host}`);
  }
  req.headers["sec-fetch-site"] = "same-origin";
}

// Present an authenticated non-loopback request as a loopback one, for routes
// that fence themselves on loopback (the built-in self-fenced plugin list plus
// the explicit `trustLoopbackPaths` prefixes). Those plugins check the socket
// address and Host header themselves (or a paired device cookie, which needs a
// pairing plugin this deployment does not run); a LAN browser fails that fence
// even after passing the password gate. Rewriting the Host/Origin headers plus
// the socket's peer address lets those routes run for the same people the
// password already admits — the trust level does not go up: an authenticated LAN
// session can already edit settings and credentials.
//
// NEVER apply this to a route that authenticates through the Host connection
// (`connection.requestRejection`): the browser cookie is bound to the real
// authority (name = sha256(authority), payload repeats it), so rewriting Host
// makes that lookup miss and the route answers 401.
//
// The peer address is shadowed as an own property of THIS request's socket and
// dropped again when the response ends: keep-alive reuses the socket, and a
// later request on it must be judged on its real peer.
function presentAsLoopback(req, res, port) {
  const authority = `127.0.0.1:${port}`;
  const socket = req.socket;
  if (socket !== null && socket !== void 0) {
    const restore = () => {
      try {
        delete socket.remoteAddress;
      } catch {
        /* a non-configurable shadow would be a host change; nothing to undo */
      }
    };
    try {
      Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
      res.once("finish", restore);
      res.once("close", restore);
    } catch {
      /* an address we cannot shadow leaves the plugin's own fence in charge */
    }
  }
  req.headers.host = authority;
  req.headers.origin = `http://${authority}`;
  if (typeof req.headers.referer === "string") {
    req.headers.referer = req.headers.referer.replace(/^https?:\/\/[^/]+/i, `http://${authority}`);
  }
  req.headers["sec-fetch-site"] = "same-origin";
}

function readCookieValue(req, cookieName) {
  const cookie = req.headers.cookie;
  if (typeof cookie !== "string") return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === cookieName) return part.slice(eq + 1).trim();
  }
  return null;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
* Sliding-window login throttle keyed by peer address.
* @returns {{ check: (ip:string)=>{locked:boolean,retryAfter:number}, recordFailure: (ip:string)=>void, clear: (ip:string)=>void }}
*   stateful throttle; `check` reports the current lock for one peer.
*/
function createLoginThrottle() {
  const failures = new Map(); // ip -> { count, windowStart }
  const locks = new Map(); // ip -> lockedUntil
  const global = { count: 0, windowStart: 0, lockedUntil: 0 };
  return {
    check(ip) {
      const now = Date.now();
      if (global.lockedUntil > now) {
        return { locked: true, retryAfter: Math.ceil((global.lockedUntil - now) / 1000) };
      }
      const until = locks.get(ip) ?? 0;
      if (until > now) return { locked: true, retryAfter: Math.ceil((until - now) / 1000) };
      return { locked: false, retryAfter: 0 };
    },
    recordFailure(ip) {
      const now = Date.now();
      let rec = failures.get(ip);
      if (rec === undefined || now - rec.windowStart > LOGIN_WINDOW_MS) {
        rec = { count: 0, windowStart: now };
      }
      rec.count++;
      failures.set(ip, rec);
      if (now - global.windowStart > LOGIN_WINDOW_MS) {
        global.count = 0;
        global.windowStart = now;
      }
      global.count++;
      if (rec.count >= LOGIN_MAX_FAILURES) locks.set(ip, now + LOGIN_LOCK_MS);
      if (global.count >= LOGIN_GLOBAL_MAX_FAILURES) global.lockedUntil = now + LOGIN_GLOBAL_LOCK_MS;
      // Bound memory: drop entries whose window has already expired.
      if (failures.size > 2000) {
        for (const [key, value] of failures) {
          if (now - value.windowStart > LOGIN_WINDOW_MS) failures.delete(key);
        }
      }
    },
    clear(ip) {
      failures.delete(ip);
      locks.delete(ip);
    },
  };
}

function readJsonBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

// 端口可用性预检。改端口时先在目标上试绑一次，成功立即释放，失败把原因带回
// 面板。这样「端口被占用」在写文件之前就以普通 HTTP 错误返回；否则它只会在
// reconcile 里炸掉 webserver fiber，而那一刻旧监听已经被关掉，浏览器什么也
// 收不到（见下面 BIND_ROUTE 的说明）。端口没变时不预检——当前监听本身就占着它。
function probeBind(host, port) {
  return new Promise((resolve) => {
    const probe = createServer();
    const settle = (reason) => {
      probe.removeAllListeners("listening");
      probe.removeAllListeners("error");
      try {
        probe.close(() => resolve(reason));
      } catch {
        resolve(reason);
      }
    };
    probe.once("error", (error) => settle((error && error.code) || "bind failed"));
    probe.once("listening", () => settle(null));
    try {
      probe.listen(port, host);
    } catch (error) {
      settle((error && error.code) || "bind failed");
    }
  });
}

function normalizeTokenRecord(token, value, now) {
  if (typeof value === "number") {
    if (value <= now) return null;
    return {
      id: token.slice(0, 16),
      expiry: value,
      issuedAt: 0,
      lastSeen: 0,
      peer: "",
      userAgent: ""
    };
  }
  if (value === null || typeof value !== "object") return null;
  const expiry = typeof value.expiry === "number" ? value.expiry : 0;
  if (expiry <= now) return null;
  return {
    id: typeof value.id === "string" && value.id.length > 0 ? value.id : token.slice(0, 16),
    expiry,
    issuedAt: typeof value.issuedAt === "number" ? value.issuedAt : 0,
    lastSeen: typeof value.lastSeen === "number" ? value.lastSeen : 0,
    peer: typeof value.peer === "string" ? value.peer : "",
    userAgent: typeof value.userAgent === "string" ? value.userAgent : ""
  };
}

function apply(ctx, config) {
  const webServer = ctx.get("webServer");
  if (webServer === void 0) return;

  const cfg = config !== null && typeof config === "object" ? config : {};
  const envPassword = typeof cfg.password === "string" && cfg.password.length > 0 ? cfg.password : null;
  const passwordFile = typeof cfg.passwordFile === "string" && cfg.passwordFile.length > 0 ? cfg.passwordFile : DEFAULT_PASSWORD_FILE;
  const tokenFile = typeof cfg.tokenFile === "string" && cfg.tokenFile.length > 0 ? cfg.tokenFile : DEFAULT_TOKEN_FILE;
  const ttlMs = (typeof cfg.tokenTtlHours === "number" && cfg.tokenTtlHours > 0 ? cfg.tokenTtlHours : 12) * 3600 * 1000;
  const port = webServer.port || 3080;

  // LAN/Tailscale hostnames the client-side connection should treat as
  // loopback: derived from the deployment's own `webStartup.trustedHosts`
  // (which carries the bind-derived LAN IP literals plus any --trusted-host
  // names), plus optional explicit `lanHosts` config. Loopback names are
  // filtered out (the patch needle already covers them). Resolved lazily at
  // request time: the loader does not mount rows in strict tree order, so
  // webStartup may not be provided yet when this row applies.
  // dsh 0.2.1-rc.2 renamed this service: it used to be `webRuntime`, carrying
  // the same `trustedHosts`. Read whichever the running host provides.
  const resolveLanHostnames = () => {
    const hostnames = new Set();
    const webRuntime = ctx.get("webStartup") ?? ctx.get("webRuntime");
    if (webRuntime !== void 0 && Array.isArray(webRuntime.trustedHosts)) {
      for (const authority of webRuntime.trustedHosts) {
        const hostname = hostnameOfAuthority(authority);
        if (hostname.length > 0 && hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1" && !hostname.startsWith("127.")) {
          hostnames.add(hostname);
        }
      }
    }
    if (Array.isArray(cfg.lanHosts)) {
      for (const hostname of cfg.lanHosts) {
        if (typeof hostname === "string" && hostname.length > 0 && hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
          hostnames.add(hostname.toLowerCase());
        }
      }
    }
    return [...hostnames];
  };

  // Password resolution: the live-editable password file wins over the env
  // bound `password`, and is re-read on every login so edits apply at once.
  const resolvePassword = () => {
    try {
      const raw = readFileSync(passwordFile, "utf8").trim();
      if (raw.length > 0) return { password: raw, source: "passwordFile" };
    } catch {
      /* no file yet — fall through to env */
    }
    if (envPassword !== null) return { password: envPassword, source: "env" };
    return { password: null, source: "none" };
  };

  // Session tokens persisted to disk so cookies survive service restarts.
  // Value is a record { id, expiry, issuedAt, lastSeen, peer, userAgent }.
  // Legacy files stored a bare expiry number; those are migrated on load.
  const tokens = new Map();
  try {
    const raw = readFileSync(tokenFile, "utf8");
    const data = JSON.parse(raw);
    const now = Date.now();
    if (data !== null && typeof data === "object") {
      for (const [token, value] of Object.entries(data)) {
        if (typeof token !== "string") continue;
        const rec = normalizeTokenRecord(token, value, now);
        if (rec !== null) tokens.set(token, rec);
      }
    }
  } catch {
    /* no token file yet */
  }
  const persistTokens = () => {
    try {
      const now = Date.now();
      const obj = {};
      for (const [token, rec] of tokens) {
        if (rec.expiry > now) obj[token] = rec;
      }
      mkdirSync(dirname(tokenFile), { recursive: true });
      writeFileSync(tokenFile, JSON.stringify(obj), { mode: 0o600 });
    } catch {
      /* best-effort persistence */
    }
  };
  const issueToken = (req) => {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    tokens.set(token, {
      id: randomBytes(8).toString("hex"),
      expiry: now + ttlMs,
      issuedAt: now,
      lastSeen: now,
      peer: peerAddress(req),
      userAgent: String(req.headers["user-agent"] || "").slice(0, 160)
    });
    persistTokens();
    return token;
  };
  const tokenRecord = (token) => {
    if (typeof token !== "string" || token.length === 0) return null;
    const rec = tokens.get(token);
    if (rec === void 0) return null;
    if (Date.now() > rec.expiry) {
      tokens.delete(token);
      persistTokens();
      return null;
    }
    rec.lastSeen = Date.now();
    return rec;
  };
  const validToken = (token) => tokenRecord(token) !== null;
  const requireAuthed = (req) => isLoopbackPeer(req) || tokenRecord(readCookieValue(req, COOKIE_NAME)) !== null;

  const sendJson = (res, status, body, extraHeaders) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    });
    res.end(payload);
  };

  const cookieHeader = (token, maxAgeSeconds) => [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ].join("; ");

  const statusBody = () => {
    const src = resolvePassword();
    return {
      ok: true,
      passwordConfigured: src.password !== null,
      passwordSource: src.source,
      ttlHours: ttlMs / 3600000
    };
  };

  const loginThrottle = createLoginThrottle();

  const handleAuth = async (req, res) => {
    const pathname = pathnameOf(req);    if (pathname === "/api/auth/login") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      const src = resolvePassword();
      if (src.password === null) {
        sendJson(res, 503, { error: "web-auth: no password configured (set DSH_WEB_AUTH_PASSWORD or write the password file)" });
        return;
      }
      const peer = peerAddress(req);
      const lock = loginThrottle.check(peer);
      if (lock.locked) {
        sendJson(res, 429, { error: "too many attempts" }, { "retry-after": String(lock.retryAfter) });
        return;
      }
      let body = null;
      try {
        body = await readJsonBody(req);
      } catch {
        /* unparseable body is treated as a wrong password */
      }
      const supplied = body !== null && typeof body === "object" && typeof body.password === "string" ? body.password : "";
      if (!safeEqual(supplied, src.password)) {
        loginThrottle.recordFailure(peer);
        sendJson(res, 401, { error: "invalid password" });
        return;
      }
      loginThrottle.clear(peer);
      const token = issueToken(req);
      sendJson(res, 200, { ok: true }, { "set-cookie": cookieHeader(token, Math.floor(ttlMs / 1000)) });
      return;
    }
    if (pathname === "/api/auth/logout") {
      const cookie = readCookieValue(req, COOKIE_NAME);
      if (cookie !== null) {
        tokens.delete(cookie);
        persistTokens();
      }
      sendJson(res, 200, { ok: true }, {
        "set-cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
      });
      return;
    }
    if (pathname === "/api/auth/sessions" && req.method === "GET") {
      if (!requireAuthed(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const current = tokenRecord(readCookieValue(req, COOKIE_NAME));
      const now = Date.now();
      const sessions = [];
      for (const rec of tokens.values()) {
        if (rec.expiry <= now) continue;
        sessions.push({
          id: rec.id,
          peer: rec.peer,
          userAgent: rec.userAgent,
          issuedAt: rec.issuedAt,
          lastSeen: rec.lastSeen,
          expiry: rec.expiry,
          current: current !== null && rec.id === current.id
        });
      }
      sessions.sort((a, b) => b.lastSeen - a.lastSeen);
      sendJson(res, 200, { ok: true, sessions });
      return;
    }
    if (pathname === "/api/auth/sessions/revoke" && req.method === "POST") {
      if (!requireAuthed(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      let body = null;
      try { body = await readJsonBody(req); } catch { /* empty */ }
      const id = body !== null && typeof body === "object" && typeof body.id === "string" ? body.id : "";
      if (id.length === 0) {
        sendJson(res, 400, { error: "missing id" });
        return;
      }
      let revoked = false;
      for (const [token, rec] of tokens) {
        if (rec.id === id) {
          tokens.delete(token);
          revoked = true;
          break;
        }
      }
      if (revoked) persistTokens();
      sendJson(res, 200, { ok: true, revoked });
      return;
    }
    if (pathname === "/api/auth/password" && req.method === "POST") {
      if (!requireAuthed(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      let body = null;
      try { body = await readJsonBody(req); } catch { /* empty */ }
      const next = body !== null && typeof body === "object" && typeof body.password === "string" ? body.password.trim() : "";
      if (next.length === 0) {
        sendJson(res, 400, { error: "password must not be empty" });
        return;
      }
      try {
        mkdirSync(dirname(passwordFile), { recursive: true });
        writeFileSync(passwordFile, `${next}\n`, { mode: 0o600 });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const keep = readCookieValue(req, COOKIE_NAME);
      for (const token of [...tokens.keys()]) {
        if (token !== keep) tokens.delete(token);
      }
      persistTokens();
      sendJson(res, 200, { ok: true, passwordSource: "passwordFile" });
      return;
    }
    if (pathname === "/api/auth/status") {
      if (isLoopbackPeer(req)) {
        sendJson(res, 200, statusBody());
        return;
      }
      if (resolvePassword().password === null) {
        sendJson(res, 503, { error: "web-auth: no password configured" });
        return;
      }
      if (validToken(readCookieValue(req, COOKIE_NAME))) {
        sendJson(res, 200, statusBody());
        return;
      }
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  };

  // Paths whose routes carry their own loopback-only fence (third-party plugins
  // such as the task board and the skill center). An authenticated LAN peer is
  // presented as loopback on exactly these prefixes.
  //
  // This cannot be a blanket rule for every exact `/api/*` route. A third-party
  // route that authenticates through the Host connection
  // (`connection.requestRejection`) is checked against the browser cookie bound
  // to the REAL authority: the cookie name is `sha256(authority)` and the signed
  // payload repeats that authority. Rewriting Host to loopback makes the cookie
  // lookup miss and the route answers 401 "authentication required" — dsh-update
  // (`/api/dsh-update/*`) is exactly that shape. So the default is a list of
  // known self-fenced plugins (they gate on `isLoopbackRequest` themselves and
  // never ask the Host connection), and `trustLoopbackPaths` extends it per
  // deployment. `builtinLoopbackPaths: false` clears the built-in list.
  const BUILTIN_LOOPBACK_PATHS = ["/api/task-board", "/api/dsh-skill-explorer"];
  const builtinLoopbackPaths = cfg.builtinLoopbackPaths === false ? [] : BUILTIN_LOOPBACK_PATHS;
  const trustLoopbackPaths = [
    ...builtinLoopbackPaths,
    ...(Array.isArray(cfg.trustLoopbackPaths) ? cfg.trustLoopbackPaths : [])
  ]
    .filter((prefix) => typeof prefix === "string" && prefix.startsWith("/"))
    .map((prefix) => (prefix.endsWith("/") ? prefix.slice(0, -1) : prefix))
    .filter((prefix) => prefix.length > 0);

  const isTrustedLoopbackPath = (pathname) =>
    trustLoopbackPaths.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

  const authorizeHttp = async (req, res, next) => {
    const pathname = pathnameOf(req);
    if (pathname.startsWith(AUTH_PREFIX)) {
      await handleAuth(req, res);
      return;
    }
    if (isLoopbackPeer(req)) {
      await next(req, res);
      return;
    }
    if (resolvePassword().password === null) {
      sendJson(res, 503, { error: "web-auth: no password configured" });
      return;
    }
    if (!validToken(readCookieValue(req, COOKIE_NAME))) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (isTrustedLoopbackPath(pathname)) presentAsLoopback(req, res, port);
    else normalizePrivilegedRequest(req, port);
    await next(req, res);
  };

  const authorizeUpgrade = (req, socket, head, next) => {
    if (isLoopbackPeer(req)) {
      next(req, socket, head);
      return;
    }
    if (resolvePassword().password === null) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (!validToken(readCookieValue(req, COOKIE_NAME))) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    normalizePrivilegedRequest(req, port);
    next(req, socket, head);
  };

  const isApiRoute = (route) => {
    const path = route && route.path;
    if (path === "/api" || (typeof path === "string" && path.startsWith("/api/"))) return true;
    // Third-party plugins sometimes register sensitive JSON routes outside
    // /api. `extraProtectedPaths` lets the deployment pull those behind the
    // same password gate.
    return Array.isArray(cfg.extraProtectedPaths) && cfg.extraProtectedPaths.includes(path);
  };

  // Patch register/registerUpgrade so every /api route and upgrade registered
  // from now on is wrapped too (upgrades are registered deferred by connection
  // after apiProxy resolves, so they are NOT present at our apply time).
  const origRegister = webServer.register.bind(webServer);
  const origRegisterUpgrade = webServer.registerUpgrade.bind(webServer);
  const origRegisterFallback = webServer.registerFallback.bind(webServer);
  const httpWrapped = [];
  const upgradeWrapped = [];

  // The browser-session launch token (dsh >= 0.1.2-alpha.1): the shell requires
  // one `?token=` exchange on the root path before it serves index.html at all,
  // and mints an authority-bound cookie from it. LAN browsers arrive without
  // that token, so the index request is rewritten to carry it once. The token
  // rotates every process start, so it is read live from the connection
  // service (older hosts without that method return empty and nothing changes).
  let warnedNoToken = false;
  const launchToken = () => {
    try {
      const connection = ctx.get("connection");
      const fn = connection?.authenticatedUrl;
      if (typeof fn !== "function") {
        // desktop profile（Electron 壳）没有可供第三方读取的会话签发入口：壳用自己的
        // 签名 cookie 注入页面。代理拿不到启动 token，转发的根路径就会被宿主拒成 401
        // "reopen the URL printed by dsh web"，远程访问只能改用 web profile。
        if (!warnedNoToken) {
          warnedNoToken = true;
          console.warn(
            "dsh-web-auth: 宿主未提供 connection.authenticatedUrl —— 手机入口无法为浏览器换发会话 cookie（desktop 壳的授权是私有的，远程访问请改用 web profile）"
          );
        }
        return "";
      }
      const url = new URL(fn.call(connection, `http://127.0.0.1:${port}`));
      return url.searchParams.get("token") ?? "";
    } catch {
      return "";
    }
  };

  // The shipped Web composition claims the fallback seat for the SPA dist
  // server, whose index authentication calls the Host connection's
  // `authorizeIndex` with the ORIGINAL `req.url`. Wrapping the fallback lets
  // the LAN index request reach that check already carrying the launch token,
  // which is the only way index.html is served on a non-loopback page. The
  // token is never exposed to the browser: the host's own check answers with a
  // 303 to the clean `/` and an HttpOnly cookie, and the URL stays clean.
  // Rewrite a LAN index request so it carries the launch token, letting the
  // Host's own index authentication mint the browser cookie.
  //
  // Whether the token is needed is decided by the Host's own predicate,
  // `connection.requestRejection`: the Host/Origin fence (403) followed by
  // browser-session verification (401 for a missing, expired, foreign-authority
  // or otherwise unverifiable cookie). Only a 401 is answered with the token.
  // The browser-session cookie is named `dsh-auth-<sha256(authority)>` and
  // signed with the secret held in the Host's credential store, while the Host
  // verifies it only against the CURRENT authority and secret. A browser that
  // holds a cookie minted for another authority on the same host (a test
  // instance on a different port, say) or before a secret rotation therefore
  // sends one that is never accepted; skipping the rewrite merely because *some*
  // `dsh-auth-*` cookie is present — what this used to do — left such a browser
  // on a plain-text 401 that no reload could clear. Rewriting on 401 cannot
  // loop either: an accepted request passes through untouched, and a rewritten
  // one is answered with 303 plus a fresh cookie, so the next load is accepted.
  //
  // A host without `requestRejection` falls back to the presence check, which
  // stays loop-free because it skips the rewrite for any request already
  // carrying a browser-session cookie.
  const hasBrowserSessionCookie = (req) => /(?:^|;\s*)dsh-auth-/.test(req.headers.cookie || "");

  const needsLaunchToken = (req) => {
    const connection = ctx.get("connection");
    const rejection = connection !== void 0 ? connection.requestRejection : void 0;
    if (typeof rejection === "function") {
      try {
        const verdict = rejection.call(connection, req);
        if (verdict === 401) return true;
        if (verdict === void 0) return false;
      } catch {
        /* an unusable predicate is treated like an older host */
      }
    }
    return !hasBrowserSessionCookie(req);
  };

  // Only GET is rewritten: the Host's token branch requires GET, so a HEAD
  // carrying a token would be rejected where a HEAD without one may still be
  // served from the browser's existing cookie.
  const withLaunchToken = (handler) => async (req, res) => {
    if (!isLoopbackPeer(req)) {
      const rawUrl = req.url || "/";
      const isIndexRequest = req.method === "GET" &&
        (rawUrl === "/" || rawUrl.startsWith("/?") || rawUrl === "/index.html");
      if (isIndexRequest && needsLaunchToken(req)) {
        const token = launchToken();
        if (token.length > 0) req.url = `/?token=${encodeURIComponent(token)}`;
      }
    }
    return handler(req, res);
  };

  // The shipped composition claims the fallback seat during its own bundle
  // apply, which may run BEFORE this row (insert order is not guaranteed), so
  // the patched register below never sees that call. Swap the live seat's
  // handler in place when it is already taken; otherwise the patched register
  // wraps whatever registers later. `fallback` is a private field today — an
  // absent value simply means the seat is still free.
  const existingFallback = webServer.fallback;
  const seatTaken = typeof existingFallback === "function";
  if (seatTaken) webServer.fallback = withLaunchToken(existingFallback);
  webServer.registerFallback = (handler) => {
    const owned = typeof handler === "function" && !seatTaken ? withLaunchToken(handler) : handler;
    return origRegisterFallback(owned);
  };

  webServer.register = (route) => {
    if (isApiRoute(route) && typeof route.handler === "function") {
      const original = route.handler;
      route.handler = (req, res) => authorizeHttp(req, res, original);
      httpWrapped.push([route, original]);
    }
    if (route && route.path === "/plugins" && typeof route.handler === "function" && !httpWrapped.some(([r]) => r === route)) {
      const originalPlugins = route.handler;
      route.handler = wrapPluginsHandler(originalPlugins);
      httpWrapped.push([route, originalPlugins]);
    }
    return origRegister(route);
  };
  webServer.registerUpgrade = (route) => {
    if (route && typeof route.handler === "function") {
      const original = route.handler;
      route.handler = (req, socket, head) => authorizeUpgrade(req, socket, head, original);
      upgradeWrapped.push([route, original]);
    }
    return origRegisterUpgrade(route);
  };

  // The connection's /api prefix route is registered before this profile row
  // applies: wrap the live map entry directly.
  const apiEntry = webServer.prefixes.get("/api");
  if (apiEntry !== void 0 && typeof apiEntry.handler === "function") {
    const original = apiEntry.handler;
    apiEntry.handler = (req, res) => authorizeHttp(req, res, original);
    httpWrapped.push([apiEntry, original]);
  }

  // Third-party bundle layers register their own /api routes while the profile
  // composes, i.e. BEFORE this row applies and patches `register` — those never
  // pass through the interception below. Sweep both live route tables once so
  // their routes sit behind the same password gate (and so
  // `trustLoopbackPaths` can reach them).
  const sweepApiRoutes = () => {
    for (const table of [webServer.exact, webServer.prefixes]) {
      if (table === void 0 || typeof table.values !== "function") continue;
      for (const route of [...table.values()]) {
        if (!isApiRoute(route) || typeof route.handler !== "function") continue;
        if (httpWrapped.some(([wrapped]) => wrapped === route)) continue;
        const original = route.handler;
        route.handler = (req, res) => authorizeHttp(req, res, original);
        httpWrapped.push([route, original]);
      }
    }
  };
  sweepApiRoutes();

  // Serve a patched dsh-client-connection bundle whose client-side
  // isLoopbackHostname also recognizes the deployment's LAN/Tailscale hosts,
  // so settings scopes behave like the loopback page over LAN (host scope
  // instead of the ephemeral memory scope). The /plugins route is registered by
  // client-modules AFTER this profile row applies, so the wrap is applied both
  // through the register patch above and to the live map entry here. The
  // bundle path is resolved per request (clientModules table may not be
  // populated at our apply time); HMR/upgrade rebuilds are picked up too.
  const sendPluginJs = (res, raw, cacheControl) => {
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": cacheControl,
      "content-length": String(raw.length)
    });
    res.end(raw);
  };
  const wrapPluginsHandler = (original) => async (req, res) => {
    // Only the connection bundle needs a content rewrite; every other
    // /plugins response (and the rewritten one) passes through untouched.
    //
    // NOTE: dsh 0.1.5+ serves the webserver with its own gzip middleware
    // (`webserver.compression: gzip`). This wrapper must NOT compress again —
    // double-compressing a `/plugins/??a,b,c` combo bundle corrupts it, and the
    // browser then re-executes the script, which the client module system
    // rejects with `duplicate factory registration`. So we only replace the
    // body bytes of the patched bundle and let the official middleware handle
    // encoding on the way out (we also drop any upstream content-encoding /
    // content-length so the middleware can re-derive them).
    let pathname = "";
    try {
      const url = new URL(req.url || "/", "http://x");
      pathname = decodeURIComponent(url.pathname);
      rev = url.searchParams.get("rev") || "";
    } catch {
      /* fall through to the original handler */
    }
    // The served connection bundle is reached through the combo route
    // (`/plugins/??pkg/client.js,...`), whose pathname is `/plugins/` — the
    // older single-package path is matched too, for compositions that still
    // advertise it. Either way the edit is a single needle replacement inside
    // the response body; the client-side loopback predicate is the only place
    // that string occurs (verified against the composed bundle).
    const isSingleConnection = pathname === `/plugins/${CONNECTION_CLIENT_ID}/client.js`;
    const isCombo = pathname === "/plugins/";
    if (!isSingleConnection && !isCombo) return original(req, res);

    const hostnames = resolveLanHostnames();
    if (hostnames.length === 0) return original(req, res);

    if (isSingleConnection) {
      const mod = ctx.get("clientModules");
      const clientPath = mod !== void 0 ? mod.clientPath(CONNECTION_CLIENT_ID) : void 0;
      if (typeof clientPath === "string") {
        const raw = readFileSync(clientPath, "utf8");
        sendPluginJs(res, Buffer.from(patchConnectionClient(raw, hostnames)), "no-store");
        return;
      }
    }

    // Combo response: the official handler still produces it, so revision,
    // HEAD, 404 and content-type semantics stay official. Only the body bytes
    // are rewritten on the way out — the frame boundaries are untouched, so a
    // multi-package combo keeps registering each factory exactly once. The
    // official gzip middleware sits outside this route and compresses whatever
    // is written here, so the body must stay uncompressed at this layer.
    const chunks = [];
    const writeHead = res.writeHead.bind(res);
    const end = res.end.bind(res);
    let status = 200;
    let headers = {};
    res.writeHead = (code, extra) => {
      status = code;
      headers = { ...(extra || {}) };
      return res;
    };
    res.end = (chunk, encoding, cb) => {
      if (typeof encoding === "function") {
        cb = encoding;
        encoding = undefined;
      }
      if (status !== 200 || chunk === undefined || chunk === null) {
        writeHead(status, headers);
        return end(chunk, encoding, cb);
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      const raw = Buffer.concat(chunks);
      const text = raw.toString("utf8");
      const patched = patchConnectionClient(text, hostnames);
      if (patched === text) {
        writeHead(status, headers);
        return end(raw, undefined, cb);
      }
      const body = Buffer.from(patched, "utf8");
      delete headers["content-length"];
      delete headers["content-encoding"];
      headers["cache-control"] = "no-store";
      writeHead(status, headers);
      return end(body, undefined, cb);
    };
    return original(req, res);
  };
  const pluginsEntry = webServer.prefixes.get("/plugins");
  if (pluginsEntry !== void 0 && typeof pluginsEntry.handler === "function" && !httpWrapped.some(([r]) => r === pluginsEntry)) {
    const originalPlugins = pluginsEntry.handler;
    pluginsEntry.handler = wrapPluginsHandler(originalPlugins);
    httpWrapped.push([pluginsEntry, originalPlugins]);
  }

  // Inject the secure-context crypto.randomUUID polyfill into every served
  // index.html (LAN pages over plain HTTP are not secure contexts). Registered
  // before the token sweep below so the polyfill survives even if the timer
  // mixin is unavailable.
  ctx.effect(() => webServer.tapIndex(injectUuidPolyfill), "dsh-web-auth: uuid polyfill");

  // 手机入口：webserver 绑回环（或某个具体地址），远程访问一律走这个代理。
  // 代理把 Host/Origin 改写成上游回环后转发，并在页面注入移动端布局与
  // `__DSH_TRANSPORT__.ownsHost`（客户端据此判定设置可写）。密码沿用本插件
  // 的 resolvePassword()：改密码文件即时生效，旧 cookie 随之失效。
  const mobileOptions = cfg.mobile !== null && typeof cfg.mobile === "object" ? cfg.mobile : {};
  if (mobileOptions.enabled !== false) {
    const mobileHost = typeof mobileOptions.host === "string" && mobileOptions.host !== "" ? mobileOptions.host : "0.0.0.0";
    const mobilePort = Number.isInteger(mobileOptions.port) && mobileOptions.port > 0 && mobileOptions.port <= 65535 ? mobileOptions.port : 3081;
    ctx.effect(() => webServer.tapIndex(injectMobileHead), "dsh-web-auth: mobile head");
    const mobileProxy = createMobileProxy({
      listenHost: mobileHost,
      port: mobilePort,
      upstream: {
        get host() {
          return webServer.host;
        },
        get port() {
          return webServer.port || port;
        }
      },
      password: () => resolvePassword().password ?? "",
      secretFile: join(defaultConfigDir(), ".dsh-mobile-secret"),
      launchToken: () => {
        try {
          const connection = ctx.get("connection");
          if (connection === undefined || typeof connection.authenticatedUrl !== "function") return "";
          const url = new URL(connection.authenticatedUrl(`http://127.0.0.1:${String(webServer.port || port)}`));
          return url.searchParams.get("token") ?? "";
        } catch {
          return "";
        }
      }
    });
    mobileProxy.listen().catch((error) => {
      console.error(
        `dsh-web-auth: 手机入口无法监听 ${mobileHost}:${String(mobilePort)} —— ${error instanceof Error ? error.message : String(error)}`
      );
    });
    ctx.effect(() => () => {
      void mobileProxy.close();
    }, "dsh-web-auth: mobile proxy");
  }

  // Settings-document read for the remote "打开配置文件" replacement action.
  // The official settings.openDocument RPC hands the path to a NATIVE opener
  // (xdg-open / open / Invoke-Item), which cannot work on a headless server;
  // the client half shadows that button and calls this route instead, which
  // serves the document text (and its path) over the authenticated /api plane.
  // `canOpenNative` mirrors the official canOpenNativePath() heuristic so the
  // client can keep using the native RPC on desktop-capable hosts.
  // The route is registered through the patched webServer.register, so it is
  // wrapped by authorizeHttp like every other /api route.
  ctx.effect(() => webServer.register({
    kind: "exact",
    path: SETTINGS_DOCUMENT_ROUTE,
    handler: async (req, res) => {
      const settings = ctx.get("settings");
      if (settings === void 0) {
        sendJson(res, 503, { ok: false, error: "settings service is absent" });
        return;
      }
      let path;
      try {
        path = await settings.prepareDocument();
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (path === void 0) {
        sendJson(res, 404, { ok: false, error: "settings provider has no local document" });
        return;
      }
      let content = "";
      try {
        content = readFileSync(path, "utf8");
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const platform = process.platform;
      const canOpenNative = platform === "darwin" || platform === "win32" ||
        Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
      sendJson(res, 200, { ok: true, path, content, canOpenNative });
    },
  }), "dsh-web-auth: settings-document route");

  // Settings-document write for the remote "打开配置文件" replacement action.
  // The modal editor saves through this route; the write goes through the same
  // atomic-write + writer-lock protocol the official settings-file provider
  // uses, so a concurrent settings commit can never be clobbered silently.
  ctx.effect(() => webServer.register({
    kind: "exact",
    path: `${SETTINGS_DOCUMENT_ROUTE}/write`,
    handler: async (req, res) => {
      const settings = ctx.get("settings");
      if (settings === void 0) {
        sendJson(res, 503, { ok: false, error: "settings service is absent" });
        return;
      }
      let path;
      try {
        path = await settings.prepareDocument();
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (path === void 0) {
        sendJson(res, 404, { ok: false, error: "settings provider has no local document" });
        return;
      }
      let body = null;
      try {
        body = await readJsonBody(req, 1048576);
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid JSON body" });
        return;
      }
      const content = typeof body.content === "string" ? body.content : null;
      if (content === null) {
        sendJson(res, 400, { ok: false, error: "missing content" });
        return;
      }
      try {
        await withFileLock(path, async () => {
          await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 });
        });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      sendJson(res, 200, { ok: true, path });
    },
  }), "dsh-web-auth: settings-document write route");

  // ── 服务绑定（host / port）────────────────────────────────────────────
  // host 与 port 是组合期事实：webserver 行在自己的激活里 listen，之后没有
  // rebind 接口。所以面板不改运行期状态，而是把选择交回组合层——官方
  // configEditor.edit() 把该行的下一份 config 写进当前 profile 的 patch，再经
  // Loader reconcile 重启 webserver fiber（旧监听关闭、新监听建立）。
  //
  // 路由挂在 /api 前缀下，由上面 patched register 包进 authorizeHttp：非回环
  // 对端必须先过密码门，回环免密，所以这里不再单独鉴权。
  //
  // 保存成功时浏览器多半收不到 200：fiber 重启会 closeAllConnections()，本插件
  // 的 fiber 也作为 webServer 的消费者一起重启，响应在写出之前就随旧 socket
  // 消失。客户端因此把网络错误按「已提交」处理，再自行探测新地址。
  const BIND_ROUTE = "/api/dsh-web-auth/bind";
  // host 能不能用由**跑着的 webserver 自己的 Config schema** 判定，不写死版本差异：
  // dsh 0.2.1-rc.2 起 host 只接受本机某个具体 IPv4/IPv6 字面量（0.0.0.0 与 :: 被
  // 拒，理由是通配绑定等于把带 RCE 的 API 摆到网络上），更早的版本反过来只接受
  // 127.0.0.1 / 0.0.0.0。候选 = 本机网卡地址 + 回环 + 通配，逐个过 schema，过不了
  // 的就不出现在下拉里，避免面板写出一个服务起不来的值。
  const bindHostAccepted = (candidate) => {
    const ctor = webServer.constructor;
    const schema = ctor === void 0 ? void 0 : ctor.Config;
    // 判定不了（桩 webserver / 官方换实现）就不拦，交给 configEditor 校验。
    if (typeof schema !== "function") return true;
    try {
      schema({ host: candidate, port: 1 });
      return true;
    } catch {
      return false;
    }
  };
  const bindHostCandidates = () => {
    // IPv4 排在 IPv6 前面：日常会选的 192.168.x.x / Tailscale 地址在前面，长串地址沉底。
    const ipv4 = ["127.0.0.1"];
    const ipv6 = ["::1"];
    const add = (list, value) => {
      if (!list.includes(value)) list.push(value);
    };
    for (const [name, infos] of Object.entries(networkInterfaces())) {
      // docker / veth / 网桥这些虚拟网卡不是运维会想绑的地址，噪音居多。
      if (/^(br-|docker|veth|virbr|vmnet|tap|tun)/.test(name)) continue;
      for (const info of infos ?? []) {
        if (info.internal) continue;
        if (info.family === "IPv6") {
          // IPv6 链路本地地址不带 zone 无法连接，绑它没有意义。
          if (!/^fe80:/i.test(info.address)) add(ipv6, info.address);
          continue;
        }
        add(ipv4, info.address);
      }
    }
    return [...ipv4, ...ipv6, "0.0.0.0"].filter(bindHostAccepted);
  };
  const findWebserverEntry = () => {
    const editor = ctx.get("configEditor");
    if (editor === void 0) return null;
    try {
      const entry = editor.entries().find((item) => item !== void 0 && item.options !== void 0 && item.options.id === "webserver");
      return entry === void 0 ? null : { editor, entry };
    } catch {
      return null;
    }
  };
  const bindUnavailable = () => ctx.get("configEditor") === void 0
    ? "宿主没有 configEditor 服务，无法在面板修改绑定（需要带 Loader 的 profile 宿主）"
    : "当前插件树里没有 webserver 行，无法在面板修改绑定";
  // webserver 重启之后，新监听上的请求回调是在 HMR 事务的 async 上下文里创建的
  // （fiber 重启就发生在 hmr.runExclusive 之内），于是同一进程里后续每个请求都
  // 带着那个上下文，configEditor.edit() 再进 runExclusive 就被判成
  // 「HMR transactions cannot be nested」——第一次改绑定能成功，第二次开始报错。
  // dsh-hmr 处理自己的 watcher 时也是用 executing.exit() 脱开这个上下文，这里照做；
  // 拿不到该字段（官方换了实现）就退回直接调用，行为不比官方更差。
  const runOutsideHmrTransaction = (operation) => {
    const hmr = ctx.get("hmr");
    const executing = hmr !== void 0 ? hmr.executing : void 0;
    if (executing !== void 0 && typeof executing.exit === "function") return executing.exit(operation);
    return operation();
  };

  ctx.effect(() => webServer.register({
    kind: "exact",
    path: BIND_ROUTE,
    handler: async (req, res) => {
      const found = findWebserverEntry();
      const boundHost = typeof webServer.host === "string" ? webServer.host : null;
      const boundPort = typeof webServer.port === "number" ? webServer.port : null;

      if (req.method === "GET") {
        const candidates = bindHostCandidates();
        // 当前绑的值不在候选里也照样报出来：客户端要拿它当默认选中项。
        if (boundHost !== null && !candidates.includes(boundHost)) candidates.unshift(boundHost);
        let patchPath = null;
        if (found !== null) {
          try {
            patchPath = found.editor.documentPath;
          } catch {
            patchPath = null;
          }
        }
        sendJson(res, 200, {
          ok: true,
          host: boundHost,
          port: boundPort,
          hosts: candidates,
          editable: found !== null,
          reason: found === null ? bindUnavailable() : null,
          patchPath
        });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }

      let body = null;
      try {
        body = await readJsonBody(req);
      } catch {
        /* 空或非法 body 交给下面的字段校验报错 */
      }
      const host = body !== null && typeof body === "object" && typeof body.host === "string" ? body.host : "";
      const portValue = body !== null && typeof body === "object" && (typeof body.port === "number" || typeof body.port === "string")
        ? String(body.port).trim()
        : "";
      // boundHost 永远放行：它已经在跑（或正在被修），只改端口时不该被地址白名单拦住。
      const candidates = bindHostCandidates();
      if (host !== boundHost && !candidates.includes(host)) {
        sendJson(res, 400, { ok: false, error: `绑定地址只支持本机网卡地址：${candidates.join(" / ")}` });
        return;
      }
      if (!/^\d+$/.test(portValue) || Number(portValue) > 65535) {
        sendJson(res, 400, { ok: false, error: "端口必须是 0-65535 的整数（0 = 由系统分配）" });
        return;
      }
      const port = Number(portValue);
      if (found === null) {
        sendJson(res, 503, { ok: false, error: bindUnavailable() });
        return;
      }
      // 只在端口真的变化时预检：端口没变说明当前监听正占着它，探了必然失败。
      if (port !== 0 && port !== boundPort) {
        const reason = await probeBind(host, port);
        if (reason !== null) {
          sendJson(res, 409, { ok: false, error: `端口 ${port} 现在不可用（${reason}）` });
          return;
        }
      }
      // 绑定地址同时是第三方插件眼里的对外 authority：dshmarket 自己的围栏
      // 只读 connection.trustedHosts，而官方 webStartup.trustedHosts 只取 CLI
      // `--trusted-host`（本部署没有该参数），空数组会让它的变更路由全部
      // 403 untrusted origin。绑定地址变化时把新地址写进 connection 行，
      // 换网卡 / 主机名后不用再手改 profile patch。
      //
      // 通配绑定推导不出对外 authority，保持原值；回环地址本来就被第三方围栏
      // 当作回环接受，不写入，但要清掉旧的非回环条目。
      let trustedHostsSync = null;
      if (host !== boundHost) {
        const connectionEntry = found.editor.entries().find((item) =>
          item !== void 0 && item.options !== void 0 && item.options.id === "connection");
        if (connectionEntry !== void 0) {
          const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
          const wildcard = host === "0.0.0.0" || host === "::";
          if (wildcard) {
            trustedHostsSync = { ok: true, applied: false, reason: "wildcard bind has no reachable authority" };
          } else {
            try {
              await runOutsideHmrTransaction(() => found.editor.edit(connectionEntry, (current) => {
                // current 是求值后的运行配置：这里写回的是字面量数组，
                // 与 port 一样，表达式一旦被改过就固化。
                const next = { ...current };
                const kept = (Array.isArray(current.trustedHosts) ? current.trustedHosts : [])
                  .filter((value) => typeof value === "string" && value !== boundHost && value !== host);
                next.trustedHosts = loopback ? kept : [...kept, host];
                return next;
              }));
              trustedHostsSync = { ok: true, applied: true };
            } catch (error) {
              // 被 home patch / CLI overlay 覆盖时 configEditor 会拒绝；绑定本身
              // 仍要保存，把原因带给面板。
              trustedHostsSync = { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
          }
        } else {
          trustedHostsSync = { ok: true, applied: false, reason: "no connection row in this plugin tree" };
        }
      }
      try {
        await runOutsideHmrTransaction(() => found.editor.edit(found.entry, (current) => {
          // 没动的键原样带回：连 !!js 表达式一起保留，例如用户只改绑定地址时
          // `port: !!js ctx.webStartup.port ?? 3080` 不会被写死成字面量。
          const next = { ...current };
          if (host !== boundHost) next.host = host;
          if (port !== boundPort) next.port = port;
          return next;
        }));
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        host,
        port,
        ...(trustedHostsSync === null ? {} : { trustedHosts: trustedHostsSync })
      });
    },
  }), "dsh-web-auth: bind route");

  // ── Web 访问（手机 / 远程入口）────────────────────────────────────────────
  // 本地监听固定回环，面板不暴露它；这里只配置插件自带的代理：开关 + 端口，以及
  // 可直接在手机上打开的地址。写的是本插件自己的 `mobile` 配置，改完 Loader 会
  // 重跑本插件的 apply，代理随之按新端口重启。
  const ACCESS_ROUTE = "/api/dsh-web-auth/access";
  const findEntryById = (id) => {
    const editor = ctx.get("configEditor");
    if (editor === void 0) return null;
    try {
      const entry = editor.entries().find((item) => item !== void 0 && item.options !== void 0 && item.options.id === id);
      return entry === void 0 ? null : { editor, entry };
    } catch {
      return null;
    }
  };
  const readMobileConfig = (fallback) => {
    const found = findEntryById("web-auth");
    const config = found === null ? void 0 : found.entry.options.config;
    const declared = config !== null && typeof config === "object" ? config.mobile : void 0;
    const source = declared !== null && typeof declared === "object" ? declared : (fallback !== null && typeof fallback === "object" ? fallback : {});
    return {
      enabled: source.enabled !== false,
      host: typeof source.host === "string" && source.host !== "" ? source.host : "0.0.0.0",
      port: Number.isInteger(source.port) && source.port > 0 ? source.port : 3081
    };
  };
  const accessUrls = (mobile) => {
    const urls = [];
    const push = (host) => {
      const url = `http://${host}:${String(mobile.port)}/`;
      if (!urls.includes(url)) urls.push(url);
    };
    if (mobile.host !== "0.0.0.0" && mobile.host !== "::") push(mobile.host);
    else {
      // 只列真正可达的网卡：docker / veth / 网桥 / TUN 这些虚拟接口列出来只会误导。
      for (const [name, infos] of Object.entries(networkInterfaces())) {
        if (/^(br-|docker|veth|virbr|vmnet|tap|tun|lo|Meta)/i.test(name)) continue;
        for (const info of infos ?? []) {
          if (info.internal || info.family !== "IPv4") continue;
          push(info.address);
        }
      }
    }
    return urls;
  };
  const accessPayload = (mobile) => ({
    ok: true,
    enabled: mobile.enabled,
    host: mobile.host,
    port: mobile.port,
    urls: mobile.enabled ? accessUrls(mobile) : []
  });

  ctx.effect(() => webServer.register({
    kind: "exact",
    path: ACCESS_ROUTE,
    handler: async (req, res) => {
      const found = findEntryById("web-auth");
      if (req.method === "GET") {
        sendJson(res, 200, { ...accessPayload(readMobileConfig(cfg.mobile)), editable: found !== null });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      if (found === null) {
        sendJson(res, 503, { ok: false, error: "当前插件树里没有 web-auth 行，无法在面板修改访问配置" });
        return;
      }
      let body = null;
      try {
        body = await readJsonBody(req);
      } catch {
        /* 交给下面的字段校验 */
      }
      const enabled = body !== null && typeof body === "object" && typeof body.enabled === "boolean" ? body.enabled : true;
      const portValue = body !== null && typeof body === "object" && (typeof body.port === "number" || typeof body.port === "string")
        ? String(body.port).trim()
        : "";
      if (!/^\d+$/.test(portValue) || Number(portValue) < 1 || Number(portValue) > 65535) {
        sendJson(res, 400, { ok: false, error: "入口端口要是 1-65535 的整数" });
        return;
      }
      const nextPort = Number(portValue);
      if (nextPort === (webServer.port || port)) {
        sendJson(res, 400, { ok: false, error: "手机入口不能和 dsh 本体的端口相同" });
        return;
      }
      try {
        await runOutsideHmrTransaction(() => found.editor.edit(found.entry, (current) => {
          const next = { ...current };
          const mobile = current.mobile !== null && typeof current.mobile === "object" ? current.mobile : {};
          next.mobile = { ...mobile, enabled, port: nextPort };
          return next;
        }));
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      sendJson(res, 200, accessPayload({ enabled, host: readMobileConfig(cfg.mobile).host, port: nextPort }));
    }
  }), "dsh-web-auth: access route");

  try {
    ctx.interval(() => {
      const now = Date.now();
      let changed = false;
      for (const [token, expiry] of tokens) {
        if (expiry <= now) {
          tokens.delete(token);
          changed = true;
        }
      }
      if (changed) persistTokens();
    }, 60000);
  } catch {
    /* token expiry is still enforced per-access; the sweep is best-effort */
  }

  ctx.effect(() => () => {
    for (const [route, original] of httpWrapped) {
      if (route !== void 0 && route.handler !== original) route.handler = original;
    }
    for (const [route, original] of upgradeWrapped) {
      if (route !== void 0 && route.handler !== original) route.handler = original;
    }
    webServer.register = origRegister;
    webServer.registerUpgrade = origRegisterUpgrade;
    webServer.registerFallback = origRegisterFallback;
    // The live seat was swapped in place (the composition had already claimed
    // it before this row applied); put the original handler back so disabling
    // or reloading the plugin leaves no wrapper behind.
    if (seatTaken && webServer.fallback !== existingFallback) {
      webServer.fallback = existingFallback;
    }
  }, "dsh-web-auth: restore webserver methods");
}

export { name, inject, apply };
