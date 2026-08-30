// dsh-web-terminal host half — user-only PTY for the web sidebar.
//
// Agent bash stays on the official ctx.shell (dsh-bash-sandbox). This plugin
// owns interactive PTYs for the human in the sidebar tab: spawn/read/send/
// signal/kill over /api/dsh-web-terminal/*. ctx.terminals still requires an
// owner Agent, so a stable `terminal-host` manager holds every user PTY.
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';

const name = 'web-terminal';
const inject = ['webServer', 'agents', 'terminals'];

const Config = z.object({
  managerSessionId: z.string().default('terminal-host'),
  shellBackendType: z.string().default('shell'),
  storePath: z.string().default(''),
});

const RC_MARKER = '__DSH_RC__';

function parseRc(viewport) {
  const re = new RegExp(`${RC_MARKER}(\\d+)\\s*$`, 'm');
  const m = viewport.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

function stripMarker(viewport) {
  return viewport.replace(new RegExp(`\\n?${RC_MARKER}\\d+\\s*$`, 'm'), '');
}

function apply(ctx, config) {
  const storePath = config.storePath || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-terminals.json');
  const managerId = config.managerSessionId;

  // ── durable terminal registry ────────────────────────────────────────────
  let terminals = {}; // terminalId → { name, cwd, sessions: [sessionId] }
  let persistTimer = null;
  function loadStore() {
    try {
      const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
      if (parsed && parsed.terminals) {
        terminals = parsed.terminals;
        for (const t of Object.values(terminals)) if (!Array.isArray(t.sessions)) t.sessions = [];
      }
    } catch { /* first run */ }
  }
  function persist() {
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        mkdirSync(join(storePath, '..'), { recursive: true });
        const tmp = `${storePath}.tmp`;
        writeFileSync(tmp, JSON.stringify({ terminals }, null, 2));
        renameSync(tmp, storePath);
      } catch (err) {
        ctx.logger.warn(`dsh-web-terminal: persist failed: ${err.message}`);
      }
    }, 200);
  }
  loadStore();

  // ── manager agent (PTY owner; not a coding session) ──────────────────────
  let manager = null;
  // 跨平台默认终端目录：Windows 无 '/'，回退到用户主目录。
  const defaultCwd = () => (process.platform === 'win32' ? homedir() : '/');

  async function ensureManager() {
    if (manager) return manager;
    const agents = ctx.get('agents');
    if (!agents) throw new Error('dsh-web-terminal: agents service unavailable');
    const existing = agents.get(managerId);
    if (existing) { manager = existing; return manager; }
    try {
      const handle = await agents.create({
        sessionId: managerId,
        meta: { cwd: defaultCwd(), agentPreset: 'minimal' },
      });
      manager = handle && handle.agent ? handle.agent : handle;
    } catch (err) {
      const again = agents.get(managerId);
      if (again) { manager = again; return manager; }
      throw new Error(`dsh-web-terminal: cannot create terminal manager agent: ${err.message}`);
    }
    reconcileFromService(manager);
    return manager;
  }

  // Rebuild the in-memory registry from the live terminals service. The plugin
  // may be re-applied (config HMR) while the manager agent and its PTY sessions
  // survive, so the durable map must be reconciled from the service or it goes
  // stale and starts duplicating sessions by name.
  function reconcileFromService(m) {
    if (!m) return;
    let snaps = [];
    try { snaps = ctx.terminals.list(m); } catch { return; }
    let changed = false;
    for (const s of snaps) {
      if (!terminals[s.sessionId]) {
        terminals[s.sessionId] = {
          name: s.name || 'terminal',
          cwd: s.cwd || '',
          sessions: [],
        };
        changed = true;
      }
    }
    if (changed) persist();
  }

  /** Drop durable rows whose PTY died with the process (ids do not survive restart). */
  function pruneDead(m) {
    if (!m) return;
    let snaps = [];
    try { snaps = ctx.terminals.list(m); } catch { return; }
    const live = new Set(snaps.map((s) => s.sessionId));
    let changed = false;
    for (const id of Object.keys(terminals)) {
      if (!live.has(id)) {
        delete terminals[id];
        changed = true;
      }
    }
    if (changed) persist();
  }

  function recordSession(termId, sessionId) {
    const t = terminals[termId];
    if (!t || !sessionId) return;
    if (!t.sessions.includes(sessionId)) t.sessions.push(sessionId);
    persist();
  }

  async function spawnTerminal(name, cwd) {
    const m = await ensureManager();
    reconcileFromService(m);
    let spawned;
    try {
      spawned = await ctx.terminals.spawn(m, { type: config.shellBackendType, name, cwd });
    } catch (err) {
      if (err && (err.code === 'DUPLICATE_NAME' || /already exists/i.test(String(err && err.message)))) {
        spawned = await ctx.terminals.spawn(m, {
          type: config.shellBackendType,
          name: `${name}-${Date.now().toString(36)}`,
          cwd,
        });
      } else {
        throw err;
      }
    }
    terminals[spawned.sessionId] = {
      name: name || basename(cwd || defaultCwd()) || 'terminal',
      cwd: cwd || '',
      sessions: [],
    };
    persist();
    return spawned;
  }

  function isMissingSessionError(err) {
    return Boolean(
      err && (err.code === 'NO_SESSION' || err.code === 'NO_BACKEND' ||
        /unknown PTY session|no such session|session.*not found/i.test(String(err && err.message)))
    );
  }

  async function runInTerminal(termId, command, opts = {}) {
    const m = await ensureManager();
    if (!terminals[termId]) throw new Error(`unknown terminal ${termId}`);
    const { signal, submit = true } = opts;
    const line = `${command}\n__dsh_rc=$?; printf '\\n${RC_MARKER}%s\\n' "$__dsh_rc"`;

    async function sendOnce(targetId) {
      const op = ctx.terminals.startSend(m, targetId, { text: line, submit, signal });
      return op.done;
    }

    let result;
    let usedId = termId;
    try {
      result = await sendOnce(termId);
    } catch (err) {
      if (!isMissingSessionError(err)) throw err;
      const rec = terminals[termId];
      const spawned = await spawnTerminal(rec ? rec.name : 'terminal', rec ? rec.cwd : undefined);
      if (rec && Array.isArray(rec.sessions)) terminals[spawned.sessionId].sessions = rec.sessions.slice();
      delete terminals[termId];
      persist();
      usedId = spawned.sessionId;
      ctx.logger.info(`dsh-web-terminal: respawned stale terminal ${termId} → ${usedId}`);
      result = await sendOnce(usedId);
    }

    const viewport = result.viewport || '';
    const aborted = Boolean(signal && signal.aborted);
    return {
      termId: usedId,
      viewport,
      rc: parseRc(viewport),
      waitReason: result.waitReason,
      sessionStatus: result.sessionStatus && result.sessionStatus.kind ? result.sessionStatus.kind : 'unknown',
      truncated: Boolean(result.truncated),
      aborted,
    };
  }

  const webServer = ctx.get('webServer');
  if (webServer !== undefined) {
    const sendJson = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const readJson = (req) => new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 262144) { reject(new Error('body too large')); req.destroy(); } });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
      req.on('error', reject);
    });

    const routes = [
      { path: '/api/dsh-web-terminal/snapshot', async handler(req, res) {
        const body = await readJson(req);
        const m = manager || await ensureManager().catch(() => null);
        if (m) pruneDead(m);
        const snaps = m ? ctx.terminals.list(m) : [];
        const byId = new Map(snaps.map((s) => [s.sessionId, s]));
        const all = Object.keys(terminals).map((id) => {
          const t = terminals[id];
          const s = byId.get(id);
          return {
            terminal_id: id, name: t.name, cwd: t.cwd,
            sessions: t.sessions.slice(),
            mine: Boolean(body.sessionId && t.sessions.includes(String(body.sessionId))),
            status: s && s.status && s.status.kind ? s.status.kind : 'unknown',
          };
        });
        sendJson(res, 200, { ok: true, terminals: all });
      } },
      { path: '/api/dsh-web-terminal/read', async handler(req, res) {
        const body = await readJson(req);
        const m = await ensureManager();
        const id = String(body.id);
        const live = ctx.terminals.list(m).some((s) => s.sessionId === id);
        if (!live) {
          delete terminals[id];
          persist();
          return sendJson(res, 404, { ok: false, code: 'NO_SESSION', error: 'no such terminal' });
        }
        const page = ctx.terminals.read(m, id, { count: Number.isSafeInteger(body.count) ? body.count : 500 });
        sendJson(res, 200, { ok: true, text: page.text, totalLines: page.totalLines, truncated: page.truncated });
      } },
      { path: '/api/dsh-web-terminal/send', async handler(req, res) {
        const body = await readJson(req);
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text) return sendJson(res, 400, { ok: false, error: 'empty text' });
        if (body.sessionId) recordSession(String(body.id), String(body.sessionId));
        try {
          const out = await runInTerminal(String(body.id), text, {});
          sendJson(res, 200, { ok: true, terminal_id: out.termId, exitCode: out.rc, output: stripMarker(out.viewport).trim() });
        } catch (err) {
          const code = err && err.code ? err.code : '';
          if (code === 'SEND_ACTIVE') return sendJson(res, 409, { ok: false, code: 'SEND_ACTIVE', error: '该终端正被使用（一条发送在途）' });
          sendJson(res, 500, { ok: false, code, error: err instanceof Error ? err.message : String(err) });
        }
      } },
      { path: '/api/dsh-web-terminal/signal', async handler(req, res) {
        const body = await readJson(req);
        const m = await ensureManager();
        const result = await ctx.terminals.signal(m, String(body.id), String(body.signal || 'SIGINT'));
        if (body.sessionId) recordSession(String(body.id), String(body.sessionId));
        sendJson(res, 200, { ok: true, delivered: result.delivered, targetPgid: result.targetPgid });
      } },
      { path: '/api/dsh-web-terminal/kill', async handler(req, res) {
        const body = await readJson(req);
        const m = await ensureManager();
        const id = String(body.id);
        let closed = false;
        try {
          closed = await ctx.terminals.kill(m, id, 'closed from web terminal');
        } catch (err) {
          if (!isMissingSessionError(err)) throw err;
        }
        delete terminals[id];
        persist();
        sendJson(res, 200, { ok: true, closed });
      } },
      { path: '/api/dsh-web-terminal/spawn', async handler(req, res) {
        const body = await readJson(req);
        const spawned = await spawnTerminal(body.name || 'web', body.cwd || defaultCwd());
        if (body.sessionId) recordSession(spawned.sessionId, String(body.sessionId));
        sendJson(res, 200, { ok: true, terminal_id: spawned.sessionId, name: terminals[spawned.sessionId].name });
      } },
    ];
    for (const route of routes) {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: route.path,
        handler: async (req, res) => {
          try { await route.handler(req, res); }
          catch (error) { sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
        },
      }));
    }
  }
}

export { Config, apply, inject, name };
