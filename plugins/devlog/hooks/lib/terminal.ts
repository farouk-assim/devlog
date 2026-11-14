// Reads what the zsh hook wrote (.devlog/terminal.jsonl + tty-*.log captures)
// and turns it into journal events. Format: header of ~/.config/devlog/devlog.zsh.
import { cleanTerminal, excerpt } from './clean'
import { fromBase64, type Host, move, readRange, sizeOf, trimMiddle } from './io'
import { appendEvents, type Journal, type JournalEvent, ROTATE_BYTES } from './journal'
import { readsCredFile, readsEnvFile, readsFlagFile } from './redact'

export type TermLine = {
  t: number
  dur: number
  exit: number
  cwd: string
  cmd: string
  tty: string
  o0: number
  o1: number
}

/** Complete lines only; `consumed` = bytes up to the last newline (the file is ASCII). */
export function parseTerminal(text: string): { lines: TermLine[]; consumed: number } {
  const end = text.lastIndexOf('\n')
  if (end < 0) return { lines: [], consumed: 0 }
  const lines: TermLine[] = []
  for (const raw of text.slice(0, end).split('\n')) {
    if (raw.trim() === '') continue
    try {
      const j = JSON.parse(raw) as Record<string, unknown>
      lines.push({
        t: Number(j.t),
        dur: Number(j.dur),
        exit: Number(j.exit),
        cwd: fromBase64(String(j.cwd ?? '')),
        cmd: fromBase64(String(j.cmd ?? '')),
        tty: String(j.tty ?? ''),
        o0: Number(j.o0 ?? -1),
        o1: Number(j.o1 ?? -1),
      })
    } catch {
      // a torn or foreign line: skip it, keep going
    }
  }
  return { lines, consumed: end + 1 }
}

const WRAPPERS = new Set(['sudo', 'rlwrap', 'proxychains', 'proxychains4', 'env', 'time', 'exec', 'nohup', 'stdbuf', 'unbuffer'])
const REMOTE = new Set([
  'ssh', 'nc', 'ncat', 'netcat', 'telnet', 'socat', 'pwncat', 'pwncat-cs', 'evil-winrm', 'msfconsole',
  'ftp', 'sftp', 'smbclient', 'mysql', 'psql', 'sqlite3', 'redis-cli', 'mongo', 'mongosh', 'su',
  'irb', 'ipython', 'ghci', 'gdb', 'r2', 'radare2', 'psexec.py', 'wmiexec.py', 'smbexec.py',
  'mssqlclient.py', 'impacket-psexec', 'impacket-wmiexec', 'impacket-smbexec', 'impacket-mssqlclient',
  'impacket-atexec', 'impacket-dcomexec',
])
const REPL_IF_BARE = new Set(['python', 'python3', 'node', 'php', 'ruby', 'perl', 'bash', 'sh', 'zsh', 'lua'])

/** Is this an interactive session (ssh, nc, a REPL...) whose capture holds several commands? */
export function isInteractive(cmd: string): boolean {
  const words = cmd.trim().split(/\s+/)
  let i = 0
  while (i < words.length) {
    const w = words[i] ?? ''
    if (WRAPPERS.has(w) || /^[A-Za-z_]\w*=/.test(w) || (i > 0 && w.startsWith('-') && WRAPPERS.has(words[i - 1] ?? ''))) {
      if (w === 'sudo' && /^-[is]$/.test(words[i + 1] ?? '')) return true
      i += 1
      continue
    }
    break
  }
  const first = (words[i] ?? '').split('/').pop() ?? ''
  const rest = words.slice(i + 1)
  if (REMOTE.has(first)) return true
  if ((first === 'docker' || first === 'kubectl' || first === 'podman') && rest.includes('exec')) {
    return rest.some(w => /^-\w*i\w*t|^-\w*t\w*i/.test(w))
  }
  if (REPL_IF_BARE.has(first)) return rest.every(w => w.startsWith('-')) || rest.includes('-i')
  return false
}

const TTY_NAME = /^tty-[\w.-]+\.log$/
const BIG_RANGE = 256 * 1024
const PART = 96 * 1024

/** The raw bytes of a command's output (head and tail only when huge). */
async function readCapture($: Host, path: string, o0: number, o1: number): Promise<string> {
  const len = o1 - o0
  if (len <= BIG_RANGE) return readRange($, path, o0, len)
  const head = await readRange($, path, o0, PART)
  const tail = await readRange($, path, o1 - PART, PART)
  return `${head}\n[… ${len - 2 * PART} bytes skipped …]\n${tail}`
}

export type SplitJob = { event: JournalEvent; cmd: string; text: string }

/**
 * Merges new terminal lines into the journal. Call inside `locked()`.
 * Returns the ssh/nc/REPL sessions to split with a model (done after, unlocked).
 */
export async function mergeTerminal($: Host, j: Journal): Promise<SplitJob[]> {
  const path = `${j.dir}/terminal.jsonl`
  const size = await sizeOf($, path)
  if (size < 0) return []
  if (size < j.state.termOffset) j.state.termOffset = 0 // replaced under us
  let splits = await mergeFrom($, j, path, size)

  // Rotate the raw file: rename, then read whatever landed before the rename.
  if (j.state.termOffset >= ROTATE_BYTES) {
    const old = `${j.dir}/terminal-${await $.clock.now()}.jsonl`
    await move($, path, old)
    splits = splits.concat(await mergeFrom($, j, old, await sizeOf($, old)))
    j.state.termOffset = 0
  }
  return splits
}

async function mergeFrom($: Host, j: Journal, path: string, size: number): Promise<SplitJob[]> {
  const from = j.state.termOffset
  if (size <= from) return []
  const { lines, consumed } = parseTerminal(await readRange($, path, from, size - from))
  const events: JournalEvent[] = []
  const splits: SplitJob[] = []
  // Commands first: a password typed in a later command of this batch is then
  // known (and hidden) when an earlier command's output shows it.
  const cmds: string[] = []
  for (const line of lines) cmds.push(await j.redactor.redact(line.cmd))
  for (const [i, line] of lines.entries()) {
    const opts = { envFile: readsEnvFile(line.cmd), flagFile: readsFlagFile(line.cmd), credFile: readsCredFile(line.cmd) }
    const cmd = cmds[i] ?? ''
    const ev: JournalEvent = {
      t: line.t,
      src: 'terminal',
      kind: 'command',
      cmd,
      cwd: line.cwd,
      exit: line.exit,
      dur: line.dur,
    }
    const captured = TTY_NAME.test(line.tty) && line.o0 >= 0 && line.o1 >= line.o0
    if (captured) {
      j.state.uncaptured = 0
      const cleaned = cleanTerminal(await readCapture($, `${j.dir}/${line.tty}`, line.o0, line.o1))
      const safe = await j.redactor.redact(cleaned, opts)
      ev.out = excerpt(safe)
      ev.ref = { tty: line.tty, o0: line.o0, o1: line.o1 }
      if (isInteractive(line.cmd) && safe.length > 300) splits.push({ event: ev, cmd, text: safe })
    } else {
      j.state.uncaptured += 1
    }
    j.state.terminalCommands += 1
    events.push(ev)
  }
  await appendEvents($, j, events)
  j.state.termOffset = from + consumed
  return splits
}

export type RemoteStep = { cmd: string; out: string }

const SPLIT_SYSTEM = `You split a terminal capture of an interactive session (ssh, nc, a reverse shell, a database client or a REPL) into the commands the person typed inside it.
Return JSON only, no prose: {"host": "<user@host or tool, if visible>", "steps": [{"cmd": "<command as typed>", "out": "<its output, at most 400 characters, keep the key lines>"}]}
Keep placeholders like [PASSWORD-1] exactly as written. Skip prompts, banners and empty lines. At most 80 steps.`

/** Asks a fast model to split an interactive capture into steps. */
export async function splitRemote($: Host, job: SplitJob): Promise<JournalEvent | null> {
  const r = await $.model.complete({
    model: 'haiku',
    system: SPLIT_SYSTEM,
    prompt: `Local command: ${job.cmd}\n\nCapture:\n${trimMiddle(job.text, 100_000, 60_000)}`,
    maxTokens: 4000,
    timeoutMs: 90_000,
  })
  if (!r.isAnswered) return null
  const steps = parseSteps(r.text)
  if (!steps) return null
  return {
    t: (job.event.t as number) + 1,
    src: 'terminal',
    kind: 'remote-steps',
    of: job.event.id,
    host: steps.host,
    steps: steps.steps,
  }
}

export function parseSteps(text: string): { host?: string; steps: RemoteStep[] } | null {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const j = JSON.parse(text.slice(a, b + 1)) as { host?: unknown; steps?: unknown }
    if (!Array.isArray(j.steps)) return null
    const steps = j.steps
      .filter((s): s is { cmd: unknown; out?: unknown } => typeof s === 'object' && s !== null && 'cmd' in s)
      .slice(0, 80)
      .map(s => ({ cmd: String(s.cmd), out: String(s.out ?? '').slice(0, 400) }))
    return { ...(typeof j.host === 'string' && j.host ? { host: j.host } : {}), steps }
  } catch {
    return null
  }
}
