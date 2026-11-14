// Pure helpers: terminal cleanup, excerpts, the zsh line format, interactive detection.
import { expect, test } from 'claude-code/testing'

import { cleanTerminal, excerpt, FULL_LIMIT } from '../hooks/lib/clean'
import { nextPart } from '../hooks/lib/journal'
import { parseNameStatus } from '../hooks/lib/snapshot'
import { isInteractive, parseSteps, parseTerminal } from '../hooks/lib/terminal'

test('cleanTerminal strips colors, replays \\r and backspaces, drops the zsh marker', () => {
  // Bytes taken from a real `script` capture of: echo inside-capture; printf red
  const raw = 'inside-capture\r\n\x1b[31mred\x1b[0m\r\n%                                                                              \r \r'
  expect(cleanTerminal(raw)).toBe('inside-capture\nred')
  expect(cleanTerminal('abc\b\bX\n')).toBe('aXc')
  expect(cleanTerminal('progress 10%\rprogress 100%\n')).toBe('progress 100%')
  expect(cleanTerminal('\x1b]0;title\x07hello')).toBe('hello')
})

test('cleanTerminal follows a REPL that redraws its line on every key', () => {
  // Python 3.13's REPL, typing "pw: then Enter (bytes as `script` saved them):
  // each key redraws the prompt + line after moving the cursor back.
  const P = '\x1b[1;35m>>> \x1b[0m'
  const raw = `${P}"p\x1b[6D\x1b[6C\x1b[6D${P}"pw\x1b[7D\x1b[7C\x1b[7D${P}"pw"\r\n'pw'\r\n`
  expect(cleanTerminal(raw)).toBe(`>>> "pw"\n'pw'`)
  // erase to end of line, insert and delete characters
  expect(cleanTerminal('hello world\x1b[6D\x1b[K!')).toBe('hello!')
  expect(cleanTerminal('abcdef\x1b[4D\x1b[2P')).toBe('abef')
  expect(cleanTerminal('ac\x1b[1D\x1b[1@b')).toBe('abc')
})

test('excerpt keeps short output whole and long output as head + tail', () => {
  expect(excerpt('a\nb')).toEqual({ text: 'a\nb', chars: 3, lines: 2 })
  const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
  expect(long.length > FULL_LIMIT).toBe(true)
  const x = excerpt(long)
  expect(x.text).toBeUndefined()
  expect(x.head?.startsWith('line 0\nline 1')).toBe(true)
  expect(x.tail?.endsWith('line 499')).toBe(true)
  expect(x.lines).toBe(500)
})

test('parseTerminal reads the zsh format and keeps a torn last line for later', () => {
  const line = '{"t":1794622206379,"dur":12,"exit":1,"cwd":"L3Byb2o=","cmd":"bHMgLWxh","tty":"","o0":-1,"o1":-1}'
  const { lines, consumed } = parseTerminal(`${line}\n{"t":17946`)
  expect(lines).toEqual([{ t: 1794622206379, dur: 12, exit: 1, cwd: '/proj', cmd: 'ls -la', tty: '', o0: -1, o1: -1 }])
  expect(consumed).toBe(line.length + 1)
})

test('interactive sessions are recognized', () => {
  for (const c of ['ssh root@10.0.0.1', 'sudo -i', 'rlwrap nc -lvnp 4444', 'python3', 'node', 'docker exec -it web bash', 'evil-winrm -i 10.0.0.5 -u a -p b']) {
    expect(isInteractive(c)).toBe(true)
  }
  for (const c of ['python3 exploit.py', 'ls -la', 'node build.js', 'docker ps', 'nmap -sV 10.0.0.1']) {
    expect(isInteractive(c)).toBe(false)
  }
})

test('model output is parsed defensively', () => {
  expect(parseSteps('Here: {"host":"www-data@box","steps":[{"cmd":"id","out":"uid=33"}]} done')).toEqual({
    host: 'www-data@box',
    steps: [{ cmd: 'id', out: 'uid=33' }],
  })
  expect(parseSteps('no json here')).toBeNull()
})

test('journal parts and git name-status', () => {
  expect(nextPart('2026-11-14.jsonl')).toBe('2026-11-14.2.jsonl')
  expect(nextPart('2026-11-14.2.jsonl')).toBe('2026-11-14.3.jsonl')
  expect(parseNameStatus('M\tsrc/a.ts\nR100\told.ts\tnew.ts')).toEqual([
    { s: 'M', p: 'src/a.ts' },
    { s: 'R', p: 'old.ts -> new.ts' },
  ])
})
