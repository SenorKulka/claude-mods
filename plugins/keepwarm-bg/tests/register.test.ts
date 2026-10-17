import { expect, mock, test, tier, type ClassicFields, type Engine } from 'claude-code/testing'
import type { ModelForkResult, On, TurnCompleteInput } from 'claude-code'

import { CAP_MS, clockTime, fmtTokens, isWarm, PING_AFTER_MS, PING_PROMPT } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN
const STORE_DIR = '/home/u/.claude/plugins/store'
const STORE_FILE = 'cache-tax_claude-code-mods-ee8adb4b3133.json'

const shell = { id: 'b1', type: 'shell', status: 'running', description: 'cargo build', command: 'cargo build' }
const stop = (tasks?: typeof shell[]): ClassicFields<'Stop'> => ({ stop_hook_active: false, background_tasks: tasks })
let turns = 0
const done = (): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer',
  usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 500, model: 'claude-fable-5-1' },
})

// One main turn ending: Stop reports the in-flight work, then the turn completes.
async function end($: Engine, tasks?: typeof shell[]) {
  await $.classic.Stop(stop(tasks))
  await $.turn.complete(done())
}

const warm = { read: 200000, write: 20 }
type ForkAnswer = ModelForkResult | { read: number; write: number }

// The engine beneath the mod: a clock, a fork that answers from a script (warm
// unless a test says otherwise), cache-tax's store file, and every slash command
// run, which should stay empty.
function world(on: On, answers: ForkAnswer[] = []) {
  const clock = mock.clock(on, { now: 10 * HOUR })
  const store: Record<string, unknown> = {}
  const forks: string[] = []
  const logs: string[] = []
  const commands: string[] = []
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  const notes: string[] = []
  let invalidations = 0
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    const a = answers.shift() ?? warm
    if ('isAnswered' in a) return { value: a }
    return { value: { isAnswered: true, text: 'warm', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } } }
  })
  on('command.run', ($, e) => { commands.push(`${e.command} ${e.args}`); return { text: '' } })
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.notify', ($, e) => { notes.push(e.text); return { value: { isSent: false as const, reason: 'no-surface' as const } } })
  on('ui.invalidate', () => { invalidations++; return { value: undefined } })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('session.id', () => ({ value: 'S1' }))
  on('fs.list', ($, e) => ({ value: e.path === STORE_DIR ? [{ name: STORE_FILE, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }] : [] }))
  on('fs.read', () => ({ value: JSON.stringify(store) }))
  on('classic.Stop', () => ({}))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('classic.SessionStart', () => ({}))
  return { clock, store, forks, logs, commands, status, toasts, notes, invalidations: () => invalidations }
}

test('pings 50 idle minutes after a turn that leaves a background shell, then every 50', async ($, on) => {
  const { clock, forks, commands } = world(on)
  await end($, [shell])
  await clock.advance(PING_AFTER_MS - MIN)
  expect(forks).toEqual([])
  await clock.advance(MIN)
  expect(forks).toEqual([PING_PROMPT])
  await clock.advance(PING_AFTER_MS)
  expect(forks.length).toBe(2)
  expect(commands).toEqual([])
})

test('never pings when no background work is in flight', async ($, on) => {
  const { clock, forks } = world(on)
  await end($, [])
  await end($)
  await clock.advance(3 * HOUR)
  expect(forks).toEqual([])
})

test('a turn that leaves no work in flight stops the pings', async ($, on) => {
  const { clock, forks } = world(on)
  await end($, [shell])
  await clock.advance(PING_AFTER_MS)
  expect(forks.length).toBe(1)
  await end($, [])
  await clock.advance(3 * HOUR)
  expect(forks.length).toBe(1)
})

test('each turn restarts the 50 minutes', async ($, on) => {
  const { clock, forks } = world(on)
  await end($, [shell])
  await clock.advance(40 * MIN)
  await end($, [shell])
  await clock.advance(40 * MIN)
  expect(forks).toEqual([])
  await clock.advance(10 * MIN)
  expect(forks.length).toBe(1)
})

test('stops pinging 12 hours after the last turn', async ($, on) => {
  const { clock, forks } = world(on)
  await end($, [shell])
  await clock.advance(CAP_MS + 3 * HOUR)
  expect(forks.length).toBe(Math.floor(CAP_MS / PING_AFTER_MS))
  await end($, [shell])
  await clock.advance(PING_AFTER_MS)
  expect(forks.length).toBe(Math.floor(CAP_MS / PING_AFTER_MS) + 1)
})

test('a ping that finds the cache gone stops until the next turn', async ($, on) => {
  const { clock, forks, logs, notes, toasts, status } = world(on, [{ read: 0, write: 200000 }])
  await end($, [shell])
  await clock.advance(3 * HOUR)
  expect(forks.length).toBe(1)
  expect(logs).toEqual([])
  expect(notes).toEqual([expect.stringContaining('cache was already gone')])
  expect(toasts).toEqual([notes[0]])
  expect(status.at(-1)).toContain('pings stopped at')
  await end($, [shell])
  await clock.advance(PING_AFTER_MS)
  expect(forks.length).toBe(2)
})

test('a ping that gets no reply stops until the next turn', async ($, on) => {
  const failed = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: null } as unknown as ModelForkResult
  const { clock, forks, logs, notes } = world(on, [failed])
  await end($, [shell])
  await clock.advance(3 * HOUR)
  expect(forks.length).toBe(1)
  expect(logs).toEqual([])
  expect(notes).toEqual([expect.stringContaining('api-error')])
})

test('leaves the pinging to a cache-tax window armed for this session', async ($, on) => {
  const { clock, store, forks } = world(on)
  store['deadline:S1'] = 10 * HOUR + 2 * HOUR
  store['deadline:S2'] = 10 * HOUR + 12 * HOUR
  await end($, [shell])
  await clock.advance(110 * MIN)
  expect(forks).toEqual([])
  await clock.advance(50 * MIN)
  expect(forks.length).toBe(1)
})

test('a subagent turn or a turn without Stop does not act', async ($, on) => {
  const { clock, forks } = world(on)
  await $.turn.complete(done())
  await $.classic.Stop(stop([shell]))
  await $.turn.complete({ ...done(), agentId: 'a1' })
  await clock.advance(HOUR)
  expect(forks).toEqual([])
  await $.turn.complete(done())
  await clock.advance(PING_AFTER_MS)
  expect(forks.length).toBe(1)
})

test('/clear and compaction cancel the pending ping', async ($, on) => {
  const { clock, forks } = world(on)
  await end($, [shell])
  await $.classic.SessionStart({ source: 'clear' })
  await clock.advance(2 * HOUR)
  expect(forks).toEqual([])
  await end($, [shell])
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  await clock.advance(2 * HOUR)
  expect(forks).toEqual([])
})

test('shows the countdown and each refresh, never in the transcript', async ($, on) => {
  const { clock, logs, status, toasts, notes } = world(on)
  await end($, [shell])
  const start = 10 * HOUR
  expect(status).toEqual([`keepwarm-bg · waiting on background work · cache ping at ${clockTime(start + PING_AFTER_MS)}`])
  await clock.advance(PING_AFTER_MS)
  expect(toasts).toEqual([`Cache refreshed: the ping read ${fmtTokens(200000)} tokens.`])
  expect(status.at(-1)).toBe(`keepwarm-bg · cache refreshed at ${clockTime(start + PING_AFTER_MS)} (read 200k) · next ping at ${clockTime(start + 2 * PING_AFTER_MS)}`)
  await end($, [])
  expect(status.at(-1)).toBeUndefined()
  expect(logs).toEqual([])
  expect(notes).toEqual([])
})

test('notifies once when the 12-hour cap ends the pings', async ($, on) => {
  const { clock, notes, status } = world(on)
  await end($, [shell])
  await clock.advance(CAP_MS + HOUR)
  expect(notes).toEqual([expect.stringContaining('that was the last ping (read 200k), 12 h after the last turn')])
  expect(status.at(-1)).toContain('pings stopped at')
})

test('on a surface with a row above the prompt, redraws it instead of the status line', async ($, on) => {
  const { status, invalidations } = world(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await end($, [shell])
  expect(status).toEqual([])
  expect(invalidations()).toBeGreaterThan(0)
})

test('tells a warm ping from a cold one', () => {
  expect(isWarm({ cache_read_input_tokens: 200000, cache_creation_input_tokens: 30 })).toBe(true)
  expect(isWarm({ cache_read_input_tokens: 200000, cache_creation_input_tokens: 20000 })).toBe(false)
  expect(isWarm({ cache_read_input_tokens: 0, cache_creation_input_tokens: 30 })).toBe(false)
})
