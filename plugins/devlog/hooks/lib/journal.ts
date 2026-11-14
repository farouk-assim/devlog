// The project journal: .devlog/state.json (status, timer, counters, offsets)
// and the daily event files .devlog/YYYY-MM-DD[.N].jsonl.
//
// `Journal` is plain data. Functions that touch the disk take the engine
// interface `$` as their first argument (the engine only lets `$` travel as
// an argument of plain functions, never stored in an object).
//
// Several Claude sessions can be open on one project, so every change goes
// through `locked()`: take the lock, re-read state.json, change, save.
import { appendText, type Host, readText, withLock, writeText, ymd } from './io'
import type { Gap } from '../../types'
import type { GapScan } from './gaps'
import { Redactor, type RedactState } from './redact'

export type Status = 'recording' | 'paused' | 'ended'

export type JournalEvent = {
  id?: string
  t: number
  src: 'journal' | 'terminal' | 'claude' | 'files'
  kind: string
  [field: string]: unknown
}

export type SnapshotState = {
  gitDir: string
  /** true: .devlog/snapshots.git (project is not a git repo). */
  isPrivate: boolean
  ref: string
  index: string
  last?: string
  tree?: string
  at?: number
}

export type JournalState = {
  v: 1
  id: string
  status: Status
  startedAt: number
  endedAt?: number
  /** Active time banked before the current recording stretch. */
  activeMs: number
  /** When the current recording stretch began; null while paused/ended. */
  resumedAt: number | null
  events: number
  seq: number
  termOffset: number
  terminalCommands: number
  /** Commands in a row that came without a tty capture (devlog-tab hint). */
  uncaptured: number
  file: string
  fileSize: number
  snapshot: SnapshotState | null
  redact: RedactState
  gaps: Gap[]
  /** Where gap detection stopped reading, and what it remembers of the story. */
  gapScan?: GapScan
  papers: unknown[]
}

/** Journal parts rotate before this size (spec: well under 4 MiB). */
export const ROTATE_BYTES = 3 * 1024 * 1024

export const DEVLOG = '.devlog'

export class Journal {
  constructor(
    readonly root: string,
    public state: JournalState,
    readonly redactor: Redactor,
  ) {}

  get dir(): string {
    return `${this.root}/${DEVLOG}`
  }

  get statePath(): string {
    return `${this.dir}/state.json`
  }

  get flagPath(): string {
    return `${this.dir}/recording`
  }

  isRecording(): boolean {
    return this.state.status === 'recording'
  }

  isOpen(): boolean {
    return this.state.status !== 'ended'
  }

  activeMs(now: number): number {
    const s = this.state
    return s.activeMs + (s.resumedAt !== null ? Math.max(0, now - s.resumedAt) : 0)
  }
}

/**
 * Nearest folder at or above `from` holding .devlog/state.json (the zsh hook
 * walks up the same way). Never the home folder or /: a journal there would
 * catch every command on the machine.
 */
export async function findJournal($: Host, from: string, home: string | undefined): Promise<string | null> {
  let dir = from.replace(/\/+$/, '') || '/'
  for (;;) {
    if (dir !== home && dir !== '/' && (await $.fs.exists(`${dir}/${DEVLOG}/state.json`))) return dir
    if (dir === '/' || dir === '') return null
    dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
  }
}

export async function openJournal($: Host, root: string): Promise<Journal | null> {
  const text = await readText($, `${root}/${DEVLOG}/state.json`)
  if (text === null) return null
  const state = JSON.parse(text) as JournalState
  return new Journal(root, state, await Redactor.create(await redactKey($, root), state.redact))
}

export function newState(now: number): JournalState {
  return {
    v: 1,
    id: journalId(now),
    status: 'recording',
    startedAt: now,
    activeMs: 0,
    resumedAt: now,
    events: 0,
    seq: 0,
    termOffset: 0,
    terminalCommands: 0,
    uncaptured: 0,
    file: `${ymd(now)}.jsonl`,
    fileSize: 0,
    snapshot: null,
    redact: { labels: {}, counters: {} },
    gaps: [],
    papers: [],
  }
}

export async function createJournal($: Host, root: string, now: number): Promise<Journal> {
  const state = newState(now)
  return new Journal(root, state, await Redactor.create(await redactKey($, root), state.redact))
}

export async function reloadJournal($: Host, j: Journal): Promise<void> {
  const text = await readText($, j.statePath)
  if (text === null) return
  j.state = JSON.parse(text) as JournalState
  j.redactor.state = j.state.redact
}

export async function saveJournal($: Host, j: Journal): Promise<void> {
  await writeText($, j.statePath, `${JSON.stringify(j.state, null, 1)}\n`)
}

/** Lock, re-read, run, save. */
export async function locked<T>($: Host, j: Journal, fn: () => Promise<T>): Promise<T> {
  return withLock($, j.dir, async () => {
    await reloadJournal($, j)
    const result = await fn()
    await saveJournal($, j)
    return result
  })
}

/**
 * Appends events (call inside `locked`). Gives each an id, picks the day's
 * file and moves to the next part before it would pass ROTATE_BYTES.
 */
export async function appendEvents($: Host, j: Journal, events: JournalEvent[]): Promise<void> {
  if (events.length === 0) return
  const s = j.state
  let chunk = ''
  for (const ev of events) {
    s.seq += 1
    ev.id = `e${s.seq}`
    const line = `${JSON.stringify(ev)}\n`
    const bytes = new TextEncoder().encode(line).length
    const day = ymd(ev.t)
    if (!s.file.startsWith(day) || (s.fileSize > 0 && s.fileSize + bytes > ROTATE_BYTES)) {
      await appendText($, `${j.dir}/${s.file}`, chunk)
      chunk = ''
      s.file = s.file.startsWith(day) ? nextPart(s.file) : `${day}.jsonl`
      s.fileSize = 0
    }
    chunk += line
    s.fileSize += bytes
    s.events += 1
  }
  await appendText($, `${j.dir}/${s.file}`, chunk)
}

/** 2026-11-14.jsonl -> 2026-11-14.2.jsonl -> 2026-11-14.3.jsonl */
export function nextPart(file: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/.exec(file)
  if (!m) return file
  const n = m[2] ? Number(m[2]) + 1 : 2
  return `${m[1]}.${n}.jsonl`
}

export function journalId(now: number): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** The HMAC key for redaction labels, per project, kept in $.store (not in the project). */
async function redactKey($: Host, root: string): Promise<string> {
  const name = `redact-key:${root}`
  const have = await $.store.get(name)
  if (typeof have === 'string' && have.length > 0) return have
  const key = Redactor.newKey()
  await $.store.set(name, key)
  return key
}
