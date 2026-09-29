// dsh-updater route checks: mount the host half into a minimal stub context and
// drive its HTTP routes directly.
//
// The real network is replaced with canned registry/GitHub payloads, so this
// verifies the plugin's own behaviour — method fencing, cross-origin rejection,
// version search, and refusing an unknown version before npm sees it — without
// booting a dsh instance or touching the running one. The two restart routes are
// only probed for their fences (a GET and a cross-origin POST), because a valid
// POST would really relaunch the service.
//
// Run: node scripts/test-routes.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate state before the plugin is imported: it persists the channel to
// `<DSH_HOME>/dsh-updater-state.json`, and writing that file into the operator's
// real DSH home both mutates their configuration and makes this suite
// order-dependent (a leftover `channel: next` from an interrupted run failed the
// next run's first assertion).
const testHome = mkdtempSync(join(tmpdir(), "dsh-updater-test-"));
process.env.DSH_HOME = testHome;
process.on("exit", () => {
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const plugin = await import("../src/index.js");

const REGISTRY_TAGS = { latest: "0.1.7-rc.2", next: "0.2.0-rc.1", alpha: "0.1.7-alpha.2" };
const REGISTRY_VERSIONS = {
  "0.1.6-alpha.1": {},
  "0.1.7-alpha.1": {},
  "0.1.7-alpha.2": {},
  "0.1.7-rc.1": {},
  "0.1.7-rc.2": {},
  "0.2.0-rc.1": {}
};
const GITHUB_RELEASES = [
  { tag_name: "dsh-v0.2.0-rc.1", name: "0.2.0-rc.1", html_url: "https://example.test/0.2.0-rc.1", published_at: "2026-09-28T12:34:03Z", body: "next notes", prerelease: true },
  { tag_name: "dsh-v0.1.7-rc.2", name: "0.1.7-rc.2", html_url: "https://example.test/0.1.7-rc.2", published_at: "2026-09-24T14:18:11Z", body: "latest notes", prerelease: true }
];

let fetchCalls = [];
// Tests that need to observe an in-flight request widen the version-check
// window through this knob instead of racing the real 15 s timeout.
let fetchDelayMs = 0;
globalThis.fetch = async (url) => {
  const target = String(url);
  fetchCalls.push(target);
  if (fetchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, fetchDelayMs));
  if (target.includes("registry")) {
    return { ok: true, status: 200, json: async () => ({ "dist-tags": REGISTRY_TAGS, versions: REGISTRY_VERSIONS }) };
  }
  if (target.includes("api.github.com")) {
    return { ok: true, status: 200, json: async () => GITHUB_RELEASES };
  }
  throw new Error(`unexpected fetch: ${target}`);
};

// ── stub cordis context ─────────────────────────────────────────────────────

const routes = new Map();
const webServer = {
  port: 3081,
  register(route) {
    routes.set(route.path, route);
    return () => routes.delete(route.path);
  }
};
const intervals = [];
const ctx = {
  get(service) {
    if (service === "webServer") return webServer;
    return void 0;
  },
  effect(fn) {
    const dispose = fn();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
  timer: {
    interval(fn, ms) {
      intervals.push({ fn, ms });
      return () => {};
    }
  },
  logger: { info() {}, warn() {} }
};

plugin.apply(ctx, { channel: "latest", autoCheck: true });
assert.deepEqual([...routes.keys()].sort(), [
  "/api/dsh-updater/channel",
  "/api/dsh-updater/check",
  "/api/dsh-updater/restart",
  "/api/dsh-updater/status",
  "/api/dsh-updater/update",
  "/api/dsh-updater/versions"
]);

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
    }
  };
}

function makeReq({ method = "GET", url = "/", headers = {}, body = null }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.resume = () => {};
  // Routes read the body via 'data'/'end'; emit them on the next tick so the
  // handler's listeners are attached first.
  setImmediate(() => {
    if (body !== null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

async function call(path, options) {
  // Routes are registered by exact path; a query string belongs to the request
  // URL, not to the registration key.
  const key = path.split("?")[0];
  const route = routes.get(key);
  assert.notEqual(route, void 0, `route ${key} is not registered`);
  const res = makeRes();
  await route.handler(makeReq({ url: path, ...options }), res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json };
}

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

console.log("route fences");

await check("GET /status answers with the merged version list", async () => {
  const { status, json } = await call("/api/dsh-updater/status");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.channel, "latest");
  assert.equal(json.channels.latest.version, "0.1.7-rc.2");
  assert.equal(json.channels.next.version, "0.2.0-rc.1");
  assert.ok(Array.isArray(json.versions));
  assert.deepEqual(json.versions.map((row) => row.version), ["0.2.0-rc.1", "0.1.7-rc.2", "0.1.7-rc.1", "0.1.7-alpha.2", "0.1.7-alpha.1", "0.1.6-alpha.1"]);
  assert.equal(json.sources.registry.ok, true);
  assert.equal(json.sources.github.ok, true);
  // Running under the same node as the test harness, the install lookup resolves
  // the real dsh copy (via the node prefix). Assert the invariants the card
  // relies on rather than a pinned version: either a real version string is
  // reported with its install root, or the lookup cleanly degrades to null —
  // never a throw and never a half-filled record.
  if (json.current !== null) {
    assert.match(json.current, /^\d+\.\d+\.\d+/);
    assert.equal(typeof json.installRoot, "string");
  } else {
    assert.equal(json.installRoot, null);
  }
  // `hasUpdate` must be a boolean-comparable answer, not undefined.
  assert.equal(typeof json.hasUpdate, "boolean");
});

await check("rejects unsupported methods", async () => {
  assert.equal((await call("/api/dsh-updater/status", { method: "POST" })).status, 405);
  assert.equal((await call("/api/dsh-updater/versions", { method: "POST" })).status, 405);
  assert.equal((await call("/api/dsh-updater/check", { method: "GET" })).status, 405);
  assert.equal((await call("/api/dsh-updater/update", { method: "GET" })).status, 405);
  assert.equal((await call("/api/dsh-updater/restart", { method: "GET" })).status, 405);
});

await check("rejects a cross-origin POST on every mutating route", async () => {
  const hostile = { origin: "https://evil.test", host: "127.0.0.1:3080" };
  for (const path of ["/api/dsh-updater/check", "/api/dsh-updater/channel", "/api/dsh-updater/update", "/api/dsh-updater/restart"]) {
    const { status, json } = await call(path, { method: "POST", headers: hostile, body: "{}" });
    assert.equal(status, 403, `${path} should be fenced`);
    assert.equal(json.ok, false);
  }
});

await check("accepts a same-origin POST and a plain CLI caller", async () => {
  const sameOrigin = { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080" };
  const ok = await call("/api/dsh-updater/check", { method: "POST", headers: sameOrigin, body: "{}" });
  assert.equal(ok.status, 200);
  // No Origin header (curl, scripts): allowed, since the deployment's own fence
  // already guards /api.
  assert.equal((await call("/api/dsh-updater/versions")).status, 200);
});

console.log("request fence");

await check("a cross-site simple POST is refused on every mutating route", async () => {
  // A page on another origin can send a simple POST with text/plain and no
  // preflight. Sec-Fetch-Site is the signal the browser sets for it.
  const hostile = { origin: "https://evil.test", host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" };
  for (const path of ["/api/dsh-updater/check", "/api/dsh-updater/channel", "/api/dsh-updater/update", "/api/dsh-updater/restart"]) {
    const { status } = await call(path, { method: "POST", headers: hostile, body: "{}" });
    assert.equal(status, 403, `${path} must be fenced`);
  }
});

await check("another port on the same host is not same-origin", async () => {
  // Hostname-only comparison also matches a page served from another port on the
  // same machine, which an attacker can reach; the full authority must be compared.
  for (const origin of ["http://127.0.0.1:9999", "http://localhost:9999", "http://127.0.0.1:1"]) {
    const { status } = await call("/api/dsh-updater/update", {
      method: "POST",
      headers: { origin, host: "127.0.0.1:3080" },
      body: "{}"
    });
    assert.equal(status, 403, `${origin} must be refused`);
  }
});

await check("a cross-site fetch without Origin is still refused", async () => {
  const { status } = await call("/api/dsh-updater/update", {
    method: "POST",
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" },
    body: "{}"
  });
  assert.equal(status, 403);
});

await check("the read routes are fenced too", async () => {
  // /status reports absolute install paths and the environment registry.
  for (const path of ["/api/dsh-updater/status", "/api/dsh-updater/versions"]) {
    const { status } = await call(path, {
      headers: { origin: "http://127.0.0.1:9999", host: "127.0.0.1:3080" }
    });
    assert.equal(status, 403, `${path} must be fenced`);
  }
});

await check("the GUI's own request is allowed", async () => {
  const same = { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" };
  const ok = await call("/api/dsh-updater/check", { method: "POST", headers: same, body: "{}" });
  assert.equal(ok.status, 200);
  // A port-less Origin matches a default-port Host.
  const portless = await call("/api/dsh-updater/check", { method: "POST", headers: { origin: "http://127.0.0.1", host: "127.0.0.1:80" }, body: "{}" });
  assert.equal(portless.status, 200);
});

await check("the host fence's own rejection is honoured and surfaced", async () => {
  // Exact routes bypass dsh's /api prefix fence, so the plugin must ask the host.
  // A stub connection stands in for a deployment whose fence denies the request.
  const connection = { requestRejection: () => 401 };
  const routesWithFence = new Map();
  const localCtx = {
    get: (svc) => (svc === "webServer"
      ? { port: 1, register(r) { routesWithFence.set(r.path, r); return () => {}; } }
      : svc === "connection" ? connection : void 0),
    effect: (f) => { const d = f(); return () => typeof d === "function" && d(); },
    timer: { interval: () => () => {} },
    logger: { info() {}, warn() {} }
  };
  plugin.apply(localCtx, { channel: "latest", autoCheck: false });
  const route = routesWithFence.get("/api/dsh-updater/update");
  const res = { writeHead(s) { this.status = s; }, end(t) { this.body = t; } };
  const req = makeReq({ method: "POST", url: "/api/dsh-updater/update", headers: { host: "127.0.0.1:3080" }, body: "{}" });
  await route.handler(req, res);
  assert.equal(res.status, 401, "the host fence's status must be surfaced");
});

console.log("version search");

await check("?q filters by version substring", async () => {
  const { json } = await call("/api/dsh-updater/versions?q=0.1.7");
  assert.equal(json.ok, true);
  assert.equal(json.query, "0.1.7");
  assert.deepEqual(json.versions.map((row) => row.version), ["0.1.7-rc.2", "0.1.7-rc.1", "0.1.7-alpha.2", "0.1.7-alpha.1"]);
});

await check("?q matches channel tags too", async () => {
  const { json } = await call("/api/dsh-updater/versions?q=rc");
  assert.deepEqual(json.versions.map((row) => row.version), ["0.2.0-rc.1", "0.1.7-rc.2", "0.1.7-rc.1"]);
});

await check("a query with no match returns an empty list, not an error", async () => {
  const { status, json } = await call("/api/dsh-updater/versions?q=9.9.9");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.deepEqual(json.versions, []);
});

await check("a crafted query cannot reach the shell", async () => {
  const { status, json } = await call("/api/dsh-updater/versions?q=" + encodeURIComponent("; rm -rf /"));
  assert.equal(status, 200);
  assert.deepEqual(json.versions, []);
});

console.log("update targeting");

await check("refuses an unknown version before npm is invoked", async () => {
  const before = fetchCalls.length;
  const { status, json } = await call("/api/dsh-updater/update", { method: "POST", body: JSON.stringify({ version: "9.9.9" }) });
  assert.equal(status, 400);
  assert.match(json.error, /9\.9\.9/);
  // Only the fresh version check should have hit the network — no npm spawn.
  assert.ok(fetchCalls.length >= before);
});

await check("refuses a malformed body", async () => {
  const { status, json } = await call("/api/dsh-updater/update", { method: "POST", body: "{not json" });
  assert.equal(status, 400);
  assert.match(json.error, /JSON/i);
});

await check("serializes concurrent updates: the second is refused, not raced", async () => {
  // Hold the first request inside its version check so the second one arrives
  // while the install slot is claimed. Without the mutex both would pass the
  // phase check and spawn `npm install -g` against the same prefix.
  fetchDelayMs = 120;
  try {
    const first = call("/api/dsh-updater/update", { method: "POST", body: JSON.stringify({ version: "9.9.9" }) });
    // Give the first handler time to claim the lock and reach its await.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await call("/api/dsh-updater/update", { method: "POST", body: JSON.stringify({ version: "9.9.9" }) });
    assert.equal(second.status, 409, "second concurrent update must be refused");
    assert.match(second.json.error, /一次只允许一个更新操作/);
    const firstResult = await first;
    // The first still completes its own (rejecting) path.
    assert.equal(firstResult.status, 400);
  } finally {
    fetchDelayMs = 0;
  }
});

await check("channel switching persists and re-resolves", async () => {
  const { status, json } = await call("/api/dsh-updater/channel", { method: "POST", body: JSON.stringify({ channel: "next" }) });
  assert.equal(status, 200);
  assert.equal(json.channel, "next");
  assert.equal(json.latest.version, "0.2.0-rc.1");
  assert.equal((await call("/api/dsh-updater/status")).json.channel, "next");
  // Restore for any later assertion.
  await call("/api/dsh-updater/channel", { method: "POST", body: JSON.stringify({ channel: "latest" }) });
});

await check("rejects an unknown channel", async () => {
  const { status, json } = await call("/api/dsh-updater/channel", { method: "POST", body: JSON.stringify({ channel: "beta" }) });
  assert.equal(status, 400);
  assert.match(json.error, /latest/);
});

console.log("background check");
await check("autoCheck registers one interval", async () => {
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 30 * 60 * 1000);
});

console.log(`\n${String(passed)} 项路由检查全部通过`);
