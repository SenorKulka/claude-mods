import type { EngineInterface, Register, Timer } from 'claude-code'

// Keeps the prompt cache warm while this session waits on background work (a
// backgrounded shell, subagent, monitor or workflow). When that work finishes,
// Claude Code wakes the session; if the last request was over an hour ago, that
// wake-up re-writes the whole cache. So at the end of a turn that leaves work in
// flight, this mod starts its own timer and, after 50 idle minutes, sends one
// tool-less fork of the conversation that reads the cache and so renews it, then
// waits another 50. A turn that leaves no work in flight stops it. Nothing is
// written to the transcript: the countdown and the last ping show in a row above
// the prompt (the status line where there is no such row), each ping in a toast,
// and pings stopping while work may still be in flight in a notification.
//
// A mod can't ping a subagent's cache (`$.model.fork` forks the main thread
// only), and a subagent's cache lasts five minutes. So at session start the mod
// also keeps a rule in the user's CLAUDE.md that tells subagents to wait in
// slices of at most four minutes; each wake-up then refreshes their cache.

export const PING_AFTER_MS = 50 * 60 * 1000
/** Pings stop this long after the last turn ended, in case a job hangs. */
export const CAP_MS = 12 * 60 * 60 * 1000
export const PING_PROMPT = 'Reply with the single word: warm'

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

type Summary = { id: string; type: string; status: string }
type Usage = { cache_read_input_tokens: number; cache_creation_input_tokens: number }

export type State = {
  /** When the last main turn ended. */
  lastTurnAt: number
  /** When the last request (a turn's or a ping's) read the cache. */
  lastRequestAt: number
  pending: Timer | null
  /** Bumped by every cancel, so a ping still out when a turn ends knows it is stale. */
  gen: number
  /** What the row above the prompt says; undefined hides it. */
  shown: string | undefined
  /** The surface draws a row above the prompt; otherwise the status line carries `shown`. */
  hasBand: boolean
}

export function freshState(): State {
  return { lastTurnAt: 0, lastRequestAt: 0, pending: null, gen: 0, shown: undefined, hasBand: false }
}

/** A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke. */
export function isWarm(u: Usage): boolean {
  return u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
}

/** `HH:MM` on the host's clock. */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function show($: EngineInterface, s: State, text: string | undefined) {
  s.shown = text
  if (s.hasBand) $.ui.invalidate('ui.render')
  else $.ui.status(text === undefined ? undefined : `keepwarm-bg · ${text}`)
}

/** Pings have stopped while work may still be in flight: say so where it stays, and raise a notification. */
async function stopped($: EngineInterface, s: State, now: number, why: string) {
  show($, s, `pings stopped at ${clockTime(now)}: ${why}`)
  const text = `Pings stopped at ${clockTime(now)}: ${why}. A wake-up after an hour idle will re-write the cache.`
  try {
    if ((await $.ui.notify(text, { title: 'keepwarm-bg' })).isSent) return
  } catch {}
  $.ui.toast(text, { timeoutMs: 15000 })
}

function cancel(s: State) {
  s.pending?.cancel()
  s.pending = null
  s.gen++
}

/**
 * Whether cache-tax holds a /keepwarm window for this session, read from its
 * store file: its own pings then keep the cache warm, and one from here would be
 * paid twice. False when the file can't be found or read.
 */
async function cacheTaxArmed($: EngineInterface, now: number): Promise<boolean> {
  try {
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
    const dir = `${config}/plugins/store`
    const file = (await $.fs.list(dir)).find(f => f.kind === 'file' && /^cache-tax_.*\.json$/.test(f.name))
    if (!file) return false
    const store = JSON.parse(await $.fs.read(`${dir}/${file.name}`)) as Record<string, unknown>
    const deadline = store[`deadline:${await $.session.id()}`]
    return typeof deadline === 'number' && deadline > now
  } catch {
    return false
  }
}

/** Waits until 50 minutes after the last request; returns that time, or null when it falls past the cap. */
function schedule($: EngineInterface, s: State, now: number): number | null {
  cancel(s)
  const at = s.lastRequestAt + PING_AFTER_MS
  if (at > s.lastTurnAt + CAP_MS) return null
  const gen = s.gen
  s.pending = $.clock.after(Math.max(1000, at - now), () => { void ping($, s, gen) })
  return at
}

async function ping($: EngineInterface, s: State, gen: number) {
  if (s.gen !== gen) return
  s.pending = null
  const now = await $.clock.now()
  if (await cacheTaxArmed($, now)) {
    if (s.gen !== gen) return
    s.lastRequestAt = now
    const at = schedule($, s, now)
    return show($, s, at === null ? undefined : `cache-tax's /keepwarm is pinging · checking again at ${clockTime(at)}`)
  }
  let reply
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    if (s.gen === gen) await stopped($, s, now, `the ping failed (${err instanceof Error ? err.message : String(err)})`)
    return
  }
  // A turn, /clear or compaction while the ping was out decides what comes next.
  if (s.gen !== gen) return
  // Older Claude Code releases returned null instead of a failure object.
  if (!reply?.isAnswered) return stopped($, s, now, `the ping got no reply (${reply ? reply.reason : 'none sent'})`)
  const read = fmtTokens(reply.usage.cache_read_input_tokens)
  if (!isWarm(reply.usage)) {
    return stopped($, s, now, `the ping read ${read} and wrote ${fmtTokens(reply.usage.cache_creation_input_tokens)} tokens, so the cache was already gone`)
  }
  s.lastRequestAt = now
  $.ui.toast(`Cache refreshed: the ping read ${read} tokens.`)
  const at = schedule($, s, now)
  if (at === null) return stopped($, s, now, `that was the last ping (read ${read}), 12 h after the last turn`)
  show($, s, `cache refreshed at ${clockTime(now)} (read ${read}) · next ping at ${clockTime(at)}`)
}

export async function onTurnEnd($: EngineInterface, s: State, tasks: readonly Summary[]) {
  const now = await $.clock.now()
  s.lastTurnAt = now
  s.lastRequestAt = now
  if (tasks.length === 0) {
    cancel(s)
    return show($, s, undefined)
  }
  const at = schedule($, s, now)
  show($, s, at === null ? undefined : `waiting on background work · cache ping at ${clockTime(at)}`)
}

export const register: Register = on => {
  const s = freshState()

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
    if (e.agentId || seen === undefined) return r
    const tasks = seen
    seen = undefined
    await onTurnEnd($, s, tasks)
    return r
  })

  // A compacted conversation is a new prefix: a ping would write it, not read it.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      cancel(s)
      show($, s, undefined)
    }
    return r
  })

  // /clear leaves nothing to keep warm.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear') {
      cancel(s)
      show($, s, undefined)
    }
    return r
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.hasBand = e.surface === 'terminal' || e.surface === 'desktop'
    await ensureWaitRule($)
    return r
  })

  // One dim row under whatever the mods above draw there (cache-tax's own row among them).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!s.hasBand || !s.shown || e.props.hasSurvey) return rest
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [
      rest,
      Text({ dimColor: true, children: [`keepwarm-bg · ${s.shown}`] }),
    ] })
  })
}
