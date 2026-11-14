// Claude Code session rows (session.append) -> journal events.
// Content blocks come in the Messages API's spelling; we keep what tells the
// story (text, tool calls, tool results) and trim what is huge.
import { trimMiddle } from './io'
import type { Redactor, RedactOptions } from './redact'
import { readsCredFile, readsEnvFile, readsFlagFile } from './redact'

export type RowBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; isError?: boolean; text: string }
  | { type: 'media'; kind: string }

export type QueuedRow = {
  t: number
  door: string
  origin: string
  uuid: string
  agentId?: string
  type: string
  role?: string
  name?: string
  isMeta?: boolean
  content: readonly unknown[]
}

const TEXT_MAX = 6000
const RESULT_MAX = 5000
const INPUT_STRING_MAX = 1500

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : isObj(b) ? `[${String(b.type)}]` : ''))
    .join('\n')
}

function trimDeep(v: unknown): unknown {
  if (typeof v === 'string') return trimMiddle(v, INPUT_STRING_MAX)
  if (Array.isArray(v)) return v.map(trimDeep)
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimDeep(x)]))
  return v
}

/**
 * Remembers which tool calls read a .env or flag file, so their results get
 * the stricter redaction. Keyed by tool_use id.
 */
export class ToolContext {
  private readonly modes = new Map<string, RedactOptions>()

  note(id: string, input: unknown): void {
    const s = JSON.stringify(input ?? '')
    const opts: RedactOptions = { envFile: readsEnvFile(s), flagFile: readsFlagFile(s), credFile: readsCredFile(s) }
    if (opts.envFile || opts.flagFile || opts.credFile) this.modes.set(id, opts)
    if (this.modes.size > 500) this.modes.delete(this.modes.keys().next().value as string)
  }

  modeFor(id: string): RedactOptions {
    return this.modes.get(id) ?? {}
  }
}

export async function rowBlocks(
  content: readonly unknown[],
  redactor: Redactor,
  tools: ToolContext,
): Promise<RowBlock[]> {
  const out: RowBlock[] = []
  for (const raw of content) {
    if (typeof raw === 'string') {
      out.push({ type: 'text', text: await redactor.redact(trimMiddle(raw, TEXT_MAX)) })
      continue
    }
    if (!isObj(raw)) continue
    switch (raw.type) {
      case 'text':
        out.push({ type: 'text', text: await redactor.redact(trimMiddle(String(raw.text ?? ''), TEXT_MAX)) })
        break
      case 'thinking': {
        const thinking = String(raw.thinking ?? '').trim()
        if (thinking) out.push({ type: 'thinking', text: await redactor.redact(trimMiddle(thinking, 3000)) })
        break
      }
      case 'redacted_thinking':
        break
      case 'tool_use':
      case 'server_tool_use': {
        const id = String(raw.id ?? '')
        tools.note(id, raw.input)
        const input = await redactor.redactDeep(trimDeep(raw.input), tools.modeFor(id))
        out.push({ type: 'tool_use', id, name: String(raw.name ?? ''), input })
        break
      }
      case 'tool_result': {
        const id = String(raw.tool_use_id ?? '')
        const text = await redactor.redact(trimMiddle(textOf(raw.content), RESULT_MAX), tools.modeFor(id))
        out.push({ type: 'tool_result', id, ...(raw.is_error === true ? { isError: true } : {}), text })
        break
      }
      default:
        out.push({ type: 'media', kind: String(raw.type ?? 'unknown') })
    }
  }
  return out
}
