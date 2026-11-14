// A fake disk + the few commands the mod runs, answered beneath the plugin.
// (Tests run with no real fs or processes.) git is "not installed" here:
// snapshots are checked against real git in the live run instead.
import type { On } from 'claude-code'

export type FakeHost = {
  files: Map<string, string>
  dirs: Set<string>
  runs: string[][]
}

export function fakeHost(on: On, root: string): FakeHost {
  const host: FakeHost = { files: new Map(), dirs: new Set([root]), runs: [] }
  const { files, dirs } = host
  const parentsOf = (p: string) => {
    for (let d = p.slice(0, p.lastIndexOf('/')); d.length > 0; d = d.slice(0, d.lastIndexOf('/'))) dirs.add(d)
  }
  const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  const fail = (stderr: string) => ({ exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })

  on('fs.exists', (_, e) => ({ value: files.has(e.path) || dirs.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    parentsOf(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => ({
    value: {
      kind: dirs.has(e.path) ? ('dir' as const) : ('file' as const),
      size: (files.get(e.path) ?? '').length,
      mtimeMs: 0,
      isLink: false,
    },
  }))
  on('process.run', (_, e) => {
    const a = [...e.argv]
    host.runs.push(a)
    const [cmd, ...rest] = a
    if (cmd === '/bin/sh' && rest[1]?.includes('cat >>')) {
      const path = rest[3] ?? ''
      parentsOf(path)
      files.set(path, (files.get(path) ?? '') + (e.init?.stdin ?? ''))
      return { value: ok() }
    }
    if (cmd === '/bin/sh' && rest[1]?.includes('tail -c')) {
      const start = Number(rest[3]) - 1
      const len = Number(rest[4])
      return { value: ok((files.get(rest[5] ?? '') ?? '').slice(start, start + len)) }
    }
    const last = a[a.length - 1] ?? ''
    if (cmd === '/bin/rm') {
      files.delete(last)
      return { value: ok() }
    }
    if (cmd === '/bin/mkdir') {
      if (!a.includes('-p') && dirs.has(last)) return { value: fail('File exists') }
      dirs.add(last)
      parentsOf(last)
      return { value: ok() }
    }
    if (cmd === '/bin/rmdir') {
      dirs.delete(last)
      return { value: ok() }
    }
    if (cmd === '/bin/mv') {
      const from = a[2] ?? ''
      files.set(last, files.get(from) ?? '')
      files.delete(from)
      return { value: ok() }
    }
    if (cmd === '/bin/ls') {
      const dir = `${last}/`
      const names = [...files.keys()].filter(f => f.startsWith(dir) && !f.slice(dir.length).includes('/'))
      return { value: ok(names.map(f => f.slice(dir.length)).join('\n')) }
    }
    if (cmd === 'git') return { value: fail('git: not here in tests') }
    return { value: ok() }
  })
  return host
}

/** One line in the zsh hook's format. */
export function termLine(f: { t: number; cmd: string; cwd: string; exit?: number; tty?: string; o0?: number; o1?: number }): string {
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
  return `${JSON.stringify({
    t: f.t,
    dur: 5,
    exit: f.exit ?? 0,
    cwd: b64(f.cwd),
    cmd: b64(f.cmd),
    tty: f.tty ?? '',
    o0: f.o0 ?? -1,
    o1: f.o1 ?? -1,
  })}\n`
}

export function journalLines(host: FakeHost, dir: string): Record<string, unknown>[] {
  return [...host.files.entries()]
    .filter(([p]) => p.startsWith(`${dir}/`) && /\/\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/.test(p))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, text]) => text.split('\n').filter(Boolean))
    .map(line => JSON.parse(line) as Record<string, unknown>)
}
