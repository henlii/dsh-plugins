// dsh-update host-half checks: the pure logic the card depends on.
//
// This is a plain Node script (no test runner) so it runs with the same
// interpreter dsh uses. It covers the three places a wrong answer is costly:
// version ordering (which release is "newer"), the merged release list, and the
// resolution of a requested version before it reaches npm.
//
// Run: node scripts/test-updater.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  "export { parseVersion, isCanonicalVersion, compareVersions, buildVersionList, resolveRequestedVersion, buildInstallCommand, classifyInstall, managerOwns };"
].join("\n");

const module = await import(`data:text/javascript,${encodeURIComponent(harness)}`);
const { compareVersions, isCanonicalVersion, buildVersionList, resolveRequestedVersion, buildInstallCommand, classifyInstall, managerOwns } = module;

let passed = 0;
function check(label, fn) {
  fn();
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

console.log(`\n${String(passed)} 项检查全部通过`);
