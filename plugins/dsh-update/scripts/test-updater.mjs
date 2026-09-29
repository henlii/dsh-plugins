// dsh-update host-half checks: the pure logic the card depends on.
//
// This is a plain Node script (no test runner) so it runs with the same
// interpreter dsh uses. It covers the three places a wrong answer is costly:
// version ordering (which release is "newer"), the merged release list, and the
// resolution of a requested version before it reaches npm.
//
// Run: node scripts/test-updater.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The host half only exports the plugin surface, so the helpers are pulled out of
// the source text and evaluated in isolation. Importing it for real would need a
// full cordis context and would touch the network.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "index.js"), "utf8");

function extractFunction(exportName) {
  const start = source.indexOf(`function ${exportName}(`);
  assert.notEqual(start, -1, `missing function ${exportName}`);
  // Walk to the matching closing brace at column 0.
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `unterminated function ${exportName}`);
  return source.slice(start, end + 3);
}

const harness = [
  "const VERSION_PATTERN = /^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.-]+)?$/",
  extractFunction("parseVersion"),
  extractFunction("isCanonicalVersion"),
  extractFunction("compareVersions"),
  extractFunction("buildVersionList"),
  extractFunction("resolveRequestedVersion"),
  extractFunction("buildInstallCommand"),
  extractFunction("classifyInstall"),
  extractFunction("managerGlobalNodeModules"),
  extractFunction("managerOwns"),
  extractFunction("retireLeftovers"),
  extractFunction("updateRefusal"),
  extractFunction("localRefs"),
  extractFunction("verifyInstallTree"),
  extractFunction("globalRootIn"),
  extractFunction("buildStagedCommand"),
  extractFunction("swapStagedTree"),
  "function readJsonFile(file) { try { const parsed = JSON.parse(globalThis.__testReadFile(file)); return parsed !== null && typeof parsed === 'object' ? parsed : null } catch { return null } }",
  "function readFileSync(p) { const v = globalThis.__testReadFile(p); if (v === undefined) throw new Error('ENOENT: ' + p); return v }",
  "function readdirSync(p) { const v = globalThis.__testReaddir(p); if (v === undefined) throw new Error('ENOENT: ' + p); return v }",
  "function renameSync(from, to) { globalThis.__testRename(from, to) }",
  "function rmSync(p) { globalThis.__testRm(p) }",
  "function pickNewer(current, candidate) { if (typeof current !== 'string' || current.length === 0) return candidate; return compareVersions(candidate, current) > 0 ? candidate : current }",
  "const CHANNELS = ['latest', 'next', 'alpha']",
  "const VERSION_LIST_LIMIT = 40",
  "const PACKAGE_NAME = '@deepseek-ai/dsh'",
  "const MANAGERS = ['npm', 'pnpm', 'yarn', 'bun']",
  "function existsSync(p) { return globalThis.__testExists(p) === true }",
  "const dirname = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i) }",
  "const sep = '/'",
  "function queryManagerPrefix(m) { const t = globalThis.__testPrefix; return t && typeof t[m] === 'string' ? t[m] : null }",
  "const join = (...parts) => parts.join('/').replace(/\\/+/g, '/')",
  "export { parseVersion, isCanonicalVersion, compareVersions, buildVersionList, resolveRequestedVersion, buildInstallCommand, classifyInstall, managerOwns, retireLeftovers, updateRefusal, localRefs, verifyInstallTree, globalRootIn, buildStagedCommand, swapStagedTree };"
].join("\n");

const module = await import(`data:text/javascript,${encodeURIComponent(harness)}`);
const { compareVersions, isCanonicalVersion, buildVersionList, resolveRequestedVersion, buildInstallCommand, classifyInstall, managerOwns, retireLeftovers, updateRefusal, localRefs, verifyInstallTree, globalRootIn, buildStagedCommand, swapStagedTree } = module;

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}
// The staged-install checks drive an async function, so their body has to finish
// before the count is taken — a plain `check` would report success and then fail
// in a detached microtask.
async function checkAsync(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

console.log("compareVersions");
check("numeric segments order", () => {
  assert.ok(compareVersions("0.2.0", "0.1.7") > 0);
  assert.ok(compareVersions("0.1.10", "0.1.9") > 0);
  assert.equal(compareVersions("0.1.7", "0.1.7"), 0);
});
check("a release outranks its own prerelease", () => {
  assert.ok(compareVersions("0.1.7", "0.1.7-rc.2") > 0);
  assert.ok(compareVersions("0.1.7-rc.2", "0.1.7-rc.1") > 0);
  assert.ok(compareVersions("0.2.0-rc.1", "0.1.7-rc.2") > 0);
});
check("prerelease identifiers sort by semver rules", () => {
  assert.ok(compareVersions("0.1.7-rc.10", "0.1.7-rc.9") > 0);
  assert.ok(compareVersions("0.1.7-rc.1", "0.1.7-alpha.2") > 0);
  assert.ok(compareVersions("0.1.7-alpha.2", "0.1.7-alpha.1") > 0);
});
check("unparseable input compares equal instead of throwing", () => {
  assert.equal(compareVersions("not-a-version", "0.1.7"), 0);
});

console.log("buildVersionList");
const registry = {
  ok: true,
  tags: { latest: "0.1.7-rc.2", next: "0.2.0-rc.1", alpha: "0.1.7-alpha.2" },
  versions: ["0.1.6-alpha.1", "0.1.7-rc.2", "0.2.0-rc.1", "0.1.7-alpha.2"],
  times: { "0.1.7-rc.2": "2026-09-24T14:18:11.337Z" }
};
const github = {
  ok: true,
  releases: [
    { version: "0.2.0-rc.1", at: null, publishedAt: "2026-09-28T12:34:03.181Z", prerelease: true, notes: "note-020", url: "https://example.test/0.2.0-rc.1" },
    { version: "0.1.7-rc.2", publishedAt: "2026-09-24T14:18:11.337Z", prerelease: true, notes: "note-017", url: "https://example.test/0.1.7-rc.2" }
  ]
};
const list = buildVersionList(registry, github);
check("newest first", () => {
  assert.deepEqual(list.map((row) => row.version), ["0.2.0-rc.1", "0.1.7-rc.2", "0.1.7-alpha.2", "0.1.6-alpha.1"]);
});
check("channel tags attach to the versions they point at", () => {
  assert.deepEqual(list.find((row) => row.version === "0.2.0-rc.1").tags, ["next"]);
  assert.deepEqual(list.find((row) => row.version === "0.1.7-rc.2").tags, ["latest"]);
  assert.deepEqual(list.find((row) => row.version === "0.1.7-alpha.2").tags, ["alpha"]);
});
check("publish time comes from the registry, GitHub fills the gap", () => {
  assert.equal(list.find((row) => row.version === "0.1.7-rc.2").at, "2026-09-24T14:18:11.337Z");
  assert.equal(list.find((row) => row.version === "0.2.0-rc.1").at, "2026-09-28T12:34:03.181Z");
});
check("notes survive from GitHub", () => {
  assert.equal(list.find((row) => row.version === "0.2.0-rc.1").notes, "note-020");
});
check("a GitHub-only release is flagged and still listed", () => {
  const merged = buildVersionList(
    { ok: true, tags: { latest: "0.1.0" }, versions: ["0.1.0"], times: {} },
    { ok: true, releases: [{ version: "0.9.9", publishedAt: "", prerelease: false, notes: null, url: "u" }] }
  );
  assert.deepEqual(merged.map((row) => row.version), ["0.9.9", "0.1.0"]);
  assert.equal(merged[0].onRegistry, false);
  assert.equal(merged[0].onGithub, true);
});
check("one source down still yields a usable list", () => {
  const onlyGithub = buildVersionList({ ok: false, tags: {}, versions: [], times: {} }, github);
  assert.equal(onlyGithub.length, 2);
  const onlyRegistry = buildVersionList(registry, { ok: false, releases: [] });
  assert.equal(onlyRegistry.length, 4);
  assert.deepEqual(onlyRegistry[0].tags, ["next"]);
});
check("the list is capped", () => {
  const many = { ok: true, tags: {}, versions: Array.from({ length: 80 }, (_, i) => `1.0.${String(i)}`), times: {} };
  assert.equal(buildVersionList(many, { ok: false, releases: [] }).length, 40);
});

console.log("resolveRequestedVersion");
const data = { channels: { latest: { version: "0.1.7-rc.2" }, next: { version: "0.2.0-rc.1" }, alpha: { version: null } }, versions: list };
check("a channel name resolves through the channels map", () => {
  assert.deepEqual(resolveRequestedVersion("latest", data), { ok: true, version: "0.1.7-rc.2", via: "tag:latest" });
  assert.deepEqual(resolveRequestedVersion("next", data), { ok: true, version: "0.2.0-rc.1", via: "tag:next" });
});
check("a channel with no version is refused", () => {
  const result = resolveRequestedVersion("alpha", data);
  assert.equal(result.ok, false);
  assert.match(result.error, /alpha/);
});
check("an exact version is accepted when the sources list it", () => {
  assert.deepEqual(resolveRequestedVersion("0.1.6-alpha.1", data), { ok: true, version: "0.1.6-alpha.1", via: "version" });
  assert.deepEqual(resolveRequestedVersion("v0.1.7-rc.2", data), { ok: true, version: "0.1.7-rc.2", via: "version" });
});
check("an unknown version is refused instead of handed to npm", () => {
  const result = resolveRequestedVersion("9.9.9", data);
  assert.equal(result.ok, false);
  assert.match(result.error, /9\.9\.9/);
});
check("garbage and empty input are refused", () => {
  assert.equal(resolveRequestedVersion("", data).ok, false);
  assert.equal(resolveRequestedVersion("; rm -rf /", data).ok, false);
  assert.equal(resolveRequestedVersion("latest; curl evil", data).ok, false);
});

console.log("buildInstallCommand");
// The command must match how dsh was installed, or the update silently hits the
// wrong tree. `-g` in particular has to be a FLAG: as a bare positional npm reads
// it as a package name (installing the unrelated `global@4.x`) and, combined with
// `--prefix`, performs a LOCAL install instead of a global one — so nothing that
// runs is ever updated and $HOME can be polluted.
const installOf = (layout, extra) => ({
  root: "/x/node_modules/@deepseek-ai/dsh",
  version: "1.0.0",
  manager: "npm",
  layout,
  dir: "/x",
  prefix: "/x",
  pnpmHome: null,
  profileDir: null,
  binary: { argv: ["node"], cliJs: "/npm-cli.js", display: "node /npm-cli.js" },
  usable: true,
  ...(extra || {})
});

check("npm global uses -g as a flag, never the bare word `global`", () => {
  const plan = buildInstallCommand(installOf("npm-global"), "0.2.0-rc.1", "https://r.test");
  assert.equal(plan.error, void 0);
  assert.ok(plan.argv.includes("-g"), "must pass -g");
  assert.ok(!plan.argv.includes("global"), "must not pass the bare positional `global`");
  // The spec must be present exactly once, and --prefix must name the target.
  assert.equal(plan.argv.filter((a) => a === "@deepseek-ai/dsh@0.2.0-rc.1").length, 1);
  assert.ok(plan.argv.includes("--prefix"));
  assert.equal(plan.argv[plan.argv.indexOf("--prefix") + 1], "/x");
  // --prefix must not be the last token, which would swallow the next argument.
  assert.notEqual(plan.argv[plan.argv.length - 1], "--prefix");
});

check("pnpm global uses add --global and pins PNPM_HOME", () => {
  const plan = buildInstallCommand(installOf("pnpm-global", { manager: "pnpm", pnpmHome: "/pnpm" }), "1.2.3", "https://r.test");
  assert.equal(plan.error, void 0);
  assert.ok(plan.argv.includes("add"));
  assert.ok(plan.argv.includes("--global"));
  assert.ok(plan.argv.includes("@deepseek-ai/dsh@1.2.3"));
  assert.equal(plan.env.PNPM_HOME, "/pnpm");
});

check("yarn global uses `global add`", () => {
  const plan = buildInstallCommand(installOf("yarn-global", { manager: "yarn" }), "1.2.3", "https://r.test");
  assert.ok(plan.argv.includes("global"));
  assert.ok(plan.argv.includes("add"));
  assert.ok(plan.argv.includes("@deepseek-ai/dsh@1.2.3"));
});

check("bun global uses `add --global`", () => {
  const plan = buildInstallCommand(installOf("bun-global", { manager: "bun" }), "1.2.3", "https://r.test");
  assert.ok(plan.argv.includes("add"));
  assert.ok(plan.argv.includes("--global"));
});

check("profile-local installs run inside the profile directory", () => {
  const plan = buildInstallCommand(installOf("profile", { manager: "pnpm", dir: "/home/u/.dsh/profiles/web" }), "1.2.3", "https://r.test");
  assert.equal(plan.cwd, "/home/u/.dsh/profiles/web");
});

check("an unknown layout refuses and names the manual command", () => {
  const plan = buildInstallCommand(installOf("unknown"), "1.2.3", "https://r.test");
  assert.match(plan.error, /npm install -g @deepseek-ai\/dsh@1\.2\.3/);
});

check("a missing manager binary refuses instead of guessing", () => {
  const plan = buildInstallCommand(installOf("npm-global", { binary: null, usable: false }), "1.2.3", "https://r.test");
  assert.equal(plan.argv, void 0);
  assert.match(plan.error, /npm/);
});

check("the version spec is a single argv token, so shell metacharacters are inert", () => {
  // resolveRequestedVersion already rejects these, but the command builder is the
  // last line of defence: whatever reaches it stays one argv element.
  const plan = buildInstallCommand(installOf("npm-global"), "1.0.0; rm -rf /", "https://r.test");
  assert.ok(plan.argv.includes("@deepseek-ai/dsh@1.0.0; rm -rf /"));
});

console.log("classifyInstall");
// Layout detection decides which command runs, so it is checked against the real
// path shapes. A scoped package name adds a path segment, which is exactly the
// mistake that made an npm-global install classify as "unknown".
const exists = new Set([
  "/pnpm/global/v11/hash/node_modules", // marker probe for the pnpm layout
]);
globalThis.__testExists = (p) => exists.has(p);

check("npm global: <prefix>/lib/node_modules/@deepseek-ai/dsh", () => {
  const got = classifyInstall("/nvm/v24/lib/node_modules/@deepseek-ai/dsh");
  assert.equal(got.layout, "npm-global");
  assert.equal(got.manager, "npm");
  // npm resolves a global prefix P to P/lib/node_modules, so the prefix is the
  // directory ABOVE lib — not lib itself. Passing lib installs into
  // P/lib/lib/node_modules and the running copy never changes.
  assert.equal(got.dir, "/nvm/v24");
  assert.equal(got.prefix, "/nvm/v24");
  assert.notEqual(got.prefix, "/nvm/v24/lib");
});

check("pnpm global: <PNPM_HOME>/global/<v>/<hash>/node_modules/@deepseek-ai/dsh", () => {
  const root = "/pnpm/global/v11/hash/node_modules/@deepseek-ai/dsh";
  exists.add("/pnpm/global/v11/hash/pnpm-lock.yaml");
  try {
    const got = classifyInstall(root);
    assert.equal(got.layout, "pnpm-global");
    assert.equal(got.manager, "pnpm");
    assert.equal(got.dir, "/pnpm/global/v11/hash");
    assert.equal(got.pnpmHome, "/pnpm");
  } finally {
    exists.delete("/pnpm/global/v11/hash/pnpm-lock.yaml");
  }
});

check("yarn global: <dir>/yarn/global/node_modules/@deepseek-ai/dsh", () => {
  const got = classifyInstall("/home/u/.config/yarn/global/node_modules/@deepseek-ai/dsh");
  assert.equal(got.layout, "yarn-global");
  assert.equal(got.manager, "yarn");
  assert.equal(got.dir, "/home/u/.config/yarn/global");
});

check("bun global: <bunHome>/install/global/node_modules/@deepseek-ai/dsh", () => {
  const got = classifyInstall("/home/u/.bun/install/global/node_modules/@deepseek-ai/dsh");
  assert.equal(got.layout, "bun-global");
  assert.equal(got.manager, "bun");
});

check("profile-local: <DSH_HOME>/profiles/<name>/node_modules/@deepseek-ai/dsh", () => {
  const got = classifyInstall("/home/u/.dsh/profiles/web/node_modules/@deepseek-ai/dsh");
  assert.equal(got.layout, "profile");
  assert.equal(got.dir, "/home/u/.dsh/profiles/web");
});

check("the npm-global branch is not shadowed by the pnpm check", () => {
  // A prefix that happens to contain a `global` path segment must still classify
  // as npm when there is no pnpm lock beside node_modules.
  const got = classifyInstall("/opt/global/lib/node_modules/@deepseek-ai/dsh");
  assert.equal(got.layout, "npm-global");
});

console.log("managerOwns");
// Ownership must be decided by PATH, not by the package name appearing in a
// listing: `npm ls -g --json` omits paths entirely, so a name test would claim
// ownership of any root as soon as one dsh exists in that prefix — and with
// several copies installed the update would target the wrong one.
check("npm owns the root under its own prefix's lib/node_modules", () => {
  globalThis.__testPrefix = { npm: "/nvm/v24" };
  assert.equal(managerOwns("npm", "/nvm/v24/lib/node_modules/@deepseek-ai/dsh"), true);
  assert.equal(managerOwns("npm", "/other/lib/node_modules/@deepseek-ai/dsh"), false);
});

check("npm on Windows has no lib level", () => {
  globalThis.__testPrefix = { npm: "/nvm/v24" };
  assert.equal(managerOwns("npm", "/nvm/v24/lib/node_modules/@deepseek-ai/dsh"), true);
  assert.equal(managerOwns("npm", "/nvm/v24/node_modules/@deepseek-ai/dsh"), true);
});

check("pnpm owns the hash directory under its version root", () => {
  globalThis.__testPrefix = { pnpm: "/pnpm/global/v11" };
  assert.equal(managerOwns("pnpm", "/pnpm/global/v11/abc123/node_modules/@deepseek-ai/dsh"), true);
  assert.equal(managerOwns("pnpm", "/pnpm/global/v10/abc123/node_modules/@deepseek-ai/dsh"), false);
});

check("yarn owns its global project's node_modules", () => {
  globalThis.__testPrefix = { yarn: "/home/u/.config/yarn/global" };
  assert.equal(managerOwns("yarn", "/home/u/.config/yarn/global/node_modules/@deepseek-ai/dsh"), true);
  assert.equal(managerOwns("yarn", "/elsewhere/node_modules/@deepseek-ai/dsh"), false);
});

check("an unanswerable manager owns nothing", () => {
  globalThis.__testPrefix = {};
  for (const manager of ["npm", "pnpm", "yarn", "bun"]) {
    assert.equal(managerOwns(manager, "/x/lib/node_modules/@deepseek-ai/dsh"), false);
  }
});

console.log("isCanonicalVersion");
// A prefix match is what let `0.1.7-rc.2; rm -rf /` and
// `0.1.7-../../../../tmp/evil` reach the npm spec position. npm parses such a
// spec as a DIRECTORY spec (verified: it creates `dsh -> ../../../../tmp/evil`),
// so the whole string must be a canonical version — GitHub release tags included,
// since they are external input.
for (const good of ["0.1.7", "0.1.7-rc.2", "0.2.0-rc.1", "1.0.0-alpha.1", "10.20.30"]) {
  check(`accepts canonical ${good}`, () => {
    assert.equal(isCanonicalVersion(good), true);
  });
}
for (const bad of [
  "0.1.7; rm -rf /",
  "0.1.7-rc.2 --prefix /tmp/x",
  "0.1.7-../../../../tmp/evil",
  "0.1.7\n0.2.0",
  "0.1.7 ",
  " 0.1.7",
  "0.1.7/build",
  "latest",
  "0.1",
  "0.1.7.8",
  "",
  "v0.1.7"
]) {
  check(`rejects ${JSON.stringify(bad)}`, () => {
    assert.equal(isCanonicalVersion(bad), false);
  });
}
check("rejects every hostile string through resolveRequestedVersion", () => {
  for (const hostile of ["0.1.7; rm -rf /", "0.1.7-rc.2 --prefix /tmp/x", "0.1.7-../../../../tmp/evil"]) {
    const result = resolveRequestedVersion(hostile, data);
    assert.equal(result.ok, false, `${hostile} must be refused`);
  }
});
check("a hostile GitHub tag never becomes a list row", () => {
  const merged = buildVersionList(
    { ok: false, tags: {}, versions: [], times: {} },
    { ok: true, releases: [
      { version: "0.1.7-../../../../tmp/evil", publishedAt: "", prerelease: false, notes: null, url: "u" },
      { version: "0.1.7-rc.2; rm -rf /", publishedAt: "", prerelease: false, notes: null, url: "u" },
      { version: "0.1.7-rc.2", publishedAt: "", prerelease: false, notes: null, url: "u" }
    ] }
  );
  assert.deepEqual(merged.map((row) => row.version), ["0.1.7-rc.2"]);
});

console.log("retireLeftovers");
// npm reifies a global tree by renaming the tree it replaces to `.<name>-<random>`.
// A leftover of that shape makes the NEXT rename fail with ENOTEMPTY, after npm
// has already deleted part of the live tree: 26110 files down to 7251 here, with
// the client bundles gone, which is the blank page in the browser. The leftovers
// are reported, never removed — the one in that incident held the only intact copy.
check("finds npm's hidden retire directories under the scope", () => {
  globalThis.__testReaddir = () => [".dsh-qv57kG2L", "dsh", "dsh-previous", ".dshmarket-abc", "dsh-2"];
  assert.deepEqual(retireLeftovers("/p/lib/node_modules/@deepseek-ai"), [".dsh-qv57kG2L"]);
});
check("an unreadable scope directory reports nothing rather than throwing", () => {
  globalThis.__testReaddir = () => void 0;
  assert.deepEqual(retireLeftovers("/nope"), []);
});

console.log("updateRefusal");
// The route hands `install` straight to this function, so the only thing that can
// be wrong here is which directory gets scanned. It must be the SCOPE directory
// (the parent of the package directory), because that is where npm parks both its
// dsh leftover and the same shape for dsh's own dependencies.
check("refuses when npm left a retire directory beside the live tree", () => {
  globalThis.__testReaddir = () => [".dsh-qv57kG2L", "dsh"];
  const reason = updateRefusal({ layout: "npm-global", root: "/p/lib/node_modules/@deepseek-ai/dsh" });
  assert.match(reason, /\.dsh-qv57kG2L/);
  assert.ok(reason.includes("（在 /p/lib/node_modules/@deepseek-ai）"), "must name the scope dir exactly");
});
check("names every leftover, sorted", () => {
  globalThis.__testReaddir = () => [".dsh-bbb", ".dsh-aaa", "dsh"];
  const reason = updateRefusal({ layout: "npm-global", root: "/p/lib/node_modules/@deepseek-ai/dsh" });
  assert.match(reason, /\.dsh-aaa、\.dsh-bbb/);
});
check("a clean scope directory is not a refusal", () => {
  // `dsh.broken-1` is not npm's shape (no leading dot), so a leftover like that
  // must not block updates.
  globalThis.__testReaddir = () => ["dsh", "dsh.broken-1"];
  assert.equal(updateRefusal({ layout: "npm-global", root: "/p/lib/node_modules/@deepseek-ai/dsh" }), null);
});
check("this plugin's own staging and backup names are outside the scanned directory", () => {
  // They live in the prefix root while the scan only reads the scope directory, so
  // the plugin can never refuse its own leftovers (both names start with `.dsh-`).
  const scopeDir = dirname("/p/lib/node_modules/@deepseek-ai/dsh");
  assert.equal(scopeDir, "/p/lib/node_modules/@deepseek-ai");
  assert.ok(!join("/p", ".dsh-update-previous").startsWith(`${scopeDir}/`));
  assert.ok(!join("/p", ".dsh-update-staging-x").startsWith(`${scopeDir}/`));
});
check("layouts other than npm-global are never refused this way", () => {
  globalThis.__testReaddir = () => [".dsh-qv57kG2L"];
  assert.equal(updateRefusal({ layout: "pnpm-global", root: "/p/x/dsh" }), null);
  assert.equal(updateRefusal({ layout: "profile", root: "/p/x/dsh" }), null);
});

console.log("localRefs");
// This is the check npm does not do. A tree can exit 0 from npm and still be
// missing the bundle index.html points at, and the only symptom is a blank page.
const distDir = "/tree/node_modules/@deepseek-ai/dsh-web-frontend/dist";
check("marks every same-directory reference present or missing", () => {
  globalThis.__testReadFile = (p) => (p === `${distDir}/index.html`
    ? '<script type="module" src="./assets/index-AAA.js"></script><link href="./assets/b.css"><script src="./assets/gone.js"></script><link rel="manifest" href="./manifest.webmanifest">'
    : void 0);
  globalThis.__testExists = (p) => p !== `${distDir}/assets/gone.js`;
  assert.deepEqual(localRefs(`${distDir}/index.html`), [
    { rel: "assets/index-AAA.js", present: true },
    { rel: "assets/b.css", present: true },
    { rel: "assets/gone.js", present: false },
    { rel: "manifest.webmanifest", present: true }
  ]);
});
check("an unreadable index.html is reported as null", () => {
  globalThis.__testReadFile = () => void 0;
  assert.equal(localRefs("/nope/index.html"), null);
});

console.log("verifyInstallTree");
const treeHtml = `${distDir}/index.html`;
const treePkg = "/tree/package.json";
function armTree({ version, present, html = '<script src="./assets/index-AAA.js"></script>' }) {
  globalThis.__testReadFile = (p) => {
    if (p === treePkg) return JSON.stringify({ name: "@deepseek-ai/dsh", version });
    if (p === treeHtml) return html;
    return void 0;
  };
  globalThis.__testExists = (p) => present.includes(p);
}
check("accepts a tree whose version and assets are all present", () => {
  armTree({ version: "0.2.0-rc.1", present: [`${distDir}/assets/index-AAA.js`] });
  assert.equal(verifyInstallTree("/tree", "0.2.0-rc.1").ok, true);
});
check("refuses a tree that stayed on the old release", () => {
  armTree({ version: "0.1.7-rc.2", present: [`${distDir}/assets/index-AAA.js`] });
  const got = verifyInstallTree("/tree", "0.2.0-rc.1");
  assert.equal(got.ok, false);
  assert.match(got.error, /版本不符/);
});
check("refuses the blank-page tree: right version, missing bundle", () => {
  armTree({ version: "0.2.0-rc.1", present: [] });
  const got = verifyInstallTree("/tree", "0.2.0-rc.1");
  assert.equal(got.ok, false);
  assert.match(got.error, /白屏/);
});
check("refuses a tree with no frontend entry at all", () => {
  // Fail closed: every published dsh ships this frontend, so an unreadable
  // index.html is a broken tree, not a tree with nothing to check.
  globalThis.__testReadFile = (p) => (p === treePkg ? JSON.stringify({ version: "0.2.0-rc.1" }) : void 0);
  globalThis.__testExists = () => false;
  const got = verifyInstallTree("/tree", "0.2.0-rc.1");
  assert.equal(got.ok, false);
  assert.match(got.error, /读不到前端入口/);
});
check("refuses an entry that points at nothing local", () => {
  armTree({ version: "0.2.0-rc.1", present: [], html: "<html><head></head><body></body></html>" });
  const got = verifyInstallTree("/tree", "0.2.0-rc.1");
  assert.equal(got.ok, false);
  assert.match(got.error, /没有任何本地资源引用/);
});
check("the real published shape is covered: both JS entries are seen", () => {
  // The 0.2.0-rc.1 build references seven local files: a module script, a
  // modulepreload vendor script, two stylesheets, two favicons and the manifest.
  // Losing the two JS entries is exactly what produced the blank page, so the
  // extractor has to see them even when only the CSS files survive.
  const shape = [
    '<link rel="manifest" href="./manifest.webmanifest" />',
    '<link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />',
    '<link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />',
    '<script type="module" crossorigin src="./assets/index-Dy0OhsZ5.js"></script>',
    '<link rel="modulepreload" crossorigin href="./assets/vendor-CCJJTK99.js">',
    '<link rel="stylesheet" crossorigin href="./assets/vendor-BNsW4eBh.css">',
    '<link rel="stylesheet" crossorigin href="./assets/index-Cq6ljTv2.css">'
  ].join("\n");
  armTree({ version: "0.2.0-rc.1", present: [], html: shape });
  globalThis.__testExists = (p) => p.endsWith(".css");
  const refs = localRefs(treeHtml);
  assert.equal(refs.length, 7);
  assert.deepEqual(refs.filter((ref) => !ref.present).map((ref) => ref.rel), [
    "manifest.webmanifest",
    "favicon-dark.svg",
    "favicon.svg",
    "assets/index-Dy0OhsZ5.js",
    "assets/vendor-CCJJTK99.js"
  ]);
  const got = verifyInstallTree("/tree", "0.2.0-rc.1");
  assert.equal(got.ok, false);
  assert.match(got.error, /前端资源缺失 5 个/);
});

console.log("globalRootIn");
check("POSIX global root lives under lib/node_modules", () => {
  globalThis.__testExists = (p) => p === "/stag/lib/node_modules/@deepseek-ai/dsh/package.json";
  assert.equal(globalRootIn("/stag"), "/stag/lib/node_modules/@deepseek-ai/dsh");
});
check("Windows global root has no lib level", () => {
  globalThis.__testExists = (p) => p === "/stag/node_modules/@deepseek-ai/dsh/package.json";
  assert.equal(globalRootIn("/stag"), "/stag/node_modules/@deepseek-ai/dsh");
});
check("null when neither layout is there", () => {
  globalThis.__testExists = () => false;
  assert.equal(globalRootIn("/stag"), null);
});

console.log("buildStagedCommand");
check("stages into a throwaway prefix, with -g as a flag", () => {
  const staging = "/p/.dsh-update-staging-x";
  const argv = buildStagedCommand({ argv: ["/usr/bin/npm"], cliJs: null }, "0.2.0-rc.1", staging, "https://r.test");
  assert.deepEqual(argv, [
    "/usr/bin/npm", "install", "-g", "@deepseek-ai/dsh@0.2.0-rc.1",
    "--prefix", staging, "--registry", "https://r.test", "--no-audit", "--no-fund"
  ]);
  // The `global` positional bug: written as a bare word it installs the unrelated
  // `global@4.x` package and turns the whole run into a LOCAL install.
  assert.ok(!argv.includes("global"));
  assert.ok(argv.indexOf("-g") < argv.indexOf("--prefix"));
  assert.equal(argv[argv.indexOf("--prefix") + 1], staging);
});

console.log("swapStagedTree");
// The swap replaces the tree the RUNNING process serves files from, so it has to
// be all-or-nothing: park the live tree outside node_modules, put the verified
// staged tree in its place, and roll back if the second rename fails.
const liveRoot = "/p/lib/node_modules/@deepseek-ai/dsh";
const stagedRoot = "/p/.dsh-update-staging-1/lib/node_modules/@deepseek-ai/dsh";
check("parks the live tree outside node_modules, then swaps the staged one in", () => {
  const calls = [];
  globalThis.__testRename = (from, to) => calls.push(["rename", from, to]);
  globalThis.__testRm = (p) => calls.push(["rm", p]);
  const got = swapStagedTree({ root: liveRoot, dir: "/p" }, stagedRoot, () => {});
  assert.equal(got.ok, true);
  assert.deepEqual(calls, [
    ["rm", "/p/.dsh-update-previous"],
    ["rename", liveRoot, "/p/.dsh-update-previous"],
    ["rename", stagedRoot, liveRoot]
  ]);
});
check("a failed swap puts the live tree back", () => {
  const calls = [];
  globalThis.__testRename = (from, to) => {
    calls.push(["rename", from, to]);
    if (from === stagedRoot) throw new Error("EXDEV: cross-device link");
  };
  globalThis.__testRm = () => {};
  const got = swapStagedTree({ root: liveRoot, dir: "/p" }, stagedRoot, () => {});
  assert.equal(got.ok, false);
  assert.deepEqual(calls.at(-1), ["rename", "/p/.dsh-update-previous", liveRoot]);
});
check("a live tree that cannot be moved is left untouched", () => {
  const calls = [];
  globalThis.__testRename = (from, to) => {
    calls.push([from, to]);
    throw new Error("EACCES");
  };
  globalThis.__testRm = () => {};
  const got = swapStagedTree({ root: liveRoot, dir: "/p" }, stagedRoot, () => {});
  assert.equal(got.ok, false);
  assert.match(got.error, /无法移开当前副本/);
  assert.equal(calls.length, 1);
});
check("a rollback that also fails says so, instead of claiming a rollback happened", () => {
  // This is the state where the live path is EMPTY: the caller must not be told a
  // rollback happened, and must not delete the staging prefix (the verified tree
  // is still in there).
  globalThis.__testRename = (from) => {
    if (from === stagedRoot || from === "/p/.dsh-update-previous") throw new Error("EACCES");
  };
  globalThis.__testRm = () => {};
  const got = swapStagedTree({ root: liveRoot, dir: "/p" }, stagedRoot, () => {});
  assert.equal(got.ok, false);
  assert.match(got.error, /回滚也失败/);
  assert.match(got.error, /\.dsh-update-previous/);
});
check("a live tree that was moved is never reported as a successful rollback", () => {
  globalThis.__testRename = (from) => {
    if (from === stagedRoot) throw new Error("EXDEV");
  };
  globalThis.__testRm = () => {};
  const got = swapStagedTree({ root: liveRoot, dir: "/p" }, stagedRoot, () => {});
  assert.equal(got.ok, false);
  assert.match(got.error, /已回滚到原版本/);
  assert.doesNotMatch(got.error, /回滚也失败/);
});
check("failing to clear the previous backup touches neither tree", () => {
  const renamed = [];
  globalThis.__testRm = () => {
    throw new Error("EBUSY");
  };
  globalThis.__testRename = (from) => renamed.push(from);
  const got = swapStagedTree({ root: liveRoot, dir: "/p" }, stagedRoot, () => {});
  assert.equal(got.ok, false);
  assert.match(got.error, /无法清理上一次的备份/);
  assert.deepEqual(renamed, []);
});

console.log("stagedNpmInstall");
// This function is the only place that decides whether a staging prefix may be
// deleted. Deleting it after a swap whose rollback failed would throw away the
// verified tree while the live path is empty, so the real function is driven
// against stubbed steps rather than restated in an assertion.
const stagedHarness = [
  // `extractFunction` slices from the word `function`, so the `async` modifier has
  // to be put back by hand; without it the body's `await` is a syntax error.
  `async ${extractFunction("stagedNpmInstall")}`,
  'const PACKAGE_NAME = "@deepseek-ai/dsh";',
  "const join = (...parts) => parts.join('/');",
  "const state = { scenario: null, removed: [], logs: [], probed: [] };",
  "function pushLog(line) { state.logs.push(line) }",
  "function mkdirSync() {}",
  "function rmSync(p) { state.removed.push(p) }",
  "function existsSync(p) { state.probed.push(p); return (state.scenario.liveBackPaths || []).includes(p) }",
  "function buildStagedCommand() { return ['npm', 'install'] }",
  "async function runCommand() { return state.scenario.install }",
  "function globalRootIn() { return state.scenario.stagedRoot }",
  "function verifyInstallTree() { return state.scenario.verify }",
  "function swapStagedTree() { return state.scenario.swap }",
  "export { stagedNpmInstall, state };"
].join("\n");
const stagedModule = await import(`data:text/javascript,${encodeURIComponent(stagedHarness)}`);

const stagedInstall = {
  binary: { argv: ["npm"], cliJs: null },
  manager: "npm",
  dir: "/p",
  root: "/p/lib/node_modules/@deepseek-ai/dsh"
};
const stagedRootPath = "/p/.dsh-update-staging-1/lib/node_modules/@deepseek-ai/dsh";
// The probe below is the whole point of the deletion rule: the LIVE tree's own
// package.json decides, not "did the swap report success".
const livePackageJson = join(stagedInstall.root, "package.json");
async function driveStaged(scenario) {
  stagedModule.state.scenario = scenario;
  stagedModule.state.removed.length = 0;
  stagedModule.state.logs.length = 0;
  stagedModule.state.probed.length = 0;
  return stagedModule.stagedNpmInstall(stagedInstall, "0.2.0-rc.1", "https://r.test", () => {});
}

await checkAsync("keeps the staging prefix when the live path did not come back", async () => {
  const result = await driveStaged({
    install: { ok: true, code: 0, error: null },
    stagedRoot: stagedRootPath,
    verify: { ok: true, error: null },
    swap: { ok: false, code: -1, error: "替换失败，且回滚也失败" },
    liveBackPaths: []
  });
  assert.equal(result.ok, false);
  assert.deepEqual(stagedModule.state.removed, [], "the verified tree must stay on disk");
  assert.deepEqual(stagedModule.state.probed, [livePackageJson]);
  assert.ok(stagedModule.state.logs.some((line) => line.includes("保留临时目录")));
});
await checkAsync("drops the staging prefix once the live tree is back", async () => {
  await driveStaged({
    install: { ok: true, code: 0, error: null },
    stagedRoot: stagedRootPath,
    verify: { ok: true, error: null },
    swap: { ok: true, code: 0, error: null },
    liveBackPaths: [livePackageJson]
  });
  assert.equal(stagedModule.state.removed.length, 1);
});
await checkAsync("a swap reporting success still keeps the staging prefix if no live tree is there", async () => {
  // `swapped.ok` is NOT the criterion. If the live path holds no package.json, the
  // staging prefix is the only good copy left, whatever the swap reported.
  await driveStaged({
    install: { ok: true, code: 0, error: null },
    stagedRoot: stagedRootPath,
    verify: { ok: true, error: null },
    swap: { ok: true, code: 0, error: null },
    liveBackPaths: []
  });
  assert.deepEqual(stagedModule.state.removed, []);
  assert.ok(stagedModule.state.logs.some((line) => line.includes("保留临时目录")));
});
await checkAsync("a rolled-back swap drops the staging prefix like any other failed replace", async () => {
  // Rollback succeeded, so the live tree is intact and the staging prefix is
  // disposable — even though the swap reported failure.
  const result = await driveStaged({
    install: { ok: true, code: 0, error: null },
    stagedRoot: stagedRootPath,
    verify: { ok: true, error: null },
    swap: { ok: false, code: -1, error: "替换运行副本失败，已回滚到原版本：EACCES" },
    liveBackPaths: [livePackageJson]
  });
  assert.equal(result.ok, false);
  assert.equal(stagedModule.state.removed.length, 1);
});
await checkAsync("never swaps in a staged tree that failed verification", async () => {
  let swapRan = false;
  const result = await driveStaged({
    install: { ok: true, code: 0, error: null },
    stagedRoot: stagedRootPath,
    verify: { ok: false, error: "前端资源缺失 5 个" },
    get swap() {
      swapRan = true;
      return { ok: true, code: 0, error: null };
    },
    liveBackPaths: [livePackageJson]
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /不完整/);
  assert.equal(swapRan, false, "the swap must not run at all");
});
await checkAsync("a failed install drops the staging prefix and changes nothing", async () => {
  const result = await driveStaged({
    install: { ok: false, code: 1, error: null },
    stagedRoot: null,
    verify: null,
    swap: null,
    liveBackPaths: [livePackageJson]
  });
  assert.equal(result.ok, false);
  assert.equal(stagedModule.state.removed.length, 1);
});

console.log("swapStagedTree (real filesystem)");
// The mocked pass above checks the order of calls; this one checks that two real
// renames actually do what the swap claims. A staging prefix beside the live tree
// is what makes each step a rename instead of a copy, so it is exercised for real.
const realHarnessPath = join(tmpdir(), `dsh-update-swap-${String(process.pid)}.mjs`);
writeFileSync(realHarnessPath, [
  'import { renameSync, rmSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  extractFunction("swapStagedTree"),
  'const PACKAGE_NAME = "@deepseek-ai/dsh";',
  "export { swapStagedTree };"
].join("\n"), "utf8");
const { swapStagedTree: swapOnDisk } = await import(pathToFileURL(realHarnessPath).href);
rmSync(realHarnessPath, { force: true });

const scopeUnder = (prefix) => join(prefix, "lib", "node_modules", "@deepseek-ai");
function makeTrees() {
  const base = mkdtempSync(join(tmpdir(), "dsh-swap-"));
  const prefix = join(base, "prefix");
  const live = join(scopeUnder(prefix), "dsh");
  const staged = join(prefix, ".dsh-update-staging-x", "lib", "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(live, { recursive: true });
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(live, "marker.txt"), "old", "utf8");
  writeFileSync(join(staged, "marker.txt"), "new", "utf8");
  return { base, prefix, live, staged };
}
check("the staged tree ends up live and the old one is parked outside node_modules", () => {
  const t = makeTrees();
  try {
    const got = swapOnDisk({ root: t.live, dir: t.prefix }, t.staged, () => {});
    assert.equal(got.ok, true);
    assert.equal(readFileSync(join(t.live, "marker.txt"), "utf8"), "new");
    assert.equal(readFileSync(join(t.prefix, ".dsh-update-previous", "marker.txt"), "utf8"), "old");
    assert.equal(existsSync(t.staged), false);
    assert.equal(existsSync(join(scopeUnder(t.prefix), ".dsh-update-previous")), false);
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});
check("a second swap replaces the parked copy instead of piling up", () => {
  const t = makeTrees();
  try {
    assert.equal(swapOnDisk({ root: t.live, dir: t.prefix }, t.staged, () => {}).ok, true);
    const staged2 = join(t.prefix, ".dsh-update-staging-y", "lib", "node_modules", "@deepseek-ai", "dsh");
    mkdirSync(staged2, { recursive: true });
    writeFileSync(join(staged2, "marker.txt"), "newer", "utf8");
    assert.equal(swapOnDisk({ root: t.live, dir: t.prefix }, staged2, () => {}).ok, true);
    assert.equal(readFileSync(join(t.live, "marker.txt"), "utf8"), "newer");
    assert.equal(readFileSync(join(t.prefix, ".dsh-update-previous", "marker.txt"), "utf8"), "new");
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});
check("a staged tree that is not there leaves the live tree alone", () => {
  const t = makeTrees();
  try {
    const got = swapOnDisk({ root: t.live, dir: t.prefix }, join(t.prefix, "missing"), () => {});
    assert.equal(got.ok, false);
    assert.equal(readFileSync(join(t.live, "marker.txt"), "utf8"), "old");
  } finally {
    rmSync(t.base, { recursive: true, force: true });
  }
});

console.log(`\n${String(passed)} 项检查全部通过`);
