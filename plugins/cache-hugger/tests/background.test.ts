import { expect, mock, test, tier, type ClassicFields, type Engine } from 'claude-code/testing'
import type { CommandRunInput, ModelForkResult, On, TurnCompleteInput } from 'claude-code'

import { CAP_MS, isWarm, PING_AFTER_MS, PING_PROMPT, priceOf } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN

const shell = { id: 'b1', type: 'shell', status: 'running', description: 'cargo build', command: 'cargo build' }
const stop = (tasks?: typeof shell[]): ClassicFields<'Stop'> => ({ stop_hook_active: false, background_tasks: tasks })
let turns = 0
const done = (): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer',
  usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 500, model: 'claude-fable-5-1' },
})
const run = (args: string): CommandRunInput => ({
  command: 'hug-cache', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

// One main turn ending: Stop reports the in-flight work, then the turn completes.
async function end($: Engine, tasks?: typeof shell[]) {
  await $.classic.Stop(stop(tasks))
  await $.turn.complete(done())
}

const warm = { read: 200000, write: 20 }
type ForkAnswer = ModelForkResult | { read: number; write: number }

// The engine beneath the mod: a clock, a fork that answers from a script (warm
// unless a test says otherwise), the store, and the surfaces it draws on.
function world(on: On, answers: ForkAnswer[] = []) {
  const clock = mock.clock(on, { now: 10 * HOUR })
  mock.store(on, {})
  const forks: string[] = []
  const logs: string[] = []
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  let invalidations = 0
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    const a = answers.shift() ?? warm
    if ('isAnswered' in a) return { value: a }
    return { value: { isAnswered: true, text: 'warm', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } } }
  })
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.invalidate', () => { invalidations++; return { value: undefined } })
  on('env.get', () => ({ value: undefined }))
  on('config.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000, tokens: 200000 }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('classic.Stop', () => ({}))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('classic.SessionStart', () => ({}))
  return { clock, forks, logs, status, toasts, invalidations: () => invalidations }
}

test('pings 50 idle minutes after a turn that leaves a background shell, then every 50', async ($, on) => {
  const { clock, forks, logs } = world(on)
  await end($, [shell])
  await clock.advance(PING_AFTER_MS - MIN)
  expect(forks).toEqual([])
  await clock.advance(MIN)
  expect(forks).toEqual([PING_PROMPT])
  await clock.advance(PING_AFTER_MS)
  expect(forks.length).toBe(2)
  expect(logs).toEqual([])
})

test('never pings when no background work is in flight', async ($, on) => {
  const { clock, forks } = world(on)
  await end($, [])
  await end($)
  await clock.advance(3 * HOUR)
  expect(forks).toEqual([])
})

test('a turn that leaves no work in flight stops the pings', async ($, on) => {
  const { clock, forks, status } = world(on)
  await end($, [shell])
  await clock.advance(PING_AFTER_MS)
  expect(forks.length).toBe(1)
  await end($, [])
  expect(status.at(-1)).toBeUndefined()
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

test('stops pinging 12 hours after the last turn, with a toast, until a turn leaves work again', async ($, on) => {
  const { clock, forks, toasts, status } = world(on)
  await end($, [shell])
  await clock.advance(CAP_MS + 3 * HOUR)
  expect(forks.length).toBe(Math.floor(CAP_MS / PING_AFTER_MS))
  expect(toasts.at(-1)).toMatch(/^Pings stopped at \d\d:\d\d: 12 h cap after the last turn/)
  expect(status.at(-1)).toMatch(/^pings stopped: 12 h cap/)
  await end($, [shell])
  await clock.advance(PING_AFTER_MS)
  expect(forks.length).toBe(Math.floor(CAP_MS / PING_AFTER_MS) + 1)
})

test('a ping that finds the cache gone stops until the next turn', async ($, on) => {
  const { clock, forks, logs, toasts, status } = world(on, [{ read: 0, write: 200000 }])
  await end($, [shell])
  await clock.advance(3 * HOUR)
  expect(forks.length).toBe(1)
  expect(logs).toEqual([])
  expect(toasts).toEqual([expect.stringContaining('the cache was already gone')])
  expect(status.at(-1)).toMatch(/^pings stopped: the ping read 0 and wrote 200k/)
  await end($, [shell])
  await clock.advance(PING_AFTER_MS)
  expect(forks.length).toBe(2)
})

test('a ping that gets no reply stops until the next turn', async ($, on) => {
  const failed = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: null } as unknown as ModelForkResult
  const { clock, forks, logs, toasts } = world(on, [failed])
  await end($, [shell])
  await clock.advance(3 * HOUR)
  expect(forks.length).toBe(1)
  expect(logs).toEqual([])
  expect(toasts).toEqual([expect.stringContaining('the API call failed (529)')])
})

test('a /keepwarm window and background work share one timer', async ($, on) => {
  const { clock, forks, status } = world(on)
  await end($, [shell])
  await $.command.run(run('2h'))
  await clock.advance(PING_AFTER_MS)
  expect(forks.length).toBe(1)
  await clock.advance(PING_AFTER_MS)
  expect(forks.length).toBe(2)
  // The cap outlasts the window, so the row names background work as the reason.
  expect(status.at(-1)).toMatch(/^10h20m left \(auto bg\) · ping in 50m/)
  await end($, [])
  await clock.advance(10 * MIN)
  expect(status.at(-1)).toMatch(/^10m left \(\w+\) · ping in 40m/)
  await clock.advance(3 * HOUR)
  expect(forks.length).toBe(2)
})

test('a subagent turn or a turn without Stop does not change the background reason', async ($, on) => {
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

test('the countdown ticks between events and each refresh shows its cost, never in the transcript', async ($, on) => {
  const { clock, logs, status, toasts } = world(on)
  await end($, [shell])
  expect(status.at(-1)).toBe('12h00m left (auto bg) · ping in 50m')
  await clock.advance(10 * MIN)
  expect(status.at(-1)).toBe('11h50m left (auto bg) · ping in 40m')
  await clock.advance(40 * MIN)
  // Fable 5.1: 200k read at $0.25, 2 input at $10, 1 output at $50.
  expect(toasts).toEqual(['Cache refreshed: the ping read 200k tokens ($0.05).'])
  expect(status.at(-1)).toBe('11h10m left (auto bg) · ping in 50m · last ping read 200k $0.05')
  await end($, [])
  expect(status.at(-1)).toBeUndefined()
  await clock.advance(10 * MIN)
  expect(status.at(-1)).toBeUndefined()
  expect(logs).toEqual([])
})

test('on a surface with a row above the prompt, redraws it instead of the status line', async ($, on) => {
  const { clock, status, invalidations } = world(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await end($, [shell])
  const drawn = invalidations()
  expect(drawn).toBeGreaterThan(0)
  await clock.advance(5 * MIN)
  expect(invalidations()).toBeGreaterThanOrEqual(drawn + 5)
  expect(status.every(t => t === undefined)).toBe(true)
})

test('tells a warm ping from a cold one', () => {
  expect(isWarm({ cache_read_input_tokens: 200000, cache_creation_input_tokens: 30 })).toBe(true)
  expect(isWarm({ cache_read_input_tokens: 200000, cache_creation_input_tokens: 20000 })).toBe(false)
  expect(isWarm({ cache_read_input_tokens: 0, cache_creation_input_tokens: 30 })).toBe(false)
})

test('prices each model at its own list price', () => {
  expect(priceOf('claude-opus-5-5')).toEqual([0.2, 8, 20])
  expect(priceOf('claude-opus-5')).toEqual([0.5, 10, 25])
  expect(priceOf('claude-opus-4-8')).toEqual([0.5, 10, 25])
  expect(priceOf('claude-opus-4-1-20250805')).toEqual([1.5, 30, 75])
  expect(priceOf('claude-sonnet-5-5')).toEqual([0.1, 4, 10])
  expect(priceOf('claude-sonnet-5')).toEqual([0.2, 4, 10])
  expect(priceOf('claude-sonnet-4-6')).toEqual([0.3, 6, 15])
  expect(priceOf('claude-fable-5-1')).toEqual([0.25, 20, 50])
  expect(priceOf('claude-fable-5')).toEqual([1, 20, 50])
  expect(priceOf('claude-haiku-5-5', 100000)).toEqual([0.01, 0.2, 0.5])
  expect(priceOf('claude-haiku-5-5', 100001)).toEqual([0.05, 1, 2.5])
  expect(priceOf('claude-haiku-4-5')).toEqual([0.1, 2, 5])
  expect(priceOf('Opus 5.5')).toEqual([0.2, 8, 20])
  expect(priceOf('gpt-9')).toBeNull()
})
