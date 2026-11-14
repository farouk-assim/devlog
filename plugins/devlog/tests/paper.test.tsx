// Stage 4: the paper pane, the context file, and the Claude turn that writes the paper.
import type { CommandRunInput, On } from 'claude-code'
import type { TestBody } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { gapsSection, paperPrompt, parsePaperArgs, storyLine } from '../hooks/lib/paper'
import { fakeHost, termLine } from './fake'

const ROOT = '/work/box'
const DIR = `${ROOT}/.devlog`
const T0 = Date.UTC(2026, 10, 14, 10, 0, 0)
const MIN = 60_000

test('/paper arguments, story lines, gaps and the prompt', () => {
  expect(parsePaperArgs('fr lab')).toEqual({ lang: 'fr', type: 'lab' })
  expect(parsePaperArgs('pentest EN')).toEqual({ lang: 'en', type: 'pentest' })
  expect(parsePaperArgs('')).toEqual({})

  expect(storyLine({ t: T0, src: 'terminal', kind: 'command', cmd: 'id', cwd: '/x', exit: 0, out: { text: 'uid=0(root)' }, ref: { tty: 't', o0: 0, o1: 1 } })).toContain(
    '$ id (in /x)\n    uid=0(root)',
  )
  expect(storyLine({ t: T0, src: 'terminal', kind: 'command', cmd: 'ls', cwd: '/x', exit: 2 })).toContain('(exit 2)\n    (output not captured)')

  const gaps = gapsSection([
    { id: 'g1', a: { id: 'e1', t: T0, label: 'nmap' }, b: { id: 'e2', t: T0, label: 'ssh' }, reason: 'why', questions: ['How?'], answers: ['Burp'], status: 'explained', foundAt: T0 },
    { id: 'g2', a: { id: 'e3', t: T0, label: 'ssh' }, b: { id: 'e4', t: T0, label: 'cat root.txt' }, reason: 'root?', questions: ['Root how?'], answers: [], status: 'open', foundAt: T0 },
  ])
  expect(gaps).toContain('Gap 1 (explained)')
  expect(gaps).toContain('A: Burp')
  expect(gaps).toContain('Gap 2 (UNEXPLAINED)')
  expect(gaps).toContain('A: (no answer)')

  const prompt = paperPrompt({ type: 'lab', lang: 'fr', focus: 'privesc', contextPath: '/c.md', paperPath: '/p.md' })
  expect(prompt).toContain('Write a Lab write-up in French')
  expect(prompt).toContain('Read /c.md completely')
  expect(prompt).toContain('Focus / audience: privesc')
  expect(prompt).toContain('UNEXPLAINED')
  expect(prompt).toContain('do not open .devlog/tty-*.log')
  expect(prompt).toContain('to /p.md')
})

const PANE = {
  plugin: 'devlog',
  component: 'Pane',
  requestId: 'devlog-paper',
  props: { title: 'Generate paper', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const cmd = (command: string, args = ''): CommandRunInput => ({
  command,
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 100 },
})

function setup(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  mock.env(on, { HOME: '/Users/me' })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const submitted: string[] = []
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('model.complete', () => ({
    value: { isAnswered: true as const, text: '{"suspects":[]}', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }))
  return { clock, submitted, host: fakeHost(on, ROOT) }
}

async function journalWithWork($: Parameters<TestBody>[0], host: ReturnType<typeof fakeHost>, clock: ReturnType<typeof mock.clock>) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run(cmd('journal', 'start'))
  const tty = 'uid=33(www-data)\r\n'
  host.files.set(`${DIR}/tty-1.log`, tty)
  host.files.set(
    `${DIR}/terminal.jsonl`,
    termLine({ t: T0 + MIN, cmd: 'sshpass -p Hunter2Secret! ssh www-data@10.10.11.42 id', cwd: ROOT, tty: 'tty-1.log', o0: 0, o1: tty.length }),
  )
  await clock.advance(2 * MIN)
  // one gap explained, one still open
  const st = JSON.parse(host.files.get(`${DIR}/state.json`) ?? '{}') as Record<string, unknown>
  st.gaps = [
    { id: 'g1', a: { id: 'e1', t: T0, label: 'nmap' }, b: { id: 'e2', t: T0 + MIN, label: 'ssh' }, reason: 'user?', questions: ['How did you get the user?'], answers: ['From the website footer'], status: 'explained', foundAt: T0 },
    { id: 'g2', a: { id: 'e2', t: T0 + MIN, label: 'ssh' }, b: { id: 'e3', t: T0 + MIN, label: 'root' }, reason: 'root?', questions: ['How did you get root?'], answers: [], status: 'open', foundAt: T0 },
  ]
  host.files.set(`${DIR}/state.json`, JSON.stringify(st))
}

test('form -> confirm -> a Claude turn writes the paper -> ready', async ($, on) => {
  const { clock, submitted, host } = setup(on)
  await journalWithWork($, host, clock)

  expect((await $.command.run(cmd('paper', 'en lab'))).text).toBe('Paper pane opened.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Select', key: 'type' }))?.props.value).toBe('lab')
  expect((await ui.find({ type: 'Select', key: 'lang' }))?.props.value).toBe('en')
  expect(await ui.find({ type: 'Button', key: 'explain-first' })).toBeDefined()
  await ui.select({ key: 'type', value: 'pentest' })
  await ui.input({ key: 'focus', text: 'for my portfolio', kind: 'change' })
  await ui.press({ key: 'generate' })
  expect((await ui.find({ type: 'Text', text: /What happens/ }))?.text).toBe('What happens to the session?')
  expect((await ui.find({ type: 'Text', text: /Pentest report in English/ }))?.text).toContain('of work')

  await ui.press({ key: 'gen-keep' })
  expect((await ui.find({ type: 'Text', text: /Writing your/ }))?.text).toBe('Writing your pentest report…')
  expect(submitted.length).toBe(1)
  const prompt = submitted[0] ?? ''
  expect(prompt).toContain('Write a Pentest report in English')
  expect(prompt).toContain('Focus / audience: for my portfolio')
  const contextPath = /Read (\S+) completely/.exec(prompt)?.[1] ?? ''
  const paperPath = /Write tool to (\S+),/.exec(prompt)?.[1] ?? ''
  expect(contextPath).toBe(`${DIR}/papers/.context-2026-11-14-pentest-report.md`)
  expect(paperPath).toBe(`${DIR}/papers/2026-11-14-pentest-report.md`)

  // the context: the story with outputs, the gaps, secrets as placeholders only
  const context = host.files.get(contextPath) ?? ''
  expect(context).toContain('sshpass -p [PASSWORD-1] ssh www-data@10.10.11.42 id')
  expect(context).toContain('uid=33(www-data)')
  expect(context).toContain('Gap 1 (explained)')
  expect(context).toContain('A: From the website footer')
  expect(context).toContain('Gap 2 (UNEXPLAINED)')
  expect(context).not.toContain('Hunter2Secret!')

  // the journal keeps recording
  expect(JSON.parse(host.files.get(`${DIR}/state.json`) ?? '{}').status).toBe('recording')

  // the turn runs, writes the paper, ends
  await $.turn.start({ text: prompt, turnId: 't1' })
  host.files.set(paperPath, '# Report\n')
  await $.turn.complete({ turnId: 't1', answer: 'Saved.', durationMs: 10, isAborted: false, reason: 'answer', category: null, explanation: null } as never)
  expect((await ui.find({ type: 'Text', text: /Paper ready/ }))?.text).toBe('✓ Paper ready')
  expect((await ui.find({ type: 'Text', text: /papers\// }))?.text).toBe(paperPath)
  await ui.press({ key: 'done' })
  await ui.unmount()

  const papers = JSON.parse(host.files.get(`${DIR}/state.json`) ?? '{}').papers as { path: string }[]
  expect(papers.map(p => p.path)).toEqual([paperPath])
})

test('generate and end session; a turn that saves nothing fails clearly', async ($, on) => {
  const { clock, submitted, host } = setup(on)
  await journalWithWork($, host, clock)
  await $.command.run(cmd('paper'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'generate' })
  await ui.press({ key: 'gen-end' })
  expect(JSON.parse(host.files.get(`${DIR}/state.json`) ?? '{}').status).toBe('ended')
  expect(submitted.length).toBe(1)

  await $.turn.start({ text: submitted[0] ?? '', turnId: 't2' })
  await $.turn.complete({ turnId: 't2', answer: 'Sorry', durationMs: 10, isAborted: false, reason: 'answer', category: null, explanation: null } as never)
  expect((await ui.find({ type: 'Text', text: /Could not write/ }))?.text).toContain('without saving the paper')
  await ui.press({ key: 'back-form' })
  expect(await ui.find({ type: 'Button', key: 'generate' })).toBeDefined()
  await ui.unmount()
})
