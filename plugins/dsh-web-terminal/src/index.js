// dsh-web-terminal host half — bridge the agent's persistent PTY shell to
// the web UI.
//
// Requires the persistent-terminal stack (dsh-terminal + dsh-terminal-bash +
// dsh-tool-bash-persistent) so the agent's `bash` tool reuses one owner-scoped
// PTY shell. This plugin exposes exact HTTP routes under /api/dsh-web-terminal/*
// (password-gated by dsh-web-auth like every /api route) that read the shell's
// live scrollback, send commands, deliver signals, and spawn/close sessions.
// Every user action is also injected into the owning session as a notice so the
// agent sees what the human did on its next turn.
//
// Routes (all POST, JSON):
//   /api/dsh-web-terminal/snapshot {sessionId}              → { sessions, active }
//   /api/dsh-web-terminal/read      {sessionId, id, count?} → { text, totalLines, truncated }
//   /api/dsh-web-terminal/send      {sessionId, id, text}   → { result } | { code: 'SEND_ACTIVE' }
//   /api/dsh-web-terminal/signal    {sessionId, id, signal} → { delivered }
//   /api/dsh-web-terminal/kill      {sessionId, id}         → { closed }
//   /api/dsh-web-terminal/spawn     {sessionId}             → { sessionId, motd }
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const name = 'dsh-web-terminal';
const inject = ['webServer', 'agents', 'terminals', 'llm'];

const API_PREFIX = '/api/dsh-web-terminal';
const MAX_BODY_BYTES = 256 * 1024;
const READ_COUNT = 500;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function plainSessions(sessions) {
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    name: s.name ?? '',
    type: s.type,
    pid: s.pid ?? null,
    status: s.status && s.status.kind ? s.status.kind : 'unknown',
    exitCode: s.status && s.status.kind === 'exited' ? s.status.exitCode : null,
  }));
}

function apply(ctx) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined) return;

  // Inject a user-visible notice into the owning session so the agent knows a
  // human operated its terminal. Mirrors the vision-bridge attribution shape.
  function notifyAgent(agent, text, summary) {
    if (!agent || typeof agent.inject !== 'function') return;
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
      ctx.logger.warn(`dsh-web-terminal: notify failed: ${err && err.message ? err.message : err}`);
    }
  }

  function resolveAgent(sessionId) {
    const agents = ctx.get('agents');
    if (agents === undefined) return undefined;
    const agent = agents.get(String(sessionId));
    return agent || undefined;
  }

  async function ensureShell(agent, preferredId) {
    const sessions = ctx.terminals.list(agent);
    const live = sessions.find((s) => s.sessionId === preferredId && s.status && s.status.kind === 'running');
    if (live) return live;
    const running = sessions.find((s) => s.status && s.status.kind === 'running');
    if (running) return running;
    return ctx.terminals.spawn(agent, { type: 'shell', name: 'web-terminal' });
  }

  const routes = [
    {
      path: `${API_PREFIX}/snapshot`,
      async handler(ctx2, req, res) {
        const body = await readJsonBody(req);
        const agent = resolveAgent(body.sessionId);
        if (!agent) return sendJson(res, 404, { ok: false, error: 'no live agent for this session' });
        const sessions = ctx.terminals.list(agent);
        const active = ctx.terminals.hasOwnerActivity(agent);
        sendJson(res, 200, { ok: true, sessions: plainSessions(sessions), active });
      },
    },
    {
      path: `${API_PREFIX}/read`,
      async handler(ctx2, req, res) {
        const body = await readJsonBody(req);
        const agent = resolveAgent(body.sessionId);
        if (!agent) return sendJson(res, 404, { ok: false, error: 'no live agent for this session' });
        const count = Number.isSafeInteger(body.count) && body.count > 0 ? body.count : READ_COUNT;
        const page = ctx.terminals.read(agent, String(body.id), { count });
        sendJson(res, 200, { ok: true, text: page.text, totalLines: page.totalLines, lineBegin: page.lineBegin, lineEnd: page.lineEnd, truncated: page.truncated });
      },
    },
    {
      path: `${API_PREFIX}/send`,
      async handler(ctx2, req, res) {
        const body = await readJsonBody(req);
        const agent = resolveAgent(body.sessionId);
        if (!agent) return sendJson(res, 404, { ok: false, error: 'no live agent for this session' });
        const text = typeof body.text === 'string' ? body.text : '';
        if (text.length === 0) return sendJson(res, 400, { ok: false, error: 'empty text' });
        try {
          const shell = await ensureShell(agent, body.id ? String(body.id) : undefined);
          const op = ctx.terminals.startSend(agent, shell.sessionId, { text, submit: true });
          const result = await op.done;
          notifyAgent(
            agent,
            `【Web 终端】用户手动向你的终端发送了命令：\n${text}`,
            `用户在 Web 终端发送了命令：${text.split('\n')[0]}`,
          );
          sendJson(res, 200, {
            ok: true,
            sessionId: shell.sessionId,
            viewport: result.viewport,
            waitReason: result.waitReason,
            sessionStatus: result.sessionStatus && result.sessionStatus.kind ? result.sessionStatus.kind : 'unknown',
            truncated: result.truncated,
          });
        } catch (err) {
          const code = err && err.code ? err.code : '';
          if (code === 'SEND_ACTIVE') {
            return sendJson(res, 409, { ok: false, code: 'SEND_ACTIVE', error: 'agent 正在使用该终端（一条发送在途）' });
          }
          return sendJson(res, 500, { ok: false, code, error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    {
      path: `${API_PREFIX}/signal`,
      async handler(ctx2, req, res) {
        const body = await readJsonBody(req);
        const agent = resolveAgent(body.sessionId);
        if (!agent) return sendJson(res, 404, { ok: false, error: 'no live agent for this session' });
        const signal = String(body.signal || 'SIGINT');
        const result = await ctx.terminals.signal(agent, String(body.id), signal);
        notifyAgent(agent, `【Web 终端】用户请求中断当前命令（${signal}）。`, `用户中断了终端命令（${signal}）`);
        sendJson(res, 200, { ok: true, delivered: result.delivered, targetPgid: result.targetPgid });
      },
    },
    {
      path: `${API_PREFIX}/kill`,
      async handler(ctx2, req, res) {
        const body = await readJsonBody(req);
        const agent = resolveAgent(body.sessionId);
        if (!agent) return sendJson(res, 404, { ok: false, error: 'no live agent for this session' });
        const closed = await ctx.terminals.kill(agent, String(body.id), 'closed from web terminal');
        notifyAgent(agent, '【Web 终端】用户关闭了终端会话。', '用户关闭了终端会话');
        sendJson(res, 200, { ok: true, closed });
      },
    },
    {
      path: `${API_PREFIX}/spawn`,
      async handler(ctx2, req, res) {
        const body = await readJsonBody(req);
        const agent = resolveAgent(body.sessionId);
        if (!agent) return sendJson(res, 404, { ok: false, error: 'no live agent for this session' });
        const shell = await ensureShell(agent, body.id ? String(body.id) : undefined);
        sendJson(res, 200, { ok: true, sessionId: shell.sessionId, motd: shell.motd });
      },
    },
  ];

  for (const route of routes) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: route.path,
      handler: async (req, res) => {
        try {
          await route.handler(ctx, req, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    }));
  }
}

export { apply, inject, name };
