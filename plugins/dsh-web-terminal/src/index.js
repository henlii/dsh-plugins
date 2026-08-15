// dsh-web-terminal host half (v2) — VS Code-style global terminals for DSH.
//
// Model:
//   * Terminals are fully independent entities: unlimited count, owned by one
//     stable `terminal-host` manager agent, so they do NOT follow a session's
//     or workspace's lifecycle.
//   * Session ↔ terminal is ONE-TO-MANY: every session records the terminals
//     it used (auto primary terminal for `bash`, plus explicit terminal_new /
//     terminal_send for more).
//   * Every command that finishes in a terminal notifies the sessions that use
//     that terminal (agent.inject → the session sees a 【终端】notice next turn).
//   * All presets get the persistent terminal automatically: this plugin
//     REPLACES the `ctx.shell` provider (dsh-bash-sandbox is disabled), and the
//     standard `dsh-tool-bash` used by every preset is a `ctx.shell` consumer —
//     so its foreground calls run in a persistent PTY shell per session.
//
// Host responsibilities:
//   ctx.shell  — ShellExecutor (resolve/run/start/sandboxMode=undefined).
//   model tools — terminal_new / terminal_send / terminal_list / terminal_kill.
//   web RPC    — /api/dsh-web-terminal/* (snapshot/read/send/signal/kill/spawn).
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';

const name = 'web-terminal';
const inject = ['webServer', 'agents', 'terminals', 'llm', 'tools'];

const Config = z.object({
  managerSessionId: z.string().default('terminal-host'),
  shellBackendType: z.string().default('shell'),
  runTimeoutMs: z.number().default(300000),
  maxOutputChars: z.number().default(60000),
  notifyOnDone: z.boolean().default(true),
  storePath: z.string().default(''),
});

const RC_MARKER = '__DSH_RC__';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

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

  // ── manager agent (stable owner of every terminal) ───────────────────────
  let manager = null;
  async function ensureManager() {
    if (manager) return manager;
    const agents = ctx.get('agents');
    if (!agents) throw new Error('dsh-web-terminal: agents service unavailable');
    const existing = agents.get(managerId);
    if (existing) { manager = existing; return manager; }
    try {
      const handle = await agents.create({
        sessionId: managerId,
        meta: { cwd: '/', agentPreset: 'minimal' },
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

  function agentOf(sessionId) {
    const agents = ctx.get('agents');
    return agents ? agents.get(sessionId) : undefined;
  }

  // ── registry helpers ─────────────────────────────────────────────────────
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

  function recordSession(termId, sessionId) {
    const t = terminals[termId];
    if (!t || !sessionId) return;
    if (!t.sessions.includes(sessionId)) t.sessions.push(sessionId);
    persist();
  }
  function sessionsOf(termId) {
    const t = terminals[termId];
    return t ? t.sessions.slice() : [];
  }
  function notifySessions(termId, text, summary) {
    for (const sid of sessionsOf(termId)) {
      const agent = agentOf(sid);
      if (!agent || typeof agent.inject !== 'function') continue;
      try {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: 'plugin',
            plugin: 'dsh-web-terminal',
            form: 'notice',
            summary: summary.length > 120 ? summary.slice(0, 117) + '…' : summary,
          },
        }));
      } catch (err) {
        ctx.logger.warn(`dsh-web-terminal: notify ${sid} failed: ${err && err.message ? err.message : err}`);
      }
    }
  }

  async function spawnTerminal(name, cwd) {
    const m = await ensureManager();
    reconcileFromService(m);
    let spawned;
    try {
      spawned = await ctx.terminals.spawn(m, { type: config.shellBackendType, name, cwd });
    } catch (err) {
      if (err && (err.code === 'DUPLICATE_NAME' || /already exists/i.test(String(err && err.message)))) {
        // A session with this name already exists for the owner — reuse it.
        const existing = ctx.terminals.list(m).find((s) => s.name === name);
        if (existing) return existing;
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
      name: name || basename(cwd || '/') || 'terminal',
      cwd: cwd || '',
      sessions: [],
    };
    persist();
    return spawned;
  }

  // ── run one command in a terminal (core) ────────────────────────────────
  // Stale-terminal resilience: a terminal recorded in the durable registry may
  // have died with a previous process (PTY sessions do not survive a dsh
  // restart). If the target session no longer exists, respawn it in place
  // (preserving name/cwd/session associations) and retry once.
  function isMissingSessionError(err) {
    return Boolean(
      err && (err.code === 'NO_SESSION' || err.code === 'NO_BACKEND' ||
        /unknown PTY session|no such session|session.*not found/i.test(String(err && err.message)))
    );
  }

  async function runInTerminal(termId, command, opts = {}) {
    const m = await ensureManager();
    if (!terminals[termId]) throw new Error(`unknown terminal ${termId}`);
    const { signal, env, dshEnv, stdin, submit = true } = opts;
    let line = '';
    if (env) for (const [k, v] of Object.entries(env)) line += `export ${shellQuote(k)}=${shellQuote(v)}; `;
    if (dshEnv) for (const [k, v] of Object.entries(dshEnv)) line += `export ${shellQuote(k)}=${shellQuote(v)}; `;
    line += command;
    if (stdin) line += ` <<'DSH_STDIN_EOF'\n${stdin}\nDSH_STDIN_EOF`;
    // 行首不带 `;`：换行后直接以命令开头（行首分号是 bash 语法错误）。
    line += `\n__dsh_rc=$?; printf '\\n${RC_MARKER}%s\\n' "$__dsh_rc"`;

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

  // ── ctx.shell executor (replaces dsh-bash-sandbox) ───────────────────────
  const shellExecutor = {
    // 持久 shell 无沙箱运行；声明为 danger-full-access 以通过
    // dsh-permission-presets 的启动检查（sandboxMode 不能为 undefined），
    // 并与 settings.yaml 的 permission.defaultPreset 保持一致。
    get sandboxMode() { return 'danger-full-access'; },
    resolve(request) {
      return {
        command: request.command,
        workdir: request.workdir || '/',
        timeoutMs: Math.min(request.timeoutMs ?? config.runTimeoutMs, 3600000),
        stdoutMaxBytes: request.stdoutMaxBytes ?? 100000,
        signal: request.signal,
        stdin: request.stdin,
        env: request.env,
        dshEnv: request.dshEnv,
      };
    },
    async run(spec) {
      const agents = ctx.get('agents');
      const caller = agents ? agents.currentInitiator() : undefined;
      // 从服务端 reconcile，避免插件重载后注册表丢失而重复建同名终端。
      reconcileFromService(manager);
      // Session's primary terminal: first recorded, else auto-create.
      let termId = null;
      if (caller) {
        const mine = Object.keys(terminals).find((id) => terminals[id].sessions.includes(caller.id));
        if (mine) termId = mine;
      }
      if (!termId) {
        // 以工作目录命名（VS Code 每文件夹一终端），避免「会话-session-」这种
        // 基于 id 前 8 位的名字（会撞 DUPLICATE_NAME）。
        const name = basename(spec.workdir || '/') || 'terminal';
        const spawned = await spawnTerminal(caller ? name : name, spec.workdir);
        termId = spawned.sessionId;
        if (caller) recordSession(termId, caller.id);
      }
      const out = await runInTerminal(termId, spec.command, {
        signal: spec.signal, env: spec.env, dshEnv: spec.dshEnv, stdin: spec.stdin,
      });
      // respawn 后实际终端可能已变，用返回的 out.termId。
      if (caller) recordSession(out.termId, caller.id);
      if (config.notifyOnDone) {
        const first = spec.command.split('\n')[0].slice(0, 80);
        notifySessions(out.termId, `【终端】命令执行结束（exit ${out.rc ?? '?'}）：${first}`, `终端命令结束 exit=${out.rc ?? '?'}`);
      }
      const text = stripMarker(out.viewport).trim();
      return {
        exitCode: out.aborted ? null : (out.rc ?? 0),
        signal: out.aborted ? (out.waitReason === 'timeout' ? null : 'SIGTERM') : null,
        timedOut: out.waitReason === 'timeout',
        aborted: out.aborted,
        timeoutMs: spec.timeoutMs,
        stdout: { text, truncated: out.truncated },
        stderr: { text: '', truncated: false },
      };
    },
    // Background jobs: a detached one-shot bash (no terminal persistence needed).
    start(spec) {
      let proc;
      let settled = false;
      let stdout = '';
      let stderr = '';
      const maxOut = spec.stdoutMaxBytes || 100000;
      try {
        proc = spawn('bash', ['-c', spec.command], {
          cwd: spec.workdir || '/',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...(spec.env || {}), ...(spec.dshEnv || {}) },
        });
      } catch (err) {
        stderr = `spawn failed: ${err.message}`;
        return {
          status: 'killed', exitCode: null, signal: 'SIGTERM',
          done: Promise.resolve(),
          readOutput() { return { delta: stderr, lossy: false }; },
          kill() { return false; },
        };
      }
      proc.stdout.on('data', (d) => { if (stdout.length < maxOut) stdout += d.toString(); });
      proc.stderr.on('data', (d) => { if (stderr.length < 50000) stderr += d.toString(); });
      const holder = { exitCode: null, signal: null };
      const done = new Promise((resolveDone) => {
        proc.on('error', (err) => { stderr += `\n${err.message}`; });
        proc.on('close', (code, sig) => {
          settled = true;
          holder.exitCode = code;
          holder.signal = sig || null;
          resolveDone();
        });
      });
      let lastRead = 0;
      return {
        get status() { return settled ? 'completed' : 'running'; },
        get exitCode() { return holder.exitCode; },
        get signal() { return holder.signal; },
        done,
        readOutput() {
          const cur = stdout.slice(lastRead);
          lastRead = stdout.length;
          return { delta: cur, lossy: false };
        },
        kill() {
          if (settled) return false;
          try { proc.kill('SIGTERM'); } catch { /* noop */ }
          return true;
        },
      };
    },
  };
  ctx.provide('shell', shellExecutor);

  // ── model tools ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'terminal_new',
    description: 'Create a new independent terminal (VS Code style). Returns its terminal_id; run commands in it later with terminal_send. The terminal does not depend on this session — it stays alive independently.',
    parameters: {
      name: { type: 'string', description: 'Optional display name for the terminal tab.' },
      cwd: { type: 'string', description: 'Optional working directory; defaults to your session workspace.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          terminal_id: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_a, v) => [{ type: 'text', text: `created terminal ${v.name} (${v.terminal_id})` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = args.cwd || (exec.agent && exec.agent.session.header.cwd) || '/';
      const spawned = await spawnTerminal(args.name || basename(cwd || '/') || 'terminal', cwd);
      if (exec.agent) recordSession(spawned.sessionId, exec.agent.id);
      return { terminal_id: spawned.sessionId, name: terminals[spawned.sessionId].name };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'terminal_send',
    description: 'Run a command in a specific terminal (created by terminal_new, or listed by terminal_list). Waits for the command to finish and returns its output. The terminal is independent — its shell state (cwd, env, background jobs) persists across calls and sessions.',
    parameters: {
      terminal_id: { type: 'string', required: true, description: 'The terminal id.' },
      command: { type: 'string', required: true, description: 'The command to run in that terminal.' },
      run_in_background: { type: 'boolean', description: 'Run as a background job and return its id instead of waiting.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object', additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              terminal_id: { type: 'string', required: true },
              exitCode: { type: 'number' },
              output: { type: 'string', required: true },
            },
          },
        ],
      },
      render: (_a, v) => [{ type: 'text', text: v.kind === 'background' ? `started terminal job ${v.jobId}` : `exit ${v.exitCode ?? '?'}\n${v.output}` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent) recordSession(args.terminal_id, exec.agent.id);
      if (args.run_in_background) {
        const jobs = ctx.get('jobs');
        if (!jobs) throw new Error('background jobs unavailable');
        const controller = new AbortController();
        return {
          kind: 'background',
          jobId: jobs.start({
            kind: 'bash', label: args.command, owner: exec.agent,
            run: () => ({
              cancel: (reason) => controller.abort(reason ?? 'terminal job killed'),
              done: runInTerminal(args.terminal_id, args.command, { signal: controller.signal }).then(async (out) => {
                if (config.notifyOnDone) notifySessions(args.terminal_id, `【终端】命令执行结束（exit ${out.rc ?? '?'}）：${args.command.split('\n')[0]}`, `终端命令结束 exit=${out.rc ?? '?'}`);
                if (controller.signal.aborted) return { status: 'killed' };
                return { status: 'completed', exitCode: out.rc ?? 0, output: stripMarker(out.viewport).trim() };
              }),
            }),
          }),
        };
      }
      const out = await runInTerminal(args.terminal_id, args.command, { signal: exec.signal });
      if (config.notifyOnDone) notifySessions(args.terminal_id, `【终端】命令执行结束（exit ${out.rc ?? '?'}）：${args.command.split('\n')[0]}`, `终端命令结束 exit=${out.rc ?? '?'}`);
      return { kind: 'foreground', terminal_id: out.termId, exitCode: out.rc, output: stripMarker(out.viewport).trim() };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'terminal_list',
    description: 'List all independent terminals: id, name, cwd, status, and which sessions use them.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { terminals: { type: 'array', required: true, items: { type: 'json' } } } },
      render: (_a, v) => {
        const rows = v.terminals.map((t) => `- ${t.terminal_id}  ${t.name} [${t.status}] cwd=${t.cwd} sessions=${t.sessions.length}`);
        return [{ type: 'text', text: rows.length ? rows.join('\n') : 'no terminals yet (create one with terminal_new or run bash)' }];
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      const m = manager || await ensureManager().catch(() => null);
      const snaps = m ? ctx.terminals.list(m) : [];
      const byId = new Map(snaps.map((s) => [s.sessionId, s]));
      return {
        terminals: Object.keys(terminals).map((id) => {
          const t = terminals[id];
          const s = byId.get(id);
          return {
            terminal_id: id,
            name: t.name,
            cwd: t.cwd,
            sessions: t.sessions.slice(),
            status: s && s.status && s.status.kind ? s.status.kind : 'unknown',
          };
        }),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'terminal_kill',
    description: 'Close an independent terminal and remove it. Running commands in it are stopped.',
    parameters: {
      terminal_id: { type: 'string', required: true, description: 'The terminal id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { closed: { type: 'boolean', required: true } } },
      render: (a) => [{ type: 'text', text: `terminal ${a.terminal_id} closed` }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const m = await ensureManager();
      const closed = await ctx.terminals.kill(m, args.terminal_id, 'closed by agent');
      delete terminals[args.terminal_id];
      persist();
      notifySessions(args.terminal_id, `【终端】终端 ${args.terminal_id} 已被关闭。`, '终端已关闭');
      return { closed };
    },
  }));

  // ── web RPC (global terminal panel) ──────────────────────────────────────
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
        const page = ctx.terminals.read(m, String(body.id), { count: Number.isSafeInteger(body.count) ? body.count : 500 });
        sendJson(res, 200, { ok: true, text: page.text, totalLines: page.totalLines, truncated: page.truncated });
      } },
      { path: '/api/dsh-web-terminal/send', async handler(req, res) {
        const body = await readJson(req);
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text) return sendJson(res, 400, { ok: false, error: 'empty text' });
        if (body.sessionId) recordSession(String(body.id), String(body.sessionId));
        try {
          const out = await runInTerminal(String(body.id), text, {});
          notifySessions(String(body.id), `【Web 终端】用户手动发送了命令：\n${text}`, `用户在终端发送了命令：${text.split('\n')[0]}`);
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
        notifySessions(String(body.id), `【Web 终端】用户请求中断命令（${body.signal || 'SIGINT'}）。`, '用户中断了终端命令');
        sendJson(res, 200, { ok: true, delivered: result.delivered, targetPgid: result.targetPgid });
      } },
      { path: '/api/dsh-web-terminal/kill', async handler(req, res) {
        const body = await readJson(req);
        const m = await ensureManager();
        const closed = await ctx.terminals.kill(m, String(body.id), 'closed from web terminal');
        delete terminals[String(body.id)];
        persist();
        notifySessions(String(body.id), '【Web 终端】用户关闭了终端。', '用户关闭了终端');
        sendJson(res, 200, { ok: true, closed });
      } },
      { path: '/api/dsh-web-terminal/spawn', async handler(req, res) {
        const body = await readJson(req);
        const spawned = await spawnTerminal(body.name || 'web', body.cwd || '/');
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
