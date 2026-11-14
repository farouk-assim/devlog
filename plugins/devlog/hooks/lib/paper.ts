// Stage 4: the paper.
//
// The mod gathers what the paper is written from into one context file
// (.devlog/papers/.context-<name>.md): the journal's story in order, the gaps
// with the person's explanations (unexplained ones marked), and the file diffs
// between the first and the last snapshot. Everything in it is redacted.
// Then a normal Claude turn reads that file and writes the paper next to it.
import type { Gap } from '../../types'
import { hms, type Host, makeDir, readRange, sizeOf, trimMiddle, writeText, ymd } from './io'
import { clock, sortJournalFiles } from './gaps'
import type { Journal, JournalEvent } from './journal'
import { readsCredFile, readsEnvFile, readsFlagFile } from './redact'
import { snapshotDiff } from './snapshot'

export type PaperType = 'pentest' | 'portfolio' | 'lab' | 'custom'
export type PaperLang = 'fr' | 'en'

export const PAPER_TYPES: { value: PaperType; label: string }[] = [
  { value: 'pentest', label: 'Pentest report' },
  { value: 'portfolio', label: 'Portfolio presentation' },
  { value: 'lab', label: 'Lab write-up' },
  { value: 'custom', label: 'Custom' },
]
export const PAPER_LANGS: { value: PaperLang; label: string }[] = [
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'English' },
]

export const typeLabel = (t: PaperType) => PAPER_TYPES.find(x => x.value === t)?.label ?? t
export const langLabel = (l: PaperLang) => PAPER_LANGS.find(x => x.value === l)?.label ?? l

/** `/paper [fr|en] [type]`: words in any order; type by a word of its name. */
export function parsePaperArgs(args: string): { lang?: PaperLang; type?: PaperType } {
  const out: { lang?: PaperLang; type?: PaperType } = {}
  for (const w of args.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (w === 'fr' || w === 'français' || w === 'francais') out.lang = 'fr'
    else if (w === 'en' || w === 'english') out.lang = 'en'
    else if (/^pen/.test(w) || w === 'report') out.type = 'pentest'
    else if (/^port/.test(w)) out.type = 'portfolio'
    else if (/^lab|^write/.test(w)) out.type = 'lab'
    else if (/^cust/.test(w)) out.type = 'custom'
  }
  return out
}

// ── The context file ─────────────────────────────────────────────────────────

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const indent = (s: string) => s.replace(/^/gm, '    ')

function outText(out: unknown): string {
  if (!isObj(out)) return ''
  return str(out.text) || [str(out.head), str(out.tail)].filter(Boolean).join('\n[…]\n')
}

/** Every event of this journal (from its start), in time order. */
export async function journalEvents($: Host, j: Journal): Promise<JournalEvent[]> {
  const r = await $.process.run(['/bin/ls', '-1', j.dir])
  const events: JournalEvent[] = []
  for (const name of sortJournalFiles(r.stdout.split('\n'))) {
    const size = await sizeOf($, `${j.dir}/${name}`)
    if (size <= 0) continue
    const text = await readRange($, `${j.dir}/${name}`, 0, size)
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line) as JournalEvent
        if (ev.t >= j.state.startedAt) events.push(ev)
      } catch {
        // torn line: skipped
      }
    }
  }
  return events.sort((a, b) => a.t - b.t)
}

/** One event as a line (or a few) of the story. */
export function storyLine(ev: JournalEvent): string | null {
  const at = `[${clock(ev.t)}]`
  if (ev.src === 'terminal' && ev.kind === 'command') {
    const out = outText(ev.out)
    const exit = typeof ev.exit === 'number' && ev.exit !== 0 ? ` (exit ${ev.exit})` : ''
    const where = str(ev.cwd) ? ` (in ${str(ev.cwd)})` : ''
    const shown = isObj(ev.ref) ? (out ? `\n${indent(trimMiddle(out, 1500))}` : '\n    (no output)') : '\n    (output not captured)'
    return `${at} $ ${str(ev.cmd)}${where}${exit}${shown}`
  }
  if (ev.src === 'terminal' && ev.kind === 'remote-steps') {
    const steps = Array.isArray(ev.steps) ? (ev.steps as Obj[]) : []
    const body = steps.map(s => `    ${str(ev.host) || 'remote'}$ ${str(s.cmd)}${str(s.out) ? `\n${indent(indent(str(s.out)))}` : ''}`).join('\n')
    return `${at} Inside that session:\n${body}`
  }
  if (ev.src === 'files' && ev.kind === 'snapshot') {
    if (ev.baseline === true) return `${at} Files: first snapshot (${String(ev.changed ?? 0)} files)`
    const changes = (Array.isArray(ev.changes) ? (ev.changes as Obj[]) : []).map(c => `${str(c.s)} ${str(c.p)}`)
    return changes.length ? `${at} Files changed: ${changes.slice(0, 40).join(', ')}${changes.length > 40 ? ` (+${changes.length - 40})` : ''}` : null
  }
  if (ev.src === 'journal') {
    const what = { start: 'Journal started', pause: 'Paused', resume: 'Resumed', end: 'Journal ended' }[String(ev.kind)]
    return what ? `${at} — ${what} —` : null
  }
  if (ev.src === 'claude') {
    const blocks = Array.isArray(ev.blocks) ? (ev.blocks as Obj[]) : []
    const lines: string[] = []
    for (const b of blocks) {
      if (b.type === 'text' && str(b.text).trim()) {
        const who = ev.type === 'user' ? 'You to Claude' : 'Claude'
        if (ev.type === 'user' && ev.kind !== 'prompt') continue // tool results etc. come as tool_result
        lines.push(`${at} ${who}: ${trimMiddle(str(b.text).trim(), ev.type === 'user' ? 1200 : 800)}`)
      } else if (b.type === 'tool_use') {
        lines.push(`${at} Claude used ${str(b.name)}: ${trimMiddle(JSON.stringify(b.input ?? {}), 400)}`)
      } else if (b.type === 'tool_result' && str(b.text).trim()) {
        lines.push(`${indent(trimMiddle(str(b.text).trim(), 600))}`)
      }
    }
    return lines.length ? lines.join('\n') : null
  }
  return null
}

export function gapsSection(gaps: Gap[]): string {
  if (gaps.length === 0) return 'No gaps were found.'
  return gaps
    .map((g, i) => {
      const head = `### Gap ${i + 1} (${g.status === 'explained' ? 'explained' : 'UNEXPLAINED'}): [${clock(g.a.t)}] ${g.a.label} → [${clock(g.b.t)}] ${g.b.label}`
      const qa = g.questions
        .map((q, k) => `- Q: ${q}\n  A: ${g.answers[k] ?? '(no answer)'}`)
        .join('\n')
      return `${head}\nWhy it was flagged: ${g.reason}\n${qa}`
    })
    .join('\n\n')
}

/** The diff, redacted file by file (.env and credential files get the strict rules). */
async function redactedDiff(j: Journal, diff: string): Promise<string> {
  const parts = diff.split(/(?=^diff --git )/m)
  const out: string[] = []
  for (const part of parts) {
    const header = part.split('\n', 1)[0] ?? ''
    const opts = { envFile: readsEnvFile(header), credFile: readsCredFile(header), flagFile: readsFlagFile(header) }
    out.push(await j.redactor.redact(part, opts))
  }
  return out.join('')
}

const DIFF_MAX = 80_000

/** Writes the context file; returns its path. */
export async function writeContext($: Host, j: Journal, now: number, name: string): Promise<string> {
  const s = j.state
  const events = await journalEvents($, j)
  const story = events.map(storyLine).filter((x): x is string => x !== null)
  const active = s.activeMs + (s.resumedAt !== null ? Math.max(0, now - s.resumedAt) : 0)

  let files = 'No file snapshots (git is missing, or nothing changed).'
  const diff = await snapshotDiff($, j).catch(() => null)
  if (diff) {
    const body = await redactedDiff(j, trimMiddle(diff.diff, DIFF_MAX))
    files = `\`\`\`\n${await j.redactor.redact(diff.stat)}\n\`\`\`\n\n\`\`\`diff\n${body}\n\`\`\``
  }

  const text = [
    `# devlog context: ${j.root}`,
    '',
    `Journal ${s.id}, started ${ymd(s.startedAt)} ${clock(s.startedAt)}, ${hms(active)} of active time (pauses excluded), ${s.events} events.`,
    'Secrets are replaced by placeholders such as [PASSWORD-1], [HASH-2], [TOKEN-3]: the same secret always has the same placeholder.',
    '',
    '## The story, in order',
    '',
    ...story,
    '',
    '## Gaps in the story, and what the person said about them',
    '',
    gapsSection(s.gaps),
    '',
    '## Files: what changed between the first and the last snapshot',
    '',
    files,
    '',
  ].join('\n')
  const path = `${j.dir}/papers/.context-${name}.md`
  await makeDir($, `${j.dir}/papers`)
  await writeText($, path, text)
  return path
}

/** A free name: papers/2026-11-14-pentest-report.md, then -2, -3... */
export async function paperName($: Host, j: Journal, type: PaperType, now: number): Promise<string> {
  const base = `${ymd(now)}-${typeLabel(type).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`
    if ((await sizeOf($, `${j.dir}/papers/${name}.md`)) < 0) return name
  }
}

// ── The prompt for the Claude turn ───────────────────────────────────────────

const OUTLINES: Record<PaperType, string> = {
  pentest:
    'A professional penetration test report: executive summary (for a non-technical reader), scope and target, methodology, findings (each with title, severity, affected asset, evidence from the journal, impact, remediation), attack path / timeline, and recommendations.',
  portfolio:
    'A portfolio presentation of this work for a recruiter or client: the problem or goal, what the person did and how (the technical story, step by step, readable), the tools and skills it shows, the result, and what they learned. Engaging, but every claim comes from the journal.',
  lab: 'A lab write-up (CTF / HackTheBox style): target overview, reconnaissance, enumeration, foothold, privilege escalation, flags (keep them as placeholders), and lessons learned, with the key commands and outputs.',
  custom: 'Follow what the person asked for in "Focus".',
}

export function paperPrompt(p: { type: PaperType; lang: PaperLang; focus: string; contextPath: string; paperPath: string }): string {
  return [
    `Write a ${typeLabel(p.type)} in ${p.lang === 'fr' ? 'French' : 'English'} from my devlog journal.`,
    '',
    `1. Read ${p.contextPath} completely (in parts if it is long). It is the whole story: commands with their outputs, file changes, my work with Claude, the gaps in the story and my explanations, and the file diffs.`,
    `2. Write the paper. ${OUTLINES[p.type]}`,
    p.focus.trim() ? `   Focus / audience: ${p.focus.trim()}` : '',
    '3. Rules:',
    '   - Use only what the context file shows and my explanations of the gaps. Do not invent steps, tools, results or findings.',
    '   - Where a gap is marked UNEXPLAINED, say so in the paper at that point, plainly (for example "> Unexplained step: how X was found is not recorded").',
    '   - Keep secret placeholders such as [PASSWORD-1] exactly as written. Never try to recover the real values, and do not open .devlog/tty-*.log or .devlog/terminal.jsonl (they hold raw, unredacted data).',
    '   - Do not run commands against any target; this is writing only.',
    `4. Save it as Markdown with the Write tool to ${p.paperPath}, then reply with one short line.`,
  ]
    .filter(Boolean)
    .join('\n')
}
