// devlog: hooks module. Stage 1 = capture, stage 2 = the band above the prompt.
//
// What it hooks:
// - session.start: registers /journal, finds this project's journal, starts timers
// - session.append: every row the conversation keeps -> queued -> journal
// - command.run (journal): start | pause | resume | end | status
// - command.run (gaps): looks for new gaps, opens the gaps pane
// - ui.render (AbovePrompt): the band: idle / recording / paused / end confirmation
// - ui.render (Pane devlog-gaps): the gaps list, one gap's questions and answers
// - command.run (paper) + ui.render (Pane devlog-paper): the paper form; a background model call writes it
// - session.end: flushes queued rows
//
// The mod is installed at user scope, so it runs in every project; it only
// records where the project has a journal that is recording.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionAppendInput } from 'claude-code'

import type { BandView, Gap, GapsPaneView, PaperPaneView } from '../types'
import { activeNow, bandView, IDLE, NO_PENDING, type Pending, plural, sameView, scanPending } from './lib/band'
import { endJournal, pauseJournal, resumeJournal, scanNow, startJournal, statusText, tick } from './lib/control'
import { answerGap, clock, MAX_OPEN } from './lib/gaps'
import { hms } from './lib/io'
import { appendEvents, findJournal, type Journal, type JournalEvent, locked, openJournal, reloadJournal } from './lib/journal'
import { langLabel, PAPER_LANGS, PAPER_TYPES, paperName, parsePaperArgs, typeLabel, writeContext, writePaper } from './lib/paper'
import { type QueuedRow, rowBlocks, ToolContext } from './lib/rows'

const TICK_MS = 5 * 60_000
const REFRESH_MS = 30_000
const FLUSH_MS = 1500
/** How often the band re-counts pending terminal commands. */
const PENDING_MS = 5_000
/** The band's clock: every half second, so the recording dot pulses at that pace. */
const SECOND_MS = 500

// What the band draws from. In $.state (not module variables) so a reload
// keeps it and a write redraws exactly the band. Bump the shape tag when
// BandView's fields change.
const band = atom({ plugin: 'devlog', key: 'band' } as const, IDLE, { shape: 'band-2' })
const clockNow = atom({ plugin: 'devlog', key: 'now' } as const, 0)
const gapsAtom = atom({ plugin: 'devlog', key: 'gaps' } as const, [] as Gap[], { shape: 'gaps-1' })
const PANE_START: GapsPaneView = { view: 'list', gapId: null, busy: null, err: null }
const paneAtom = atom({ plugin: 'devlog', key: 'gapsPane' } as const, PANE_START, { shape: 'gaps-pane-1' })
const PANE = 'devlog-gaps'
const PAPER_START: PaperPaneView = { view: 'form', type: 'pentest', lang: 'fr', focus: '', path: null, err: null }
const paperAtom = atom({ plugin: 'devlog', key: 'paperPane' } as const, PAPER_START, { shape: 'paper-pane-1' })
const PAPER_PANE = 'devlog-paper'

/** What this module keeps between hooks. Reset on a reload; state.json is the truth. */
type Ctx = {
  journal: Journal | null
  queue: QueuedRow[]
  flushing: Promise<void>
  flushTimer: boolean
  tools: ToolContext
  pending: Pending
  /** A paper is being written in the background. */
  paper: boolean
}

async function locate($: EngineInterface, ctx: Ctx): Promise<void> {
  const root = await findJournal($, await $.session.root(), await $.env.get('HOME'))
  ctx.journal = root ? await openJournal($, root) : null
  ctx.pending = NO_PENDING
}

/** Recomputes the band from the journal; writes (and redraws) only on a change. */
async function publish($: EngineInterface, ctx: Ctx): Promise<void> {
  const j = ctx.journal
  try {
    ctx.pending = j ? await scanPending($, j, ctx.pending) : NO_PENDING
  } catch {
    // terminal.jsonl unreadable for a moment (rotation): keep the last count
  }
  const gaps = JSON.stringify(j?.state.gaps ?? [])
  if (JSON.stringify(await read($, gapsAtom)) !== gaps) await update($, gapsAtom, () => JSON.parse(gaps) as Gap[])
  const root = await $.session.root()
  const home = await $.env.get('HOME')
  const before = await read($, band)
  if (sameView(before, bandView(j, ctx.pending, root, home, before))) return
  await update($, band, old => bandView(j, ctx.pending, root, home, old))
}

async function setBand($: EngineInterface, patch: Partial<BandView>): Promise<void> {
  await update($, band, old => ({ ...(old ?? IDLE), ...patch }))
}

/** Moves the band's clock on, only while a journal records (the timer is frozen otherwise). */
async function secondTick($: EngineInterface, ctx: Ctx): Promise<void> {
  if (!ctx.journal?.isRecording()) return
  const now = await $.clock.now()
  await update($, clockNow, () => now)
}

/** Writes the queued session rows (redacted) to the journal. */
async function flush($: EngineInterface, ctx: Ctx): Promise<void> {
  const j = ctx.journal
  const rows = ctx.queue
  ctx.queue = []
  if (!j || rows.length === 0) return
  await locked($, j, async () => {
    const events: JournalEvent[] = []
    for (const row of rows) {
      events.push({
        t: row.t,
        src: 'claude',
        kind: row.door,
        type: row.type,
        ...(row.role ? { role: row.role } : {}),
        ...(row.name ? { name: row.name } : {}),
        ...(row.isMeta ? { isMeta: true } : {}),
        ...(row.agentId ? { agentId: row.agentId } : {}),
        origin: row.origin,
        uuid: row.uuid,
        blocks: await rowBlocks(row.content, j.redactor, ctx.tools),
      })
    }
    await appendEvents($, j, events)
  })
}

/** Batches rows: one write per 1.5 s instead of one per row. */
function scheduleFlush($: EngineInterface, ctx: Ctx): void {
  if (ctx.flushTimer) return
  ctx.flushTimer = true
  $.clock.after(FLUSH_MS, () => {
    ctx.flushTimer = false
    ctx.flushing = ctx.flushing
      .then(() => flush($, ctx))
      .then(() => publish($, ctx))
      .catch(err => {
        $.ui.log(`devlog: could not write session rows: ${String(err)}`)
      })
  })
}

async function queueRow(
  $: EngineInterface,
  ctx: Ctx,
  e: SessionAppendInput,
  stored: { message?: SessionAppendInput['message']; uuid?: string },
): Promise<void> {
  if (!ctx.journal?.isRecording() || e.door === 'queue' || !stored.message) return
  const o = e.origin as { kind?: string; model?: string; tool?: string; name?: string }
  const m = stored.message
  ctx.queue.push({
    t: await $.clock.now(),
    door: e.door,
    origin: [o.kind, o.model ?? o.tool ?? o.name].filter(Boolean).join(':'),
    uuid: stored.uuid ?? e.uuid,
    ...(e.agentId ? { agentId: e.agentId } : {}),
    type: m.type,
    ...(m.role ? { role: m.role } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.isMeta ? { isMeta: true } : {}),
    content: m.content,
  })
  scheduleFlush($, ctx)
}

function startTimers($: EngineInterface, ctx: Ctx): void {
  // Every 5 minutes: merge terminal lines + snapshot files (only while recording).
  $.clock.every(TICK_MS, () => {
    const j = ctx.journal
    if (!j?.isRecording()) return
    void tick($, j)
      .then(problems => {
        for (const p of problems) $.ui.log(`devlog: ${p}`)
        return publish($, ctx)
      })
      .catch(() => undefined)
  })
  // Every 30 s: notice a journal started, paused or ended in another session.
  $.clock.every(REFRESH_MS, () => {
    void (ctx.journal ? reloadJournal($, ctx.journal) : locate($, ctx))
      .then(() => publish($, ctx))
      .catch(() => undefined)
  })
  // Every 5 s: count terminal commands waiting for the merge (band counter, devlog-tab hint).
  $.clock.every(PENDING_MS, () => {
    if (ctx.journal?.isRecording()) void publish($, ctx).catch(() => undefined)
  })
  $.clock.every(SECOND_MS, () => {
    void secondTick($, ctx).catch(() => undefined)
  })
}

async function runJournal($: EngineInterface, ctx: Ctx, args: string): Promise<string> {
  const [sub = 'status'] = args.trim().split(/\s+/)
  try {
    if (!ctx.journal) await locate($, ctx)
    await ctx.flushing // let a row write in flight finish first
    switch (sub) {
      case 'start': {
        const r = await startJournal($, await $.session.root(), ctx.journal)
        ctx.journal = r.journal
        ctx.pending = NO_PENDING
        return r.text
      }
      case 'pause':
        await flush($, ctx)
        return pauseJournal($, ctx.journal)
      case 'resume':
        return resumeJournal($, ctx.journal)
      case 'end':
        await flush($, ctx)
        return endJournal($, ctx.journal)
      case 'status':
        await flush($, ctx)
        return statusText($, ctx.journal)
      default:
        return 'Usage: /journal start | pause | resume | end | status'
    }
  } catch (err) {
    return `devlog: ${sub} failed: ${String(err)}`
  }
}

/** The band's buttons, by key. */
type Action = 'start' | 'pause' | 'resume' | 'end' | 'end-cancel' | 'end-confirm' | 'gaps' | 'paper'

const BUSY: Record<string, string> = {
  start: 'Starting…',
  pause: 'Pausing…',
  resume: 'Resuming…',
  end: 'Ending…',
}

async function setPane($: EngineInterface, patch: Partial<GapsPaneView>): Promise<void> {
  await update($, paneAtom, old => ({ ...(old ?? PANE_START), ...patch }))
}

/** Opens the gaps pane on its list; with `scan`, looks for new gaps first (/gaps). */
async function openGaps($: EngineInterface, ctx: Ctx, scan: boolean): Promise<string> {
  if (!ctx.journal) await locate($, ctx)
  const j = ctx.journal
  if (!j) return 'devlog: no journal in this project. Start one with /journal start.'
  await setPane($, { view: 'list', gapId: null, err: null, busy: scan ? 'Looking for new gaps…' : null })
  await publish($, ctx)
  await $.ui.open({ id: PANE, title: 'Gaps', focus: true })
  if (!scan) return 'Gaps pane opened.'
  try {
    const r = await scanNow($, j)
    const found = r.added > 0 ? `devlog: ${plural(r.added, 'new gap')} found.` : 'devlog: no new gaps.'
    return r.stopped ? `${found} Checking paused: ${MAX_OPEN} gaps wait for an answer.` : found
  } catch (err) {
    return `devlog: gap scan failed: ${String(err)}`
  } finally {
    await setPane($, { busy: null })
    await publish($, ctx)
  }
}

/** The person sent an explanation for a gap. */
async function sendAnswer($: EngineInterface, ctx: Ctx, gapId: string, text: string): Promise<void> {
  const j = ctx.journal
  if (!j || (await read($, paneAtom)).busy) return
  if (text.trim().length < 3) {
    await setPane($, { err: 'Write a short explanation first.' })
    return
  }
  await setPane($, { busy: 'Checking…', err: null })
  try {
    const r = await answerGap($, j, gapId, text)
    if (r.status === 'missing') await setPane($, { view: 'list', gapId: null })
  } catch (err) {
    await setPane($, { err: `Could not check the answer: ${String(err)}` })
  } finally {
    await setPane($, { busy: null })
    await publish($, ctx)
  }
}

async function setPaper($: EngineInterface, patch: Partial<PaperPaneView>): Promise<void> {
  await update($, paperAtom, old => ({ ...(old ?? PAPER_START), ...patch }))
}

/** Opens the paper pane on its form (`/paper fr lab` preselects). */
async function openPaper($: EngineInterface, ctx: Ctx, args: string): Promise<string> {
  if (!ctx.journal) await locate($, ctx)
  if (!ctx.journal) return 'devlog: no journal in this project. Start one with /journal start.'
  await reloadJournal($, ctx.journal) // fresh gap and event counts for the form
  await publish($, ctx)
  const p = await read($, paperAtom)
  if (p.view !== 'generating') await setPaper($, { view: 'form', err: null, ...parsePaperArgs(args) })
  await $.ui.open({ id: PAPER_PANE, title: 'Generate paper', focus: true })
  return 'Paper pane opened.'
}

/**
 * Gathers the context file, then hands the writing to a normal Claude turn.
 * With `endAfter`, the journal ends first; otherwise it keeps recording (the
 * paper turn itself is left out of the journal).
 */
async function generate($: EngineInterface, ctx: Ctx, endAfter: boolean): Promise<void> {
  const p = await read($, paperAtom)
  if (p.view === 'generating' || ctx.paper) return
  if (!ctx.journal) await locate($, ctx)
  const j = ctx.journal
  if (!j) {
    await setPaper($, { view: 'failed', err: 'No journal in this project.' })
    return
  }
  await setPaper($, { view: 'generating', err: null, path: null })
  ctx.paper = true
  try {
    await ctx.flushing
    await flush($, ctx)
    if (endAfter && j.isOpen()) await runJournal($, ctx, 'end')
    else if (j.isRecording()) await tick($, j, { gaps: false }) // the latest commands and files
    const now = await $.clock.now()
    const name = await paperName($, j, p.type, now)
    const contextPath = await writeContext($, j, now, name)
    const path = `${j.dir}/papers/${name}.md`
    await setPaper($, { path })
    await writePaper($, j, { type: p.type, lang: p.lang, focus: p.focus, contextPath, paperPath: path })
    await locked($, j, async () => {
      j.state.papers.push({ path, type: p.type, lang: p.lang, at: now })
    }).catch(() => undefined)
    await setPaper($, { view: 'ready', path })
    $.ui.toast(`devlog: paper ready, ${path.slice(j.root.length + 1)}`)
  } catch (err) {
    await setPaper($, { view: 'failed', err: String(err).replace(/^Error: /, '') })
  } finally {
    ctx.paper = false
    await publish($, ctx)
  }
}

/** A band button was pressed: same work as the /journal command, then a toast. */
async function press($: EngineInterface, ctx: Ctx, action: Action): Promise<void> {
  if ((await read($, band)).busy) return // one press at a time
  try {
    switch (action) {
      case 'end':
        await setBand($, { confirmEnd: true })
        return
      case 'end-cancel':
        await setBand($, { confirmEnd: false })
        return
      case 'gaps':
        await openGaps($, ctx, false)
        return
      case 'paper':
        await openPaper($, ctx, '')
        return
      default: {
        const sub = action === 'end-confirm' ? 'end' : action
        await setBand($, { confirmEnd: false, busy: BUSY[sub] ?? null })
        const text = await runJournal($, ctx, sub)
        $.ui.toast(text.split('\n')[0] ?? text)
      }
    }
  } finally {
    await setBand($, { busy: null })
    await publish($, ctx)
  }
}

export const register: Register = on => {
  const ctx: Ctx = {
    journal: null,
    queue: [],
    flushing: Promise.resolve(),
    flushTimer: false,
    tools: new ToolContext(),
    pending: NO_PENDING,
    paper: false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'journal',
      description: 'devlog: start, pause, resume or end the project journal, or show its status',
      argumentHint: 'start | pause | resume | end | status',
    })
    await $.command.register({
      name: 'gaps',
      description: 'devlog: look for gaps in the journal and explain them',
    })
    await $.command.register({
      name: 'paper',
      description: 'devlog: write a paper (pentest report, portfolio, lab write-up) from the journal',
      argumentHint: '[fr|en] [pentest|portfolio|lab|custom]',
    })
    await locate($, ctx)
    await setBand($, { busy: null, confirmEnd: false }) // a reload mid-press must not leave the band stuck
    await publish($, ctx)
    startTimers($, ctx)
    return next(e)
  })

  // Logging must never get in the way of the conversation: the row is stored
  // first, queueing can't throw, and if anything still fails the row goes on.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    try {
      await queueRow($, ctx, e, stored)
    } catch {
      // a row we could not queue is lost from the journal, not from the session
    }
    return stored
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'journal' }, async ($, e) => {
    const text = await runJournal($, ctx, e.args)
    await publish($, ctx)
    return { text }
  })

  on('command.run', { command: 'gaps' }, async $ => ({ text: await openGaps($, ctx, true) }))

  on('command.run', { command: 'paper' }, async ($, e) => ({ text: await openPaper($, ctx, e.args) }))

  // The paper pane (spec: "Generate pane").
  on('ui.render', { component: 'Pane', requestId: PAPER_PANE }, async ($, e) => {
    const { Box, Button, Input, Select, Text } = $.ui.resolve(e)
    const p = await read($, paperAtom)
    const kind = typeLabel(p.type)

    if (p.view === 'generating') {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text>Writing your {kind.toLowerCase()}…</Text>
          <Text dimColor>Written in the background (a few minutes): you can close this pane and keep working.</Text>
        </Box>
      )
    }
    if (p.view === 'ready') {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text color="success" bold>
            ✓ Paper ready
          </Text>
          <Text dimColor>{p.path ?? ''}</Text>
          <Box flexDirection="row" columnGap={1}>
            <Button key="open" label="Open" onPress={() => $.process.run(['/usr/bin/open', p.path ?? ''])} />
            <Button
              key="done"
              variant="primary"
              label="Done"
              onPress={async () => {
                await setPaper($, { view: 'form', path: null })
                await $.ui.close({ id: PAPER_PANE })
              }}
            />
          </Box>
        </Box>
      )
    }
    if (p.view === 'failed') {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text color="error">Could not write the paper: {p.err ?? ''}</Text>
          <Box flexDirection="row">
            <Button key="back-form" label="← Back" onPress={() => setPaper($, { view: 'form', err: null })} />
          </Box>
        </Box>
      )
    }
    if (p.view === 'confirm') {
      const v = await read($, band)
      const worked = hms(activeNow(v, Math.max(await read($, clockNow), v.resumedAt ?? 0)))
      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="column">
            <Text bold>What happens to the session?</Text>
            <Text dimColor>
              {kind} in {langLabel(p.lang)}, from {plural(v.events, 'event')} and {worked} of work.
            </Text>
          </Box>
          <Box flexDirection="column">
            <Button key="gen-end" label="Generate and end session" onPress={() => void generate($, ctx, true)} />
            <Text dimColor>   The journal closes. The next start is a new session.</Text>
          </Box>
          <Box flexDirection="column">
            <Button key="gen-keep" variant="primary" label="Generate and keep journaling" onPress={() => void generate($, ctx, false)} />
            <Text dimColor>   You can generate an updated paper later.</Text>
          </Box>
          <Box flexDirection="row">
            <Button key="back-form" label="← Back" onPress={() => setPaper($, { view: 'form' })} />
          </Box>
        </Box>
      )
    }

    const open = (await read($, gapsAtom)).filter(g => g.status !== 'explained').length
    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Select
            key="type"
            label="Type"
            value={p.type}
            options={PAPER_TYPES.map(t => ({ value: t.value, label: t.label }))}
            onSelect={value => setPaper($, { type: value as PaperPaneView['type'] })}
          />
          <Select
            key="lang"
            label="Language"
            value={p.lang}
            options={PAPER_LANGS.map(l => ({ value: l.value, label: l.label }))}
            onSelect={value => setPaper($, { lang: value as PaperPaneView['lang'] })}
          />
        </Box>
        <Text>What should it focus on?</Text>
        <Input
          key="focus"
          placeholder="HackTheBox lab, for my portfolio, focus on privilege escalation"
          value={p.focus}
          submitLabel="next"
          onInput={value => setPaper($, { focus: value })}
          onSubmit={value => setPaper($, { focus: value, view: 'confirm' })}
        />
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
          {open > 0 ? (
            <Button key="explain-first" label={`${plural(open, 'gap')} unexplained · Explain first`} onPress={() => openGaps($, ctx, false)} />
          ) : (
            <Text color="success">✓ All gaps explained</Text>
          )}
          <Box flexDirection="row" columnGap={1}>
            <Button key="cancel" label="Cancel" onPress={() => $.ui.close({ id: PAPER_PANE })} />
            <Button key="generate" variant="primary" label="Generate" onPress={() => setPaper($, { view: 'confirm' })} />
          </Box>
        </Box>
      </Box>
    )
  })

  // The gaps pane: the list, then one gap at a time (spec: "Gaps pane").
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const gaps = [...(await read($, gapsAtom))].sort((x, y) => x.a.t - y.a.t)
    const p = await read($, paneAtom)
    const toList = () => setPane($, { view: 'list', gapId: null, err: null })
    const gap = p.view === 'gap' ? gaps.find(g => g.id === p.gapId) : undefined

    if (gap && gap.status === 'explained') {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text color="success" bold>
            ✓ All good, this gap is closed
          </Text>
          <Text dimColor>Your explanation will go into the paper.</Text>
          <Box flexDirection="row">
            <Button key="perfect" variant="primary" label="Perfect" onPress={toList} />
          </Box>
        </Box>
      )
    }

    if (gap) {
      const n = gaps.indexOf(gap) + 1
      const asked = gap.questions[gap.answers.length] ?? gap.questions[gap.questions.length - 1] ?? ''
      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
            <Text bold>
              Gap {n} · {clock(gap.a.t)} → {clock(gap.b.t)}
            </Text>
            <Button key="to-list" label="← Gaps" onPress={toList} />
          </Box>
          <Text dimColor>Why: {gap.reason}</Text>
          <Box flexDirection="column">
            <Text>
              {clock(gap.a.t)}  {gap.a.label}
            </Text>
            <Text dimColor>   ↓ ?</Text>
            <Text>
              {clock(gap.b.t)}  {gap.b.label}
            </Text>
          </Box>
          {gap.answers.map((a, i) => (
            <Box flexDirection="column">
              <Text dimColor>{gap.questions[i] ?? ''}</Text>
              <Text>› {a}</Text>
            </Box>
          ))}
          <Box flexDirection="column">
            {gap.answers.length > 0 ? <Text color="warning">Follow-up</Text> : null}
            <Text bold>{asked}</Text>
          </Box>
          {p.busy ? (
            <Text dimColor>{p.busy}</Text>
          ) : (
            <Input
              key={`answer-${gap.answers.length}`}
              placeholder="What did you do between these two steps?"
              submitLabel="send"
              rows={2}
              autoFocus
              onSubmit={value => sendAnswer($, ctx, gap.id, value)}
            />
          )}
          {p.err ? <Text color="error">{p.err}</Text> : null}
        </Box>
      )
    }

    const open = gaps.filter(g => g.status !== 'explained').length
    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Text bold>
            {open} of {plural(gaps.length, 'gap')} to explain
          </Text>
          <Button key="back" label="Back" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
        {p.busy ? <Text dimColor>{p.busy}</Text> : null}
        {open >= MAX_OPEN ? (
          <Text color="warning">Checking paused: explain some gaps and it picks up where it stopped.</Text>
        ) : null}
        {gaps.length === 0 && !p.busy ? (
          <Text dimColor>No gaps found yet. The journal is checked every 5 minutes, or run /gaps.</Text>
        ) : null}
        <Box flexDirection="column">
          {gaps.map(g => (
            <Box flexDirection="column">
              <Button key={g.id} plain onPress={() => setPane($, { view: 'gap', gapId: g.id, err: null })}>
                {clock(g.a.t)} {g.a.label} → {clock(g.b.t)} {g.b.label}{' '}
                <Text color={g.status === 'explained' ? 'success' : 'warning'}>
                  {g.status === 'explained' ? '✓ Explained' : '? To explain'}
                </Text>
              </Button>
              <Text dimColor>   {g.reason}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })

  // The band above the prompt (spec: idle / recording / paused / end).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const v = await read($, band)
    if (v.status === 'off') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    // Keep other mods' bands above this one, and draw this band as a rounded grey card.
    const rest = await next(e)
    const wrap = (inner: unknown) => (
      <Box flexDirection="column">
        {rest as never}
        <Box key="band-card" flexDirection="column" backgroundColor="#2f2f2f" borderStyle="round" borderColor="#2f2f2f" paddingX={1} marginTop={rest && (rest as { type?: string }).type !== "engine" ? 1 : 0}>
          {inner as never}
        </Box>
      </Box>
    )

    if (v.status === 'idle') {
      return wrap(
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
          <Text dimColor>Journal off</Text>
          {v.busy ? (
            <Text dimColor>{v.busy}</Text>
          ) : (
            <Button key="start" variant="primary" label="Start journaling" onPress={() => press($, ctx, 'start')} />
          )}
        </Box>
      )
    }

    if (v.confirmEnd) {
      return wrap(
        <Box flexDirection="column">
          <Text bold>End the session without a paper?</Text>
          <Text dimColor>The journal stays in .devlog, so you can still generate a paper from it later.</Text>
          <Box flexDirection="row" justifyContent="flex-end" columnGap={1} marginTop={1}>
            <Button key="end-cancel" label="Cancel" onPress={() => press($, ctx, 'end-cancel')} />
            <Button key="end-confirm" label="End session" onPress={() => press($, ctx, 'end-confirm')} />
          </Box>
        </Box>
      )
    }

    const isRecording = v.status === 'recording'
    const now = isRecording ? Math.max(await read($, clockNow), v.resumedAt ?? 0) : 0
    return wrap(
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {isRecording ? (
              // The dot pulses: dim every other half second (the band's clock ticks every 500 ms).
              <Box flexDirection="row" columnGap={1}>
                <Text color="error" dimColor={Math.floor(now / 500) % 2 === 1}>●</Text>
                <Text color="error">Recording</Text>
              </Box>
            ) : (
              <Text color="warning">‖ Paused</Text>
            )}
            <Text tabular>{hms(activeNow(v, now))}</Text>
            <Text dimColor>{plural(v.events, 'event')}</Text>
            {v.gapsOpen > 0 ? (
              <Button key="gaps" label={`${plural(v.gapsOpen, 'gap')} · Explain`} onPress={() => press($, ctx, 'gaps')} />
            ) : (
              <Text color="success">✓ No gaps</Text>
            )}
            {v.checkingStopped ? <Text dimColor>checking paused</Text> : null}
          </Box>
          {/* Buttons on the right */}
          {v.busy ? (
            <Text dimColor>{v.busy}</Text>
          ) : (
            <Box flexDirection="row" columnGap={1}>
              {isRecording ? (
                <Button key="pause" label="Pause" onPress={() => press($, ctx, 'pause')} />
              ) : (
                <Button key="resume" label="Resume" onPress={() => press($, ctx, 'resume')} />
              )}
              <Button key="paper" label="Generate paper" onPress={() => press($, ctx, 'paper')} />
              <Button key="end" label="End" onPress={() => press($, ctx, 'end')} />
            </Box>
          )}
        </Box>
        {v.uncaptured ? <Text dimColor>Run devlog-tab to capture outputs</Text> : null}
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    try {
      await ctx.flushing
      await flush($, ctx)
    } catch (err) {
      $.ui.log(`devlog: could not write the last session rows: ${String(err)}`)
    }
    return next(e)
  })
}
