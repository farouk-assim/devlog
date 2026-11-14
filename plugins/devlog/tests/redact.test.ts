// Redaction rules: what must be hidden, what must stay readable.
import { expect, test } from 'claude-code/testing'

import { Redactor } from '../hooks/lib/redact'

const KEY = btoa('k'.repeat(32))
const fresh = () => Redactor.create(KEY, { labels: {}, counters: {} })

test('passwords in commands become stable placeholders', async () => {
  const r = await fresh()
  const a = await r.redact('sshpass -p Sup3rS3cret! ssh admin@10.10.11.42')
  const b = await r.redact("mysql -u root -pSup3rS3cret! -h db")
  expect(a).toBe('sshpass -p [PASSWORD-1] ssh admin@10.10.11.42')
  expect(b).toContain('-p[PASSWORD-1]')
  // seen once, hidden everywhere after, even with no context
  expect(await r.redact('echo Sup3rS3cret! > pw.txt')).toBe('echo [PASSWORD-1] > pw.txt')
})

test('the same secret keeps its placeholder across a restart', async () => {
  const state = { labels: {}, counters: {} }
  const r1 = await Redactor.create(KEY, state)
  await r1.redact('curl -u bob:hunter22 http://x')
  await r1.redact('password=Other#Pass1')
  const r2 = await Redactor.create(KEY, JSON.parse(JSON.stringify(r1.state)))
  expect(await r2.redact('curl -u bob:hunter22 http://x')).toBe('curl -u bob:[PASSWORD-1] http://x')
  expect(await r2.redact('new: token=abcDEF123456789xyz')).toBe('new: token=[TOKEN-1]')
})

test('the stored map holds digests, never values', async () => {
  const r = await fresh()
  await r.redact('DB_PASSWORD=correct-horse-battery')
  const dump = JSON.stringify(r.state)
  expect(dump).not.toContain('correct-horse-battery')
  expect(Object.values(r.state.labels)).toEqual(['[PASSWORD-1]'])
})

test('hashes, tokens, keys and flags', async () => {
  const r = await fresh()
  const nt = 'Administrator:500:aad3b435b51404eeaad3b435b51404ee:31d6cfe0d16ae931b73c59d7e0c089c0:::'
  expect(await r.redact(nt)).toBe('Administrator:500:[HASH-1]:::')
  expect(await r.redact('root:$6$saltsalt$abcdefghijklmnopqrstuv0123456789:19000:0:99999')).toBe(
    'root:[HASH-2]:19000:0:99999',
  )
  // fake secrets are assembled at runtime so secret scanners don't flag this file
  expect(await r.redact(`Authorization: Bearer ${'eyJ'}hbGciOiJIUzI1NiJ9.${'eyJ'}zdWIiOiIxMjM0NSJ9.abcdefghijk`)).toBe(
    'Authorization: Bearer [TOKEN-1]',
  )
  expect(await r.redact(`key ${'ghp'}_abcdefghijklmnopqrstuvwxyz0123456789`)).toBe('key [TOKEN-2]')
  const k = 'OPENSSH PRIVATE KEY'
  const pem = `-----BEGIN ${k}-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END ${k}-----`
  expect(await r.redact(`id_rsa:\n${pem}\ndone`)).toBe('id_rsa:\n[KEY-1]\ndone')
  expect(await r.redact('got HTB{y0u_f0und_m3}!')).toBe('got [FLAG-1]!')
  expect(await r.redact('9f86d081884c7d659a2feaa0c55ad015', { flagFile: true })).toBe('[FLAG-2]')
})

test('.env contents: every value', async () => {
  const r = await fresh()
  const out = await r.redact('PORT_NAME=web\nSTRIPE=abc123\nexport REGION="eu-west-1"\n# comment', { envFile: true })
  expect(out).toBe('PORT_NAME=[SECRET-1]\nSTRIPE=[SECRET-2]\nexport REGION="[SECRET-3]"\n# comment')
})

test('credential lists: user:secret lines', async () => {
  const r = await fresh()
  expect(await r.redact('admin:letmein\nbob:S3cure!pass\n# notes', { credFile: true })).toBe(
    'admin:[PASSWORD-1]\nbob:[PASSWORD-2]\n# notes',
  )
})

test('code and normal text stay readable', async () => {
  const r = await fresh()
  const keep = [
    'const password = req.body.password',
    'function login(password: string) {}',
    'max_tokens: 4096',
    'author: Ada',
    'ssh -p 2222 user@host',
    'git commit 3f786850e387550fdab836ed7e6dc881de23001b',
    'python3 exploit.py -p 8080',
    'token: process.env.API_TOKEN',
    'docker pull alpine@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1',
  ]
  for (const line of keep) expect(await r.redact(line)).toBe(line)
})

test('a URL after -u is not a user:password pair (gobuster, ffuf, sqlmap)', async () => {
  const r = await fresh()
  for (const c of [
    'gobuster dir -u http://10.10.11.42 -w common.txt',
    'ffuf -u https://target.htb/FUZZ -w words.txt',
    'sqlmap -u "http://10.10.11.42/item?id=1" --batch',
  ]) {
    expect(await r.redact(c)).toBe(c)
  }
  // and nothing was learned that would hide the URL later
  expect(await r.redact('curl -s http://10.10.11.42/login')).toBe('curl -s http://10.10.11.42/login')
  // a real curl -u pair is still hidden
  expect(await r.redact('curl -u admin:S3cret!42 http://10.10.11.42/')).toBe('curl -u admin:[PASSWORD-1] http://10.10.11.42/')
})
