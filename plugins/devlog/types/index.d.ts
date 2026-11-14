// devlog's $.state contract: what the band above the prompt draws from.

export type BandStatus = 'off' | 'idle' | 'recording' | 'paused'

export type BandView = {
  /** off: nothing drawn (home folder or /); idle: no open journal here. */
  status: BandStatus
  /** Active time banked before the current recording stretch (ms). */
  activeMs: number
  /** When the current recording stretch began (epoch ms); null while paused. */
  resumedAt: number | null
  /** Journal events, plus terminal commands waiting for the next merge. */
  events: number
  /** Gaps still to explain (stage 3 fills them). */
  gapsOpen: number
  /** So many gaps wait for an answer that checking has stopped. */
  checkingStopped: boolean
  /** The last commands came without an output capture: show the devlog-tab hint. */
  uncaptured: boolean
  /** The End confirmation is showing. */
  confirmEnd: boolean
  /** A press is being handled ("Starting…"): buttons are hidden meanwhile. */
  busy: string | null
}

/** One side of a gap: an event of the journal, as the gaps pane shows it. */
export type GapEvent = { id: string; t: number; label: string }

/** A hole in the story (stage 3), kept in state.json under `gaps`. */
export type Gap = {
  id: string
  a: GapEvent
  b: GapEvent
  /** What the cheap rule saw ("35 minutes with nothing recorded"). */
  reason: string
  /** questions[i] is answered by answers[i]; one more question while open. */
  questions: string[]
  answers: string[]
  status: 'open' | 'explained'
  foundAt: number
}

/** What the gaps pane shows. */
export type GapsPaneView = {
  view: 'list' | 'gap'
  gapId: string | null
  /** "Checking…" / "Looking for gaps…" while the model works. */
  busy: string | null
  err: string | null
}

/** What the paper pane shows (stage 4). */
export type PaperPaneView = {
  view: 'form' | 'confirm' | 'generating' | 'ready' | 'failed'
  type: 'pentest' | 'portfolio' | 'lab' | 'custom'
  lang: 'fr' | 'en'
  focus: string
  /** Where the paper is (being) written. */
  path: string | null
  err: string | null
}

declare module 'claude-code' {
  interface PluginState {
    devlog: {
      band: Shaped<BandView>
      now: number
      gaps: Shaped<Gap[]>
      gapsPane: Shaped<GapsPaneView>
      paperPane: Shaped<PaperPaneView>
    }
  }
}
