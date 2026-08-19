// dsh-plugin-quota-monitor — host half.
//
// One logical RPC channel, /balance, serving endpoints:
//   - "snapshot" → DeepSeek account balance (Rage bar, ¥ remaining).
//   - "opencode" → OpenCode Go subscription usage (HP/MP/SP bars).
//   - "scnet"    → National Supercomputing Center (国家超算) Token Plan
//                  Credits usage, estimated LOCALLY from DSH session logs
//                  (there is no public credits API; the plan deducts monthly
//                  Credits and usage is only visible in the web console).
//   - "config"   → get/set the monitor configuration (active provider,
//                  per-meter toggles, scnet quota + credits rates).
//   - "detect"   → resolve the active provider from DSH settings.yaml
//                  (auto mode) with a manual override.
//
// DeepSeek endpoint: reads DEEPSEEK_API_KEY (env or .credentials.yaml), queries
// GET https://api.deepseek.com/user/balance, keeps a day-start baseline in
// $DSH_HOME/storages/quota-monitor.json.
//
// OpenCode endpoint: reads OPENCODE_GO_API_KEY, queries
// GET https://opencode.ai/zen/go/v1/usage (Bearer + x-api-key) and returns
// each window's used/remaining.
//
// scnet endpoint: no HTTP. It walks $DSH_HOME/sessions/**/*.jsonl(.zstd),
// decodes the concatenated Zstandard frames (pure Node, no deps), tracks the
// active provider/model from request/context records, and sums the token
// usage of assistant messages routed through the scnet provider, converted to
// Credits via the per-model rate table (config-editable). Only the current
// UTC+8 calendar month counts, matching the plan's natural-month cycle.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dsh-plugin-quota-monitor'
export const inject = ['connection']

const DEEPSEEK_BALANCE_API = 'https://api.deepseek.com/user/balance'
const OPENCODE_USAGE_API =
  process.env.OPENCODE_USAGE_URL ?? 'https://opencode.ai/zen/go/v1/usage'
const CREDENTIALS_FILE = '.credentials.yaml'
const SETTINGS_FILE = 'settings.yaml'
const STATE_FILE = 'quota-monitor.json'
const CONFIG_FILE = 'quota-monitor-config.json'

// Official OpenCode Go dollar caps per window.
const OPENCODE_LIMITS = { rolling: 12, weekly: 30, monthly: 60 }

// Default scnet Token Plan config (plan tier + credits rates from the scnet
// docs; both editable in plugin settings).
const DEFAULT_CONFIG = {
  mode: 'auto', // 'auto' | 'opencode' | 'scnet'
  opencodeMeters: { rolling: true, weekly: true, monthly: true },
  scnet: {
    planQuota: 60000, // 基础版 60,000 Credits / month
    resetDay: 1, // billing cycle reset day of each month (1-28); not necessarily the natural month
    rates: {
      'deepseek-v4-flash-0731': { input: 1543, output: 3086, cache: 31 },
      'deepseek-v4-flash': { input: 1200, output: 2400, cache: 24 },
      'glm-5.2': { input: 7543, output: 26400, cache: 189 },
      'glm-5.1': { input: 8743, output: 32057, cache: 175 },
      'glm-5': { input: 8743, output: 32057, cache: 175 },
      'kimi-k3': { input: 34286, output: 171429, cache: 343 },
      'kimi-k2.7-code': { input: 8357, output: 34714, cache: 167 },
      'kimi-k2.6': { input: 8357, output: 34714, cache: 167 },
      'kimi-k2.5': { input: 5143, output: 27000, cache: 103 },
      'minimax-m3': { input: 3600, output: 14400, cache: 72 },
      'minimax-m2.7': { input: 3600, output: 14400, cache: 72 },
      'minimax-m2.5': { input: 2520, output: 10080, cache: 50 },
      'qwen3.8-max': { input: 18514, output: 49371, cache: 231 },
    },
  },
  showDeepseek: true,
}

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function today() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

// Billing cycle boundaries in UTC+8. scnet Token Plan resets on a per-plan
// day of each month (not necessarily the 1st), so the window runs from the
// last reset day <= today to the next reset day.
function cycleWindow(resetDay) {
  const d = Math.min(28, Math.max(1, Number(resetDay) || 1))
  const now = new Date(Date.now() + 8 * 3600 * 1000) // UTC+8 wall clock
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const day = now.getUTCDate()
  // cycle start: this month's reset day if today >= it, else last month's
  let sy = y
  let sm = m
  if (day < d) {
    const prev = new Date(Date.UTC(y, m - 1, 1))
    sy = prev.getUTCFullYear()
    sm = prev.getUTCMonth()
  }
  const start = Date.UTC(sy, sm, d) - 8 * 3600 * 1000 // local midnight UTC+8
  const end = Date.UTC(sy, sm + 1, d) - 8 * 3600 * 1000
  const n = new Date(Date.UTC(sy, sm + 1, d))
  const label = `${String(sm + 1).padStart(2, '0')}.${d}–${String(n.getUTCMonth() + 1).padStart(2, '0')}.${d}`
  return { start, end, label }
}

// ─── credentials & settings ──────────────────────────────────────────────────

async function readCredential(envName, yamlName) {
  if (process.env[envName]) return process.env[envName]
  try {
    const yaml = await readFile(join(dshHome(), CREDENTIALS_FILE), 'utf8')
    const match = yaml.match(new RegExp(`^${yamlName}:\\s*(\\S+)`, 'm'))
    if (match) return match[1]
  } catch {
    // fall through
  }
  return null
}

const readDeepSeekKey = () => readCredential('DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY')
const readOpencodeKey = () => readCredential('OPENCODE_GO_API_KEY', 'OPENCODE_GO_API_KEY')

/** Resolve the DSH default provider from settings.yaml (agent-default-model). */
async function detectDefaultProvider() {
  try {
    const yaml = await readFile(join(dshHome(), SETTINGS_FILE), 'utf8')
    const m = yaml.match(/agent-default-model:\s*\n\s*provider:\s*(\S+)/)
    if (m) {
      const p = m[1].trim()
      if (p === 'scnet') return 'scnet'
      if (p === 'opencode-go') return 'opencode'
    }
  } catch {
    // fall through
  }
  return null
}

// ─── config persistence ──────────────────────────────────────────────────────

const configPath = () => join(dshHome(), 'storages', CONFIG_FILE)

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = { ...base }
  for (const k of Object.keys(patch)) {
    out[k] =
      out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])
        ? deepMerge(out[k], patch[k])
        : patch[k]
  }
  return out
}

async function loadConfig() {
  try {
    const parsed = JSON.parse(await readFile(configPath(), 'utf8'))
    return deepMerge(DEFAULT_CONFIG, parsed)
  } catch {
    return {
      ...DEFAULT_CONFIG,
      scnet: { ...DEFAULT_CONFIG.scnet, rates: { ...DEFAULT_CONFIG.scnet.rates } },
    }
  }
}

async function saveConfig(config) {
  try {
    await mkdir(join(dshHome(), 'storages'), { recursive: true })
    await writeFile(configPath(), JSON.stringify(config, null, 2))
  } catch (error) {
    console.error('[quota-monitor] config write failed:', error)
  }
}

/** Resolve the active provider: manual mode wins, otherwise auto-detect. */
async function resolveProvider(config) {
  if (config.mode === 'opencode' || config.mode === 'scnet') return config.mode
  return (await detectDefaultProvider()) ?? null
}

// ─── Zstandard multi-frame decode (pure Node) ────────────────────────────────

const ZSTD_MAGIC = 0xfd2fb528

/**
 * Locate complete frames in a concatenated Zstandard stream without
 * decompressing their blocks (mirrors dsh-session-persistence-jsonl).
 */
function scanZstdFrames(buf) {
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) return frames
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) return frames
    offset += 4
    if (offset === buf.length) return frames
    const desc = buf.readUInt8(offset)
    offset += 1
    if ((desc & 0x18) !== 0) return frames
    const csf = desc >>> 6
    const single = (desc & 0x20) !== 0
    const checksum = (desc & 0x04) !== 0
    const dictFlag = desc & 0x03
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const csBytes = csf === 0 ? (single ? 1 : 0) : 1 << csf
    const remHeader = (single ? 0 : 1) + dictBytes + csBytes
    if (buf.length - offset < remHeader) return frames
    offset += remHeader
    for (;;) {
      if (buf.length - offset < 3) return frames
      const bh = buf.readUIntLE(offset, 3)
      offset += 3
      const last = (bh & 1) !== 0
      const type = (bh >>> 1) & 0x03
      const size = bh >>> 3
      const payload = type === 1 ? 1 : size
      if (buf.length - offset < payload) return frames
      offset += payload
      if (last) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return frames
      offset += 4
    }
    frames.push([start, offset])
  }
  return frames
}

function decodeZstdFile(buf) {
  let out = ''
  for (const [s, e] of scanZstdFrames(buf)) {
    try {
      out += zstdDecompressSync(buf.subarray(s, e)).toString('utf8')
    } catch {
      // skip a torn/corrupt frame
    }
  }
  return out
}

// ─── scnet local Credits estimation ──────────────────────────────────────────

async function collectSessionFiles() {
  const root = join(dshHome(), 'sessions')
  const out = []
  async function walk(dir, depth) {
    if (depth > 4) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p, depth + 1)
      } else if (e.isFile() && (e.name.endsWith('.jsonl.zstd') || e.name.endsWith('.jsonl'))) {
        out.push(p)
      }
    }
  }
  await walk(root, 0)
  return out
}

/**
 * Estimate Credits consumed through the scnet provider within the current
 * billing cycle by reading DSH session logs. Returns a snapshot or null when
 * nothing usable is found.
 */
async function estimateScnet(config) {
  const resetDay = Number(config.scnet?.resetDay) || 1
  const { start, end, label } = cycleWindow(resetDay)
  const rates = (config.scnet && config.scnet.rates) || {}
  const quota = Number(config.scnet?.planQuota) || DEFAULT_CONFIG.scnet.planQuota
  const files = await collectSessionFiles()
  let creditsUsed = 0
  let tokens = 0
  let messages = 0
  let filesScanned = 0

  for (const file of files) {
    let text
    try {
      if (file.endsWith('.zstd')) {
        text = decodeZstdFile(await readFile(file))
      } else {
        text = await readFile(file, 'utf8')
      }
    } catch {
      continue
    }
    filesScanned++
    let curProvider = null
    let curModel = null
    for (const line of text.split('\n')) {
      if (!line) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      // Provider/model tracking must persist across the whole file even when
      // a record's own timestamp falls outside the window.
      if (o.type === 'request/context' || o.type === 'request/header') {
        const d = o.data || {}
        const p =
          o.type === 'request/context'
            ? d.provider
            : d.header && d.header.config && d.header.config.provider
        const m =
          o.type === 'request/context'
            ? d.model
            : d.header && d.header.config && d.header.config.model
        if (p) curProvider = p
        if (m) curModel = String(m).toLowerCase()
        continue
      }
      const t = o.time
      if (typeof t !== 'number' || t < start || t >= end) continue
      if (o.type === 'assistant/message' && o.data && o.data.usage && curProvider === 'scnet') {
        const u = o.data.usage
        const inp = Number(u.inputTokens) || 0
        const outp = Number(u.outputTokens) || 0
        const cach = Number(u.cacheReadTokens) || 0
        const rate =
          rates[curModel] ||
          rates['deepseek-v4-flash-0731'] ||
          { input: 1543, output: 3086, cache: 31 }
        creditsUsed +=
          (inp / 1e6) * rate.input + (outp / 1e6) * rate.output + (cach / 1e6) * rate.cache
        tokens += inp + outp + cach
        messages++
      }
    }
  }

  creditsUsed = Math.round(creditsUsed * 100) / 100
  const remaining = Math.max(0, Math.round((quota - creditsUsed) * 100) / 100)
  const remainingPct = quota > 0 ? Math.max(0, Math.min(100, (remaining / quota) * 100)) : 0

  return {
    ok: true,
    value: {
      used: creditsUsed,
      remaining,
      remainingPct,
      quota,
      tokens,
      messages,
      files: filesScanned,
      month: label,
      stale: false,
    },
  }
}

// ─── DeepSeek balance (existing) ─────────────────────────────────────────────

async function fetchBalance(apiKey, signal) {
  const res = await fetch(DEEPSEEK_BALANCE_API, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  if (!res.ok) throw new Error(`balance api responded ${res.status}`)
  const json = await res.json()
  const infos = Array.isArray(json.balance_infos) ? json.balance_infos : []
  const info = infos.find((i) => i.currency === 'CNY') ?? infos[0]
  if (!info) throw new Error('balance api returned no balance_infos')
  return {
    available: json.is_available === true,
    currency: info.currency,
    total: Number.parseFloat(info.total_balance),
  }
}

const statePath = () => join(dshHome(), 'storages', STATE_FILE)

async function loadState() {
  try {
    const state = JSON.parse(await readFile(statePath(), 'utf8'))
    if (state && typeof state.date === 'string' && typeof state.dayStart === 'number') return state
  } catch {
    // no state yet
  }
  return null
}

async function saveState(state) {
  try {
    await mkdir(join(dshHome(), 'storages'), { recursive: true })
    await writeFile(statePath(), JSON.stringify(state, null, 2))
  } catch (error) {
    console.error('[quota-monitor] state write failed:', error)
  }
}

// ─── OpenCode usage (existing) ───────────────────────────────────────────────

function pickWindow(quota, keys) {
  for (const k of keys) {
    if (quota && typeof quota[k] === 'object' && quota[k] !== null) return quota[k]
  }
  return null
}

function toNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function parseWindow(window) {
  if (!window) return null
  if (typeof window.percent === 'number' && Number.isFinite(window.percent)) {
    return { usedPct: Math.max(0, Math.min(100, window.percent)), resetsAt: window.resetsAt ?? null }
  }
  if (typeof window.percent === 'string' && window.percent.trim() !== '') {
    const p = Number.parseFloat(window.percent)
    if (Number.isFinite(p)) return { usedPct: Math.max(0, Math.min(100, p)), resetsAt: window.resetsAt ?? null }
  }
  const used = toNumber(window.used ?? window.used_amount)
  const limit = toNumber(window.limit ?? window.limit_amount)
  if (limit > 0) {
    const pct = (used / limit) * 100
    return { usedPct: Math.max(0, Math.min(100, pct)), resetsAt: window.resetsAt ?? window.reset_at ?? null }
  }
  return null
}

function parseOpencode(data) {
  const root = data && typeof data === 'object' ? data : {}
  const usage = root.usage ?? root
  const quota = root.quota ?? usage
  const winRolling = parseWindow(
    pickWindow(usage, ['rolling']) ?? pickWindow(quota, ['window_5h', '5h', 'hourly', 'short']),
  )
  const winWeekly = parseWindow(
    pickWindow(usage, ['weekly']) ?? pickWindow(quota, ['window_weekly', 'weekly', 'week', 'wk']),
  )
  const winMonthly = parseWindow(
    pickWindow(usage, ['monthly']) ?? pickWindow(quota, ['window_monthly', 'monthly', 'month', 'mo']),
  )
  if (!winRolling && !winWeekly && !winMonthly) return null
  const mk = (win, limitUsd) => {
    if (!win) return null
    return {
      usedPct: win.usedPct,
      remainingPct: Math.max(0, Math.min(100, 100 - win.usedPct)),
      usedUsd: Math.round((win.usedPct / 100) * limitUsd * 100) / 100,
      limitUsd,
      resetsAt: win.resetsAt ?? null,
    }
  }
  return {
    rolling: mk(winRolling, OPENCODE_LIMITS.rolling),
    weekly: mk(winWeekly, OPENCODE_LIMITS.weekly),
    monthly: mk(winMonthly, OPENCODE_LIMITS.monthly),
  }
}

async function fetchOpencodeUsage(apiKey, signal) {
  const res = await fetch(OPENCODE_USAGE_API, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal,
  })
  if (!res.ok) throw new Error(`opencode usage api responded ${res.status}`)
  const json = await res.json()
  const usage = parseOpencode(json)
  if (!usage) throw new Error('opencode usage api returned no parseable windows')
  return usage
}

// ─── RPC channel ─────────────────────────────────────────────────────────────

export function apply(ctx) {
  let lastBalance = null
  let lastOpencode = null

  const snapshotEndpoint = async (signal) => {
    try {
      const apiKey = await readDeepSeekKey()
      if (!apiKey) {
        return {
          ok: false,
          error: { code: 'unauthorized', message: 'DEEPSEEK_API_KEY not found', details: {} },
        }
      }
      const balance = await fetchBalance(apiKey, signal)
      const state = (await loadState()) ?? {}
      const date = today()
      const sameDay = state.date === date
      const sameCurrency = state.lastCurrency === undefined || state.lastCurrency === balance.currency
      let dayStart = sameDay && sameCurrency ? state.dayStart : balance.total
      let spent = sameDay && sameCurrency ? (state.spent ?? 0) : 0
      const prevTotal = sameDay && sameCurrency ? state.lastTotal : balance.total
      if (prevTotal > balance.total) {
        spent += prevTotal - balance.total
        spent = Math.round(spent * 100) / 100
      }
      if (balance.total > dayStart) dayStart = balance.total
      await saveState({
        date,
        dayStart,
        lastTotal: balance.total,
        lastCurrency: balance.currency,
        spent,
        updatedAt: Date.now(),
      })
      const snapshot = {
        date,
        dayStart,
        total: balance.total,
        currency: balance.currency,
        available: balance.available,
        spent,
        updatedAt: Date.now(),
        stale: false,
      }
      lastBalance = snapshot
      return { ok: true, value: snapshot }
    } catch (error) {
      const fallback = lastBalance ?? (await loadState())
      const lastTotal =
        fallback &&
        (typeof fallback.lastTotal === 'number'
          ? fallback.lastTotal
          : typeof fallback.total === 'number'
            ? fallback.total
            : NaN)
      if (fallback && Number.isFinite(lastTotal)) {
        return {
          ok: true,
          value: {
            date: fallback.date,
            dayStart: fallback.dayStart,
            total: lastTotal,
            currency: fallback.lastCurrency ?? fallback.currency ?? 'CNY',
            available: false,
            spent: fallback.spent ?? Math.max(0, fallback.dayStart - lastTotal),
            updatedAt: fallback.updatedAt ?? 0,
            stale: true,
          },
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: { code: 'internal', message: `balance query failed: ${message}`, details: {} },
      }
    }
  }

  const opencodeEndpoint = async (signal) => {
    try {
      const apiKey = await readOpencodeKey()
      if (!apiKey) {
        return {
          ok: false,
          error: { code: 'unauthorized', message: 'OPENCODE_GO_API_KEY not found', details: {} },
        }
      }
      const usage = await fetchOpencodeUsage(apiKey, signal)
      const value = { ...usage, stale: false, updatedAt: Date.now() }
      lastOpencode = value
      return { ok: true, value }
    } catch (error) {
      if (lastOpencode) return { ok: true, value: { ...lastOpencode, stale: true } }
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: { code: 'internal', message: `opencode usage query failed: ${message}`, details: {} },
      }
    }
  }

  const scnetEndpoint = async () => {
    try {
      const config = await loadConfig()
      return await estimateScnet(config)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: { code: 'internal', message: `scnet estimation failed: ${message}`, details: {} },
      }
    }
  }

  const configGet = async () => {
    const config = await loadConfig()
    const activeProvider = await resolveProvider(config)
    return { ok: true, value: { config, activeProvider } }
  }

  const configSet = async (payload) => {
    try {
      const next = deepMerge(DEFAULT_CONFIG, payload && payload.config ? payload.config : {})
      await saveConfig(next)
      const activeProvider = await resolveProvider(next)
      return { ok: true, value: { config: next, activeProvider } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: { code: 'internal', message: `config save failed: ${message}`, details: {} },
      }
    }
  }

  const detectEndpoint = async () => {
    const config = await loadConfig()
    const activeProvider = await resolveProvider(config)
    return { ok: true, value: { mode: config.mode, activeProvider } }
  }

  ctx.connection.rpc.handle(
    '/balance',
    async (endpoint, payload, signal) => {
      switch (endpoint) {
        case 'opencode':
          return opencodeEndpoint(signal)
        case 'scnet':
          return scnetEndpoint()
        case 'configGet':
          return configGet()
        case 'configSet':
          return configSet(payload)
        case 'detect':
          return detectEndpoint()
        default:
          return snapshotEndpoint(signal)
      }
    },
    { authority: 'loopback' },
  )
}
