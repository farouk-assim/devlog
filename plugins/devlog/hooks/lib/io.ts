// Host IO. A hooks module has no Node: files and commands go through `$`.
// $.fs reads/writes whole files and stats them; it cannot append, delete, make
// an empty folder or read a byte range, so those go through $.process.run with
// a fixed argv (paths are arguments, never pasted into shell text).
import type { EngineInterface } from 'claude-code'

export type Host = EngineInterface

const SH = '/bin/sh'

export async function exists($: Host, path: string): Promise<boolean> {
  return $.fs.exists(path)
}

/** File text, or null when the file is not there. */
export async function readText($: Host, path: string): Promise<string | null> {
  if (!(await $.fs.exists(path))) return null
  return $.fs.read(path)
}

export async function writeText($: Host, path: string, text: string): Promise<void> {
  await $.fs.write(path, text)
}

/** Size in bytes, -1 when missing. */
export async function sizeOf($: Host, path: string): Promise<number> {
  if (!(await $.fs.exists(path))) return -1
  return (await $.fs.stat(path)).size
}

/** Appends with one `cat >>`, creating the file owner-only. */
export async function appendText($: Host, path: string, text: string): Promise<void> {
  if (text === '') return
  const r = await $.process.run([SH, '-c', 'umask 077; cat >> "$1"', 'devlog', path], {
    stdin: text,
  })
  if (r.exitCode !== 0) throw new Error(`append to ${path} failed: ${r.stderr.trim()}`)
}

/** Bytes [start, start+length) of a file, decoded as text. */
export async function readRange(
  $: Host,
  path: string,
  start: number,
  length: number,
): Promise<string> {
  if (length <= 0) return ''
  const r = await $.process.run(
    [SH, '-c', 'tail -c +"$1" "$3" | head -c "$2"', 'devlog', String(start + 1), String(length), path],
    { timeoutMs: 20_000 },
  )
  return r.stdout
}

export async function remove($: Host, path: string): Promise<void> {
  await $.process.run(['/bin/rm', '-f', '--', path])
}

export async function makeDir($: Host, path: string): Promise<void> {
  const r = await $.process.run(['/bin/mkdir', '-p', '-m', '700', '--', path])
  if (r.exitCode !== 0) throw new Error(`mkdir ${path} failed: ${r.stderr.trim()}`)
}

export async function move($: Host, from: string, to: string): Promise<void> {
  const r = await $.process.run(['/bin/mv', '--', from, to])
  if (r.exitCode !== 0) throw new Error(`mv failed: ${r.stderr.trim()}`)
}

/**
 * Runs `fn` while holding `<dir>/<name>/` (mkdir is atomic, so only one
 * session gets it). A lock older than two minutes is a crashed holder's.
 */
export async function withLock<T>(
  $: Host,
  dir: string,
  fn: () => Promise<T>,
  { name = 'lock', waitMs = 8000 }: { name?: string; waitMs?: number } = {},
): Promise<T> {
  const lock = `${dir}/${name}`
  const deadline = (await $.clock.now()) + waitMs
  for (;;) {
    const r = await $.process.run(['/bin/mkdir', '-m', '700', '--', lock])
    if (r.exitCode === 0) break
    const now = await $.clock.now()
    const stat = (await $.fs.exists(lock)) ? await $.fs.stat(lock) : undefined
    if (stat && now - stat.mtimeMs > 120_000) {
      await $.process.run(['/bin/rmdir', '--', lock])
      continue
    }
    if (now > deadline) throw new Error('the journal is busy in another session, try again')
    await $.clock.sleep(150)
  }
  try {
    return await fn()
  } finally {
    await $.process.run(['/bin/rmdir', '--', lock])
  }
}

// ── small pure helpers ─────────────────────────────────────────────────────────

/** base64 (UTF-8 inside) to text. */
export function fromBase64(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local date as YYYY-MM-DD. */
export function ymd(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** hh:mm:ss for a duration. */
export function hms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`
}

/** Head + tail of a long text, with a marker saying how much was cut. */
export function trimMiddle(text: string, max: number, head = Math.floor(max * 0.65)): string {
  if (text.length <= max) return text
  const tail = max - head
  return `${text.slice(0, head)}\n[… ${text.length - max} chars cut …]\n${text.slice(-tail)}`
}
