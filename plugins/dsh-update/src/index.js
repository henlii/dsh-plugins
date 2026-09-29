// dsh-update host half — check the dsh release channels and apply an in-place
// npm upgrade, then restart the running instance.
//
// Why this exists: `dsh` has no self-update subcommand (`dsh --help` only boots
// profiles and `dsh plugin add`s packages), so keeping a deployment current
// means hand-running `npm install -g @deepseek-ai/dsh@<tag>` and restarting the
// service. This plugin does both from the Web GUI and shows which source each
// version fact came from.
//
// Version sources (checked independently, the freshest wins; every result
// carries its origin so the card can name it):
//   registry  — npm dist-tags for @deepseek-ai/dsh, read from whatever
//               registry `npm config get registry` resolves to (mirrors are
//               common; hitting registry.npmjs.org while npm installs from a
//               mirror is exactly the mismatch this plugin avoids).
//   github    — release tags `dsh-v*` on deepseek-ai/deepseek-harness, used as
//               the channel list, the release notes, and the fallback when the
//               registry is unreachable.
//
// Routes (all JSON; POSTs are same-origin fenced):
//   GET  /api/dsh-update/status     current version, channel, latest per source
//   GET  /api/dsh-update/versions   release history, optionally ?q= filtered
//   POST /api/dsh-update/check      force a fresh check (bypasses the cache)
//   POST /api/dsh-update/channel    switch latest | next | alpha
//   POST /api/dsh-update/update     npm install a version in place
//                                    (default: the selected channel; body
//                                     { version } pins any release from the list)
//   POST /api/dsh-update/restart    restart the running dsh service
//
// Only the dsh launcher itself is restarted, and only when the operator asks
// for it. The plugin never touches the profile tree.
//
// The upgrade is staged rather than applied in place. An npm-global tree is
// installed into a throwaway prefix first, verified (the version it claims, plus
// every asset the web bundle's index.html references), and only then swapped in
// with two renames. Installing in place is what made an interrupted run
// dangerous: npm deletes part of the live tree before it writes the new one, and
// the RUNNING process serves those files straight off disk, so a failed install
// reached the browser as a blank page.
import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const name = "dsh-update";
const inject = ["webServer", "timer"];

const ROUTE_PREFIX = "/api/dsh-update";
const PACKAGE_NAME = "@deepseek-ai/dsh";
const REPO = "deepseek-ai/deepseek-harness";
const TAG_PREFIX = "dsh-v";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

// Channels are npm dist-tags, in the order the card shows them. `latest` is the
// release candidate a normal deployment should follow; `next` and `alpha` can
// jump a minor version, which the card says out loud.
const CHANNELS = ["latest", "next", "alpha"];
const DEFAULT_CHANNEL = "latest";

// Version facts change on the order of days, so a 10 minute cache keeps the card
// instant without ever showing a stale answer to a deliberate re-check.
const CHECK_TTL_MS = 10 * 60 * 1000;
const GITHUB_TTL_MS = 10 * 60 * 1000;
// Auto-check cadence. Long on purpose: the point is to notice a release during a
// work session, not to poll CI.
const AUTO_CHECK_MS = 30 * 60 * 1000;

// npm install of a 200 MB+ dependency tree over a slow mirror is normal; a fixed
// wall-clock timeout kills healthy downloads. Reset 10 minutes of *silence*
// instead.
const UPDATE_IDLE_MS = 10 * 60 * 1000;

// ── paths ────────────────────────────────────────────────────────────────────

function dshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME;
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "dsh");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "dsh");
}

function stateFile() {
  return join(dshHome(), "dsh-update-state.json");
}

// ── small utilities ──────────────────────────────────────────────────────────

function readJsonFile(file) {
  try {
    const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Write via a temp file + rename so a crash mid-write cannot leave a truncated
// state file (which would silently reset the operator's channel choice).
function writeJsonFile(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch {
    /* state is a convenience; losing it must never break a route */
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

// Fence for the mutating routes.
//
// Two independent checks, because either one alone is insufficient:
//
//  1. The host's own fence (`connection.requestRejection`) is the authority on
//     who may reach API routes. These routes are registered `kind: "exact"`, and
//     WebServer.match() consults the exact table before the `/api` prefix route
//     that carries dsh's fence — so the official check does NOT run for them and
//     must be invoked explicitly. Official plugins with exact `/api` routes do
//     the same. Absent service ⇒ no opinion, fall through to check 2.
//  2. `sameOrigin`, which rejects a browser request whose Origin is a different
//     site. Crucially it compares the FULL authority (hostname + port): a
//     hostname-only comparison also matches a page served from another port on
//     the same host (`http://127.0.0.1:9999` vs `Host: 127.0.0.1:3080`), which is
//     attacker-reachable and defeats CORS only nominally. `Sec-Fetch-Site` is
//     honoured too, since a cross-site simple POST carries it and needs no
//     preflight.
//
// Non-browser callers (curl) send no Origin and are allowed through: they are
// already subject to the deployment's own API fence.
function sameOrigin(req) {
  // A cross-site browser request must never mutate: the header is set by the
  // browser and cannot be forged by page script.
  const fetchSite = req.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite.toLowerCase() === "cross-site") return false;

  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return true;
  if (origin === "null") return false;

  let originHost;
  let originProtocol;
  try {
    const parsed = new URL(origin);
    originHost = parsed.host;
    originProtocol = parsed.protocol;
  } catch {
    return false;
  }
  const target = req.headers.host;
  if (typeof target !== "string" || target.length === 0) return false;

  // Exact authority match wins outright (covers the GUI's own requests).
  if (originHost === target) return true;

  // A default port may be omitted on either side; compare full host:port after
  // filling it in, so `http://h` matches `h:80` but never `h:9999`.
  const defaultPort = originProtocol === "https:" ? "443" : "80";
  const withPort = (authority) => {
    const idx = authority.lastIndexOf(":");
    // `lastIndexOf` keeps IPv6 literals ([::1]:3080) intact; a bare IPv6 literal
    // without a port falls back to the default.
    if (idx > 0 && !authority.slice(idx + 1).includes("]")) return authority;
    if (authority.endsWith("]")) return `${authority}:${defaultPort}`;
    return idx > 0 ? authority : `${authority}:${defaultPort}`;
  };
  return withPort(originHost) === withPort(target);
}

// Whether a mutating request may proceed: the host fence first, then sameOrigin.
function requestRejection(ctx, req) {
  const connection = ctx.get("connection");
  if (connection !== void 0 && typeof connection.requestRejection === "function") {
    const rejection = connection.requestRejection(req);
    if (rejection !== void 0) return rejection;
  }
  return sameOrigin(req) ? void 0 : 403;
}

async function fetchJson(url, timeoutMs, extraHeaders) {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": `${name} (dsh plugin)`, ...(extraHeaders || {}) },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, json: null };
    return { ok: true, error: null, json: await res.json() };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), json: null };
  }
}

// Semver comparison that understands prereleases: 0.1.7-rc.2 < 0.1.7, and
// 0.2.0-rc.1 > 0.1.7-rc.2. Returns >0 when a is newer than b.
//
// The pattern is ANCHORED and the trailing characters are rejected: a prefix
// match would accept `0.1.7-rc.2; rm -rf /` or `0.1.7-../../../../tmp/evil`, and
// those strings reach npm as `${PACKAGE_NAME}@<version>`. `shell:false` keeps
// shell metacharacters inert, but npm parses such a spec as a DIRECTORY spec —
// verified: `npm i -g '@deepseek-ai/dsh@0.1.7-../../../../tmp/evil'` creates
// `dsh -> ../../../../tmp/evil`. GitHub release tags are attacker-influenced
// external input that lands in this same function, so the whole string must be a
// valid version.
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(value) {
  const m = VERSION_PATTERN.exec(String(value || "").trim());
  if (m === null) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : null };
}

// A version string is only usable when the canonical rendering of what was
// parsed equals the input EXACTLY. Comparison is against the raw string, not a
// trimmed copy: a caller that keeps the original value (a GitHub tag becomes a
// list row verbatim) would otherwise pass a `"0.1.7 "` through validation and
// then splice the untrimmed string into the npm spec.
function isCanonicalVersion(value) {
  if (typeof value !== "string") return false;
  const parsed = parseVersion(value);
  if (parsed === null) return false;
  const canonical = `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}` +
    (parsed.pre !== null ? `-${parsed.pre.join(".")}` : "");
  return canonical === value;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
  }
  // A release outranks any prerelease of the same version.
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === void 0) return -1;
    if (y === void 0) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // numeric identifiers sort below alphanumeric ones
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

// ── the running install ──────────────────────────────────────────────────────

// Version of the dsh copy this process is running from. Read from the package
// manifest next to the launcher rather than a hardcoded constant, so the card is
// truthful even when several dsh copies exist on the box.
//
// When this plugin is installed from a profile, the module URL resolves through
// `profiles/<name>/node_modules/<pkg>` — but `import.meta.url` is a *symlink* in
// the common `link:` / `file:` install shape used for local development, and its
// realpath points at wherever the package actually lives (a git checkout, which
// is nowhere near the prefix). So both the raw and the resolved path are walked,
// and the raw one finds dsh in `<profile>/node_modules` when the plugin was
// installed beside it.
function walkUpForDsh(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12; i += 1) {
    const pkg = readJsonFile(join(dir, "package.json"));
    if (pkg !== null && pkg.name === PACKAGE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function runningDshRoot() {
  try {
    const url = fileURLToPath(import.meta.url);
    for (const start of [dirname(url), dirname(realpathSync(url))]) {
      const found = walkUpForDsh(start);
      if (found !== null) return found;
    }
    return null;
  } catch {
    return null;
  }
}

// The launcher's own path. On a normal install `process.argv[1]` is a *symlink*
// (`<prefix>/bin/dsh` → `<prefix>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`),
// so both the raw path and its realpath are walked; the raw one matters for a
// profile entry, the realpath for a global install.
function launcherDshRoot() {
  const argv1 = process.argv[1];
  const starts = [];
  if (typeof argv1 === "string" && argv1.length > 0) {
    starts.push(dirname(argv1));
    try {
      starts.push(dirname(realpathSync(argv1)));
    } catch {
      /* a vanished entry: the raw walk above still applies */
    }
  }
  // The running node gives the prefix even when argv[1] is unhelpful:
  // <prefix>/bin/node → <prefix>/lib/node_modules/@deepseek-ai/dsh.
  const nodeDir = dirname(process.execPath);
  if (existsSync(join(nodeDir, "..", "lib", "node_modules", PACKAGE_NAME, "package.json"))) {
    starts.push(join(nodeDir, "..", "lib", "node_modules", PACKAGE_NAME));
  }
  for (const start of starts) {
    const found = walkUpForDsh(start);
    if (found !== null) return found;
  }
  return null;
}

// ── which install is this, and who owns it? ──────────────────────────────────
//
// The update command has to match how THIS copy was installed. Running
// `npm install -g` against a pnpm- or yarn-managed tree (or another prefix)
// either fails or writes a second copy that the running process never reads.
//
// Detection is by path shape plus ownership probes, never by marker files alone:
// an npm global tree only gets `.package-lock.json` when `package-lock` is on,
// and on this host it is absent while the install is nevertheless npm's. Asking
// each manager what it owns is the reliable signal; path shape decides the
// candidate order.
const MANAGERS = ["npm", "pnpm", "yarn", "bun"];

// Resolve a manager executable. npm prefers the CLI script beside the running
// node (nvm prefixes ship one, so the right npm is used even when PATH points at
// another install); the others are looked up on PATH.
function resolveManagerBinary(manager) {
  if (manager === "npm") {
    const cli = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(cli)) return { argv: [process.execPath], cliJs: cli, display: `node ${cli}` };
    if (process.platform === "win32") {
      const sibling = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm", "node_modules", "npm", "bin", "npm-cli.js");
      if (existsSync(sibling)) return { argv: [process.execPath], cliJs: sibling, display: `node ${sibling}` };
    }
    return commandOnPath("npm");
  }
  return commandOnPath(manager);
}

function commandOnPath(name) {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(probe, [name], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (out.length > 0) return { argv: [out[0]], cliJs: null, display: out[0] };
  } catch {
    /* not on PATH */
  }
  return null;
}

// Ask a manager whether the running package root belongs to its global tree.
//
// This compares PATHS, never the presence of the package name: `npm ls -g
// --json` reports only `{"name":"lib","dependencies":{"@deepseek-ai/dsh":
// {"version":"…"}}}` — no filesystem path — so a name test would answer "yes"
// for ANY root whenever that npm prefix happens to contain a dsh, and with
// several copies on the box the update would be aimed at the wrong one. Each
// manager is asked for its own global root, and the running root must live
// under the corresponding node_modules.
function managerGlobalNodeModules(manager) {
  const prefix = queryManagerPrefix(manager);
  if (prefix === null) return [];
  if (manager === "npm") {
    // npm prefix P → packages under P/lib/node_modules (POSIX) or
    // P/node_modules (Windows).
    return [join(prefix, "lib", "node_modules"), join(prefix, "node_modules")];
  }
  if (manager === "pnpm") {
    // `pnpm root -g` answers <PNPM_HOME>/global/<major>; packages live one hash
    // directory deeper, so any directory at that depth qualifies.
    return [prefix];
  }
  if (manager === "yarn") {
    // `yarn global dir` answers the project root; packages under node_modules.
    return [join(prefix, "node_modules")];
  }
  // bun: `bun pm bin -g` answers the bin directory, one level beside install/global.
  return [join(dirname(prefix), "install", "global", "node_modules"), join(prefix, "node_modules")];
}

function managerOwns(manager, root) {
  const scopeDir = dirname(root); // <node_modules>/@scope
  const nodeModules = dirname(scopeDir); // <node_modules>
  const roots = managerGlobalNodeModules(manager);
  if (roots.length === 0) return false;
  return roots.some((candidate) => {
    if (manager !== "pnpm") return nodeModules === candidate;
    // pnpm's global root is the version directory, and the real node_modules sits
    // under a per-project hash: <root>/<hash>/node_modules.
    return nodeModules.startsWith(candidate + sep) && nodeModules.endsWith(`${sep}node_modules`);
  });
}

// Ask a manager for its global prefix (`npm prefix -g`, `pnpm root -g`, ...).
// Used to recognize an install whose path shape differs per platform — most
// importantly npm on Windows, where the global root has no `lib` component.
// Returns a normalized absolute path, or null when the manager cannot answer.
//
// Memoized: this is a synchronous subprocess on the request path, and on Windows
// it is consulted for every `/status` poll. Cleared by a forced check.
const prefixCache = new Map();

function queryManagerPrefix(manager) {
  if (prefixCache.has(manager)) return prefixCache.get(manager);
  const value = queryManagerPrefixUncached(manager);
  prefixCache.set(manager, value);
  return value;
}

function queryManagerPrefixUncached(manager) {
  const bin = resolveManagerBinary(manager);
  if (bin === null) return null;
  const args = bin.cliJs !== null ? [bin.cliJs] : [];
  const tail = manager === "npm"
    ? ["prefix", "-g"]
    : manager === "pnpm"
      ? ["root", "-g"]
      : manager === "yarn"
        ? ["global", "dir"]
        : ["pm", "bin", "-g"];
  try {
    const out = execFileSync(bin.argv[0], [...args, ...tail], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env
    }).trim();
    if (out.length === 0 || out.includes("\n")) return null;
    // npm's prefix is the directory above `lib`; the package root is under
    // `<prefix>/lib/node_modules` on POSIX, so compare against the node_modules
    // parent that the caller derived.
    return stripSlash(out);
  } catch {
    return null;
  }
}

// Classify the running copy from its path, then confirm the owner. Returns the
// layout, the directory the update must target, and the manager to invoke.
//
// `root` is the package directory, i.e. `<node_modules>/@deepseek-ai/dsh`. The
// scope costs an extra path segment, so `node_modules` is two levels up, not one;
// missing that made the npm-global branch compare `.../node_modules` against the
// `lib` suffix and fall through to "unknown".
function classifyInstall(root) {
  const scopeDir = dirname(root); // <node_modules>/@deepseek-ai
  const nodeModules = dirname(scopeDir); // <node_modules>
  const container = dirname(nodeModules); // the directory holding node_modules

  // pnpm global: <PNPM_HOME>/global/<major>/<hash>/node_modules/@deepseek-ai/dsh
  // `container` is the hash directory, so PNPM_HOME is three levels up
  // (hash → <major> → global → PNPM_HOME).
  if (existsSync(join(container, "pnpm-lock.yaml")) && /(^|[\\/])global([\\/]|$)/.test(container)) {
    return { manager: "pnpm", layout: "pnpm-global", dir: container, pnpmHome: dirname(dirname(dirname(container))) };
  }
  // yarn v1 global: <dir>/node_modules/@deepseek-ai/dsh where <dir> ends in yarn/global
  if (/(^|[\\/])yarn[\\/]global$/.test(container)) {
    return { manager: "yarn", layout: "yarn-global", dir: container };
  }
  // bun global: <bunHome>/install/global/node_modules/@deepseek-ai/dsh
  if (/(^|[\\/])install[\\/]global$/.test(container)) {
    return { manager: "bun", layout: "bun-global", dir: container };
  }
  // profile-local: <DSH_HOME>/profiles/<name>/node_modules/@deepseek-ai/dsh
  if (/(^|[\\/])profiles[\\/][^\\/]+$/.test(container)) {
    return { manager: "pnpm", layout: "profile", dir: container, profileDir: container };
  }
  // npm global on POSIX: <prefix>/lib/node_modules/@deepseek-ai/dsh
  //
  // The `--prefix` value is the directory ABOVE `lib`, not `lib` itself: npm
  // resolves a global prefix P to P/lib/node_modules, so passing the `lib`
  // directory installs into P/lib/lib/node_modules and leaves the running copy
  // untouched. Verified against npm 11:
  //   npm install -g is-odd --prefix P     → P/lib/node_modules/is-odd
  //   npm install -g is-odd --prefix P/lib → P/lib/lib/node_modules/is-odd
  // `container` is already `.../lib`, so the prefix is its parent.
  if (/(^|[\\/])lib$/.test(container)) {
    const prefix = dirname(container);
    return { manager: "npm", layout: "npm-global", dir: prefix, prefix };
  }
  // Anything left that npm itself claims is an npm global install. On Windows
  // there is no `lib` component (the root is `%APPDATA%\npm\node_modules`), so
  // the path shape alone cannot identify it; asking npm is authoritative. Kept
  // last so the common POSIX path never pays for the extra process.
  const npmPrefix = queryManagerPrefix("npm");
  if (npmPrefix !== null && container === npmPrefix) {
    return { manager: "npm", layout: "npm-global", dir: container, prefix: container };
  }
  // Fall back to whichever manager admits ownership. `dir` is deliberately left
  // unset: `dir` feeds `--prefix`, and `scopeDir` is `<node_modules>/@scope`, NOT
  // an install root. Passing it would make npm install into
  // `<...>/@deepseek-ai/lib/node_modules` — a stray tree that leaves the running
  // copy untouched. Without a trustworthy target the update route refuses and
  // hands over the manual command instead of guessing.
  for (const manager of MANAGERS) {
    if (managerOwns(manager, root)) return { manager, layout: `${manager}-global`, dir: null };
  }
  return { manager: "npm", layout: "unknown", dir: null, prefix: null };
}

// A dsh source checkout: the launcher lives inside a workspace whose root has
// `pnpm-workspace.yaml`. Updating it is a git + install job, not a package
// manager install, and the card must say so instead of pretending.
//
// The `node_modules` test is what keeps this from misfiring: an installed copy
// ALWAYS sits under a `node_modules`, so a git repo containing `DSH_HOME`
// (dotfiles managing `.dsh/`, common in practice) or a repo that merely happens
// to carry a `pnpm-workspace.yaml` can no longer be mistaken for the source tree
// and block updates on a perfectly normal profile install. A real checkout has
// the package outside any `node_modules`.
function detectSourceCheckout(root) {
  if (/(^|[\\/])node_modules([\\/]|$)/.test(root)) return null;
  let dir = root;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// The dsh copy this process runs from, plus how to update it.
//
// Memoized between forced checks: detection walks paths and shells out for
// manager queries, and it is called more than once per `/status` request. The
// version is re-read from disk on every call by design (the post-install check
// must observe a new version), so only the shape detection is cached.
let installCache = null;

function dshInstall() {
  let root = null;
  for (const locate of [launcherDshRoot, runningDshRoot]) {
    const found = locate();
    if (found !== null && found !== void 0) {
      root = found;
      break;
    }
  }
  if (root === null) return null;
  const pkg = readJsonFile(join(root, "package.json"));
  const version = pkg !== null && typeof pkg.version === "string" ? pkg.version : null;
  if (version === null) return null;

  const sourceRepo = detectSourceCheckout(root);
  if (sourceRepo !== null) {
    return { root, version, manager: "source", layout: "source", dir: sourceRepo, sourceRepo, prefix: null, binary: null };
  }

  // Cache the SHAPE, not the version: the version is re-read above on every call
  // so the post-install verification observes the new one, while classification
  // (which may shell out to a manager) is stable for the process lifetime.
  if (installCache === null || installCache.root !== root) {
    const detected = classifyInstall(root);
    const binary = resolveManagerBinary(detected.manager);
    installCache = {
      root,
      manager: detected.manager,
      layout: detected.layout,
      dir: detected.dir,
      prefix: detected.prefix || null,
      pnpmHome: detected.pnpmHome || null,
      profileDir: detected.profileDir || null,
      binary,
      // A detected manager whose executable is missing cannot be used at all. The
      // card reports this rather than silently switching tools.
      usable: binary !== null && detected.manager !== "source"
    };
  }
  return { ...installCache, version };
}

// Registry the owning manager itself would use, so check and install agree.
//
// Resolution shells out synchronously (~140 ms measured here) and is reachable
// from every `/status` poll; the GUI polls every 2 s during an install, so
// recomputing it per request would hold the event loop for a large slice of each
// poll. The answer only changes when the operator edits their manager config, so
// it is cached and cleared whenever a forced check runs.
let registryCache = null; // { key, value }

function registryBase(install) {
  const fromEnv = process.env.npm_config_registry;
  if (typeof fromEnv === "string" && /^https?:\/\//.test(fromEnv)) return stripSlash(fromEnv);
  const manager = install !== null && install !== void 0 ? install.manager : "npm";
  const resolved = resolveManagerBinary(manager === "source" ? "pnpm" : manager);
  const key = resolved !== null ? resolved.display : manager;
  if (registryCache !== null && registryCache.key === key) return registryCache.value;
  let value = DEFAULT_REGISTRY;
  if (resolved !== null) {
    const args = resolved.cliJs !== null ? [resolved.cliJs] : [];
    try {
      const out = execFileSync(resolved.argv[0], [...args, "config", "get", "registry"], {
        encoding: "utf8",
        timeout: 15000,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      if (/^https?:\/\//.test(out)) value = stripSlash(out);
    } catch {
      /* fall through to the public registry */
    }
  }
  registryCache = { key, value };
  return value;
}

function stripSlash(url) {
  return url.replace(/\/+$/, "");
}

// ── version sources ──────────────────────────────────────────────────────────

// One request answers everything the registry can tell us: the dist-tags and the
// full version list with publish times. The complete packument is ~200 KB, which
// is heavy for a status card, so the abbreviated form (`Accept:
// application/vnd.npm.install-v1+json`, ~150 KB and no `time` map) is used and
// the publish date is filled in from GitHub where available.
async function checkRegistry() {
  const base = registryBase(dshInstall());
  const res = await fetchJson(`${base}/${encodeURIComponent(PACKAGE_NAME)}`, 15000, {
    Accept: "application/vnd.npm.install-v1+json, application/json"
  });
  if (!res.ok || res.json === null) {
    return { ok: false, source: base, error: res.error || "empty response", tags: {}, versions: [], times: {} };
  }
  const tags = {};
  const rawTags = res.json["dist-tags"];
  if (rawTags !== null && typeof rawTags === "object") {
    for (const [tag, version] of Object.entries(rawTags)) {
      if (typeof version === "string") tags[tag] = version;
    }
  }
  const times = {};
  const rawTimes = res.json.time;
  if (rawTimes !== null && typeof rawTimes === "object") {
    for (const [version, at] of Object.entries(rawTimes)) {
      if (typeof at === "string") times[version] = at;
    }
  }
  const rawVersions = res.json.versions;
  const versions = rawVersions !== null && typeof rawVersions === "object" ? Object.keys(rawVersions) : [];
  return { ok: true, source: base, error: null, tags, versions, times };
}

// GitHub release tags are the second, independent source: they expose tags the
// registry may not have mirrored yet, and they carry the release notes.
async function checkGithub() {
  const res = await fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=15`, 15000);
  if (!res.ok || !Array.isArray(res.json)) {
    return { ok: false, error: res.error || "unexpected response", releases: [], tags: {} };
  }
  const releases = [];
  const tags = {};
  for (const rel of res.json) {
    if (rel === null || typeof rel !== "object") continue;
    const tag = typeof rel.tag_name === "string" ? rel.tag_name : "";
    if (!tag.startsWith(TAG_PREFIX)) continue;
    const version = tag.slice(TAG_PREFIX.length);
    // A tag is external input: only a canonical version may become a list row.
    if (!isCanonicalVersion(version)) continue;
    releases.push({
      version,
      name: typeof rel.name === "string" && rel.name.length > 0 ? rel.name : tag,
      url: typeof rel.html_url === "string" ? rel.html_url : `https://github.com/${REPO}/releases/tag/${tag}`,
      publishedAt: typeof rel.published_at === "string" ? rel.published_at : "",
      notes: typeof rel.body === "string" ? rel.body.slice(0, 1200) : "",
      prerelease: rel.prerelease === true
    });
  }
  // Tag → newest channel-ish guess. GitHub does not publish dist-tags, so map by
  // prerelease identifier: -alpha.→alpha, anything else prerelease→next.
  for (const rel of releases) {
    if (rel.prerelease && rel.version.includes("-alpha.")) tags.alpha = pickNewer(tags.alpha, rel.version);
    else if (rel.prerelease) tags.next = pickNewer(tags.next, rel.version);
    else tags.latest = pickNewer(tags.latest, rel.version);
  }
  return { ok: true, error: null, releases, tags };
}

function pickNewer(current, candidate) {
  if (typeof current !== "string" || current.length === 0) return candidate;
  return compareVersions(candidate, current) > 0 ? candidate : current;
}

// Merge both sources per channel and say where the winning fact came from.
function resolveChannels(registry, github) {
  const resolved = {};
  for (const channel of CHANNELS) {
    const fromRegistry = registry.ok && typeof registry.tags[channel] === "string" ? registry.tags[channel] : null;
    const fromGithub = github.ok && typeof github.tags[channel] === "string" ? github.tags[channel] : null;
    let version = fromRegistry;
    let source = fromRegistry !== null ? "registry" : null;
    if (fromGithub !== null && (version === null || compareVersions(fromGithub, version) > 0)) {
      version = fromGithub;
      source = fromRegistry !== null ? "registry+github" : "github";
    }
    resolved[channel] = { version, source };
  }
  return resolved;
}

// The release history the card lists: every version the registry knows, newest
// first, annotated with the channel tags pointing at it and the release notes
// GitHub has for it. Registry versions are authoritative for "installable";
// GitHub-only versions are still offered (npm can resolve a tag the mirror has
// not indexed yet) and flagged.
const VERSION_LIST_LIMIT = 40;

function buildVersionList(registry, github) {
  const byVersion = new Map();
  const ensure = (version) => {
    let row = byVersion.get(version);
    if (row === void 0) {
      row = { version, at: null, prerelease: parseVersion(version) !== null && parseVersion(version).pre !== null, tags: [], notes: null, url: null, onRegistry: false, onGithub: false };
      byVersion.set(version, row);
    }
    return row;
  };

  if (registry.ok) {
    for (const version of registry.versions) {
      if (!isCanonicalVersion(version)) continue;
      const row = ensure(version);
      row.onRegistry = true;
      row.at = registry.times[version] || row.at;
    }
    for (const [tag, version] of Object.entries(registry.tags)) {
      if (!isCanonicalVersion(version)) continue;
      const row = ensure(version);
      if (!row.tags.includes(tag)) row.tags.push(tag);
    }
  }

  if (github.ok) {
    for (const rel of github.releases) {
      // Re-checked here rather than trusting the caller: this function is the last
      // gate before a version can be rendered in the card and then installed, and
      // its input is external (GitHub). A non-canonical string must never become a
      // list row, whatever upstream did.
      if (!isCanonicalVersion(rel.version)) continue;
      const row = ensure(rel.version);
      row.onGithub = true;
      if (row.at === null) row.at = rel.publishedAt || null;
      row.notes = rel.notes || row.notes;
      row.url = rel.url || row.url;
      row.prerelease = rel.prerelease;
    }
  }

  const list = [...byVersion.values()];
  list.sort((a, b) => {
    const cmp = compareVersions(b.version, a.version);
    if (cmp !== 0) return cmp;
    return a.version > b.version ? 1 : -1;
  });
  // Channel tags are the deployment-relevant labels; GitHub's own `latest` flag
  // on a prerelease must not relabel it, so prerelease is recomputed from tags.
  for (const row of list) {
    if (row.tags.length > 0) row.prerelease = row.tags.includes("latest") ? false : row.prerelease;
  }
  return list.slice(0, VERSION_LIST_LIMIT);
}

// Resolve one requested version against what the sources actually offer. The
// card may post a dist-tag (`latest`) or an exact version; anything else is
// rejected here rather than handed to npm, so a typo cannot become an install of
// some unrelated package state.
function resolveRequestedVersion(requested, data) {
  const wanted = String(requested || "").trim();
  if (wanted.length === 0) return { ok: false, error: "版本号不能为空" };
  if (CHANNELS.includes(wanted)) {
    const entry = data.channels[wanted];
    if (entry === null || entry === void 0 || typeof entry.version !== "string") {
      return { ok: false, error: `通道 ${wanted} 当前没有可用版本` };
    }
    return { ok: true, version: entry.version, via: `tag:${wanted}` };
  }
  const bare = wanted.replace(/^v/, "");
  // Must be a canonical version, not merely version-shaped: a prefix match here
  // is what would let a crafted string through to the npm spec position.
  if (!isCanonicalVersion(bare)) return { ok: false, error: `不是合法的版本号或通道：${wanted}` };
  const known = data.versions.find((row) => row.version === bare);
  if (known === void 0) {
    return { ok: false, error: `源里没有 ${bare} 这个版本（可用版本见列表）` };
  }
  return { ok: true, version: bare, via: "version" };
}

// ── check state ──────────────────────────────────────────────────────────────

let checkCache = null; // { at, data }
let githubCache = null; // { at, data }
let checkInFlight = null;

async function checkGithubCached() {
  const now = Date.now();
  if (githubCache !== null && now - githubCache.at < GITHUB_TTL_MS) return githubCache.data;
  const data = await checkGithub();
  githubCache = { at: now, data };
  return data;
}

async function runCheck(force) {
  const now = Date.now();
  if (!force && checkCache !== null && now - checkCache.at < CHECK_TTL_MS) return checkCache.data;
  if (checkInFlight !== null) return checkInFlight;
  checkInFlight = (async () => {
    // A forced check means "re-read the world", so drop the memoized registry and
    // any manager lookup alongside the version cache they belong to.
    if (force === true) {
      registryCache = null;
      installCache = null;
      prefixCache.clear();
    }
    const [registry, github] = await Promise.all([checkRegistry(), checkGithubCached()]);
    const install = dshInstall();
    const channels = resolveChannels(registry, github);
    const data = {
      checkedAt: new Date().toISOString(),
      current: install !== null ? install.version : null,
      installRoot: install !== null ? install.root : null,
      prefix: install !== null ? install.prefix : null,
      registry: { ok: registry.ok, base: registry.source, error: registry.error },
      github: { ok: github.ok, error: github.error, releases: github.releases.slice(0, 5) },
      channels,
      versions: buildVersionList(registry, github)
    };
    checkCache = { at: Date.now(), data };
    return data;
  })();
  try {
    return await checkInFlight;
  } finally {
    checkInFlight = null;
  }
}

// ── update state (long running) ──────────────────────────────────────────────

// Mutex for the install slot. `state.phase` alone cannot serialize callers: the
// phase is only set after the version check (an await), so two concurrent
// requests would both observe "idle" and spawn npm against the same prefix.
// Claimed and released synchronously around the whole update route.
let installLocked = false;

const state = {
  channel: DEFAULT_CHANNEL,
  phase: "idle", // idle | installing | done | failed
  target: null,
  startedAt: null,
  finishedAt: null,
  log: [],
  error: null,
  versionBefore: null,
  versionAfter: null,
  restart: null, // { at, mode, ok, error }
  autoRestart: null // { at, ok, error, mode } — the post-install automatic restart
};

function pushLog(line) {
  state.log.push(line);
  if (state.log.length > 120) state.log.splice(0, state.log.length - 120);
}

function persistedConfig() {
  return readJsonFile(stateFile()) || {};
}

function saveChannel(channel) {
  const next = { ...persistedConfig(), channel };
  writeJsonFile(stateFile(), next);
}

// ── installing through the detected manager ──────────────────────────────────

// Build the update command for the detected install. Each manager needs a
// different verb, and each needs to be pinned at the tree we are actually running
// from: without that, the install lands in some other prefix and the running copy
// never changes.
//
// Only the detected manager is ever used. If it is missing, that is reported as a
// failure with the manual command, never worked around by silently picking a
// different tool — a wrong manager can leave a second, broken copy behind.
function buildInstallCommand(install, version, registry) {
  if (install === null || install === void 0 || install.binary === null) {
    return { error: `未找到可用的 ${install === null || install === void 0 ? "" : install.manager} 命令` };
  }
  const spec = `${PACKAGE_NAME}@${version}`;
  const cliPrefix = install.binary.cliJs !== null ? [install.binary.cliJs] : [];
  const base = [install.binary.argv[0], ...cliPrefix];

  if (install.layout === "npm-global") {
    // `-g` must be the FLAG, and `--prefix` must precede the spec: written as a
    // bare `global` positional, npm treats it as one more package to install
    // (downloading the unrelated `global@4.x`), and — worse — `--prefix` then
    // makes it a LOCAL install rooted at the prefix, so nothing global is
    // updated at all. Verified against npm 11:
    //   npm install global is-odd --prefix P  → P/node_modules/{global,is-odd}
    //   npm install -g is-odd --prefix P      → P/lib/node_modules/is-odd
    return {
      argv: [...base, "install", "-g", spec, "--prefix", install.dir, "--registry", registry, "--no-audit", "--no-fund"],
      display: `npm install -g ${spec} --prefix ${install.dir}`
    };
  }
  if (install.layout === "pnpm-global") {
    return {
      argv: [...base, "add", "--global", spec, "--registry", registry],
      display: `pnpm add -g ${spec}`,
      env: install.pnpmHome !== null ? { PNPM_HOME: install.pnpmHome } : null
    };
  }
  if (install.layout === "yarn-global") {
    return {
      argv: [...base, "global", "add", spec, "--registry", registry],
      display: `yarn global add ${spec}`
    };
  }
  if (install.layout === "bun-global") {
    return {
      argv: [...base, "add", "--global", spec, "--registry", registry],
      display: `bun add -g ${spec}`
    };
  }
  if (install.layout === "profile") {
    // A profile's own dependencies belong to its pnpm project; `dsh plugin`
    // reconciles the manifest, so that is the command that keeps it consistent.
    return {
      argv: [...base, "add", spec, "--registry", registry],
      display: `(在 ${install.dir} 内) pnpm add ${spec}`,
      cwd: install.dir
    };
  }
  // Unknown shape: refuse rather than guess, and hand over the command to run.
  return {
    error: `无法判定安装方式（路径 ${install.root}）；请手动执行：npm install -g ${spec}`
  };
}

// Run one manager command to completion, streaming its output to `onLog`.
//
// The idle timer resets on every line of output. A fixed wall-clock timeout would
// kill a healthy 200 MB download over a slow mirror, while ten minutes of total
// silence means the install is genuinely stuck.
function runCommand(argv, options, onLog) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        // Never run in $HOME: if a manager ever falls back to a local install, the
        // damage must land somewhere disposable rather than writing node_modules,
        // package.json, and package-lock.json into the home directory. The global
        // layouts all name their target explicitly, so cwd is only a safety net.
        cwd: options.cwd !== void 0 ? options.cwd : tmpdir(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: options.env !== void 0 ? options.env : process.env
      });
    } catch (err) {
      resolve({ ok: false, code: -1, error: err && err.message ? err.message : String(err) });
      return;
    }

    const armIdle = () => setTimeout(() => {
      pushLog(`安装静默超过 ${Math.round(UPDATE_IDLE_MS / 60000)} 分钟，已终止`);
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }, UPDATE_IDLE_MS);

    let idle = armIdle();
    const bump = (chunk) => {
      clearTimeout(idle);
      idle = armIdle();
      for (const line of String(chunk).split(/\r?\n/)) {
        const text = line.trim();
        if (text.length > 0) onLog(text);
      }
    };

    child.stdout.on("data", bump);
    child.stderr.on("data", bump);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      resolve({ ok: false, code: -1, error: err && err.message ? err.message : String(err) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      resolve({ ok: code === 0, code, error: null });
    });
  });
}

// Install straight into the tree we are running from. Used for the layouts whose
// staging story differs per manager (pnpm / yarn / bun / profile), where the
// caller verifies the result afterwards instead.
async function runInstall(version, onLog) {
  const install = dshInstall();
  const registry = registryBase(install);
  const manager = install !== null ? install.manager : null;
  const plan = buildInstallCommand(install, version, registry);
  if (plan.error !== void 0) return { ok: false, code: -1, error: plan.error, manager };
  const env = plan.env !== null && plan.env !== void 0 ? { ...process.env, ...plan.env } : process.env;
  pushLog(`安装方式 ${install.layout} → ${plan.display}`);
  pushLog(`$ ${plan.argv.join(" ")}`);
  const result = await runCommand(plan.argv, { cwd: plan.cwd, env }, onLog);
  return { ...result, manager };
}

// ── staged upgrade ───────────────────────────────────────────────────────────

// npm reifies a global tree by renaming the directory it replaces to a hidden
// sibling, `.<name>-<random>`. A leftover of that shape (an earlier run
// interrupted before its own cleanup) makes the rename fail with ENOTEMPTY — and
// it fails AFTER npm has already deleted part of the live tree. Measured on this
// machine: 26110 files down to 7251, with both JS bundles that index.html
// references gone, which reaches the browser as a blank page.
//
// Leftovers are reported, never removed. In that same incident the leftover was
// the only intact copy of the running version, so deleting one automatically
// would destroy the recovery path.
function retireLeftovers(scopeDir) {
  let entries;
  try {
    entries = readdirSync(scopeDir);
  } catch {
    return [];
  }
  const base = PACKAGE_NAME.slice(PACKAGE_NAME.indexOf("/") + 1);
  return entries.filter((entry) => entry.startsWith(`.${base}-`)).sort();
}

// Why an update must be refused before anything is installed, or null when it may
// proceed.
//
// npm's leftover retire directories break npm's own next rename with ENOTEMPTY,
// and that failure lands after npm has deleted part of the live tree. They are
// reported instead of removed on purpose: the copy inside one can be the only
// intact install left (it was, in the incident that prompted this).
//
// The SCOPE directory is scanned — the parent of the package directory — because
// that is where npm parks both `.<name>-<random>` for dsh and the same shape for
// its `dsh-*` dependencies.
function updateRefusal(install) {
  if (install.layout !== "npm-global") return null;
  const scopeDir = dirname(install.root);
  const leftovers = retireLeftovers(scopeDir);
  if (leftovers.length === 0) return null;
  return `安装目录里有 npm 上次中断留下的目录：${leftovers.join("、")}（在 ${scopeDir}）。它可能是唯一一份完整副本，请先人工确认，再移走或改名后重试。`;
}

// What an HTML file points at, relative to itself, and whether each one is on
// disk. Null means the file could not be read at all.
//
// Only same-directory references count: an absolute URL belongs to another origin,
// while a missing local file is what breaks the page.
function localRefs(htmlPath) {
  let html;
  try {
    html = readFileSync(htmlPath, "utf8");
  } catch {
    return null;
  }
  const dir = dirname(htmlPath);
  return [...html.matchAll(/(?:src|href)="\.\/([^"?#]+)/g)]
    .map((match) => match[1])
    .map((rel) => ({ rel, present: existsSync(join(dir, rel)) }));
}

// Is the tree at `root` complete enough to serve? This is the check npm does not
// do: npm exits 0 for a tree whose client bundle is missing, and the only symptom
// is a blank page. The claimed version is checked too, so a tree that silently
// stayed on the old release cannot be swapped in as if it were the new one.
function verifyInstallTree(root, expectedVersion) {
  const pkg = readJsonFile(join(root, "package.json"));
  if (pkg === null) return { ok: false, error: `安装目录无法读取 package.json：${root}` };
  if (pkg.version !== expectedVersion) {
    return { ok: false, error: `版本不符：期望 ${expectedVersion}，实际 ${String(pkg.version)}` };
  }
  const htmlPath = join(root, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "index.html");
  const refs = localRefs(htmlPath);
  // Unreadable, or pointing at nothing local, is a FAILURE rather than "nothing to
  // check": every published dsh ships this frontend, and a tree without it serves a
  // blank page — the symptom this whole check exists to catch. Fail closed.
  if (refs === null) {
    return { ok: false, error: `读不到前端入口 ${htmlPath}（缺了它页面就是白屏）` };
  }
  if (refs.length === 0) {
    return { ok: false, error: `前端入口没有任何本地资源引用（${htmlPath}），无法确认页面能加载` };
  }
  const missing = refs.filter((ref) => !ref.present).map((ref) => ref.rel);
  if (missing.length > 0) {
    return { ok: false, error: `前端资源缺失 ${missing.length} 个（页面会白屏）：${missing.slice(0, 3).join("、")}` };
  }
  return { ok: true, error: null };
}

// The global root a manager wrote into `prefix`. POSIX layouts nest it under
// `lib/`, Windows does not — try both rather than assume one.
function globalRootIn(prefix) {
  const scope = PACKAGE_NAME.slice(0, PACKAGE_NAME.indexOf("/"));
  const base = PACKAGE_NAME.slice(PACKAGE_NAME.indexOf("/") + 1);
  for (const nodeModules of [join(prefix, "lib", "node_modules"), join(prefix, "node_modules")]) {
    const root = join(nodeModules, scope, base);
    if (existsSync(join(root, "package.json"))) return root;
  }
  return null;
}

// Put the verified staged tree in place of the live one. Both renames are on the
// same filesystem, so each one is atomic; if the second fails, the first is
// rolled back and the live tree is exactly as it was.
//
// The previous tree is parked OUTSIDE node_modules, under a name npm never
// manages, so it cannot be taken for an installed package or collide with npm's
// own hidden retire directory.
function swapStagedTree(install, stagedRoot, onLog) {
  const live = install.root;
  const previous = join(install.dir, ".dsh-update-previous");
  const why = (err) => (err && err.message ? err.message : String(err));
  try {
    rmSync(previous, { recursive: true, force: true });
  } catch (err) {
    // Nothing has been moved yet, so the live tree is untouched.
    return { ok: false, code: -1, error: `无法清理上一次的备份 ${previous}：${why(err)}` };
  }
  try {
    renameSync(live, previous);
  } catch (err) {
    return { ok: false, code: -1, error: `无法移开当前副本：${why(err)}` };
  }
  try {
    renameSync(stagedRoot, live);
  } catch (err) {
    let rolledBack = false;
    try {
      renameSync(previous, live);
      rolledBack = true;
    } catch {
      /* reported through the message below */
    }
    // A failed rollback must be said out loud: the live path is empty at this
    // point, and the caller uses this result to decide whether the staging prefix
    // may be deleted (it may not — the verified tree is still in there).
    return {
      ok: false,
      code: -1,
      error: rolledBack
        ? `替换运行副本失败，已回滚到原版本：${why(err)}`
        : `替换运行副本失败，且回滚也失败：${why(err)}。原版本在 ${previous}，请手动把它改回 ${live}`
    };
  }
  onLog(`已替换运行副本；上一版本留在 ${previous}`);
  return { ok: true, code: 0, error: null };
}

// Command for the staged install: same manager and registry as the in-place one,
// pointed at a throwaway prefix instead of the live tree.
function buildStagedCommand(binary, version, staging, registry) {
  const spec = `${PACKAGE_NAME}@${version}`;
  const cliPrefix = binary.cliJs !== null ? [binary.cliJs] : [];
  return [binary.argv[0], ...cliPrefix, "install", "-g", spec, "--prefix", staging, "--registry", registry, "--no-audit", "--no-fund"];
}

// npm-global upgrade, staged: install into a throwaway prefix on the SAME
// filesystem as the live tree (so the final swap is a rename, not a copy), verify
// the staged tree, then swap it in. A staged tree that fails to install or verify
// is deleted and the live tree is never touched — which is the point, since the
// running process serves the live tree straight off disk.
async function stagedNpmInstall(install, version, registry, onLog) {
  const binary = install.binary;
  if (binary === null || binary === void 0) {
    return { ok: false, code: -1, error: `未找到可用的 ${install.manager} 命令` };
  }
  const staging = join(install.dir, `.dsh-update-staging-${Date.now().toString(36)}`);
  const argv = buildStagedCommand(binary, version, staging, registry);
  pushLog(`先装到临时目录（不影响正在运行的副本）：${staging}`);
  pushLog(`$ ${argv.join(" ")}`);
  mkdirSync(staging, { recursive: true });
  // Cleanup must never turn a good update into a reported failure, and a cleanup
  // error must not escape the handler (an escaped error leaves the card stuck on
  // "installing", which also refuses restarts).
  const dropStaging = (because) => {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch (err) {
      pushLog(`临时目录清理失败（${because}）：${err && err.message ? err.message : String(err)}`);
    }
  };
  const result = await runCommand(argv, {}, onLog);
  if (!result.ok) {
    dropStaging("安装失败");
    return { ok: false, code: result.code, error: result.error };
  }
  const stagedRoot = globalRootIn(staging);
  if (stagedRoot === null) {
    dropStaging("没找到安装结果");
    return { ok: false, code: -1, error: `临时安装结束，但没找到 ${PACKAGE_NAME}（${staging}）` };
  }
  const verify = verifyInstallTree(stagedRoot, version);
  if (!verify.ok) {
    dropStaging("校验未通过");
    return { ok: false, code: -1, error: `临时副本不完整，已放弃替换：${verify.error}` };
  }
  pushLog("临时副本校验通过（版本与前端资源齐备），开始替换运行副本…");
  const swapped = swapStagedTree(install, stagedRoot, onLog);
  // Delete the staging prefix only once the live path really holds a tree again.
  // After a swap whose rollback also failed, the verified tree is still sitting in
  // there, and deleting it would throw away the only good copy.
  if (existsSync(join(install.root, "package.json"))) {
    dropStaging("更新已结束");
  } else {
    pushLog(`运行目录尚未恢复，保留临时目录不删：${staging}`);
  }
  return swapped;
}

// ── restart ──────────────────────────────────────────────────────────────────

// The unit that owns this process, or null when dsh was started by hand. Probed
// from the process cgroup, which is the only reliable way to tell: PATH and argv
// are identical in both cases.
//
// A cgroup path carries several `.service` components —
// `user.slice/user-1000.slice/user@1000.service/app.slice/dsh.service` — and the
// FIRST one is the user manager, not the launcher. Only the unit whose MainPID is
// this process may be restarted, so every candidate is checked and the wrong ones
// are rejected rather than guessed at from position in the path.
function systemdUnitForSelf() {
  if (process.platform !== "linux") return null;
  if (!existsSync("/run/systemd/system")) return null;
  let cgroup = "";
  try {
    cgroup = readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return null;
  }
  const candidates = [...cgroup.matchAll(/([A-Za-z0-9@._-]+\.service)/g)].map((m) => m[1]);
  for (const unit of candidates) {
    try {
      const pid = execFileSync("systemctl", ["--user", "show", "-p", "MainPID", "--value", unit], {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      if (pid.length > 0 && Number(pid) === process.pid) return unit;
    } catch {
      /* not a unit this user can query: try the next candidate */
    }
  }
  return null;
}

function spawnDetached(argv, logFile) {
  let out = "ignore";
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    out = openSync(logFile, "a");
  } catch {
    out = "ignore";
  }
  const child = spawn(argv[0], argv.slice(1), {
    detached: true,
    stdio: ["ignore", out, out],
    shell: false,
    env: process.env
  });
  // spawn reports a missing binary (setsid/systemctl) asynchronously. Without a
  // listener the `error` event is unhandled and Node terminates the process —
  // i.e. the restart route would kill dsh instead of answering. Remember it so
  // the caller can report the truth rather than a claimed success.
  child.on("error", (err) => {
    child.dshSpawnError = err && err.message ? err.message : String(err);
  });
  child.unref();
  if (typeof out === "number") {
    try {
      closeSync(out);
    } catch {
      /* ignore */
    }
  }
  return child;
}

// Fallback for a hand-started dsh: stop this PID, then relaunch the exact command
// line. Without this the update would leave the operator with no running instance
// and no way back from the GUI.
//
// The script must terminate the running process itself: a plain dsh does not exit
// on its own, so waiting for the PID to disappear would hang forever and the
// "restart" would silently do nothing. SIGTERM first (lets dsh drain and close
// sockets), a bounded wait, then SIGKILL.
function launchWatchdogReexec(unitHint) {
  // Private directory, not a predictable name directly in /tmp: a fixed path
  // under a world-writable /tmp can be pre-created as a symlink by another local
  // user, and writeFileSync follows it (overwriting an arbitrary file the dsh
  // user can write). mkdtemp gives a 0700 directory only this user can enter.
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), "dsh-update-"));
  } catch {
    dir = tmpdir();
  }
  const script = join(dir, "restart.sh");
  const pid = process.pid;
  const log = join(dshHome(), "dsh-update-restart.log");
  // argv[0] is the node binary; re-exec it with the original script and args.
  const argv = process.argv.slice(1);
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const relaunch = `${quote(process.execPath)} ${argv.map(quote).join(" ")}`;
  const body = [
    "#!/bin/sh",
    `# dsh-update: restart dsh (pid ${pid}) with its original command line`,
    `exec >>${quote(log)} 2>&1`,
    `echo "[$(date -Is)] stopping pid ${pid}"`,
    // The script outlives the target, so it must not share its process group.
    `if kill -0 ${pid} 2>/dev/null; then kill -TERM ${pid} 2>/dev/null; fi`,
    `n=0`,
    `while kill -0 ${pid} 2>/dev/null && [ "$n" -lt 150 ]; do sleep 0.2; n=$((n + 1)); done`,
    `if kill -0 ${pid} 2>/dev/null; then echo "[$(date -Is)] SIGTERM timed out, killing"; kill -KILL ${pid} 2>/dev/null; sleep 1; fi`,
    // Give the old process a moment to release its listening socket: rebinding too
    // early makes the relaunched dsh fail with EADDRINUSE. The loop waits while
    // the process still exists (bounded), which is the condition that matters —
    // the previous version broke out as soon as it was gone, i.e. it never waited.
    `n=0`,
    `while kill -0 ${pid} 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.2; n=$((n + 1)); done`,
    // No command substitution anywhere in this line: quoting is correct today,
    // but echoing interpolated text through a shell is a fragile guarantee.
    `echo "[$(date -Is)] relaunching pid ${pid}"`,
    `cd ${quote(process.cwd())} 2>/dev/null || cd ${quote(homedir())}`,
    `exec ${relaunch}`,
    ""
  ].join("\n");
  writeFileSync(script, body, { encoding: "utf8", mode: 0o700 });
  // setsid detaches from this process group so the relaunched dsh survives the
  // death of the instance that spawned it.
  spawnDetached(["setsid", "/bin/sh", script], log);
  lastWatchdogDir = dir;
  return { mode: "watchdog", unit: unitHint, dir };
}

function launchRestart() {
  const unit = systemdUnitForSelf();
  if (unit !== null) {
    pushLog(`systemd 用户服务 ${unit} 托管当前实例，执行 systemctl --user restart ${unit}`);
    const child = spawnDetached(["systemctl", "--user", "restart", unit], join(dshHome(), "dsh-update-restart.log"));
    return { mode: "systemd", unit, pid: child.pid || null, child };
  }
  pushLog("未检测到 systemd 托管，改用看门狗脚本重拉当前命令行");
  return launchWatchdogReexec(null);
}

// A spawn failure (missing setsid/systemctl) surfaces on a later tick. Give it a
// moment so the route reports the failure instead of telling the operator the
// service is restarting when nothing was launched.
function spawnFailure(handle) {
  return new Promise((resolve) => {
    const child = handle !== null && handle !== void 0 ? handle.child : void 0;
    if (child === void 0) {
      resolve(null);
      return;
    }
    setTimeout(() => {
      resolve(child.dshSpawnError !== void 0 ? child.dshSpawnError : null);
    }, 150).unref();
  });
}

// Remove the previous run's watchdog script. The directory is per-run now, so the
// path recorded by the last launch is what gets cleaned, not a fixed name.
let lastWatchdogDir = null;

function cleanupWatchdogScript() {
  if (lastWatchdogDir === null) return;
  const dir = lastWatchdogDir;
  lastWatchdogDir = null;
  // The script is already running (or has exited); only its directory is ours.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* nothing to clean */
  }
}

// Launch the restart and report the truth about it. Shared by the manual restart
// route and the automatic post-install restart, so both use the identical proven
// path (systemd unit first, watchdog fallback) and both record the same state.
async function performRestart(ctx) {
  cleanupWatchdogScript();
  let launched;
  try {
    launched = launchRestart();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    state.restart = { at: new Date().toISOString(), mode: "none", ok: false, error: message };
    return { ok: false, status: 500, error: `重启失败：${message}`, mode: "none", unit: null };
  }
  // A missing setsid/systemctl fails asynchronously; check before claiming the
  // restart was launched, otherwise the operator is told to expect a restart
  // that will never happen.
  const failure = await spawnFailure(launched);
  if (failure !== null) {
    const message = `重启命令未能启动：${failure}`;
    pushLog(message);
    state.restart = { at: new Date().toISOString(), mode: launched.mode, unit: launched.unit || null, ok: false, error: message };
    return { ok: false, status: 500, error: message, mode: launched.mode, unit: launched.unit || null };
  }
  state.restart = { at: new Date().toISOString(), mode: launched.mode, unit: launched.unit || null, ok: true, error: null };
  const webServer = ctx.get("webServer");
  return {
    ok: true,
    status: 202,
    mode: launched.mode,
    unit: launched.unit || null,
    port: webServer !== void 0 ? webServer.port || null : null
  };
}

// Read a small JSON body. Bounded because these routes only ever receive a
// channel name or a version string; an unbounded read would let a hostile client
// buffer memory. Returns null for malformed JSON so the caller can answer 400.
function readJsonBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let raw = "";
    let over = false;
    req.on("data", (chunk) => {
      if (over) return;
      raw += chunk;
      if (raw.length > limit) {
        over = true;
        raw = "";
      }
    });
    req.on("end", () => {
      if (over || raw.length === 0) {
        resolve(over ? null : {});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed !== null && typeof parsed === "object" ? parsed : null);
      } catch {
        resolve(null);
      }
    });
  });
}

// ── plugin ───────────────────────────────────────────────────────────────────

function apply(ctx, config) {
  const webServer = ctx.get("webServer");
  if (webServer === void 0) return;

  const cfg = config !== null && typeof config === "object" ? config : {};
  const persisted = persistedConfig();
  const configuredChannel = CHANNELS.includes(cfg.channel) ? cfg.channel : null;
  state.channel = CHANNELS.includes(persisted.channel) ? persisted.channel : configuredChannel || DEFAULT_CHANNEL;
  const autoCheck = cfg.autoCheck !== false;
  // Restarting after a successful install is the DEFAULT: it is what makes the
  // update actually take effect, and it avoids the window where the process runs
  // old code while serving the new client bundle (a broken page). Opt out with
  // `autoRestart: false` to keep the manual two-button flow.
  const autoRestart = cfg.autoRestart !== false;

  const statusBody = async (force) => {
    const data = await runCheck(force === true);
    const channel = state.channel;
    const entry = data.channels[channel] || { version: null, source: null };
    const behind = data.current !== null && entry.version !== null ? compareVersions(entry.version, data.current) > 0 : null;
    const install = dshInstall();
    return {
      ok: true,
      current: data.current,
      installRoot: data.installRoot,
      prefix: data.prefix,
      // How this copy was installed and which tool will update it. The card shows
      // this so an operator never has to guess which package manager owns dsh.
      install: install === null ? null : {
        manager: install.manager,
        layout: install.layout,
        dir: install.dir,
        prefix: install.prefix,
        pnpmHome: install.pnpmHome,
        profileDir: install.profileDir,
        sourceRepo: install.sourceRepo !== void 0 ? install.sourceRepo : null,
        binary: install.binary !== null ? install.binary.display : null,
        usable: install.usable === true
      },
      registryBase: registryBase(install),
      systemdUnit: systemdUnitForSelf(),
      channel,
      channels: data.channels,
      latest: entry,
      hasUpdate: behind === true,
      // A downgrade is possible (channel switched from next back to latest); it
      // is reported separately so the card never calls it an update.
      isDowngrade: data.current !== null && entry.version !== null ? compareVersions(entry.version, data.current) < 0 : false,
      behind,
      sources: { registry: data.registry, github: { ok: data.github.ok, error: data.github.error } },
      releases: data.github.releases,
      versions: data.versions,
      checkedAt: data.checkedAt,
      busy: state.phase === "installing",
      update: {
        phase: state.phase,
        target: state.target,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        versionBefore: state.versionBefore,
        versionAfter: state.versionAfter,
        error: state.error,
        log: state.log.slice(-40),
        elapsedMs: state.startedAt !== null ? Date.now() - state.startedAt : null
      },
      restart: state.restart,
      installPathExists: install !== null,
      autoCheck,
      autoRestart,
      autoRestartResult: state.autoRestart !== void 0 ? state.autoRestart : null
    };
  };

  ctx.effect(() => webServer.register({
    kind: "exact",
    path: `${ROUTE_PREFIX}/status`,
    handler: async (req, res) => {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      // The read routes are fenced too: /status reports absolute install paths and
      // the environment's registry, which should not be readable off-host.
      const rejection = requestRejection(ctx, req);
      if (rejection !== void 0) {
        sendJson(res, rejection === 401 ? 401 : 403, {
          ok: false,
          error: rejection === 401 ? "authentication required" : "request rejected by the API fence"
        });
        return;
      }
      try {
        sendJson(res, 200, await statusBody(false));
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
  }), "dsh-update: status route");

  ctx.effect(() => webServer.register({
    kind: "exact",
    path: `${ROUTE_PREFIX}/check`,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      const rejection = requestRejection(ctx, req);
      if (rejection !== void 0) {
        // Surface the host fence's own status (401 when unauthenticated, 403 when
        // the request is not trusted) instead of flattening it to 403.
        sendJson(res, rejection === 401 ? 401 : 403, {
          ok: false,
          error: rejection === 401 ? "authentication required" : "request rejected by the API fence"
        });
        return;
      }
      try {
        sendJson(res, 200, await statusBody(true));
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
  }), "dsh-update: check route");

  ctx.effect(() => webServer.register({
    kind: "exact",
    path: `${ROUTE_PREFIX}/channel`,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      const rejection = requestRejection(ctx, req);
      if (rejection !== void 0) {
        // Surface the host fence's own status (401 when unauthenticated, 403 when
        // the request is not trusted) instead of flattening it to 403.
        sendJson(res, rejection === 401 ? 401 : 403, {
          ok: false,
          error: rejection === 401 ? "authentication required" : "request rejected by the API fence"
        });
        return;
      }
      const body = await readJsonBody(req);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: "invalid JSON body" });
        return;
      }
      const channel = typeof body.channel === "string" ? body.channel : "";
      if (!CHANNELS.includes(channel)) {
        sendJson(res, 400, { ok: false, error: `channel must be one of ${CHANNELS.join(", ")}` });
        return;
      }
      state.channel = channel;
      saveChannel(channel);
      try {
        sendJson(res, 200, await statusBody(true));
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
  }), "dsh-update: channel route");

  ctx.effect(() => webServer.register({
    kind: "exact",
    path: `${ROUTE_PREFIX}/versions`,
    handler: async (req, res) => {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      const rejection = requestRejection(ctx, req);
      if (rejection !== void 0) {
        sendJson(res, rejection === 401 ? 401 : 403, {
          ok: false,
          error: rejection === 401 ? "authentication required" : "request rejected by the API fence"
        });
        return;
      }
      // Search the release history. `q` filters by substring (a version, a
      // partial like `0.2`, or a channel tag such as `rc`); an empty query
      // returns the newest slice the card lists by default.
      let query = "";
      try {
        query = String(new URL(req.url, "http://localhost").searchParams.get("q") || "").trim().toLowerCase();
      } catch {
        query = "";
      }
      try {
        const data = await runCheck(false);
        const matched = query.length === 0
          ? data.versions
          : data.versions.filter((row) => row.version.toLowerCase().includes(query) || row.tags.some((tag) => tag.includes(query)));
        sendJson(res, 200, {
          ok: true,
          query,
          total: data.versions.length,
          matched: matched.length,
          versions: matched.slice(0, VERSION_LIST_LIMIT),
          checkedAt: data.checkedAt
        });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
  }), "dsh-update: versions route");

  ctx.effect(() => webServer.register({
    kind: "exact",
    path: `${ROUTE_PREFIX}/update`,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      const rejection = requestRejection(ctx, req);
      if (rejection !== void 0) {
        // Surface the host fence's own status (401 when unauthenticated, 403 when
        // the request is not trusted) instead of flattening it to 403.
        sendJson(res, rejection === 401 ? 401 : 403, {
          ok: false,
          error: rejection === 401 ? "authentication required" : "request rejected by the API fence"
        });
        return;
      }
      if (state.phase === "installing") {
        sendJson(res, 409, { ok: false, error: "一次只允许一个更新操作" });
        return;
      }
      const body = await readJsonBody(req);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: "invalid JSON body" });
        return;
      }
      // Claim the install slot BEFORE the first await. The `state.phase` check
      // above is not enough on its own: two concurrent requests would both pass
      // it and then both spawn `npm install -g`, whose concurrent writers corrupt
      // the same prefix. This flag is the actual mutex.
      if (installLocked) {
        sendJson(res, 409, { ok: false, error: "一次只允许一个更新操作" });
        return;
      }
      installLocked = true;
      try {
        // `version` pins an exact release from the list (or a dist-tag such as
        // `latest`); omitting it means "whatever the selected channel points at
        // now". A fresh check backs both paths, so the target is never a version
        // the sources no longer offer.
        const requested = typeof body.version === "string" ? body.version : "";
        let target;
        let via;
        try {
          const data = await runCheck(true);
          const resolved = resolveRequestedVersion(requested.length > 0 ? requested : state.channel, data);
          if (!resolved.ok) {
            sendJson(res, 400, { ok: false, error: resolved.error });
            return;
          }
          target = resolved.version;
          via = resolved.via;
        } catch (err) {
          sendJson(res, 502, { ok: false, error: `检查版本失败：${err && err.message ? err.message : String(err)}` });
          return;
        }
        const install = dshInstall();
        if (install === null) {
          sendJson(res, 500, { ok: false, error: "无法定位 dsh 安装目录" });
          return;
        }
        // A source checkout is not installable through a package manager: the
        // running code comes from the working tree, so a registry install would
        // only add a second copy. Refuse and say what to run instead.
        if (install.layout === "source") {
          sendJson(res, 409, {
            ok: false,
            error: `当前以源码树模式运行（${install.dir}），npm/pnpm 全局安装不会改变运行实例。请在该目录执行 git pull && pnpm install 后重启。`
          });
          return;
        }
        // The detected manager must be present. Working around a missing tool by
        // picking another one can leave a second copy behind, so this refuses.
        if (install.usable !== true) {
          sendJson(res, 409, {
            ok: false,
            error: `检测到 dsh 由 ${install.manager} 安装，但找不到可用的 ${install.manager} 命令；请让它出现在 PATH 后重试，或手动执行：${install.manager} ${install.layout === "npm-global" ? "install -g" : "add -g"} ${PACKAGE_NAME}@${target}`
          });
          return;
        }
        // npm's own leftovers are a refusal, not something to clean up silently:
        // they break npm's next rename with ENOTEMPTY, and the copy sitting inside
        // one can be the only intact install left (that was the case here).
        const refusal = updateRefusal(install);
        if (refusal !== null) {
          sendJson(res, 409, { ok: false, error: refusal });
          return;
        }

        state.phase = "installing";
        state.target = target;
        state.startedAt = Date.now();
        state.finishedAt = null;
        state.error = null;
        state.versionBefore = install.version;
        state.versionAfter = null;
        state.log = [];
        pushLog(`目标版本 ${PACKAGE_NAME}@${target}（${via === "version" ? "指定版本" : `${state.channel} 通道`}）`);
        sendJson(res, 202, { ok: true, started: true, target, via, versionBefore: install.version });

        // npm-global goes through a staging prefix; the other layouts have their
        // own staging stories and are verified after the fact instead.
        const result = install.layout === "npm-global"
          ? await stagedNpmInstall(install, target, registryBase(install), pushLog)
          : await runInstall(target, pushLog);
        const after = dshInstall();
        state.versionAfter = after !== null ? after.version : null;
        state.finishedAt = Date.now();
        if (!result.ok) {
          state.phase = "failed";
          state.error = `npm 退出码 ${result.code}${result.error !== null ? `：${result.error}` : ""}`;
          pushLog(state.error);
          return;
        }
        // npm can exit 0 without having changed the copy we run (wrong prefix,
        // another dsh on PATH). That is not success — report it as such.
        if (state.versionAfter !== null && state.versionAfter !== target) {
          state.phase = "failed";
          state.error = `npm 退出码 0，但当前运行副本仍是 v${state.versionAfter}（目标 v${target}）——更新可能落在了另一个 dsh 副本`;
          pushLog(state.error);
          return;
        }
        // A tree can claim the right version and still be missing the client
        // bundle — npm exits 0 for that, and the browser shows a blank page. Check
        // the tree we are about to run, not just the version it reports.
        if (after !== null) {
          const verified = verifyInstallTree(after.root, target);
          if (!verified.ok) {
            state.phase = "failed";
            state.error = `更新已写入，但运行副本不完整：${verified.error}`;
            pushLog(state.error);
            return;
          }
        }
        state.phase = "done";
        pushLog(`更新完成：v${state.versionBefore} → v${state.versionAfter}`);
        // Restart automatically by default. Two reasons: the running process still
        // holds the OLD code in memory while the client bundle is served from disk,
        // so until the process restarts the browser gets a mismatched pair and
        // fails to load ("white screen", observed in practice); and the operator
        // asked for the update to just take effect. `autoRestart: false` restores
        // the two-button flow for anyone who wants to pick the moment.
        if (autoRestart) {
          pushLog("按配置自动重启以让新版本生效…");
          // Give the browser a beat to receive the 202 and render progress, then
          // restart. The reply is already sent, so this does not block it.
          await new Promise((resolve) => {
            setTimeout(resolve, 1500).unref();
          });
          const restarted = await performRestart(ctx);
          state.autoRestart = {
            at: new Date().toISOString(),
            ok: restarted.ok,
            error: restarted.error !== null && restarted.error !== void 0 ? restarted.error : null,
            mode: restarted.mode
          };
          pushLog(restarted.ok
            ? `已触发自动重启（${String(restarted.mode)}）`
            : `自动重启失败：${String(restarted.error)}；请用「重启服务」手动重启`);
        } else {
          pushLog("已按配置跳过自动重启；运行中的进程仍是旧版本，需手动重启后生效");
        }
      } catch (err) {
        // Anything thrown after the 202 was sent (a failed mkdir, a cleanup error)
        // would otherwise leave `phase` stuck on "installing", and while it is
        // stuck BOTH /update and /restart answer 409. That is the worst possible
        // pair: the new tree is already on disk and the GUI refuses to restart
        // into it.
        if (state.phase === "installing") {
          state.phase = "failed";
          state.error = `安装过程异常中断：${err && err.message ? err.message : String(err)}`;
          pushLog(state.error);
        } else {
          throw err;
        }
      } finally {
        installLocked = false;
      }
    }
  }), "dsh-update: update route");

  ctx.effect(() => webServer.register({
    kind: "exact",
    path: `${ROUTE_PREFIX}/restart`,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      const rejection = requestRejection(ctx, req);
      if (rejection !== void 0) {
        // Surface the host fence's own status (401 when unauthenticated, 403 when
        // the request is not trusted) instead of flattening it to 403.
        sendJson(res, rejection === 401 ? 401 : 403, {
          ok: false,
          error: rejection === 401 ? "authentication required" : "request rejected by the API fence"
        });
        return;
      }
      // `installLocked` rather than the phase: an update claims the lock before
      // its version check resolves, and restarting into a half-started install
      // (npm about to write the prefix) is the case this refuses.
      if (installLocked || state.phase === "installing") {
        sendJson(res, 409, { ok: false, error: "更新进行中，请等安装结束后再重启" });
        return;
      }
      const result = await performRestart(ctx);
      // Answer before the instance goes away, then let the restart land: the
      // browser needs the response body, and the service needs a moment to drain.
      if (result.ok) {
        sendJson(res, 202, { ok: true, mode: result.mode, unit: result.unit, port: result.port });
      } else {
        sendJson(res, result.status, { ok: false, error: result.error });
      }
    }
  }), "dsh-update: restart route");

  if (autoCheck) {
    ctx.timer.interval(() => {
      runCheck(true).catch(() => {
        /* an unreachable source keeps the previous answer */
      });
    }, AUTO_CHECK_MS);
  }
}

export { name, inject, apply };
