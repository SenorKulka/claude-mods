import type { EngineInterface, Register } from 'claude-code'
import { statusIcons } from './status-icons'

// Keeps the main conversation's one-hour prompt cache warm and prices it when
// it goes cold. Pings are cache-reading forks of the conversation (`$.model.fork`)
// sent 50 idle minutes after the last request, so the next request reads the
// cache instead of re-writing it. They run while either reason holds:
//
// - background work: a turn ended with a shell, subagent, monitor or workflow
//   still in flight, which will wake the session later. Pings then run until a
//   turn leaves no work, for at most 12 hours after the last turn.
// - a /keepwarm window: a time the user picked (6 hours by default, `always` for
//   every session), or 3 hours after a cold write was paid.
//
// A message sent on a cold cache is refused once with its re-write price (or
// only warned about, with /keepwarm guard warn). Nothing goes to the
// transcript: the state shows in a row above the prompt (the status line where
// there is no such row), each ping in a toast, and pings stopping early in a
// longer toast.
//
// A mod can't ping a subagent's cache (`$.model.fork` forks the main thread
// only), and a subagent's cache lasts five minutes. So at session start the mod
// also keeps a rule in the user's CLAUDE.md that tells subagents to wait in
// slices of at most four minutes; each wake-up then refreshes their cache.
//
// The window, guard, pricing and indicator are ported from cache-tax 2.2.1 by
// Karan Bansal (MIT); see NOTICE.

const TTL_MS = 60 * 60 * 1000
export const PING_AFTER_MS = 50 * 60 * 1000
/** Pings for background work stop this long after the last turn ended, in case a job hangs. */
export const CAP_MS = 12 * 60 * 60 * 1000
const MIN_PING_MS = 60 * 1000
/** How often the countdown is redrawn while pings are scheduled. */
const TICK_MS = 60 * 1000
const AUTO_WARM_MS = 3 * 60 * 60 * 1000
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
const BIG_TOKENS = 50000
export const PING_PROMPT = 'Reply with the single word: warm'
const KEY_DEADLINE = 'deadline'
const KEY_EVERY = 'every'
const KEY_GUARD = 'guard'
const KEY_ALWAYS = 'always'

export const RULE_START = '<!-- KEEPWARM_BG_WAIT_RULE_START -->'
export const RULE_END = '<!-- KEEPWARM_BG_WAIT_RULE_END -->'
/** Anywhere in CLAUDE.md, keeps the mod from adding or updating the rule. */
export const RULE_OFF = '<!-- KEEPWARM_BG_WAIT_RULE: off -->'
const RULE_HEADING = '## Waiting in sub-agents (4-minute slices)'
export const WAIT_RULE = `${RULE_START}
${RULE_HEADING}

A sub-agent's prompt cache lasts 5 minutes; one idle tool call longer than that makes it rewrite its whole cache when it wakes (measured 17 Oct 2026: 600–700k-token caches rewritten 16 times in one session; see the keepwarm-bg README). So:

- **If you are a sub-agent** and wait on a background job (a review trial, a check run, a test suite, a build, a server), wait in slices of at most 4 minutes: a Bash or Monitor wait with a timeout of at most 240 s, then a short status check, then the next slice. Never make one long blocking wait.
- **If you launch sub-agents** (Agent tool, workflows), put this rule in every prompt for one that may wait on a background job.
- Waits in the main conversation are exempt: its cache lasts an hour.
${RULE_END}`

/**
 * CLAUDE.md's text with the wait rule in it, or null when it needs no change:
 * the marked block is replaced when it differs, an unmarked section under the
 * rule's heading (added by hand) is taken over, and otherwise the rule is
 * appended. RULE_OFF anywhere leaves the file alone.
 */
export function withWaitRule(text: string): string | null {
  if (text.includes(RULE_OFF)) return null
  const start = text.indexOf(RULE_START)
  const end = text.indexOf(RULE_END, start)
  if (start >= 0 && end > start) {
    const next = text.slice(0, start) + WAIT_RULE + text.slice(end + RULE_END.length)
    return next === text ? null : next
  }
  const heading = text.search(/^## Waiting in sub-agents \(4-minute slices\)[ \t]*$/m)
  if (heading >= 0) {
    const rest = text.slice(heading + RULE_HEADING.length)
    const after = rest.search(/^(## |<!-- )/m)
    const tail = after < 0 ? '\n' : '\n\n' + rest.slice(after)
    return text.slice(0, heading) + WAIT_RULE + tail
  }
  const body = text.trimEnd()
  return (body ? body + '\n\n' : '') + WAIT_RULE + '\n'
}

async function ensureWaitRule($: EngineInterface) {
  try {
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
    const path = `${config}/CLAUDE.md`
    const text = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    const next = withWaitRule(text)
    if (next !== null) await $.fs.write(path, next)
  } catch (err) {
    $.ui.log(`keepwarm-bg: could not update CLAUDE.md with the sub-agent wait rule: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

/** $ per million tokens: cache read, 1-hour cache write, output. Uncached input is half the 1-hour write. */
export type Price = [number, number, number]

// List prices from https://platform.claude.com/docs/en/about-claude/pricing, 17 October 2026.
// A model id matches the first row whose family it contains, so longer names come first.
// The second price applies to prompts over 100,000 tokens (Haiku 5.5 only).
const PRICES: Array<[string, Price, Price?]> = [
  ['fable-5-1', [0.25, 20, 50]],
  ['mythos-5-1', [0.25, 20, 50]],
  ['fable-5', [1, 20, 50]],
  ['mythos-5', [1, 20, 50]],
  ['opus-5-5', [0.2, 8, 20]],
  ['opus-5', [0.5, 10, 25]],
  ['opus-4-1', [1.5, 30, 75]],
  ['opus-4-5', [0.5, 10, 25]],
  ['opus-4-6', [0.5, 10, 25]],
  ['opus-4-7', [0.5, 10, 25]],
  ['opus-4-8', [0.5, 10, 25]],
  ['opus-4', [1.5, 30, 75]],
  ['sonnet-5-5', [0.1, 4, 10]],
  ['sonnet-5', [0.2, 4, 10]],
  ['sonnet', [0.3, 6, 15]],
  ['haiku-5-5', [0.01, 0.2, 0.5], [0.05, 1, 2.5]],
  ['haiku-3-5', [0.08, 1.6, 4]],
  ['haiku', [0.1, 2, 5]],
]
const TIER_TOKENS = 100000

/** The model's prices for a request whose prompt (cache read + write + input) is `prompt` tokens; null for a model not in the table. */
export function priceOf(model: string | null, prompt = 0): Price | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  for (const [family, base, above] of PRICES) if (m.includes(family)) return above && prompt > TIER_TOKENS ? above : base
  return null
}

type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'refuse' | 'warn'
type Summary = { id: string; type: string; status: string }
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export type State = {
  hasBand: boolean
  sid: string
  /** When the /keepwarm window ends; 0 when none is open. */
  deadline: number
  /** When pings for background work stop (12 h after the turn that left it); 0 when the last turn left none. */
  bgUntil: number
  every: number
  always: boolean
  lastRequestAt: number
  lastModel: string | null
  ctx: number
  compacted: boolean
  guard: GuardMode
  ackedAt: number
  coldWritePending: boolean
  misses: Miss[]
  pending: { cancel: () => void } | null
  /** Redraws the countdown while pings are scheduled; nothing else changes it between turns. */
  tick: { cancel: () => void } | null
  last: PingRecord | null
  stopped: string | null
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

export function fmtTokens(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

/** `HH:MM` on the host's clock. */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function coldUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[1] / 1e6 : null
}

function warmUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[0] / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate (half the 1h write rate), and the output. */
function pingUsd(u: Usage, price: Price): number {
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + u.input_tokens * price[1] / 2 + u.output_tokens * price[2]) / 1e6
}

/** A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke. */
export function isWarm(u: Pick<Usage, 'cache_read_input_tokens' | 'cache_creation_input_tokens'>): boolean {
  return u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  if (!price || s.ctx <= 0) return null
  return Math.floor(price[1] / price[0])
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= TTL_MS
}

/** When pings stop: the later of the window's end and background work's cap; 0 when neither holds. */
function endOf(s: State): number {
  return Math.max(s.deadline, s.bgUntil)
}

function guardText(s: State, now: number): string {
  const price = priceOf(s.lastModel, s.ctx)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  const warm = warmUsd(s)
  return `the prompt cache went cold ${fmtDuration(now - s.lastRequestAt - TTL_MS)} ago. Sending this re-writes ` +
    `up to ${s.ctx.toLocaleString('en-US')} tokens at ${rate} = ${fmtUsd(coldUsd(s))}` +
    (warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`) + '.'
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.compacted = false
  s.ackedAt = 0
  s.coldWritePending = false
  s.misses = []
  s.bgUntil = 0
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') s.lastRequestAt = now - e.seconds_since_last_response * 1000
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  if (e.prompt_cache_likely_expired !== true || s.ctx < BIG_TOKENS) return null
  const usd = typeof e.estimated_cache_write_usd === 'number' ? fmtUsd(e.estimated_cache_write_usd) : fmtUsd(coldUsd(s))
  return `resuming cold. The first message re-writes ${s.ctx.toLocaleString('en-US')} tokens, about ${usd}. /clear and paste a summary if you only need the conclusions.`
}

function statusText(s: State, now: number): string | undefined {
  if (s.stopped) return `keepwarm stopped: ${s.stopped}`
  const end = endOf(s)
  if (!end) return undefined
  const why = s.bgUntil > s.deadline ? ' for background work' : ''
  const pingText = s.last ? ` · last ping read ${fmtTokens(s.last.read)} ${fmtUsd(s.last.usd)}` : ''
  const nextText = !s.lastRequestAt ? ' · waiting for the first turn'
    : s.compacted ? ' · waiting for the first turn after compaction'
    : isCold(s, now) ? ` · cold now, first ping ${fmtDuration(s.every)} after the next turn`
    : ` · ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  return `keepwarm ${fmtDuration(end - now)} left${why}${nextText}${pingText}`
}

function updateStatus($: EngineInterface, s: State, now: number) {
  if (s.hasBand) $.ui.invalidate('ui.render')
  else $.ui.status(statusText(s, now))
  syncTick($, s)
}

/** Keeps a one-minute redraw running exactly while pings are scheduled, so "left" and "ping in" count down. */
function syncTick($: EngineInterface, s: State) {
  if (endOf(s) && !s.tick) {
    s.tick = $.clock.every(TICK_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        if (s.hasBand) $.ui.invalidate('ui.render')
        else $.ui.status(statusText(s, now))
      })()
    })
  } else if (!endOf(s) && s.tick) {
    s.tick.cancel()
    s.tick = null
  }
}

function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The always switch and the guard mode stay global.
function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

/** Clears this session's own dead window and bare keys from an old store. Other sessions' keys are never touched: a read followed by a delete cannot be made atomic against their renewal. */
async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [KEY_DEADLINE, deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(KEY_EVERY + key.slice(KEY_DEADLINE.length))
  }
}

/** Pings have stopped early: the whole reason in a long toast; the row keeps the short form. */
function notifyStopped($: EngineInterface, now: number, why: string) {
  $.ui.toast(`Pings stopped at ${clockTime(now)}: ${why}. A request after an hour idle will re-write the cache.`, { timeoutMs: 15000 })
}

async function stop($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  s.deadline = 0
  s.bgUntil = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  if (forgetAlways) {
    s.always = false
    await $.store.delete(KEY_ALWAYS)
  }
  const now = await $.clock.now()
  updateStatus($, s, now)
  if (why) notifyStopped($, now, why)
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  const end = endOf(s)
  if (!end) return
  const now = await $.clock.now()
  if (now >= end) {
    // A window ends quietly; background work may still be running when its cap ends.
    const capped = s.bgUntil > 0 && s.bgUntil >= s.deadline
    return stop($, s, capped ? '12 h cap after the last turn, background work may still be running' : null)
  }
  // A cold cache still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + TTL_MS - now
    const delay = Math.min(end - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
    s.pending = $.clock.after(delay, () => { void ping($, s) })
  } else {
    s.pending = $.clock.after(end - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  const end = endOf(s)
  if (!end) return
  const now = await $.clock.now()
  if (now >= end) return arm($, s)
  // A turn in the meantime re-armed the timer; this callback is stale.
  if (isCold(s, now)) return arm($, s)
  if (now - s.lastRequestAt < s.every - 1000) return
  const sent = s.lastRequestAt
  let reply
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    return stop($, s, `the ping failed, ${err instanceof Error ? err.message : String(err)}`)
  }
  // A turn while the ping was out stamped a newer request and re-armed; it decides what comes next.
  if (s.lastRequestAt !== sent) return
  // Older Claude Code releases returned null instead of a failure object.
  if (reply === null) return stop($, s, 'the engine did not send the ping, either the snapshot was cold or the API call failed')
  if (reply.isAnswered === false) {
    const reason = reply.reason === 'nothing-to-fork' ? 'no conversation to warm yet'
      : reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    return stop($, s, reason)
  }
  const u = reply.usage
  const price = priceOf(s.lastModel, u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens)
  const warm = isWarm(u)
  const usd = price ? pingUsd(u, price) : null
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  if (!warm) return stop($, s, `the ping read ${fmtTokens(u.cache_read_input_tokens)} and wrote ${fmtTokens(u.cache_creation_input_tokens)} tokens (${fmtUsd(usd)}), the cache was already gone`)
  s.lastRequestAt = now
  $.ui.toast(`Cache refreshed: the ping read ${fmtTokens(u.cache_read_input_tokens)} tokens (${fmtUsd(usd)}).`)
  await arm($, s)
}

/** The reply to an arming command; on a cold cache it says when the first ping can come. */
function armedText(s: State, now: number, windowMs: number): string {
  if (isCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written`
}

async function startWindow($: EngineInterface, s: State, windowMs: number, every: number) {
  const now = await $.clock.now()
  s.every = every
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  s.deadline = now + windowMs
  s.stopped = null
  await $.store.set(deadlineKey(s), s.deadline)
  await arm($, s)
}

function card(s: State, now: number): string {
  const lines: string[] = []
  lines.push(`${s.lastModel ?? 'model not seen yet'}`)
  if (s.compacted) lines.push('state       reset by compaction, waiting for the first turn')
  else if (!s.lastRequestAt) lines.push('state       no request yet this session')
  else if (isCold(s, now)) lines.push(`state       COLD, last request ${fmtDuration(now - s.lastRequestAt)} ago`)
  else lines.push(`state       warm, ${fmtDuration(s.lastRequestAt + TTL_MS - now)} left`)
  lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens`)
  lines.push(`cold cost   ${fmtUsd(coldUsd(s))} to re-write it (warm turn ${fmtUsd(warmUsd(s))})`)
  const always = s.always ? ' (always)' : ''
  const idle = s.always ? 'off until the next session start, which arms 6h00m (always)' : 'off (/keepwarm to arm it for 6h00m)'
  lines.push(`keepwarm    ${endOf(s) ? (statusText(s, now) ?? '').replace(/^keepwarm /, 'on, ') + always : s.stopped ? `stopped, ${s.stopped}${always}` : idle}`)
  lines.push(`background  ${s.bgUntil ? `work in flight, pings until ${clockTime(s.bgUntil)} at the latest` : 'no work in flight at the last turn'}`)
  const pings = breakEvenPings(s)
  if (pings != null) lines.push(`break-even  up to ${pings} pings at the read rate cost one cold write, about ${fmtDuration(pings * s.every)} of idle at one ping per ${fmtDuration(s.every)}`)
  lines.push(`guard       ${s.guard === 'refuse' ? 'refuse once (/keepwarm guard warn to only show the price)' : 'warn only (/keepwarm guard refuse to be stopped once)'}`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  lines.push(`session     ${s.misses.length} cold write${s.misses.length === 1 ? '' : 's'} paid, ${fmtUsd(paid)}`)
  return lines.join('\n')
}

export function freshState(): State {
  return {
    hasBand: false, sid: '', deadline: 0, bgUntil: 0, every: PING_AFTER_MS, always: false, lastRequestAt: 0, lastModel: null, ctx: 0, compacted: false,
    guard: 'refuse', ackedAt: 0, coldWritePending: false, misses: [], pending: null, tick: null, last: null, stopped: null,
  }
}

export const register: Register = on => {
  const s = freshState()
  let light = false
  let noColor = false

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      light = typeof result.value === 'string' && result.value.startsWith('light')
      if (s.hasBand) $.ui.invalidate('ui.render')
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!s.hasBand || e.props.hasSurvey) return rest
    const now = await $.clock.now()
    const text = statusText(s, now)
    if (!text || (endOf(s) && now >= endOf(s))) return rest
    const state = s.stopped ? 'stopped' : !s.lastRequestAt || s.compacted ? 'unknown' : isCold(s, now) ? 'cold' : 'warm'
    const color = noColor ? undefined : state === 'warm' ? 'success' : state === 'cold' ? (light ? '#c15f3c' : '#d97757') : undefined
    const { Box, Text } = $.ui.resolve(e)
    const asset = statusIcons[light ? 'light' : 'dark'][state === 'warm' || state === 'cold' ? state : 'neutral']
    const icon = noColor ? Text({ bold: true, children: ['[>]'] })
      : e.surface === 'terminal' ? $.ui.resolve(e).Image({ source: { png: asset.png }, columns: 3, rows: 1, alt: '[>]' })
      : e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: asset.svg, width: 18, height: 18, alt: 'keepwarm-bg' })
      : Text({ color, bold: true, children: ['[>]'] })
    return Box({ flexDirection: 'column', children: [
      rest,
      Box({ flexDirection: 'row', alignItems: 'center', children: [
        Box({ flexShrink: 0, children: [icon] }),
        Text({ children: [
          ' keepwarm-bg · ',
          Text({ color, bold: true, children: [state] }),
          ` · ${text.replace(/^keepwarm /, '')}`,
        ] }),
      ] }),
    ] })
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.hasBand = e.surface === 'terminal' || e.surface === 'desktop'
    if (s.hasBand) {
      const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
      light = typeof theme === 'string' && theme.startsWith('light')
      noColor = Boolean(await $.env.get('NO_COLOR'))
      $.ui.status(undefined)
    }
    await ensureWaitRule($)
    s.sid = await $.session.id()
    const now = await $.clock.now()
    await prune($, s, now)
    const saved = await $.store.get(deadlineKey(s))
    const savedEvery = await $.store.get(everyKey(s))
    const savedGuard = await $.store.get(KEY_GUARD)
    s.deadline = typeof saved === 'number' && saved > now ? saved : 0
    s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS ? savedEvery : PING_AFTER_MS
    s.guard = savedGuard === 'warn' ? 'warn' : 'refuse'
    s.always = (await $.store.get(KEY_ALWAYS)) === true
    // Always means a fresh default window every session, whatever the last one left behind.
    if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
    const usage = await $.session.usage()
    if (usage.context.tokens) s.ctx = usage.context.tokens
    await $.command.register({
      name: 'keepwarm',
      description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always, off, status (cache state and cold price), or guard warn|refuse (keepwarm-bg)',
      argumentHint: '[6h | always | off | status | guard warn | guard refuse]',
      immediate: true,
    })
    // cache-tax, which this mod replaces, would ping and guard a second time.
    const commands = await $.command.list()
    if (commands.some(c => c.name === 'cache-tax' || c.name === 'cache-tax:status')) {
      $.ui.log('cache-tax is also installed, so the cache is pinged and a cold send is guarded twice. keepwarm-bg does all of its work; uninstall cache-tax.')
    }
    updateStatus($, s, now)
    return r
  })

  // Resume fields seed the guard before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear') {
      await stop($, s, null)
      s.stopped = null
      resetForClear(s)
      s.sid = await $.session.id()
      updateStatus($, s, await $.clock.now())
      return r
    }
    const line = seedFromResume(s, e, await $.clock.now())
    // The resume payload may omit the model; without it the guard cannot price the cold write.
    if (!s.lastModel) s.lastModel = await $.session.model()
    if (line) $.ui.log(line)
    // The seeded clock decides whether a restored or always window pings before the first turn: never when it is cold.
    await arm($, s)
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'off') {
      const wasAlways = s.always
      await stop($, s, null, true)
      return { text: wasAlways ? 'keepwarm is off, and no longer arms itself at session start' : 'keepwarm is off' }
    }
    if (words[0] === 'status') return { text: card(s, now) }
    if (words[0] === 'guard') {
      if (words[1] !== 'warn' && words[1] !== 'refuse') return { text: '/keepwarm guard takes warn or refuse' }
      s.guard = words[1]
      await $.store.set(KEY_GUARD, s.guard)
      return { text: s.guard === 'refuse' ? 'guard set to refuse once: a cold send is dropped with its price, the resend goes through' : 'guard set to warn: a cold send goes through with its price shown' }
    }
    if (words[0] === 'always') {
      s.always = true
      await $.store.set(KEY_ALWAYS, true)
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      const cold = isCold(s, now) ? `. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn` : ''
      return { text: `keepwarm always on: every session starts with a ${fmtDuration(DEFAULT_WINDOW_MS)} window; /keepwarm off turns it off for good${cold}` }
    }
    if (!words.length) {
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      return { text: armedText(s, now, DEFAULT_WINDOW_MS) }
    }
    const window = parseDuration(words[0])
    if (window == null) return { text: 'keepwarm takes a window such as 6h or 90m, or always, off, status, or guard warn|refuse' }
    // "every 2m" is a testing knob and lasts only for the window it was given with.
    let every = PING_AFTER_MS
    if (words[1] === 'every') {
      const period = parseDuration(words[2] ?? '')
      if (period == null || period < MIN_PING_MS) return { text: 'every takes a period of at least 1m' }
      every = period
    }
    await startWindow($, s, window, every)
    return { text: armedText(s, now, window) }
  })

  // The message that pays. Only its first character is read.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    if (!isCold(s, now) || s.ctx < BIG_TOKENS) return next(e)
    if (s.guard === 'warn') {
      $.ui.log(`${guardText(s, now)} Sending anyway; keepwarm will hold the cache for ${fmtDuration(AUTO_WARM_MS)} once it lands.`)
      s.coldWritePending = true
      return next(e)
    }
    if (s.ackedAt === s.lastRequestAt) {
      s.ackedAt = 0
      s.coldWritePending = true
      return next(e)
    }
    s.ackedAt = s.lastRequestAt
    return { drop: `keepwarm-bg: ${guardText(s, now)} Send it again to pay it, and keepwarm will then hold the cache for ${fmtDuration(AUTO_WARM_MS)}. Or /clear and start from a note.` }
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) s.lastRequestAt = await $.clock.now()
    yield* next(e)
  })

  // Stop fires when the main conversation's turn ends; background_tasks lists the
  // work still in flight that will wake it later. turn.complete acts on what
  // Stop saw, once the turn is over.
  let seen: readonly Summary[] | undefined
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    seen = e.background_tasks ?? []
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) {
      s.deadline = 0
      s.every = PING_AFTER_MS
      await $.store.delete(deadlineKey(s))
      await $.store.delete(everyKey(s))
    }
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    if (now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    s.compacted = false
    s.ackedAt = 0
    const u = e.usage
    if (u) {
      if (u.model) s.lastModel = u.model
      const prev = s.ctx
      // A turn's usage is its responses summed, so a ten-step turn reports ten
      // reads of the context. The live window is the engine's figure; the sum
      // is only the fallback for a host that reports no tokens.
      const write = u.cache_creation_input_tokens
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + write
      // Each warm step writes only what it added, so a long turn's summed write
      // can match the context's growth without anything going cold. Only the
      // write beyond that growth re-wrote the prefix the turn started from.
      const rewrote = Math.max(0, write - Math.max(0, s.ctx - prev))
      const full = prev > 20000 && rewrote >= 0.5 * prev
      if (full || s.coldWritePending) {
        const price = priceOf(s.lastModel, s.ctx)
        const usd = price ? rewrote * price[1] / 1e6 : null
        s.misses.push({ at: now, tokens: rewrote, usd })
        if (s.deadline < now + AUTO_WARM_MS) {
          await startWindow($, s, AUTO_WARM_MS, s.every)
          $.ui.log(`cold write of ${fmtTokens(rewrote)} tokens paid (${fmtUsd(usd)}). Keeping the cache warm for ${fmtDuration(AUTO_WARM_MS)} so it is not paid again today; /keepwarm off to stop.`)
        }
      }
    }
    s.coldWritePending = false
    if (seen !== undefined) {
      s.bgUntil = seen.length ? now + CAP_MS : 0
      if (seen.length) s.stopped = null
      seen = undefined
    }
    // arm draws nothing when no reason is left, so the row is cleared here.
    if (!endOf(s)) updateStatus($, s, now)
    await arm($, s)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      s.compacted = true
      s.ctx = 0
      s.ackedAt = 0
      disarm(s)
      await arm($, s)
    }
    return r
  })
}
