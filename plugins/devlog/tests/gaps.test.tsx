// Stage 3: Haiku finds steps that don't follow, Sonnet confirms them, checking
// stops at MAX_OPEN open gaps and resumes with the answers as context.
import type { CommandRunInput, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { MAX_OPEN, parseSuspects, sortJournalFiles, type Story, toSteps } from '../hooks/lib/gaps'
import { fakeHost, termLine } from './fake'

const ROOT = '/work/box'
const DIR = `${ROOT}/.devlog`
const T0 = Date.UTC(2026, 10, 14, 10, 0, 0)
const MIN = 60_000

// ── pure parts ───────────────────────────────────────────────────────────────

const story = (id: string, t: number, kind: string, extra: Partial<Story> = {}): Story => ({
  id,
  t,
  label: id,
  src: kind === 'command' ? 'terminal' : 'journal',
  kind,
  says: '',
  ...extra,
})

test('steps: uncaptured commands are left out, silences are hints, pauses reset them', () => {
  const steps = toSteps(
    [
      story('nmap', T0, 'command', { captured: true }),
      story('ls', T0 + MIN, 'command', { captured: false }),
      story('curl', T0 + 20 * MIN, 'command', { captured: true }),
      story('pause', T0 + 21 * MIN, 'pause'),
      story('resume', T0 + 90 * MIN, 'resume'),
      story('hydra', T0 + 91 * MIN, 'command', { captured: true }),
    ],
    null,
  )
  expect(steps.map(s => [s.id, Math.round(s.quietBefore / MIN)])).toEqual([
    ['nmap', 0],
    ['curl', 19], // measured from the uncaptured ls, which still counts as activity
    ['pause', 1],
    ['resume', 0], // the paused time is not a silence
    ['hydra', 1],
  ])
})

test('the fast model reply is read defensively', () => {
  expect(parseSuspects('Sure: {"suspects":[{"a":2,"b":3,"why":"Where does the user come from?"},{"a":3,"b":3},{"a":1,"b":9}]}', 3, 5)).toEqual([
    { a: 2, b: 3, why: 'Where does the user come from?' },
  ])
  expect(parseSuspects('nothing', 1, 3)).toEqual([])
  expect(sortJournalFiles(['2026-11-14.10.jsonl', 'terminal.jsonl', '2026-11-14.2.jsonl', '2026-11-13.jsonl', '2026-11-14.jsonl'])).toEqual([
    '2026-11-13.jsonl',
    '2026-11-14.jsonl',
    '2026-11-14.2.jsonl',
    '2026-11-14.10.jsonl',
  ])
})

// ── through the hooks ────────────────────────────────────────────────────────

const PANE = {
  plugin: 'devlog',
  component: 'Pane',
  requestId: 'devlog-gaps',
  props: { title: 'Gaps', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const cmd = (command: string, args = ''): CommandRunInput => ({
  command,
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 100 },
})

const usage = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

type Call = { model: string; system: string; prompt: string }

/** Model replies by role: the scan (Haiku), the confirmation (Sonnet), the answer check. */
function setup(on: On, replies: { scan?: string[]; confirm?: string[]; judge?: string[] } = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  mock.env(on, { HOME: '/Users/me' })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const calls: Call[] = []
  on('model.complete', (_, e) => {
    const system = typeof e.system === 'string' ? e.system : JSON.stringify(e.system ?? '')
    calls.push({ model: e.model, system, prompt: e.prompt })
    const queue = system.includes('NEW steps') ? replies.scan : system.includes('suspected gap') ? replies.confirm : replies.judge
    return { value: { isAnswered: true as const, text: queue?.shift() ?? '{}', usage } }
  })
  return { clock, calls, host: fakeHost(on, ROOT) }
}

/** Commands as zsh + devlog-tab would have written them (with captured outputs). */
function typed(host: ReturnType<typeof fakeHost>, cmds: { t: number; cmd: string; out?: string }[]) {
  let tty = host.files.get(`${DIR}/tty-1.log`) ?? ''
  let lines = host.files.get(`${DIR}/terminal.jsonl`) ?? ''
  for (const c of cmds) {
    if (c.out === undefined) {
      lines += termLine({ t: c.t, cmd: c.cmd, cwd: ROOT })
      continue
    }
    const o0 = tty.length
    tty += `${c.out}\r\n`
    lines += termLine({ t: c.t, cmd: c.cmd, cwd: ROOT, tty: 'tty-1.log', o0, o1: tty.length })
  }
  host.files.set(`${DIR}/tty-1.log`, tty)
  host.files.set(`${DIR}/terminal.jsonl`, lines)
}

type State = { gaps: { id: string; status: string; answers: string[]; questions: string[]; reason: string }[] }
const stateOf = (host: ReturnType<typeof fakeHost>) => JSON.parse(host.files.get(`${DIR}/state.json`) ?? '{}') as State

test('Haiku flags, Sonnet confirms, the gap is explained in the pane', async ($, on) => {
  const { clock, calls, host } = setup(on, {
    scan: ['{"suspects":[{"a":2,"b":3,"why":"svc_backup appears with nothing showing where it came from."}]}'],
    confirm: ['{"gap": true, "question": "How did you find the user svc_backup?"}'],
    judge: ['{"enough": false, "followUp": "Thanks. Where was that config file?"}', '{"enough": true}'],
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run(cmd('journal', 'start'))
  typed(host, [
    { t: T0 + MIN, cmd: 'nmap -sV 10.10.11.42', out: '22/tcp open ssh' },
    { t: T0 + 2 * MIN, cmd: 'whoami' }, // no capture: not sent to the models
    { t: T0 + 4 * MIN, cmd: 'hydra -l svc_backup 10.10.11.42 ssh', out: '[22][ssh] login: svc_backup' },
  ])
  await clock.advance(4.5 * MIN) // before the 5-minute tick: /gaps does the check
  expect((await $.command.run(cmd('gaps'))).text).toBe('devlog: 1 new gap found.')

  const [scan, confirm] = calls
  expect(scan?.model).toBe('haiku')
  expect(scan?.prompt).toContain('#1 [')
  expect(scan?.prompt).toContain('Journal started')
  expect(scan?.prompt).toContain('#2 [')
  expect(scan?.prompt).toContain('22/tcp open ssh')
  expect(scan?.prompt).toContain('#3 [')
  expect(scan?.prompt).not.toContain('whoami')
  expect(confirm?.model).toBe('sonnet')
  expect(confirm?.prompt).toContain('Suspected because: svc_backup appears')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /to explain/ }))?.text).toBe('1 of 1 gap to explain')
  expect((await ui.find({ type: 'Text', text: /nothing showing/ }))?.text).toContain('svc_backup appears')
  await ui.press({ key: 'g1' })
  expect((await ui.find({ type: 'Text', text: /^Why:/ }))?.text).toContain('svc_backup appears')
  expect((await ui.find({ type: 'Text', text: /svc_backup\?/ }))?.text).toBe('How did you find the user svc_backup?')

  await ui.input({ key: 'answer-0', text: 'ok' })
  expect((await ui.find({ type: 'Text', text: /short explanation/ }))?.text).toBe('Write a short explanation first.')

  await ui.input({ key: 'answer-0', text: 'I read an old config, password=Winter2026! was in it' })
  expect((await ui.find({ type: 'Text', text: /Where was/ }))?.text).toBe('Thanks. Where was that config file?')
  await ui.input({ key: 'answer-1', text: 'In /backup/config.old, found by gobuster in another tab' })
  expect((await ui.find({ type: 'Text', text: /closed/ }))?.text).toBe('✓ All good, this gap is closed')
  await ui.press({ key: 'perfect' })
  expect((await ui.find({ type: 'Text', text: /to explain/ }))?.text).toBe('0 of 1 gap to explain')
  await ui.unmount()

  const g = stateOf(host).gaps[0]
  expect(g?.status).toBe('explained')
  expect(g?.answers[0]).toBe('I read an old config, password=[PASSWORD-1] was in it')
  expect(calls.map(c => c.prompt).join('\n')).not.toContain('Winter2026!')
  expect(host.files.get(`${DIR}/state.json`)).not.toContain('Winter2026!')
})

test('Sonnet can drop a suspect; a check never re-reads what it checked', async ($, on) => {
  const { clock, calls, host } = setup(on, {
    scan: ['{"suspects":[{"a":1,"b":2,"why":"maybe"}]}', '{"suspects":[]}'],
    confirm: ['{"gap": false}'],
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run(cmd('journal', 'start'))
  typed(host, [{ t: T0 + MIN, cmd: 'ls -la', out: 'a.txt' }])
  await clock.advance(2 * MIN)
  expect((await $.command.run(cmd('gaps'))).text).toBe('devlog: no new gaps.')
  expect(calls.map(c => c.model)).toEqual(['haiku', 'sonnet'])

  // nothing new: no model call at all
  expect((await $.command.run(cmd('gaps'))).text).toBe('devlog: no new gaps.')
  expect(calls.length).toBe(2)

  // something new: only that is sent as NEW, the old steps as context
  typed(host, [{ t: T0 + 3 * MIN, cmd: 'cat a.txt', out: 'hello' }])
  await clock.advance(MIN)
  await $.command.run(cmd('gaps'))
  const second = calls[2]?.prompt ?? ''
  const [context, fresh] = second.split('NEW steps:')
  expect(context).toContain('ls -la')
  expect(fresh).toContain('cat a.txt')
  expect(fresh).not.toContain('ls -la')
})

test(`checking stops at ${MAX_OPEN} open gaps and resumes with the answers as context`, async ($, on) => {
  const { clock, calls, host } = setup(on, {
    scan: [
      '{"suspects":[{"a":2,"b":3,"why":"first"},{"a":3,"b":4,"why":"second"}]}',
      '{"suspects":[]}',
    ],
    confirm: ['{"gap": true, "question": "Q1?"}', '{"gap": true, "question": "Q2?"}'],
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run(cmd('journal', 'start'))

  // MAX_OPEN - 1 gaps already wait for an answer
  const st = stateOf(host) as State & Record<string, unknown>
  st.gaps = Array.from({ length: MAX_OPEN - 1 }, (_, i) => ({
    id: `g${i + 1}`,
    a: { id: 'x', t: T0, label: 'old a' },
    b: { id: `y${i}`, t: T0, label: 'old b' },
    reason: 'old',
    questions: ['old?'],
    answers: [],
    status: 'open',
    foundAt: T0,
  }))
  host.files.set(`${DIR}/state.json`, JSON.stringify(st))

  typed(host, [
    { t: T0 + MIN, cmd: 'nmap 10.0.0.5', out: '80/tcp open http' },
    { t: T0 + 2 * MIN, cmd: 'curl http://10.0.0.5:8080/', out: 'admin panel' },
    { t: T0 + 3 * MIN, cmd: 'ssh root@10.0.0.9', out: 'Welcome' },
  ])
  await clock.advance(4 * MIN)
  expect((await $.command.run(cmd('gaps'))).text).toBe(`devlog: 1 new gap found. Checking paused: ${MAX_OPEN} gaps wait for an answer.`)
  expect(calls.map(c => c.model)).toEqual(['haiku', 'sonnet']) // the second suspect waits

  // full: nothing is read, no model is called
  expect((await $.command.run(cmd('gaps'))).text).toContain('Checking paused')
  expect(calls.length).toBe(2)

  // the band says so
  const band = await $.ui.mount({
    plugin: 'devlog',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    surface: 'terminal',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect((await band.find({ type: 'Text', text: /checking paused/ }))?.text).toBe('checking paused')
  await band.unmount()

  // one answered: checking picks up right after the gap it stopped at, with the answer as context
  const after = stateOf(host) as State & Record<string, unknown>
  const first = after.gaps[0]
  if (first) {
    first.status = 'explained'
    first.answers = ['The port 8080 was in the Burp history']
  }
  host.files.set(`${DIR}/state.json`, JSON.stringify(after))
  await $.command.run(cmd('gaps'))
  const resumed = calls[2]?.prompt ?? ''
  expect(resumed).toContain('The port 8080 was in the Burp history')
  const fresh = resumed.split('NEW steps:')[1] ?? ''
  expect(fresh).toContain('ssh root@10.0.0.9')
  expect(fresh).not.toContain('curl http://10.0.0.5:8080/')
})

test('a backlog is read in chunks of 40, each step sent once', async ($, on) => {
  const { clock, calls, host } = setup(on, { scan: Array.from({ length: 20 }, () => '{"suspects":[]}') })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run(cmd('journal', 'start'))
  // the journal start + 90 commands = 91 events: chunks of 40, 40 and 11
  typed(
    host,
    Array.from({ length: 90 }, (_, i) => ({ t: T0 + 1000 * (i + 1), cmd: `echo step-${i}`, out: `out-${i} ${'x'.repeat(1500)}` })),
  )
  await clock.advance(2 * MIN)
  await $.command.run(cmd('gaps'))
  const scans = calls.filter(c => c.model === 'haiku')
  expect(scans.length).toBe(3)
  const fresh = scans.map(c => c.prompt.split('NEW steps:')[1] ?? '')
  for (let i = 0; i < 90; i++) {
    // every step was sent as NEW exactly once, never cut out of the middle of a prompt
    expect(fresh.filter(f => f.includes(`echo step-${i}\n`) || f.includes(`echo step-${i} `)).length).toBe(1)
  }
  expect(scans.every(c => c.prompt.length <= 120_000)).toBe(true)
})
