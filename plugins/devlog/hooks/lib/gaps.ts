// Stage 3: holes in the story.
//
// Every check (5-minute tick, /gaps) reads the journal events written since
// the last one and asks, for each step A -> B: does B follow from A, with a
// clear thread, or does something the journal doesn't show sit between them?
//
// 1. Haiku reads the new steps in order (commands captured by devlog-tab with
//    their outputs, file and folder changes, Claude's actions and your prompts,
//    the silences between them), with what came just before and your answers
//    to earlier gaps, and lists the suspect steps.
// 2. Sonnet takes each suspect with more context and the same answers, and
//    confirms it with a question, or drops it.
// 3. While MAX_OPEN gaps wait for an answer, checking stops (nothing is read,
//    no model is called); it resumes where it stopped once some are explained,
//    with those answers as context.
// 4. When you answer, a model decides: enough (closed) or a follow-up.
//
// Silences and rules are hints in what the models read, never a gap by
// themselves. Everything read here comes from the journal, already redacted;
// answers are redacted before they are stored or sent to a model.
import type { Gap, GapEvent } from '../../types'
import { type Host, pad2, readRange, sizeOf, trimMiddle, withLock } from './io'
import { type Journal, type JournalEvent, locked, reloadJournal } from './journal'

/** An event as gap detection sees it: a short label and the text it can mention. */
export type Story = GapEvent & {
  src: string
  kind: string
  cwd?: string
  tool?: string
  /** Output excerpt (commands, Claude tool results). */
  out?: string
  /** Changed files (snapshots) or the file a Claude edit touched. */
  paths?: string[]
  /** Command, prompt or tool input: what it says. */
  says: string
  /** Terminal commands: devlog-tab captured the output. */
  captured?: boolean
}

export type GapScan = {
  /** Journal file and byte offset the next check starts at. */
  file: string
  offset: number
  /** The last steps already checked: context for the next check. */
  recent: Story[]
  /** Time of the last step checked (for the silence before the next one). */
  lastT?: number | null
}

/** Gaps waiting for an answer before checking stops. */
export const MAX_OPEN = 20
/** Journal events per Haiku call when there is a backlog. */
const CHUNK = 40
/** Largest prompt sent to Haiku; a bigger chunk is split in two, never cut. */
const SCAN_PROMPT_MAX = 120_000
/** A silence this long is pointed out to the models (a hint, not a gap). */
const SILENCE_MS = 15 * 60_000
const MAX_FOLLOW_UPS = 3
const RECENT = 10
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'proxychains', 'proxychains4', 'rlwrap', 'exec'])

export function newScan(): GapScan {
  return { file: '', offset: 0, recent: [], lastT: null }
}

// ── Reading new events ────────────────────────────────────────────────────────

const JOURNAL_FILE = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/

/** Journal files in order: by day, then part (YYYY-MM-DD.jsonl is part 1). */
export function sortJournalFiles(names: string[]): string[] {
  const key = (n: string) => {
    const m = JOURNAL_FILE.exec(n)
    return m ? [m[1] ?? '', Number(m[2] ?? '1')] as const : (['', 0] as const)
  }
  return names
    .filter(n => JOURNAL_FILE.test(n))
    .sort((x, y) => {
      const [dx, px] = key(x)
      const [dy, py] = key(y)
      return dx < dy ? -1 : dx > dy ? 1 : px - py
    })
}

/** A journal event and where its line ends (to move the cursor to). */
type Read = { ev: JournalEvent; file: string; end: number }

/** Events written since the cursor, with their positions; the cursor itself is not moved. */
async function readNewEvents($: Host, j: Journal, scan: GapScan): Promise<Read[]> {
  const r = await $.process.run(['/bin/ls', '-1', j.dir])
  const files = sortJournalFiles(r.stdout.split('\n'))
  const startAt = scan.file === '' ? 0 : Math.max(0, files.indexOf(scan.file))
  const out: Read[] = []
  const enc = new TextEncoder()
  for (const name of files.slice(startAt)) {
    const from = name === scan.file ? scan.offset : 0
    const size = await sizeOf($, `${j.dir}/${name}`)
    if (size <= from) continue
    const text = await readRange($, `${j.dir}/${name}`, from, size - from)
    let pos = from
    let start = 0
    for (;;) {
      const nl = text.indexOf('\n', start)
      if (nl < 0) break // a line still being written: next time
      const line = text.slice(start, nl)
      pos += enc.encode(text.slice(start, nl + 1)).length
      start = nl + 1
      if (!line.trim()) continue
      try {
        out.push({ ev: JSON.parse(line) as JournalEvent, file: name, end: pos })
      } catch {
        // a torn line from a crash: skipped
      }
    }
  }
  return out
}

// ── Events -> stories ────────────────────────────────────────────────────────

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const oneLine = (s: string, max: number) => trimMiddle(s.replace(/\s+/g, ' ').trim(), max)
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p

function outText(out: unknown): string {
  if (!isObj(out)) return ''
  return str(out.text) || [str(out.head), str(out.tail)].filter(Boolean).join('\n…\n')
}

function toolOf(cmd: string): string {
  const words = cmd.trim().split(/\s+/)
  for (const w of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w) || w.startsWith('-')) continue
    return base(w)
  }
  return ''
}

/** One journal event -> zero or more stories (an assistant row may hold several tool calls). */
export function toStories(ev: JournalEvent, results: Map<string, Story>): Story[] {
  const id = str(ev.id)
  const t = ev.t
  if (ev.src === 'terminal' && ev.kind === 'command') {
    const cmd = str(ev.cmd)
    return [
      {
        id,
        t,
        label: oneLine(cmd, 90),
        src: 'terminal',
        kind: 'command',
        cwd: str(ev.cwd),
        tool: toolOf(cmd),
        out: trimMiddle(outText(ev.out), 900),
        says: cmd,
        // devlog-tab captured it (an output, even empty, and a pointer to it)
        captured: isObj(ev.ref),
      },
    ]
  }
  if (ev.src === 'terminal' && ev.kind === 'remote-steps') {
    const steps = Array.isArray(ev.steps) ? (ev.steps as Obj[]) : []
    const says = steps.map(s => str(s.cmd)).join('\n')
    return [
      {
        id,
        t,
        label: `${str(ev.host) || 'Remote session'}: ${steps.length} commands`,
        src: 'terminal',
        kind: 'remote-steps',
        out: trimMiddle(steps.map(s => `$ ${str(s.cmd)}\n${str(s.out)}`).join('\n'), 1500),
        says,
      },
    ]
  }
  if (ev.src === 'files' && ev.kind === 'snapshot') {
    const paths = (Array.isArray(ev.changes) ? (ev.changes as Obj[]) : []).map(c => str(c.p).split(' -> ').pop() ?? '')
    if (ev.baseline === true || paths.length === 0) return []
    const names = paths.slice(0, 3).map(base).join(', ')
    const more = paths.length > 3 ? ` (+${paths.length - 3})` : ''
    return [{ id, t, label: `Files changed: ${names}${more}`, src: 'files', kind: 'snapshot', paths, says: '' }]
  }
  if (ev.src === 'journal') {
    const kind = String(ev.kind)
    const label = { start: 'Journal started', pause: 'Journal paused', resume: 'Journal resumed', end: 'Journal ended' }[kind]
    return label ? [{ id, t, label, src: 'journal', kind, says: '' }] : []
  }
  if (ev.src === 'claude') {
    const blocks = Array.isArray(ev.blocks) ? (ev.blocks as Obj[]) : []
    const out: Story[] = []
    if (ev.kind === 'prompt' && ev.type === 'user') {
      const text = blocks.map(b => (b.type === 'text' ? str(b.text) : '')).join(' ').trim()
      if (text) out.push({ id, t, label: `You asked Claude: "${oneLine(text, 70)}"`, src: 'claude', kind: 'prompt', says: text })
    }
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        const input = isObj(b.input) ? b.input : {}
        const name = str(b.name)
        const file = str(input.file_path) || str(input.notebook_path) || str(input.path)
        const command = str(input.command)
        const label = command
          ? `Claude ran: ${oneLine(command, 70)}`
          : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name) && file
            ? `Claude edited ${base(file)}`
            : `Claude used ${name}${file ? ` on ${base(file)}` : ''}`
        const story: Story = {
          id,
          t,
          label,
          src: 'claude',
          kind: 'tool',
          says: `${name} ${JSON.stringify(input)}`,
          ...(file ? { paths: [file] } : {}),
        }
        results.set(str(b.id), story)
        out.push(story)
      } else if (b.type === 'tool_result') {
        // the output belongs to the tool call it answers (same batch or earlier)
        const call = results.get(str(b.id))
        if (call) call.out = trimMiddle(str(b.text), 900)
      }
    }
    return out
  }
  return []
}

// ── What the models read ──────────────────────────────────────────────────────

export function clock(t: number): string {
  const d = new Date(t)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000)
}

/**
 * The steps the models judge: terminal commands only when devlog-tab captured
 * them (without an output, every step would look unexplained), plus files,
 * Claude and journal events. Each carries the silence before it, as a hint.
 */
export type Step = Story & { quietBefore: number }

export function toSteps(stories: Story[], lastT: number | null | undefined, owner?: Map<Story, unknown>): Step[] {
  const steps: Step[] = []
  let prevT = lastT ?? null
  let paused = false
  for (const s of [...stories].sort((x, y) => x.t - y.t)) {
    const quiet = prevT !== null && !paused ? Math.max(0, s.t - prevT) : 0
    prevT = Math.max(prevT ?? s.t, s.t)
    if (s.kind === 'pause' || s.kind === 'end') paused = true
    if (s.kind === 'resume' || s.kind === 'start') paused = false
    if (s.kind === 'command' && !s.captured) continue
    const step = { ...s, quietBefore: quiet }
    if (owner?.has(s)) owner.set(step, owner.get(s))
    steps.push(step)
  }
  return steps
}

function describe(s: Story & { quietBefore?: number }, n?: string): string {
  const quiet = (s.quietBefore ?? 0) >= SILENCE_MS ? ` (after ${minutes(s.quietBefore ?? 0)} min with nothing recorded)` : ''
  const files = s.kind === 'snapshot' && s.paths ? `\n  files: ${s.paths.slice(0, 30).join(', ')}` : ''
  const out = s.out ? `\n  output:\n${s.out.replace(/^/gm, '    ')}` : ''
  return `${n ? `${n} ` : ''}[${clock(s.t)}]${quiet} ${s.label}${s.cwd ? ` (in ${s.cwd})` : ''}${files}${out}`
}

/** What the person already explained: the models take it as known. */
function answersText(gaps: Gap[]): string {
  const done = gaps.filter(g => g.answers.length > 0).slice(-15)
  if (done.length === 0) return '(none yet)'
  return done
    .map(g => `- Between "${g.a.label}" and "${g.b.label}": ${g.answers.join(' / ')}`)
    .join('\n')
}

/** Tolerant JSON: the first {...} in the text. */
export function parseJson(text: string): Obj | null {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const v = JSON.parse(text.slice(a, b + 1)) as unknown
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

// ── 1. Haiku: which steps don't follow? ──────────────────────────────────────

const SCAN_SYSTEM = `You read a work journal (security labs, pentests, coding projects) so a report can be written from it.
You get the steps already checked (context), what the person already explained, then NEW steps in order, numbered: terminal commands with their outputs, file and folder changes, Claude's actions and the person's prompts to Claude, journal pauses. A silence before a step is pointed out.
For each NEW step B, ask: does it follow from the step before it (or another earlier step), with a clear thread? Or did the person do or learn something the journal does not show (a username, a port, a file, a folder, a credential, a reason to change files) that B depends on?
List only the steps where the thread is missing. Obvious next steps, things visible in earlier outputs or steps, and things the person already explained are NOT gaps. A silence alone is not a gap.
Reply with JSON only: {"suspects": [{"a": <number of the step B should follow from>, "b": <number of the new step>, "why": "<one short sentence: what is missing>"}]}
Use the numbers as given. Keep placeholders like [PASSWORD-1] exactly as written.`

export type Suspect = { a: number; b: number; why: string }

export function parseSuspects(text: string, first: number, last: number): Suspect[] {
  const j = parseJson(text)
  const list = j && Array.isArray(j.suspects) ? (j.suspects as unknown[]) : []
  const out: Suspect[] = []
  for (const x of list) {
    if (!isObj(x)) continue
    const a = Number(x.a)
    const b = Number(x.b)
    if (!Number.isInteger(a) || !Number.isInteger(b) || b < first || b > last || a < 1 || a >= b) continue
    if (out.some(o => o.a === a && o.b === b)) continue
    out.push({ a, b, why: str(x.why).trim() || 'The step before does not explain this one.' })
  }
  return out.sort((x, y) => x.b - y.b)
}

function scanPrompt(context: Step[], steps: Step[], answers: string): string {
  const first = context.length + 1
  return [
    'Already checked (context):',
    ...(context.length ? context.map((s, i) => describe(s, `#${i + 1}`)) : ['(nothing)']),
    '',
    'Already explained by the person:',
    answers,
    '',
    'NEW steps:',
    ...steps.map((s, i) => describe(s, `#${first + i}`)),
  ].join('\n')
}

/** Does this chunk fit in one Haiku call? (Otherwise it is split, never cut.) */
export function fitsScan(context: Step[], steps: Step[], answers: string): boolean {
  return scanPrompt(context, steps, answers).length <= SCAN_PROMPT_MAX
}

async function findSuspects($: Host, context: Step[], steps: Step[], answers: string): Promise<Suspect[]> {
  const first = context.length + 1
  // one step alone too big (a huge output): its output is shortened, the rest is kept whole
  const prompt = trimMiddle(scanPrompt(context, steps, answers), SCAN_PROMPT_MAX)
  const r = await $.model.complete({ model: 'haiku', system: SCAN_SYSTEM, prompt, maxTokens: 3000, timeoutMs: 120_000 })
  if (!r.isAnswered) throw new Error('the fast model did not answer')
  return parseSuspects(r.text, first, first + steps.length - 1)
}

// ── 2. Sonnet: is it a real gap? ─────────────────────────────────────────────

const CONFIRM_SYSTEM = `You check a suspected gap in a work journal (security labs, pentests, coding projects) before the person is asked about it.
You get the steps around it with their outputs, what the person already explained, step A, step B, and why a first reader suspected a gap.
It is a real gap only if B depends on something the person did or learned that nothing shown explains (how they found a username, a port, a file, a folder, a credential, or why files changed). Obvious next steps, anything visible in the outputs or earlier steps, and anything already explained are NOT gaps. A silence alone is not a gap.
Reply with JSON only: {"gap": true|false, "question": "<if gap: at most two short sentences (under 40 words) in English, second person: what is missing, then what they did between the two steps>"}
Keep placeholders like [PASSWORD-1] exactly as written.`

async function confirm($: Host, around: Step[], a: Step, b: Step, why: string, answers: string): Promise<string | null> {
  const prompt = [
    'Steps around it:',
    ...around.map(s => describe(s)),
    '',
    'Already explained by the person:',
    answers,
    '',
    `Step A: ${describe(a)}`,
    `Step B: ${describe(b)}`,
    '',
    `Suspected because: ${why}`,
  ].join('\n')
  const r = await $.model.complete({ model: 'sonnet', system: CONFIRM_SYSTEM, prompt: trimMiddle(prompt, 60_000), maxTokens: 400, timeoutMs: 90_000 })
  if (!r.isAnswered) throw new Error('the model did not answer')
  const j = parseJson(r.text)
  if (!j || j.gap !== true) return null
  return typeof j.question === 'string' && j.question.trim() ? j.question.trim() : `${why} What did you do between these two steps?`
}

// ── 3. Answers ───────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You check whether a person's explanation fills a gap in their work journal, so a report can be written from it.
Enough = the answers explain the specific missing piece the questions ask about (how they got from event A to event B).
Not enough = vague, or a piece of the question is still unexplained.
Reply with JSON only: {"enough": true|false, "followUp": "<if not enough: thank them briefly for what is clear, then one short question about what is still missing>"}
Keep placeholders like [PASSWORD-1] exactly as written.`

export type Verdict = { enough: true } | { enough: false; followUp: string }

/** Is the explanation enough? */
export async function judge($: Host, gap: Gap): Promise<Verdict> {
  if (gap.answers.length >= MAX_FOLLOW_UPS) return { enough: true }
  const qa = gap.questions.map((q, i) => `Q: ${q}\nA: ${gap.answers[i] ?? '(no answer yet)'}`).join('\n\n')
  const prompt = `Event A [${clock(gap.a.t)}]: ${gap.a.label}\nEvent B [${clock(gap.b.t)}]: ${gap.b.label}\nSuspected because: ${gap.reason}\n\n${qa}`
  try {
    const r = await $.model.complete({ model: 'haiku', system: JUDGE_SYSTEM, prompt: trimMiddle(prompt, 16_000), maxTokens: 300, timeoutMs: 60_000 })
    if (r.isAnswered) {
      const j = parseJson(r.text)
      if (j && j.enough === false && typeof j.followUp === 'string' && j.followUp.trim()) {
        return { enough: false, followUp: j.followUp.trim() }
      }
    }
  } catch {
    // no model: the answer is taken as it is
  }
  return { enough: true }
}

// ── The check ────────────────────────────────────────────────────────────────

const toGapEvent = (s: Story): GapEvent => ({ id: s.id, t: s.t, label: s.label })

export const openCount = (gaps: Gap[]) => gaps.filter(g => g.status !== 'explained').length

export type ScanResult = { added: number; stopped: boolean }

/**
 * One check: reads what was journaled since the last one, in chunks, and
 * stops as soon as MAX_OPEN gaps wait for an answer. The cursor only moves
 * past what was really checked, so nothing is skipped. Models run outside
 * the journal lock; a second session checking at the same time just skips.
 */
export async function scanGaps($: Host, j: Journal): Promise<ScanResult> {
  try {
    return await withLock($, j.dir, () => scanLocked($, j), { name: 'gap-lock', waitMs: 0 })
  } catch (err) {
    if (String(err).includes('busy')) return { added: 0, stopped: false }
    throw err
  }
}

async function scanLocked($: Host, j: Journal): Promise<ScanResult> {
  await reloadJournal($, j)
  if (openCount(j.state.gaps) >= MAX_OPEN) return { added: 0, stopped: true }
  const scan: GapScan = { ...newScan(), ...(j.state.gapScan ?? {}) }
  const reads = await readNewEvents($, j, scan)
  let added = 0

  let size = CHUNK
  for (let i = 0; i < reads.length; ) {
    const chunk = reads.slice(i, i + size)
    const results = new Map<string, Story>()
    const owner = new Map<Story, Read>()
    const stories: Story[] = []
    for (const r of chunk) for (const s of toStories(r.ev, results)) {
      stories.push(s)
      owner.set(s, r)
    }
    const steps = toSteps(stories, scan.lastT, owner as Map<Story, unknown>)
    const context = scan.recent.map(s => ({ ...s, quietBefore: 0 }))
    const all = [...context, ...steps]
    let stopAt: Read | null = null
    const answers = answersText(j.state.gaps)
    if (steps.length > 0 && chunk.length > 1 && !fitsScan(context, steps, answers)) {
      size = Math.max(1, Math.floor(chunk.length / 2)) // too big: same start, half the events
      continue
    }
    size = CHUNK
    i += chunk.length

    if (steps.length > 0) {
      const suspects = await findSuspects($, context, steps, answers)
      const now = await $.clock.now()
      for (const sus of suspects) {
        const a = all[sus.a - 1]
        const b = all[sus.b - 1]
        if (!a || !b) continue
        const around = all.slice(Math.max(0, sus.a - 8), sus.b + 2)
        const question = await confirm($, around, a, b, sus.why, answers)
        if (!question) continue
        const gap: Gap = {
          id: '',
          a: toGapEvent(a),
          b: toGapEvent(b),
          reason: await j.redactor.redact(sus.why),
          questions: [await j.redactor.redact(question)],
          answers: [],
          status: 'open',
          foundAt: now,
        }
        const isFull = await locked($, j, async () => {
          if (!j.state.gaps.some(x => x.a.id === gap.a.id && x.b.id === gap.b.id)) {
            gap.id = `g${j.state.gaps.length + 1}`
            j.state.gaps.push(gap)
            added += 1
          }
          return openCount(j.state.gaps) >= MAX_OPEN
        })
        if (isFull) {
          // stop right after B: what follows is checked once some gaps are answered
          stopAt = owner.get(b as Story) ?? null
          break
        }
      }
    }

    // move the cursor past what was checked, and remember it as context
    const last = stopAt ?? chunk[chunk.length - 1]
    if (!last) break
    const lastIdx = chunk.indexOf(last)
    const isChecked = (s: Story) => chunk.indexOf(owner.get(s) as Read) <= lastIdx
    const checked = stories.filter(isChecked)
    const checkedSteps = steps.filter(s => isChecked(s))
    scan.file = last.file
    scan.offset = last.end
    scan.recent = [...scan.recent, ...checkedSteps.map(({ quietBefore: _q, ...s }) => s)].slice(-RECENT)
    const lastStory = checked.reduce<Story | null>((m, s) => (m === null || s.t > m.t ? s : m), null)
    if (lastStory) scan.lastT = Math.max(scan.lastT ?? 0, lastStory.t)
    await locked($, j, async () => {
      j.state.gapScan = scan
    })
    if (stopAt) return { added, stopped: true }
  }
  return { added, stopped: openCount(j.state.gaps) >= MAX_OPEN }
}

export type AnswerResult = { status: 'explained' } | { status: 'open'; followUp: string } | { status: 'missing' }

/** Stores an answer (redacted), asks the model, closes the gap or adds a follow-up. */
export async function answerGap($: Host, j: Journal, gapId: string, raw: string): Promise<AnswerResult> {
  const answer = await j.redactor.redact(raw.trim())
  const gap = await locked($, j, async () => {
    const g = j.state.gaps.find(x => x.id === gapId)
    if (!g || g.status === 'explained') return null
    g.answers.push(answer)
    return JSON.parse(JSON.stringify(g)) as Gap
  })
  if (!gap) return { status: 'missing' }
  const verdict = await judge($, gap)
  const followUp = verdict.enough ? null : await j.redactor.redact(verdict.followUp)
  await locked($, j, async () => {
    const g = j.state.gaps.find(x => x.id === gapId)
    if (!g) return
    if (followUp === null) g.status = 'explained'
    else g.questions.push(followUp)
  })
  return followUp === null ? { status: 'explained' } : { status: 'open', followUp }
}
