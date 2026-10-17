import { expect, mock, test, tier } from 'claude-code/testing'

import { RULE_END, RULE_OFF, RULE_START, WAIT_RULE, withWaitRule } from '../hooks/register'

tier('user')

const CODEGRAPH = '<!-- CODEGRAPH_START -->\n## CodeGraph\n\nUse it.\n<!-- CODEGRAPH_END -->\n'
const HAND_ADDED = '## Waiting in sub-agents (4-minute slices)\n\nAn older wording, added by hand.\n\n- wait in slices\n'

test('appends the rule to an empty or missing CLAUDE.md', () => {
  expect(withWaitRule('')).toBe(WAIT_RULE + '\n')
})

test('appends the rule after what is there', () => {
  expect(withWaitRule(CODEGRAPH)).toBe(CODEGRAPH.trimEnd() + '\n\n' + WAIT_RULE + '\n')
})

test('leaves a file that already has the current rule alone', () => {
  expect(withWaitRule(CODEGRAPH + '\n' + WAIT_RULE + '\n')).toBeNull()
})

test('replaces an older marked rule in place', () => {
  const old = `${RULE_START}\n## Waiting in sub-agents (4-minute slices)\n\nold\n${RULE_END}`
  expect(withWaitRule(`# Mine\n\n${old}\n\n## After\n`)).toBe(`# Mine\n\n${WAIT_RULE}\n\n## After\n`)
})

test('takes over the section added by hand, at the end or before another section', () => {
  expect(withWaitRule(CODEGRAPH + '\n' + HAND_ADDED)).toBe(CODEGRAPH + '\n' + WAIT_RULE + '\n')
  expect(withWaitRule(HAND_ADDED + '\n## Other\n\nkept\n')).toBe(WAIT_RULE + '\n\n## Other\n\nkept\n')
  expect(withWaitRule(HAND_ADDED + '\n' + CODEGRAPH)).toBe(WAIT_RULE + '\n\n' + CODEGRAPH)
})

test('the opt-out marker keeps the file as it is', () => {
  expect(withWaitRule(`${RULE_OFF}\n`)).toBeNull()
  expect(withWaitRule(`${RULE_OFF}\n${HAND_ADDED}`)).toBeNull()
})

test('session start writes the rule into CLAUDE.md under the config dir', async ($, on) => {
  const files: Record<string, string> = { '/cfg/CLAUDE.md': CODEGRAPH }
  on('env.get', ($, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/cfg' : undefined }))
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => ({ value: files[e.path] }))
  on('fs.write', ($, e) => { files[e.path] = e.text; return { value: undefined } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // The rest of session start: the window store, the session and the /hug-cache command.
  mock.store(on, {})
  on('session.id', () => ({ value: 'S1' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000, tokens: undefined }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  expect(files['/cfg/CLAUDE.md']).toBe(withWaitRule(CODEGRAPH))
  const written = files['/cfg/CLAUDE.md']
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  expect(files['/cfg/CLAUDE.md']).toBe(written)
})
