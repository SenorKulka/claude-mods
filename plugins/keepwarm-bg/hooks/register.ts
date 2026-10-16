import type { EngineInterface, Register, Timer } from 'claude-code'

// Keeps the prompt cache warm while this session waits on background work (a
// backgrounded shell, subagent, monitor or workflow). When that work finishes,
// Claude Code wakes the session; if the last request was over an hour ago, that
// wake-up re-writes the whole cache. So at the end of a turn that leaves work in
// flight, this mod starts its own timer and, after 50 idle minutes, sends one
// tool-less fork of the conversation that reads the cache and so renews it, then
// waits another 50. A turn that leaves no work in flight stops it. Nothing is
// written to the transcript.

export const PING_AFTER_MS = 50 * 60 * 1000
/** Pings stop this long after the last turn ended, in case a job hangs. */
export const CAP_MS = 12 * 60 * 60 * 1000
export const PING_PROMPT = 'Reply with the single word: warm'

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
}

export function freshState(): State {
  return { lastTurnAt: 0, lastRequestAt: 0, pending: null, gen: 0 }
}

/** A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke. */
export function isWarm(u: Usage): boolean {
  return u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
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

/** Waits until 50 minutes after the last request, unless that falls past the cap. */
function schedule($: EngineInterface, s: State, now: number) {
  cancel(s)
  const at = s.lastRequestAt + PING_AFTER_MS
  if (at > s.lastTurnAt + CAP_MS) return
  const gen = s.gen
  s.pending = $.clock.after(Math.max(1000, at - now), () => { void ping($, s, gen) })
}

async function ping($: EngineInterface, s: State, gen: number) {
  if (s.gen !== gen) return
  s.pending = null
  const now = await $.clock.now()
  if (await cacheTaxArmed($, now)) {
    if (s.gen !== gen) return
    s.lastRequestAt = now
    return schedule($, s, now)
  }
  let reply
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    if (s.gen === gen) $.ui.log(`keepwarm-bg: the ping failed, ${err instanceof Error ? err.message : String(err)}. No more pings until the next turn.`)
    return
  }
  // A turn, /clear or compaction while the ping was out decides what comes next.
  if (s.gen !== gen) return
  // Older Claude Code releases returned null instead of a failure object.
  if (!reply?.isAnswered) {
    $.ui.log(`keepwarm-bg: the ping got no reply (${reply ? reply.reason : 'none sent'}). No more pings until the next turn.`)
    return
  }
  if (!isWarm(reply.usage)) {
    const u = reply.usage
    $.ui.log(`keepwarm-bg: the ping read ${u.cache_read_input_tokens} and wrote ${u.cache_creation_input_tokens} tokens, so the cache was already gone. No more pings until the next turn.`)
    return
  }
  s.lastRequestAt = now
  schedule($, s, now)
}

export async function onTurnEnd($: EngineInterface, s: State, tasks: readonly Summary[]) {
  const now = await $.clock.now()
  s.lastTurnAt = now
  s.lastRequestAt = now
  if (tasks.length > 0) schedule($, s, now)
  else cancel(s)
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
    if (!e.agentId) cancel(s)
    return r
  })

  // /clear leaves nothing to keep warm.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear') cancel(s)
    return r
  })
}
