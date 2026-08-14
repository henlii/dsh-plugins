// dsh-sidebar host half — workspace files + git diff + file editing RPC.
//
// Exposes exact HTTP routes under /api/dsh-sidebar/* (the dsh-ssh pattern):
// the browser half fetches them directly, and an installed dsh-web-auth
// deployment gates every /api route (including these exact ones) behind the
// password cookie. Routes operate on the CURRENT session's workspace
// (sessions.get(sessionId).header.cwd), reading files through the `fs`
// service and running git through the `subprocess` service.
//
// Routes (all POST, JSON):
//   /api/dsh-sidebar/snapshot  {sessionId}  → { cwd, rootName, files, git }
//   /api/dsh-sidebar/read      {sessionId, path}            → { content, truncated }
//   /api/dsh-sidebar/write     {sessionId, path, content}   → { ok }
//   /api/dsh-sidebar/diff      {sessionId, path}            → { diff, untracked }
const name = "dsh-sidebar";
const inject = ["webServer", "sessions", "sessionQuery", "fs", "subprocess"];

const API_PREFIX = "/api/dsh-sidebar";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 5;
const MAX_ENTRIES = 1200;
const MAX_READ_BYTES = 512 * 1024;
const MAX_GIT_BYTES = 768 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".venv", "__pycache__", ".cache"]);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
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

/** Run git in `cwd`; returns { ok, code, stdout, stderr }. */
async function runGit(subprocess, cwd, args) {
  try {
    const handle = subprocess.spawn({
      argv: ["git", ...args],
      cwd,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: MAX_GIT_BYTES },
        stderr: { maxBytes: 64 * 1024 }
      },
      graceMs: 8000
    });
    const outcome = await handle.done;
    return {
      ok: outcome.exitCode === 0,
      code: outcome.exitCode,
      stdout: handle.collected.stdout.readFrom(0).text,
      stderr: handle.collected.stderr.readFrom(0).text
    };
  } catch (error) {
    return { ok: false, code: null, stdout: "", stderr: String(error) };
  }
}

/**
* Parse `git status --porcelain=v1` output into { branch, changes }.
* Change entries: { index, worktree, path, oldPath? } with single-letter
* status codes (M/A/D/R/C/U/?). Renames carry `old -> new`.
*/
function parseGitStatus(text) {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const changes = [];
  let branch = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      branch = line.slice(3).split(" ")[0].replace(/^.*\.\.\./, "");
      continue;
    }
    if (line.length < 4) continue;
    const index = line[0];
    const worktree = line[1];
    let path = line.slice(3);
    let oldPath;
    if (index === "R" || index === "C") {
      const arrow = path.indexOf(" -> ");
      if (arrow !== -1) {
        oldPath = path.slice(0, arrow);
        path = path.slice(arrow + 4);
      }
    }
    // git quotes paths with C-style escapes; a leading " is a quoted path.
    if (path.startsWith('"')) {
      try {
        path = JSON.parse(path);
      } catch {
        /* keep raw */
      }
    }
    changes.push({ index, worktree, path, ...(oldPath === void 0 ? {} : { oldPath }) });
  }
  return { branch, changes };
}

/** Recursively build a bounded file tree (skips heavy dirs). */
async function buildTree(fs, target, cwd, depth, state) {
  if (depth > MAX_DEPTH || state.count >= MAX_ENTRIES) return [];
  let entries = [];
  try {
    entries = await fs.listDir(target);
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (state.count >= MAX_ENTRIES) break;
    if (entry.type !== "directory" && entry.type !== "file") continue;
    if (entry.type === "directory" && SKIP_DIRS.has(entry.name)) continue;
    const abs = fs.processPath(entry.target);
    const rel = abs.startsWith(cwd) ? abs.slice(cwd.length + 1) : abs;
    state.count += 1;
    if (entry.type === "directory") {
      out.push({
        name: entry.name,
        type: "dir",
        path: rel,
        children: await buildTree(fs, entry.target, cwd, depth + 1, state)
      });
    } else {
      out.push({ name: entry.name, type: "file", path: rel });
    }
  }
  // Directories first, then files; each group by natural, case-insensitive name.
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, void 0, { numeric: true, sensitivity: "base" });
  });
  return out;
}

/**
* Resolve a session's workspace cwd. The live session store only holds active
* sessions, so a non-active session falls back to the session query's stored
* header (which carries cwd).
* @param sessions - live sessions service.
* @param sessionQuery - storage-backed session query service.
* @param sessionId - target session id.
* @returns the absolute workspace path, or undefined when unknown.
*/
async function resolveCwd(sessions, sessionQuery, sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return void 0;
  const live = sessions !== void 0 ? sessions.get(sessionId) : void 0;
  const liveCwd = live !== void 0 && live.header !== void 0 ? live.header.cwd : void 0;
  if (typeof liveCwd === "string" && liveCwd.length > 0) return liveCwd;
  if (sessionQuery !== void 0) {
    try {
      const snapshot = await sessionQuery.readSession(sessionId);
      const storedCwd = snapshot !== void 0 && snapshot.session !== void 0 ? snapshot.session.cwd : void 0;
      if (typeof storedCwd === "string" && storedCwd.length > 0) return storedCwd;
    } catch {
      /* session not found in storage */
    }
  }
  return void 0;
}

/** Extract leaf session-header fields for display (null when unknown). */
function sessionFields(header) {
  if (header === void 0) return null;
  return {
    createdAt: typeof header.createdAt === "number" ? header.createdAt : null,
    parentSession: typeof header.parentSession === "string" ? header.parentSession : null,
    seedLength: typeof header.seedLength === "number" ? header.seedLength : null,
    origin: typeof header.origin === "string" ? header.origin : null,
    delegationDepth: typeof header.delegationDepth === "number" ? header.delegationDepth : null,
    agentPreset: typeof header.agentPreset === "string" ? header.agentPreset : null
  };
}

/** Read session info: live session store first, storage-backed query fallback. */
async function readSessionInfo(sessions, sessionQuery, sessionId) {
  const live = sessions !== void 0 ? sessions.get(sessionId) : void 0;
  if (live !== void 0 && live.header !== void 0) return sessionFields(live.header);
  if (sessionQuery !== void 0) {
    try {
      const snapshot = await sessionQuery.readSession(sessionId);
      return sessionFields(snapshot !== void 0 ? snapshot.session : void 0);
    } catch {
      return null;
    }
  }
  return null;
}

function apply(ctx) {
  const webServer = ctx.get("webServer");
  if (webServer === void 0) return;

  const routes = [
    { path: `${API_PREFIX}/snapshot`, handler: snapshot },
    { path: `${API_PREFIX}/read`, handler: readFile },
    { path: `${API_PREFIX}/write`, handler: writeFile },
    { path: `${API_PREFIX}/diff`, handler: fileDiff }
  ];
  for (const route of routes) {
    ctx.effect(() => webServer.register({
      kind: "exact",
      path: route.path,
      handler: async (req, res) => {
        try {
          await route.handler(ctx, req, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }), `dsh-sidebar: ${route.path}`);
  }

  async function snapshot(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const sessionId = body !== null && typeof body.sessionId === "string" ? body.sessionId : "";
    const sessions = ctx.get("sessions");
    const fs = ctx.get("fs");
    const subprocess = ctx.get("subprocess");
    const cwd = await resolveCwd(sessions, ctx.get("sessionQuery"), sessionId);
    if (cwd === void 0 || fs === void 0 || subprocess === void 0) {
      sendJson(res, 404, { ok: false, error: "no active workspace for this session" });
      return;
    }
    let root;
    try {
      root = await fs.resolve(cwd, { cwd });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `cannot resolve workspace: ${String(error)}` });
      return;
    }
    const state = { count: 0 };
    const files = await buildTree(fs, root, cwd, 0, state);

    const status = await runGit(subprocess, cwd, ["status", "--porcelain=v1", "-b"]);
    let git = { isGit: false, branch: null, changes: [] };
    if (status.ok) {
      const parsed = parseGitStatus(status.stdout);
      git = { isGit: true, branch: parsed.branch, changes: parsed.changes };
    }

    const rootName = cwd.split("/").filter(Boolean).pop() || cwd;
    const session = await readSessionInfo(sessions, ctx.get("sessionQuery"), sessionId);
    sendJson(res, 200, { ok: true, cwd, rootName, files, git, session });
  }

  async function readFile(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const sessions = ctx.get("sessions");
    const fs = ctx.get("fs");
    const cwd = await resolveCwd(sessions, ctx.get("sessionQuery"), body !== null ? body.sessionId : void 0);
    const path = body !== null && typeof body.path === "string" ? body.path : "";
    if (cwd === void 0 || fs === void 0 || path.length === 0) {
      sendJson(res, 400, { ok: false, error: "missing session or path" });
      return;
    }
    let target;
    try {
      target = await fs.resolve(path, { cwd });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `cannot resolve ${path}` });
      return;
    }
    const data = await fs.readBytes(target, void 0, MAX_READ_BYTES).catch(() => void 0);
    if (data === void 0) {
      sendJson(res, 400, { ok: false, error: `cannot read ${path}` });
      return;
    }
    const truncated = data.byteLength >= MAX_READ_BYTES;
    sendJson(res, 200, {
      ok: true,
      path,
      content: new TextDecoder("utf-8", { fatal: false }).decode(data),
      truncated
    });
  }

  async function writeFile(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const sessions = ctx.get("sessions");
    const fs = ctx.get("fs");
    const cwd = await resolveCwd(sessions, ctx.get("sessionQuery"), body !== null ? body.sessionId : void 0);
    const path = body !== null && typeof body.path === "string" ? body.path : "";
    const content = body !== null && typeof body.content === "string" ? body.content : "";
    if (cwd === void 0 || fs === void 0 || path.length === 0) {
      sendJson(res, 400, { ok: false, error: "missing session or path" });
      return;
    }
    let target;
    try {
      target = await fs.resolve(path, { cwd });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `cannot resolve ${path}` });
      return;
    }
    try {
      await fs.writeText(target, content);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    sendJson(res, 200, { ok: true });
  }

  async function fileDiff(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const sessions = ctx.get("sessions");
    const fs = ctx.get("fs");
    const subprocess = ctx.get("subprocess");
    const cwd = await resolveCwd(sessions, ctx.get("sessionQuery"), body !== null ? body.sessionId : void 0);
    const path = body !== null && typeof body.path === "string" ? body.path : "";
    if (cwd === void 0 || subprocess === void 0 || path.length === 0) {
      sendJson(res, 400, { ok: false, error: "missing session or path" });
      return;
    }
    const diff = await runGit(subprocess, cwd, ["diff", "--", path]);
    // `git diff` exits 0 (empty output) for untracked files, so untracked
    // detection must come from `git status` for that path, not from the exit.
    const status = await runGit(subprocess, cwd, ["status", "--porcelain=v1", "--", path]);
    const untracked = status.ok && status.stdout.trim().startsWith("??");
    let preview = "";
    if (untracked && fs !== void 0) {
      try {
        const target = await fs.resolve(path, { cwd });
        const data = await fs.readBytes(target, void 0, MAX_READ_BYTES);
        preview = new TextDecoder("utf-8", { fatal: false }).decode(data);
      } catch {
        /* no preview */
      }
    }
    sendJson(res, 200, {
      ok: true,
      path,
      untracked,
      diff: diff.ok ? diff.stdout : "",
      preview
    });
  }
}

export { name, inject, apply };
