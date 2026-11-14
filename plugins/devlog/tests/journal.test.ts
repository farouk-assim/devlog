// The capture flow through the real hooks: /journal, session rows, terminal merge.
import type { CommandRunInput, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fakeHost, journalLines, termLine } from './fake'

const ROOT = '/work/box'
const DIR = `${ROOT}/.devlog`
const T0 = Date.UTC(2026, 10, 14, 10, 0, 0)

const cmd = (args: string): CommandRunInput => ({
  command: 'journal',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
})

function setup(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  mock.env(on, { HOME: '/Users/me' })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'journal' } }))
  return { clock, host: fakeHost(on, ROOT) }
}

test('start creates the journal, the flag and the .gitignore line', async ($, on) => {
  const { host } = setup(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const r = await $.command.run(cmd('start'))
  expect(r.text).toContain('journal started')
  expect(host.files.has(`${DIR}/recording`)).toBe(true)
  expect(host.files.get(`${ROOT}/.gitignore`)).toBe('.devlog/\n')
  const state = JSON.parse(host.files.get(`${DIR}/state.json`) ?? '{}') as { status: string }
  expect(state.status).toBe('recording')
  expect(journalLines(host, DIR).map(e => e.kind)).toEqual(['start'])

  // a second start is refused, home is refused
  expect((await $.command.run(cmd('start'))).text).toContain('already recording')
})

test('session rows are journaled, redacted, only while recording', async ($, on) => {
  const { clock, host } = setup(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run(cmd('start'))

  const prompt = (text: string, uuid: string) =>
    $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid,
    })
  await prompt('log in with password=Winter2026! please', 'u1')
  await clock.advance(2000)
  await $.command.run(cmd('pause'))
  await prompt('this one is not logged', 'u2')
  await clock.advance(2000)
  await $.command.run(cmd('status'))

  const rows = journalLines(host, DIR).filter(e => e.src === 'claude')
  expect(rows.length).toBe(1)
  const text = JSON.stringify(rows[0])
  expect(text).toContain('password=[PASSWORD-1]')
  expect(text).not.toContain('Winter2026!')
  expect(host.files.has(`${DIR}/recording`)).toBe(false)
})

test('terminal lines are merged with cleaned, redacted output excerpts', async ($, on) => {
  const { clock, host } = setup(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run(cmd('start'))

  // what devlog-tab + the zsh hook would have written
  const capture = 'cat creds.txt\r\n\x1b[32madmin:Passw0rd!xyz\x1b[0m\r\n'
  const o0 = 'cat creds.txt\r\n'.length
  host.files.set(`${DIR}/tty-1.log`, capture)
  host.files.set(
    `${DIR}/terminal.jsonl`,
    termLine({ t: T0 + 1000, cmd: 'cat creds.txt', cwd: ROOT, tty: 'tty-1.log', o0, o1: capture.length }) +
      termLine({ t: T0 + 2000, cmd: 'curl -u admin:Passw0rd!xyz http://10.0.0.5', cwd: ROOT, exit: 7 }),
  )
  await clock.advance(1000)
  const r = await $.command.run(cmd('pause')) // pause merges first
  expect(r.text).toContain('paused')

  const cmds = journalLines(host, DIR).filter(e => e.kind === 'command')
  expect(cmds.length).toBe(2)
  // creds.txt is read as a credentials list, and the curl in the same batch
  // teaches the same password: one placeholder for both
  expect(cmds[0]?.out).toEqual({ text: 'admin:[PASSWORD-1]', chars: 18, lines: 1 })
  expect(cmds[0]?.ref).toEqual({ tty: 'tty-1.log', o0, o1: capture.length })
  expect(cmds[1]?.cmd).toBe('curl -u admin:[PASSWORD-1] http://10.0.0.5')
  expect(JSON.stringify(journalLines(host, DIR))).not.toContain('Passw0rd')
  expect(cmds[1]?.exit).toBe(7)

  const status = await $.command.run(cmd('status'))
  expect(status.text).toContain('2 commands merged')
  expect(status.text).toContain('last 1 without output: run devlog-tab')
})

test('active time excludes pauses and survives a restart', async ($, on) => {
  const { clock, host } = setup(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run(cmd('start'))
  await clock.advance(60_000)
  await $.command.run(cmd('pause'))
  await clock.advance(10 * 60_000) // paused: not counted
  await $.command.run(cmd('resume'))
  await clock.advance(30_000)

  // a new session reads state.json
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const s = await $.command.run(cmd('status'))
  expect(s.text).toContain('recording · 00:01:30 active')

  const e = await $.command.run(cmd('end'))
  expect(e.text).toContain('ended after 00:01:30')
  expect(e.text).toContain('a paper can still be written later')
  expect(host.files.has(`${DIR}/recording`)).toBe(false)
  expect(journalLines(host, DIR).map(x => x.kind)).toEqual(['start', 'pause', 'resume', 'end'])
})
