// Stage 4: the paper pane, the context file, and the Claude turn that writes the paper.
import type { CommandRunInput, On } from 'claude-code'
import type { TestBody } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { gapsSection, paperRequest, parsePaperArgs, storyLine } from '../hooks/lib/paper'
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

  const prompt = paperRequest({ type: 'lab', lang: 'fr', focus: 'privesc', context: 'THE STORY' })
  expect(prompt).toContain('Write a Lab write-up in French')
  expect(prompt).toContain('Focus / audience: privesc')
  expect(prompt).toContain('<journal>\nTHE STORY\n</journal>')
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
  const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const papers: { model: string; system: string; prompt: string }[] = []
  const reply = { paper: '# Lab report\n\nThe user www-data logged in with [PASSWORD-1] and ran id. Hunter2Secret! leaked.' as string | null }
  on('prompt.submit', () => {
    throw new Error('the paper must not go through the chat')
  })
  on('model.complete', (_, e) => {
    const system = typeof e.system === 'string' ? e.system : ''
    if (system.includes('You write papers')) {
      papers.push({ model: e.model, system, prompt: e.prompt })
      return reply.paper === null
        ? { value: { isAnswered: false as const, reason: 'api-error' as const, status: 500, error: { type: 'api_error', message: 'x' } as never, usage } }
        : { value: { isAnswered: true as const, text: reply.paper, usage } }
    }
    return { value: { isAnswered: true as const, text: '{"suspects":[]}', usage } }
  })
  return { clock, papers, reply, host: fakeHost(on, ROOT) }
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

test('form -> confirm -> written in the background -> ready', async ($, on) => {
  const { clock, papers, host } = setup(on)
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

  await ui.press({ key: 'gen-keep' })
  expect((await ui.find({ type: 'Text', text: /Paper ready/ }))?.text).toBe('✓ Paper ready')
  const paperPath = `${DIR}/papers/2026-11-14-pentest-report.md`
  expect((await ui.find({ type: 'Text', text: /papers\// }))?.text).toBe(paperPath)

  // one background call with the whole context; nothing went through the chat
  expect(papers.length).toBe(1)
  const call = papers[0]
  expect(call?.model).toBe('opus')
  expect(call?.prompt).toContain('Write a Pentest report in English')
  expect(call?.prompt).toContain('Focus / audience: for my portfolio')
  expect(call?.prompt).toContain('sshpass -p [PASSWORD-1] ssh www-data@10.10.11.42 id')
  expect(call?.prompt).toContain('uid=33(www-data)')
  expect(call?.prompt).toContain('Gap 2 (UNEXPLAINED)')
  expect(call?.prompt).not.toContain('Hunter2Secret!')
  expect(call?.system).toContain('UNEXPLAINED')

  // the saved paper: the model's text, with anything secret-looking hidden again
  const paper = host.files.get(paperPath) ?? ''
  expect(paper).toContain('# Lab report')
  expect(paper).toContain('[PASSWORD-1]')
  expect(paper).not.toContain('Hunter2Secret!')

  expect(JSON.parse(host.files.get(`${DIR}/state.json`) ?? '{}').status).toBe('recording')
  const listed = JSON.parse(host.files.get(`${DIR}/state.json`) ?? '{}').papers as { path: string }[]
  expect(listed.map(p => p.path)).toEqual([paperPath])
  await ui.press({ key: 'done' })
  await ui.unmount()
})

test('generate and end session; a model failure is shown clearly', async ($, on) => {
  const { clock, reply, host } = setup(on)
  await journalWithWork($, host, clock)
  reply.paper = null
  await $.command.run(cmd('paper'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'generate' })
  await ui.press({ key: 'gen-end' })
  expect(JSON.parse(host.files.get(`${DIR}/state.json`) ?? '{}').status).toBe('ended')
  expect((await ui.find({ type: 'Text', text: /Could not write/ }))?.text).toContain('the model did not answer')
  await ui.press({ key: 'back-form' })
  expect(await ui.find({ type: 'Button', key: 'generate' })).toBeDefined()
  await ui.unmount()
})
