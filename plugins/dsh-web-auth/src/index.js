// dsh-web-auth host half — password gate + loopback trust rewrite.
//
// Why this exists: dsh web binds 0.0.0.0 (Route B) so LAN/Tailscale devices
// reach /api directly, but dsh pins the privileged configuration plane
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
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import z from "@deepseek-ai/schemastery";

const name = "dsh-web-auth";
const inject = ["webServer", "timer"];
const SETTINGS_DOCUMENT_ROUTE = "/api/dsh-web-auth/settings-document";
const SETTINGS_NS = settingsNamespace("dsh-web-auth");
const SettingsSchema = z.object({});

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
// deployment's own hostnames (derived from `webRuntime.trustedHosts` plus the
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

function rewriteToLoopback(req, port) {
  const lbHost = `127.0.0.1:${port}`;
  if (typeof req.headers.host === "string") req.headers.host = lbHost;
  if (typeof req.headers.origin === "string") req.headers.origin = `http://${lbHost}`;
  if (typeof req.headers.referer === "string") {
    req.headers.referer = req.headers.referer.replace(/^https?:\/\/[^/]+/i, `http://${lbHost}`);
  }
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
  // rc.8 keyed settings.plugin.item only dispatches namespaces the Host serves.
  installSettingsSection(ctx, SETTINGS_NS, SettingsSchema, {}, {
    setSource() {},
    onChange() {}
  });

  const webServer = ctx.get("webServer");
  if (webServer === void 0) return;

  const cfg = config !== null && typeof config === "object" ? config : {};
  const envPassword = typeof cfg.password === "string" && cfg.password.length > 0 ? cfg.password : null;
  const passwordFile = typeof cfg.passwordFile === "string" && cfg.passwordFile.length > 0 ? cfg.passwordFile : DEFAULT_PASSWORD_FILE;
  const tokenFile = typeof cfg.tokenFile === "string" && cfg.tokenFile.length > 0 ? cfg.tokenFile : DEFAULT_TOKEN_FILE;
  const ttlMs = (typeof cfg.tokenTtlHours === "number" && cfg.tokenTtlHours > 0 ? cfg.tokenTtlHours : 12) * 3600 * 1000;
  const port = webServer.port || 3080;

  // LAN/Tailscale hostnames the client-side connection should treat as
  // loopback: derived from the deployment's own webRuntime.trustedHosts
  // (which carries the bind-derived LAN IP literals plus any --trusted-host
  // names), plus optional explicit `lanHosts` config. Loopback names are
  // filtered out (the patch needle already covers them). Resolved lazily at
  // request time: the loader does not mount rows in strict tree order, so
  // webRuntime may not be provided yet when this row applies.
  const resolveLanHostnames = () => {
    const hostnames = new Set();
    const webRuntime = ctx.get("webRuntime");
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

  const handleAuth = async (req, res) => {
    const pathname = pathnameOf(req);
    if (pathname === "/api/auth/login") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      const src = resolvePassword();
      if (src.password === null) {
        sendJson(res, 503, { error: "web-auth: no password configured (set DSH_WEB_AUTH_PASSWORD or write the password file)" });
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
        sendJson(res, 401, { error: "invalid password" });
        return;
      }
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
    rewriteToLoopback(req, port);
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
    rewriteToLoopback(req, port);
    next(req, socket, head);
  };

  const isApiRoute = (route) => {
    const path = route && route.path;
    if (path === "/api" || (typeof path === "string" && path.startsWith("/api/"))) return true;
    // Third-party plugins sometimes register sensitive JSON routes outside
    // /api (e.g. /vision-bridge/rpc). `extraProtectedPaths` lets the deployment
    // pull those behind the same password gate.
    return Array.isArray(cfg.extraProtectedPaths) && cfg.extraProtectedPaths.includes(path);
  };

  // Patch register/registerUpgrade so every /api route and upgrade registered
  // from now on is wrapped too (upgrades are registered deferred by connection
  // after apiProxy resolves, so they are NOT present at our apply time).
  const origRegister = webServer.register.bind(webServer);
  const origRegisterUpgrade = webServer.registerUpgrade.bind(webServer);
  const httpWrapped = [];
  const upgradeWrapped = [];

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

  // Serve a patched dsh-client-connection bundle whose client-side
  // isLoopbackHostname also recognizes the deployment's LAN/Tailscale hosts,
  // so settings scopes behave like the loopback page over LAN (host scope
  // instead of the ephemeral memory scope). The /plugins route is registered by
  // client-modules AFTER this profile row applies, so the wrap is applied both
  // through the register patch above and to the live map entry here. The
  // bundle path is resolved per request (clientModules table may not be
  // populated at our apply time); HMR/upgrade rebuilds are picked up too.
  let pluginsCachedRaw = null;
  let pluginsCachedBody = null;
  const gzipCache = new Map();
  const gzipBody = (raw, acceptEncoding, cacheKey) => {
    if (!/\bgzip\b/.test(String(acceptEncoding || "")) || raw.length < 1024) {
      return { buf: raw, encoding: null };
    }
    let hit = gzipCache.get(cacheKey);
    if (hit === undefined || hit.len !== raw.length) {
      const gz = gzipSync(raw);
      if (gz.length >= raw.length) return { buf: raw, encoding: null };
      if (gzipCache.size > 64) gzipCache.clear();
      hit = { len: raw.length, buf: gz };
      gzipCache.set(cacheKey, hit);
    }
    return { buf: hit.buf, encoding: "gzip" };
  };
  const sendPluginJs = (res, raw, cacheControl, acceptEncoding, cacheKey) => {
    const packed = gzipBody(raw, acceptEncoding, cacheKey);
    const headers = {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": cacheControl
    };
    if (packed.encoding) {
      headers["content-encoding"] = packed.encoding;
      headers.vary = "Accept-Encoding";
    }
    headers["content-length"] = String(packed.buf.length);
    res.writeHead(200, headers);
    res.end(packed.buf);
  };
  const wrapPluginsHandler = (original) => async (req, res) => {
    const acceptEncoding = req.headers["accept-encoding"];
    let pathname = "";
    let rev = "";
    try {
      const url = new URL(req.url || "/", "http://x");
      pathname = decodeURIComponent(url.pathname);
      rev = url.searchParams.get("rev") || "";
    } catch {
      /* fall through to the original handler */
    }
    const expected = `/plugins/${CONNECTION_CLIENT_ID}/client.js`;
    if (pathname === expected) {
      const mod = ctx.get("clientModules");
      const clientPath = mod !== void 0 ? mod.clientPath(CONNECTION_CLIENT_ID) : void 0;
      if (typeof clientPath === "string") {
        const raw = readFileSync(clientPath, "utf8");
        let body = pluginsCachedBody;
        if (raw !== pluginsCachedRaw) {
          body = patchConnectionClient(raw, resolveLanHostnames());
          pluginsCachedRaw = raw;
          pluginsCachedBody = body;
          gzipCache.delete(expected);
        }
        sendPluginJs(res, Buffer.from(body), "no-store", acceptEncoding, expected);
        return;
      }
    }
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
      const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      if (rev) headers["cache-control"] = "public, max-age=31536000, immutable";
      const packed = gzipBody(raw, acceptEncoding, pathname);
      if (packed.encoding) {
        headers["content-encoding"] = packed.encoding;
        headers.vary = "Accept-Encoding";
        headers["content-length"] = String(packed.buf.length);
      }
      writeHead(status, headers);
      return end(packed.buf, undefined, cb);
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
  }, "dsh-web-auth: restore webserver methods");
}

export { name, inject, apply };
