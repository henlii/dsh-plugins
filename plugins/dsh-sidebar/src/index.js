// dsh-sidebar host half — workspace files + git diff + file operations RPC.
//
// Exposes exact HTTP routes under /api/dsh-sidebar/* (the dsh-ssh pattern):
// the browser half fetches them directly, and an installed dsh-web-auth
// deployment gates every /api route (including these exact ones) behind the
// password cookie. Routes operate on the CURRENT session's workspace
// (sessions.get(sessionId).header.cwd), reading files through the `fs`
// service and running git through the `subprocess` service. Mutating file
// operations canonicalize against the session cwd before touching disk.
//
// Routes (all POST, JSON except noted):
//   /api/dsh-sidebar/snapshot       {sessionId, options?}            → { cwd, rootName, files, git, session, options }
//   /api/dsh-sidebar/listdir        {sessionId, path, options?}      → { path, files }
//   /api/dsh-sidebar/read           {sessionId, path}                → { content, truncated }
//   /api/dsh-sidebar/write          {sessionId, path, content}       → { ok }
//   /api/dsh-sidebar/diff           {sessionId, path}                → { diff, untracked, preview? }
//   /api/dsh-sidebar/create         {sessionId, path, type}          → { ok, path }
//   /api/dsh-sidebar/rename         {sessionId, path, newName}       → { ok, path, newPath }
//   /api/dsh-sidebar/move           {sessionId, path, targetDirectory} → { ok, path, targetPath }
//   /api/dsh-sidebar/copy           {sessionId, path, targetDirectory} → { ok, path, targetPath }
//   /api/dsh-sidebar/delete         {sessionId, path}                → { ok, path }
//   /api/dsh-sidebar/upload-check   {sessionId, directory, fileNames} → { conflicts, nonReplaceable }
//   /api/dsh-sidebar/upload         {sessionId, directory, files, strategy} → { uploaded, skipped, errors } | 409
import { cp, mkdir, realpath, rename, rm, stat, writeFile as nodeWriteFile } from "node:fs/promises";
import path from "node:path";

const name = "dsh-sidebar";
const inject = ["webServer", "sessions", "sessionQuery", "fs", "subprocess"];

const API_PREFIX = "/api/dsh-sidebar";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 48 * 1024 * 1024;
const MAX_UPLOAD_FILE_BYTES = 32 * 1024 * 1024;
const MAX_UPLOAD_FILES = 60;
const MAX_READ_BYTES = 512 * 1024;
const MAX_GIT_BYTES = 768 * 1024;
const DEFAULT_FILE_OPTIONS = {
  showHidden: false,
  skipDirs: ["node_modules", ".git", ".next", ".venv", "__pycache__", ".cache", "dist", "build", ".turbo", ".output", ".pnpm"]
};
const OPTION_LIMITS = { skipDirs: 60 };

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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error) {
  return error !== null && typeof error === "object" && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** 文件名/相对路径基础校验：拒绝分隔符、穿越与绝对逃逸。 */
function isSafeChildPath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && value !== "."
    && value !== ".."
    && !value.includes("\0")
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "..");
}

function isSafeName(value) {
  return isSafeChildPath(value) && !value.includes("/");
}

/** 目录参数允许 "."（项目根）。 */
function isSafeDirectoryPath(value) {
  return value === "." || isSafeChildPath(value);
}

function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function existingPath(cwd, requestPath) {
  const base = await realpath(cwd);
  const requested = path.isAbsolute(requestPath) ? path.normalize(requestPath) : path.resolve(base, requestPath);
  const target = await realpath(requested);
  if (!isInside(base, target)) throw new Error(`path escapes workspace: ${requestPath}`);
  return { base, target };
}

async function missingPath(cwd, requestPath) {
  const base = await realpath(cwd);
  const requested = path.isAbsolute(requestPath) ? path.normalize(requestPath) : path.resolve(base, requestPath);
  const parent = await realpath(path.dirname(requested));
  const target = path.join(parent, path.basename(requested));
  if (!isInside(base, target)) throw new Error(`path escapes workspace: ${requestPath}`);
  return { base, target };
}

async function pathExists(target) {
  try {
    const info = await stat(target);
    return { exists: true, isDir: info.isDirectory() };
  } catch (error) {
    if (isMissing(error)) return { exists: false, isDir: false };
    throw error;
  }
}

/** 解析文件树过滤：隐藏文件与忽略目录名。不做数量/深度截断。 */
function parseFileOptions(input) {
  const source = input !== null && typeof input === "object" ? input : {};
  const skipDirs = Array.isArray(source.skipDirs)
    ? source.skipDirs.filter((item) => typeof item === "string" && item.length > 0 && item.length <= 80).slice(0, OPTION_LIMITS.skipDirs)
    : DEFAULT_FILE_OPTIONS.skipDirs;
  return {
    showHidden: source.showHidden === true,
    skipDirs: [...new Set(skipDirs)]
  };
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
    return { ok: false, code: null, stdout: "", stderr: errorMessage(error) };
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
    let requestPath = line.slice(3);
    let oldPath;
    if (index === "R" || index === "C") {
      const arrow = requestPath.indexOf(" -> ");
      if (arrow !== -1) {
        oldPath = requestPath.slice(0, arrow);
        requestPath = requestPath.slice(arrow + 4);
      }
    }
    // git quotes paths with C-style escapes; a leading " is a quoted path.
    if (requestPath.startsWith('"')) {
      try {
        requestPath = JSON.parse(requestPath);
      } catch {
        /* keep raw */
      }
    }
    changes.push({ index, worktree, path: requestPath, ...(oldPath === void 0 ? {} : { oldPath }) });
  }
  return { branch, changes };
}

/** 只列 target 这一层。目录带 loaded:false，展开后再 listdir。 */
async function listLevel(fs, target, cwd, options) {
  let entries = [];
  try {
    entries = await fs.listDir(target);
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (entry.type !== "directory" && entry.type !== "file") continue;
    if (!options.showHidden && entry.name.startsWith(".")) continue;
    if (entry.type === "directory" && options.skipDirs.includes(entry.name)) continue;
    const abs = fs.processPath(entry.target);
    const rel = path.relative(cwd, abs);
    if (entry.type === "directory") {
      out.push({ name: entry.name, type: "dir", path: rel, loaded: false, children: [] });
    } else {
      out.push({ name: entry.name, type: "file", path: rel });
    }
  }
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
    { path: `${API_PREFIX}/listdir`, handler: listDirectory },
    { path: `${API_PREFIX}/read`, handler: readFile },
    { path: `${API_PREFIX}/write`, handler: writeFile },
    { path: `${API_PREFIX}/diff`, handler: fileDiff },
    { path: `${API_PREFIX}/create`, handler: createEntry },
    { path: `${API_PREFIX}/rename`, handler: renameEntry },
    { path: `${API_PREFIX}/move`, handler: moveEntry },
    { path: `${API_PREFIX}/copy`, handler: copyEntry },
    { path: `${API_PREFIX}/delete`, handler: deleteEntry },
    { path: `${API_PREFIX}/upload-check`, handler: uploadCheck },
    { path: `${API_PREFIX}/upload`, handler: uploadFiles }
  ];
  for (const route of routes) {
    ctx.effect(() => webServer.register({
      kind: "exact",
      path: route.path,
      handler: async (req, res) => {
        try {
          await route.handler(ctx, req, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorMessage(error) });
        }
      }
    }), `dsh-sidebar: ${route.path}`);
  }

  async function workspace(body) {
    const sessionId = body !== null && typeof body.sessionId === "string" ? body.sessionId : "";
    const sessions = ctx.get("sessions");
    const fs = ctx.get("fs");
    const cwd = await resolveCwd(sessions, ctx.get("sessionQuery"), sessionId);
    if (cwd === void 0 || fs === void 0) return null;
    return { sessionId, sessions, fs, cwd };
  }

  async function snapshot(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const ws = await workspace(body);
    if (ws === null) {
      sendJson(res, 404, { ok: false, error: "no active workspace for this session" });
      return;
    }
    const subprocess = ctx.get("subprocess");
    if (subprocess === void 0) {
      sendJson(res, 404, { ok: false, error: "git subprocess service is unavailable" });
      return;
    }
    let root;
    try {
      root = await ws.fs.resolve(ws.cwd, { cwd: ws.cwd });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `cannot resolve workspace: ${errorMessage(error)}` });
      return;
    }
    const options = parseFileOptions(body !== null ? body.options : void 0);
    const [files, git, session] = await Promise.all([
      listLevel(ws.fs, root, ws.cwd, options),
      runGit(subprocess, ws.cwd, ["status", "--porcelain=v1", "-b"]).then((status) => {
        if (!status.ok) return { isGit: false, branch: null, changes: [] };
        const parsed = parseGitStatus(status.stdout);
        return { isGit: true, branch: parsed.branch, changes: parsed.changes };
      }),
      readSessionInfo(ws.sessions, ctx.get("sessionQuery"), ws.sessionId)
    ]);
    const rootName = path.basename(ws.cwd) || ws.cwd;
    sendJson(res, 200, { ok: true, cwd: ws.cwd, rootName, files, git, session, options });
  }

  async function listDirectory(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const ws = await workspace(body);
    const requestPath = body !== null && typeof body.path === "string" ? body.path : ".";
    if (ws === null || !isSafeDirectoryPath(requestPath)) {
      sendJson(res, 400, { ok: false, error: "missing session or path" });
      return;
    }
    let target;
    try {
      target = requestPath === "."
        ? await ws.fs.resolve(ws.cwd, { cwd: ws.cwd })
        : await ws.fs.resolve(requestPath, { cwd: ws.cwd });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `cannot resolve ${requestPath}` });
      return;
    }
    const options = parseFileOptions(body !== null ? body.options : void 0);
    const files = await listLevel(ws.fs, target, ws.cwd, options);
    sendJson(res, 200, { ok: true, path: requestPath, files });
  }

  async function readFile(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const ws = await workspace(body);
    const requestPath = body !== null && typeof body.path === "string" ? body.path : "";
    if (ws === null || requestPath.length === 0 || !isSafeChildPath(requestPath)) {
      sendJson(res, 400, { ok: false, error: "missing session or path" });
      return;
    }
    let target;
    try {
      target = await ws.fs.resolve(requestPath, { cwd: ws.cwd });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `cannot resolve ${requestPath}` });
      return;
    }
    const data = await ws.fs.readBytes(target, void 0, MAX_READ_BYTES).catch(() => void 0);
    if (data === void 0) {
      sendJson(res, 400, { ok: false, error: `cannot read ${requestPath}` });
      return;
    }
    const truncated = data.byteLength >= MAX_READ_BYTES;
    sendJson(res, 200, {
      ok: true,
      path: requestPath,
      content: new TextDecoder("utf-8", { fatal: false }).decode(data),
      truncated
    });
  }

  async function writeFile(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const ws = await workspace(body);
    const requestPath = body !== null && typeof body.path === "string" ? body.path : "";
    const content = body !== null && typeof body.content === "string" ? body.content : "";
    if (ws === null || requestPath.length === 0 || !isSafeChildPath(requestPath)) {
      sendJson(res, 400, { ok: false, error: "missing session or path" });
      return;
    }
    let target;
    try {
      target = await ws.fs.resolve(requestPath, { cwd: ws.cwd });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `cannot resolve ${requestPath}` });
      return;
    }
    try {
      await ws.fs.writeText(target, content);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorMessage(error) });
      return;
    }
    sendJson(res, 200, { ok: true });
  }

  async function fileDiff(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const ws = await workspace(body);
    const requestPath = body !== null && typeof body.path === "string" ? body.path : "";
    const subprocess = ctx.get("subprocess");
    if (ws === null || subprocess === void 0 || requestPath.length === 0 || !isSafeChildPath(requestPath)) {
      sendJson(res, 400, { ok: false, error: "missing session or path" });
      return;
    }
    const diff = await runGit(subprocess, ws.cwd, ["diff", "--", requestPath]);
    // `git diff` exits 0 (empty output) for untracked files, so untracked
    // detection must come from `git status` for that path, not from the exit.
    const status = await runGit(subprocess, ws.cwd, ["status", "--porcelain=v1", "--", requestPath]);
    const untracked = status.ok && status.stdout.trim().startsWith("??");
    let preview = "";
    if (untracked) {
      try {
        const target = await ws.fs.resolve(requestPath, { cwd: ws.cwd });
        const data = await ws.fs.readBytes(target, void 0, MAX_READ_BYTES);
        preview = new TextDecoder("utf-8", { fatal: false }).decode(data);
      } catch {
        /* no preview */
      }
    }
    sendJson(res, 200, {
      ok: true,
      path: requestPath,
      untracked,
      diff: diff.ok ? diff.stdout : "",
      preview
    });
  }

  async function createEntry(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const ws = await workspace(body);
    const requestPath = body !== null && typeof body.path === "string" ? body.path : "";
    const type = body !== null && typeof body.type === "string" ? body.type : "file";
    if (ws === null || requestPath.length === 0 || !isSafeChildPath(requestPath) || (type !== "file" && type !== "dir")) {
      sendJson(res, 400, { ok: false, error: "missing session or path" });
      return;
    }
    try {
      const { base, target } = await missingPath(ws.cwd, requestPath);
      const existing = await pathExists(target);
      if (existing.exists) {
        sendJson(res, 409, { ok: false, error: `already exists: ${requestPath}` });
        return;
      }
      if (type === "file") {
        const fsTarget = await ws.fs.resolve(requestPath, { cwd: ws.cwd });
        await ws.fs.writeText(fsTarget, "", { kind: "createIfAbsent" });
      } else {
        await mkdir(target);
      }
      sendJson(res, 200, { ok: true, path: path.relative(base, target) });
    } catch (error) {
      const status = isMissing(error) ? 400 : error && typeof error === "object" && (error.code === "EEXIST" || error.code === "FS_NOT_OBSERVED") ? 409 : 400;
      sendJson(res, status, { ok: false, error: errorMessage(error) });
    }
  }

  async function renameEntry(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const ws = await workspace(body);
    const requestPath = body !== null && typeof body.path === "string" ? body.path : "";
    const newName = body !== null && typeof body.newName === "string" ? body.newName : "";
    if (ws === null || requestPath.length === 0 || !isSafeChildPath(requestPath) || !isSafeName(newName)) {
      sendJson(res, 400, { ok: false, error: "missing session or path" });
      return;
    }
    try {
      const { base, target } = await existingPath(ws.cwd, requestPath);
      if (target === base) {
        sendJson(res, 400, { ok: false, error: "cannot rename the workspace root" });
        return;
      }
      const dest = path.join(path.dirname(target), newName);
      if (!isInside(base, dest)) {
        sendJson(res, 400, { ok: false, error: "target escapes the workspace" });
        return;
      }
      const existing = await pathExists(dest);
      if (existing.exists) {
        sendJson(res, 409, { ok: false, error: `already exists: ${newName}` });
        return;
      }
      await rename(target, dest);
      sendJson(res, 200, { ok: true, path: path.relative(base, target), newPath: path.relative(base, dest) });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
  }

  async function moveEntry(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const ws = await workspace(body);
    const requestPath = body !== null && typeof body.path === "string" ? body.path : "";
    const targetDirectory = body !== null && typeof body.targetDirectory === "string" ? body.targetDirectory : "";
    if (ws === null || requestPath.length === 0 || !isSafeChildPath(requestPath) || !isSafeDirectoryPath(targetDirectory)) {
      sendJson(res, 400, { ok: false, error: "missing session or path" });
      return;
    }
    try {
      const { base, target } = await existingPath(ws.cwd, requestPath);
      if (target === base) {
        sendJson(res, 400, { ok: false, error: "cannot move the workspace root" });
        return;
      }
      const { target: dirTarget } = await existingPath(ws.cwd, targetDirectory || ".");
      const dirInfo = await stat(dirTarget);
      if (!dirInfo.isDirectory()) {
        sendJson(res, 400, { ok: false, error: "target is not a directory" });
        return;
      }
      const dest = path.join(dirTarget, path.basename(target));
      if (!isInside(base, dest) || dest === target) {
        sendJson(res, 400, { ok: false, error: "invalid move target" });
        return;
      }
      const existing = await pathExists(dest);
      if (existing.exists) {
        sendJson(res, 409, { ok: false, error: `already exists: ${path.basename(target)}` });
        return;
      }
      await rename(target, dest);
      sendJson(res, 200, { ok: true, path: path.relative(base, target), targetPath: path.relative(base, dest) });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
  }

  async function copyEntry(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const ws = await workspace(body);
    const requestPath = body !== null && typeof body.path === "string" ? body.path : "";
    const targetDirectory = body !== null && typeof body.targetDirectory === "string" ? body.targetDirectory : "";
    if (ws === null || requestPath.length === 0 || !isSafeChildPath(requestPath) || !isSafeDirectoryPath(targetDirectory)) {
      sendJson(res, 400, { ok: false, error: "missing session or path" });
      return;
    }
    try {
      const { base, target } = await existingPath(ws.cwd, requestPath);
      const { target: dirTarget } = await existingPath(ws.cwd, targetDirectory || ".");
      const dirInfo = await stat(dirTarget);
      if (!dirInfo.isDirectory()) {
        sendJson(res, 400, { ok: false, error: "target is not a directory" });
        return;
      }
      const dest = path.join(dirTarget, path.basename(target));
      if (!isInside(base, dest) || dest === target) {
        sendJson(res, 400, { ok: false, error: "invalid copy target" });
        return;
      }
      const existing = await pathExists(dest);
      if (existing.exists) {
        sendJson(res, 409, { ok: false, error: `already exists: ${path.basename(target)}` });
        return;
      }
      await cp(target, dest, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
      sendJson(res, 200, { ok: true, path: path.relative(base, target), targetPath: path.relative(base, dest) });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
  }

  async function deleteEntry(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const ws = await workspace(body);
    const requestPath = body !== null && typeof body.path === "string" ? body.path : "";
    if (ws === null || requestPath.length === 0 || !isSafeChildPath(requestPath)) {
      sendJson(res, 400, { ok: false, error: "missing session or path" });
      return;
    }
    try {
      const { base, target } = await existingPath(ws.cwd, requestPath);
      if (target === base) {
        sendJson(res, 400, { ok: false, error: "cannot delete the workspace root" });
        return;
      }
      await rm(target, { recursive: true, force: false });
      sendJson(res, 200, { ok: true, path: requestPath });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
  }

  async function resolveUploadDirectory(ws, directory) {
    const requestPath = typeof directory === "string" && directory.length > 0 ? directory : ".";
    if (!isSafeDirectoryPath(requestPath)) throw new Error("invalid upload directory");
    const { base, target } = await existingPath(ws.cwd, requestPath);
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error("upload target is not a directory");
    return { base, target };
  }

  async function uploadCheck(ctx, req, res) {
    const body = await readJsonBody(req).catch(() => null);
    const ws = await workspace(body);
    const directory = body !== null && typeof body.directory === "string" ? body.directory : ".";
    const fileNames = body !== null && Array.isArray(body.fileNames) ? body.fileNames.filter((item) => typeof item === "string") : [];
    if (ws === null || fileNames.length === 0 || fileNames.length > MAX_UPLOAD_FILES) {
      sendJson(res, 400, { ok: false, error: "missing upload file list" });
      return;
    }
    try {
      const { target } = await resolveUploadDirectory(ws, directory);
      const conflicts = [];
      const nonReplaceable = [];
      for (const name of fileNames) {
        if (!isSafeName(name)) return sendJson(res, 400, { ok: false, error: `invalid file name: ${name}` });
        const dest = path.join(target, name);
        const existing = await pathExists(dest);
        if (!existing.exists) continue;
        if (existing.isDir) nonReplaceable.push(name);
        else conflicts.push(name);
      }
      sendJson(res, 200, { ok: true, conflicts, nonReplaceable });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
  }

  async function uploadFiles(ctx, req, res) {
    const body = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES).catch(() => null);
    const ws = await workspace(body);
    const directory = body !== null && typeof body.directory === "string" ? body.directory : ".";
    const files = body !== null && Array.isArray(body.files) ? body.files.filter((item) => item !== null && typeof item === "object") : [];
    const strategy = body !== null && typeof body.strategy === "string" ? body.strategy : "error";
    if (ws === null || files.length === 0 || files.length > MAX_UPLOAD_FILES || !["error", "skip", "overwrite"].includes(strategy)) {
      sendJson(res, 400, { ok: false, error: "missing upload files" });
      return;
    }
    try {
      const { target } = await resolveUploadDirectory(ws, directory);
      // 预扫描冲突：error 策略下一处冲突即整体返回 409，不写任何文件。
      const conflicts = [];
      const nonReplaceable = [];
      for (const file of files) {
        const name = typeof file.name === "string" ? file.name : "";
        if (!isSafeName(name)) return sendJson(res, 400, { ok: false, error: `invalid file name: ${name}` });
        const existing = await pathExists(path.join(target, name));
        if (!existing.exists) continue;
        if (existing.isDir) nonReplaceable.push(name);
        else conflicts.push(name);
      }
      if (strategy === "error" && (conflicts.length > 0 || nonReplaceable.length > 0)) {
        sendJson(res, 409, { ok: false, error: "files already exist", conflicts, nonReplaceable });
        return;
      }

      const uploaded = [];
      const skipped = [];
      const errors = [];
      for (const file of files) {
        const name = typeof file.name === "string" ? file.name : "";
        if (!isSafeName(name)) {
          errors.push({ name: name || "(unnamed)", error: "invalid file name" });
          continue;
        }
        const content = typeof file.content === "string" ? file.content : "";
        if (content.length === 0) {
          errors.push({ name, error: "empty file content" });
          continue;
        }
        let buffer;
        try {
          buffer = Buffer.from(content, "base64");
        } catch {
          errors.push({ name, error: "invalid base64 content" });
          continue;
        }
        if (buffer.byteLength > MAX_UPLOAD_FILE_BYTES) {
          errors.push({ name, error: `file exceeds ${String(Math.round(MAX_UPLOAD_FILE_BYTES / 1024 / 1024))} MB` });
          continue;
        }
        const dest = path.join(target, name);
        try {
          const existing = await pathExists(dest);
          if (existing.exists) {
            if (existing.isDir) {
              errors.push({ name, error: "cannot replace a directory" });
              continue;
            }
            if (strategy === "skip") { skipped.push(name); continue; }
          }
          await nodeWriteFile(dest, buffer, { flag: existing.exists ? "w" : "wx" });
          uploaded.push(name);
        } catch (error) {
          errors.push({ name, error: errorMessage(error) });
        }
      }
      sendJson(res, 200, { ok: true, uploaded, skipped, errors });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
  }
}

export { name, inject, apply };
