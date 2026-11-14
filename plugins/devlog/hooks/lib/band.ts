// What the band above the prompt shows, computed from the journal.
// The drawing itself is in register.tsx; this file only decides the numbers.
import type { BandView } from '../../types'
import { type Host, readRange, sizeOf } from './io'
import { MAX_OPEN } from './gaps'
import type { Journal } from './journal'
import { parseTerminal } from './terminal'

/** Terminal commands the zsh hook wrote that the 5-minute merge hasn't taken yet. */
export type Pending = {
  /** Size of terminal.jsonl when it was last read (-1: never read). */
  size: number
  /** termOffset it was read from. */
  from: number
  commands: number
  /** The newest pending command came without an output capture. */
  lastUncaptured: boolean | null
}

export const NO_PENDING: Pending = { size: -1, from: -1, commands: 0, lastUncaptured: null }

/**
 * Counts pending terminal commands, re-reading terminal.jsonl only when its
 * size or the merge offset changed (cheap enough to run every few seconds).
 */
export async function scanPending($: Host, j: Journal, before: Pending): Promise<Pending> {
  const path = `${j.dir}/terminal.jsonl`
  const size = await sizeOf($, path)
  const from = j.state.termOffset
  if (size === before.size && from === before.from) return before
  if (size <= from) return { size, from, commands: 0, lastUncaptured: null }
  const { lines } = parseTerminal(await readRange($, path, from, size - from))
  const last = lines[lines.length - 1]
  return { size, from, commands: lines.length, lastUncaptured: last ? last.tty === '' : null }
}

export const IDLE: BandView = {
  status: 'idle',
  activeMs: 0,
  resumedAt: null,
  events: 0,
  gapsOpen: 0,
  checkingStopped: false,
  uncaptured: false,
  confirmEnd: false,
  busy: null,
}

/** The band for this session: off in home or /, idle without an open journal. */
export function bandView(
  j: Journal | null,
  pending: Pending,
  root: string,
  home: string | undefined,
  previous: BandView | undefined,
): BandView {
  const keep = { confirmEnd: previous?.confirmEnd ?? false, busy: previous?.busy ?? null }
  if (!j || !j.isOpen()) {
    const off = root === home || root === '/' || root === ''
    return { ...IDLE, status: off ? 'off' : 'idle', busy: keep.busy }
  }
  const s = j.state
  const gapsOpen = s.gaps.filter(g => g.status !== 'explained').length
  return {
    status: s.status === 'recording' ? 'recording' : 'paused',
    activeMs: s.activeMs,
    resumedAt: s.resumedAt,
    events: s.events + pending.commands,
    gapsOpen,
    checkingStopped: gapsOpen >= MAX_OPEN,
    // The newest command decides; with none pending, the last merged ones do.
    uncaptured: s.status === 'recording' && (pending.lastUncaptured ?? s.uncaptured > 0),
    ...keep,
  }
}

/** Active time to show: banked time + the running stretch. */
export function activeNow(view: BandView, now: number): number {
  return view.activeMs + (view.resumedAt !== null ? Math.max(0, now - view.resumedAt) : 0)
}

export function sameView(a: BandView | undefined, b: BandView): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b)
}

/** "1 gap", "3 gaps". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
