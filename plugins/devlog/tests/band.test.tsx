// Stage 2: the band above the prompt, through the real hooks and a fake disk.
import type { CommandRunInput, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fakeHost, termLine } from './fake'

const ROOT = '/work/box'
const DIR = `${ROOT}/.devlog`
const HOME = '/Users/me'
const T0 = Date.UTC(2026, 10, 14, 10, 0, 0)

const BAND = {
  plugin: 'devlog',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const cmd = (args: string): CommandRunInput => ({
  command: 'journal',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
})

function setup(on: On, root = ROOT) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  mock.env(on, { HOME })
  on('session.root', () => ({ value: root }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'journal' } }))
  on('ui.toast', () => ({ value: undefined }))
  // stands for the engine's own band (a survey, or nothing)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return { clock, host: fakeHost(on, root) }
}

const textOf = async (ui: { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string } | undefined> }, re: RegExp) =>
  (await ui.find({ type: 'Text', text: re }))?.text

test('nothing is drawn in the home folder', async ($, on) => {
  setup(on, HOME)
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await textOf(ui, /engine/)).toBe('engine')
  expect(await textOf(ui, /Journal off/)).toBeUndefined()
  await ui.unmount()
})

test('idle -> recording -> paused -> end, from the band', async ($, on) => {
  const { clock, host } = setup(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const idle = await $.ui.mount({ ...BAND, surface })
    expect(await textOf(idle, /Journal off/)).toBe('Journal off')
    expect(await idle.find({ type: 'Button', key: 'start' })).toBeDefined()
    await idle.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'start' })
  expect(host.files.has(`${DIR}/state.json`)).toBe(true)
  expect(await textOf(ui, /Recording/)).toBe('Recording')
  expect(await textOf(ui, /^\d\d:\d\d:\d\d$/)).toBe('00:00:00')
  expect(await textOf(ui, /event/)).toBe('1 event')
  expect(await textOf(ui, /No gaps/)).toBe('✓ No gaps')

  // the timer runs while recording
  await clock.advance(65_000)
  expect(await textOf(ui, /^\d\d:\d\d:\d\d$/)).toBe('00:01:05')

  // paused: frozen timer, Resume instead of Pause
  await ui.press({ key: 'pause' })
  expect(await textOf(ui, /Paused/)).toBe('‖ Paused')
  expect(await ui.find({ type: 'Button', key: 'resume' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'pause' })).toBeUndefined()
  await clock.advance(120_000)
  expect(await textOf(ui, /^\d\d:\d\d:\d\d$/)).toBe('00:01:05')

  // resume: the timer goes on from where it stopped
  await ui.press({ key: 'resume' })
  await clock.advance(10_000)
  expect(await textOf(ui, /^\d\d:\d\d:\d\d$/)).toBe('00:01:15')

  // End asks first; Cancel goes back
  await ui.press({ key: 'end' })
  expect(await textOf(ui, /without a paper/)).toBe('End the session without a paper?')
  expect(await textOf(ui, /stays in \.devlog/)).toContain('generate a paper from it later')
  await ui.press({ key: 'end-cancel' })
  expect(await textOf(ui, /Recording/)).toBe('Recording')

  // End session: back to idle, journal kept on disk
  await ui.press({ key: 'end' })
  await ui.press({ key: 'end-confirm' })
  expect(await textOf(ui, /Journal off/)).toBe('Journal off')
  const state = JSON.parse(host.files.get(`${DIR}/state.json`) ?? '{}') as { status: string }
  expect(state.status).toBe('ended')
  await ui.unmount()
})

test('pending terminal commands count, and uncaptured ones show the devlog-tab hint', async ($, on) => {
  const { clock, host } = setup(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run(cmd('start'))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await textOf(ui, /devlog-tab/)).toBeUndefined()

  // two commands typed in a tab that devlog-tab isn't capturing
  const lines = [
    termLine({ t: T0 + 1000, cmd: 'ls', cwd: ROOT }),
    termLine({ t: T0 + 2000, cmd: 'whoami', cwd: ROOT }),
  ]
  host.files.set(`${DIR}/terminal.jsonl`, `${lines.join('\n')}\n`)
  await clock.advance(5_000)
  expect(await textOf(ui, /event/)).toBe('3 events')
  expect(await textOf(ui, /devlog-tab/)).toBe('Run devlog-tab to capture outputs')

  // a captured command makes the hint go away
  host.files.set(
    `${DIR}/terminal.jsonl`,
    `${[...lines, termLine({ t: T0 + 3000, cmd: 'id', cwd: ROOT, tty: 'tty-1.log', o0: 0, o1: 10 })].join('\n')}\n`,
  )
  await clock.advance(5_000)
  expect(await textOf(ui, /event/)).toBe('4 events')
  expect(await textOf(ui, /devlog-tab/)).toBeUndefined()

  // /journal from the prompt redraws the band too
  await $.command.run(cmd('pause'))
  expect(await textOf(ui, /Paused/)).toBe('‖ Paused')
  await ui.unmount()
})

test('the band yields to a survey', async ($, on) => {
  setup(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
  expect(await textOf(ui, /engine/)).toBe('engine')
  await ui.unmount()
})
