// Journal lifecycle: start / pause / resume / end / status, and the 5-minute tick.
// Every step that changes the journal goes through locked().
import { hms, type Host, makeDir, readText, remove, sizeOf, withLock, writeText } from './io'
import {
  appendEvents,
  createJournal,
  type Journal,
  type JournalEvent,
  locked,
  openJournal,
  reloadJournal,
  saveJournal,
} from './journal'
import { type ScanResult, scanGaps } from './gaps'
import { takeSnapshot } from './snapshot'
import { mergeTerminal, type SplitJob, splitRemote } from './terminal'

export type Result = { text: string; journal: Journal | null }

/** Adds `.devlog/` to the project's .gitignore (creating it if needed). */
export async function ignoreDevlog($: Host, root: string): Promise<boolean> {
  const path = `${root}/.gitignore`
  const text = (await readText($, path)) ?? ''
  if (/^\/?\.devlog\/?\s*$/m.test(text)) return false
  const sep = text === '' || text.endsWith('\n') ? '' : '\n'
  await writeText($, path, `${text}${sep}.devlog/\n`)
  return true
}

export async function startJournal($: Host, root: string, current: Journal | null): Promise<Result> {
  const home = await $.env.get('HOME')
  if (root === home || root === '/') {
    return { text: 'devlog: refusing to journal your home folder or /. Open Claude Code in a project folder first.', journal: current }
  }
  if (current?.isOpen()) {
    const what = current.isRecording() ? 'already recording' : 'paused: use /journal resume'
    return { text: `devlog: a journal is ${what} (${current.root}).`, journal: current }
  }
  const now = await $.clock.now()
  const dir = `${root}/.devlog`
  await makeDir($, dir)
  const j = await createJournal($, root, now)
  // A journal that ended earlier keeps its files; the new one continues them
  // (and their placeholders) but has its own timer, counters and snapshot ref.
  const before = current?.root === root ? current : await openJournal($, root)
  if (before) {
    j.state.file = before.state.file
    j.state.fileSize = before.state.fileSize
    j.state.seq = before.state.seq
    j.state.termOffset = before.state.termOffset
    j.state.redact = before.state.redact
    // gap detection goes on from where it stopped (the old story isn't re-read)
    if (before.state.gapScan) j.state.gapScan = { ...before.state.gapScan, lastT: null }
    j.redactor.state = j.state.redact
  }
  const ignored = await ignoreDevlog($, root)
  await withLock($, dir, async () => {
    // Skip terminal lines written while no journal was recording.
    j.state.termOffset = Math.max(j.state.termOffset, Math.max(0, await sizeOf($, `${dir}/terminal.jsonl`)))
    await appendEvents($, j, [{ t: now, src: 'journal', kind: 'start', journal: j.state.id, root }])
    await saveJournal($, j)
  })
  await writeText($, j.flagPath, '')
  const snap = await snapshotSafely($, j)
  return {
    text: [
      `devlog: journal started in ${root}/.devlog`,
      ignored ? 'Added .devlog/ to .gitignore.' : '',
      snap,
      'Terminal: commands are logged by your zsh hook; run devlog-tab in a tab to capture outputs too.',
    ]
      .filter(Boolean)
      .join('\n'),
    journal: j,
  }
}

export async function pauseJournal($: Host, j: Journal | null): Promise<string> {
  if (!j?.isRecording()) return `devlog: ${j?.isOpen() ? 'already paused' : 'no journal is recording'}.`
  await tick($, j, { gaps: false }) // bank what happened up to now (gaps: next scan, pausing stays quick)
  const now = await $.clock.now()
  await locked($, j, async () => {
    const s = j.state
    s.activeMs = j.activeMs(now)
    s.resumedAt = null
    s.status = 'paused'
    await appendEvents($, j, [{ t: now, src: 'journal', kind: 'pause' }])
  })
  await remove($, j.flagPath)
  return `devlog: paused at ${hms(j.activeMs(now))}. Nothing is logged until /journal resume.`
}

export async function resumeJournal($: Host, j: Journal | null): Promise<string> {
  if (!j || j.state.status !== 'paused') {
    return `devlog: ${j?.isRecording() ? 'already recording' : 'nothing to resume, use /journal start'}.`
  }
  const now = await $.clock.now()
  await locked($, j, async () => {
    j.state.status = 'recording'
    j.state.resumedAt = now
    j.state.termOffset = Math.max(j.state.termOffset, Math.max(0, await sizeOf($, `${j.dir}/terminal.jsonl`)))
    await appendEvents($, j, [{ t: now, src: 'journal', kind: 'resume' }])
  })
  await writeText($, j.flagPath, '')
  return `devlog: recording again (${hms(j.activeMs(now))} so far).`
}

export async function endJournal($: Host, j: Journal | null): Promise<string> {
  if (!j?.isOpen()) return 'devlog: no journal to end.'
  if (j.isRecording()) await tick($, j)
  await remove($, j.flagPath)
  const now = await $.clock.now()
  await locked($, j, async () => {
    const s = j.state
    s.activeMs = j.activeMs(now)
    s.resumedAt = null
    s.status = 'ended'
    s.endedAt = now
    await appendEvents($, j, [{ t: now, src: 'journal', kind: 'end', activeMs: s.activeMs }])
  })
  return `devlog: session ended after ${hms(j.state.activeMs)} active, ${j.state.events} events. The journal stays in .devlog, so a paper can still be written later.`
}

export async function statusText($: Host, j: Journal | null): Promise<string> {
  if (!j) return 'devlog: no journal in this project. Start one with /journal start.'
  await reloadJournal($, j)
  const now = await $.clock.now()
  const s = j.state
  const lines = [
    `devlog · ${s.status} · ${hms(j.activeMs(now))} active · ${s.events} events`,
    `journal: ${j.dir}/${s.file}`,
    `terminal: ${s.terminalCommands} commands merged${s.uncaptured > 0 ? ` · last ${s.uncaptured} without output: run devlog-tab to capture outputs` : ''}`,
  ]
  if (s.snapshot?.last) {
    const ago = Math.round((now - (s.snapshot.at ?? now)) / 60000)
    lines.push(`snapshot: ${s.snapshot.ref} @ ${s.snapshot.last.slice(0, 8)} (${ago} min ago)${s.snapshot.isPrivate ? ', private repo in .devlog' : ''}`)
  }
  const secrets = Object.entries(s.redact.counters)
    .map(([k, n]) => `${n} ${k.toLowerCase()}`)
    .join(', ')
  if (secrets) lines.push(`redacted so far: ${secrets}`)
  return lines.join('\n')
}

/**
 * The 5-minute work: merge terminal lines, snapshot files, then split
 * interactive sessions with a fast model. Each part fails on its own.
 */
export async function tick($: Host, j: Journal, opts: { gaps?: boolean } = {}): Promise<string[]> {
  const problems: string[] = []
  let splits: SplitJob[] = []
  try {
    splits = await locked($, j, () => mergeTerminal($, j))
  } catch (err) {
    problems.push(`terminal merge: ${String(err)}`)
  }
  const snap = await snapshotSafely($, j)
  if (snap.startsWith('snapshot failed')) problems.push(snap)
  for (const job of splits) {
    try {
      const ev = await splitRemote($, job)
      if (!ev) continue
      ev.steps = await j.redactor.redactDeep(ev.steps)
      await locked($, j, () => appendEvents($, j, [ev]))
    } catch (err) {
      problems.push(`remote split: ${String(err)}`)
    }
  }
  // after the merge and splits, so the scan sees every command up to now
  if (opts.gaps !== false) try {
    await scanGaps($, j)
  } catch (err) {
    problems.push(`gap scan: ${String(err)}`)
  }
  return problems
}

/** /gaps: merge the terminal so the scan sees everything up to now, then scan. */
export async function scanNow($: Host, j: Journal): Promise<ScanResult> {
  try {
    await locked($, j, () => mergeTerminal($, j))
  } catch {
    // the merge is retried by the next tick; scan what is there
  }
  return scanGaps($, j)
}

/** Snapshot under its own lock (git can take seconds), then record it. */
async function snapshotSafely($: Host, j: Journal): Promise<string> {
  try {
    const now = await $.clock.now()
    const ev = await withLock(
      $,
      j.dir,
      async () => {
        await reloadJournal($, j)
        const made = await takeSnapshot($, j, now)
        const snap = j.state.snapshot
        await locked($, j, async () => {
          j.state.snapshot = snap
          if (made) await appendEvents($, j, [made])
        })
        return made
      },
      { name: 'snap-lock', waitMs: 2000 },
    )
    return ev ? `Snapshot ${String(ev.commit).slice(0, 8)} saved in ${String(ev.ref)} (${String(ev.changed)} files).` : ''
  } catch (err) {
    return `snapshot failed: ${String(err)}`
  }
}

export type { JournalEvent }
