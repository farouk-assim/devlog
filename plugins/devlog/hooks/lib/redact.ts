// Redaction: replace secrets with stable placeholders BEFORE anything is
// written to the journal or sent to a model.
//
// "Stable" = the same secret always gets the same placeholder:
// - in memory, a Map secret -> label (real values never leave memory);
// - across restarts, state.json keeps SHA-256(key + secret) -> label. The key
//   is 32 random bytes kept in $.store (under ~/.claude, not in the project),
//   so the .devlog folder alone can't be used to test password guesses.
//
// Each rule's regex has two groups: (1) text kept as is, (2) the secret.
// Anything after the secret must be a lookahead, so match = group1 + group2.

export type SecretKind = 'PASSWORD' | 'HASH' | 'TOKEN' | 'KEY' | 'SECRET' | 'FLAG'

export type RedactState = {
  labels: Record<string, string>
  counters: Partial<Record<SecretKind, number>>
}

export type RedactOptions = {
  /** Text is a .env-style file: every KEY=value value is a secret. */
  envFile?: boolean
  /** Text is a CTF flag file (user.txt, root.txt, flag*): a bare 32-hex is a FLAG. */
  flagFile?: boolean
  /** Text is a credentials list (creds.txt, passwords, users...): `user:secret` lines. */
  credFile?: boolean
}

type Rule = {
  re: RegExp
  kind: SecretKind | ((pre: string, secret: string, opts: RedactOptions) => SecretKind)
  accept?: (secret: string, pre: string, input: string, index: number) => boolean
  only?: (opts: RedactOptions) => boolean
}

const PLACEHOLDER = /^\[[A-Z]+-\d+\]$/

// key=value values that are clearly not secrets (types, code, variables).
const NOT_A_VALUE =
  /^(?:string|number|boolean|bool|int|str|bytes|null|nil|none|undefined|true|false|yes|no|on|off|any|object|enabled|disabled|required|optional|redacted|changeme|example|\*+|x{3,}|\.{3}|<[^>]*>|\$\{?[A-Za-z_][\w.]*\}?.*|%[A-Za-z_]+%|(?:process\.env|os\.environ|os\.getenv|getenv|env)\b.*|[A-Za-z_$][\w$]*\(.*|[A-Za-z_$][\w$]*(?:\.[\w$]+)+[,;)]*)$/i
// key names that mention a sensitive word but hold no secret.
const NOT_A_KEY =
  /(?:count|len|length|size|type|types|file|path|dir|name|url|uri|policy|field|label|hint|limit|expir\w*|tokens|ttl|_at|min\w*|max\w*|reset|forgot|confirm\w*|strength|hash(?:er|ing)?|prompt|placeholder|input|form|endpoint|route)["']?$/i

const SENSITIVE_KEY =
  'pass(?:word|wd|phrase)?|pwd|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|token|auth(?!or)\\w*|credentials?|session[_-]?id|cookie'

function kindForKey(pre: string): SecretKind {
  if (/token|api[_-]?key|apikey|access[_-]?key|auth|session|cookie/i.test(pre)) return 'TOKEN'
  if (/secret|private|credential/i.test(pre)) return 'SECRET'
  return 'PASSWORD'
}

function hexAccept(secret: string, _pre: string, input: string, index: number): boolean {
  const before = input.slice(Math.max(0, index - 32), index + _pre.length)
  if (/sha(?:256|512|384|1)[:\-]\s*$|digest[:=]\s*$|integrity/i.test(before)) return false
  if (secret.length === 40) return /hash|sha1|pass|pwd|ntlm|lm:|digest/i.test(before)
  return true
}

const RULES: Rule[] = [
  // ── private keys (multi-line), cut-off keys too ──────────────────────────
  {
    re: /()(-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$))/g,
    kind: 'KEY',
  },
  // ── tokens with a known shape ────────────────────────────────────────────
  { re: /()(\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g, kind: 'TOKEN' },
  {
    re: /()(\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|[sr]k_(?:live|test)_[0-9A-Za-z]{16,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}))/g,
    kind: 'TOKEN',
  },
  { re: /(\bBearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g, kind: 'TOKEN' },
  { re: /(Authorization:\s*Basic\s+)([A-Za-z0-9+/]{8,}={0,2})/gi, kind: 'TOKEN' },
  // ── CTF flags ────────────────────────────────────────────────────────────
  {
    re: /(^|[^A-Za-z0-9_])((?:HTB|THM|flag|FLAG|Flag|CTF|ctf|picoCTF|DUCTF|FCSC|ECSC|DGHACK|404CTF|HackTheBox)\{[^}\s]{3,200}\})/gm,
    kind: 'FLAG',
  },
  // ── hashes ───────────────────────────────────────────────────────────────
  // secretsdump / pwdump: user:rid:LM:NT:::
  { re: /((?:^|\s)[^\s:]+:\d+:)([a-fA-F0-9]{32}:[a-fA-F0-9]{32})(?=:::)/gm, kind: 'HASH' },
  // NetNTLMv2 (Responder): user::DOMAIN:challenge:proof:blob
  { re: /((?:^|\s)[^\s:]+::[^\s:]+:)([a-fA-F0-9]{16}:[a-fA-F0-9]{32}:[a-fA-F0-9]{20,})/gm, kind: 'HASH' },
  { re: /()(\$krb5(?:tgs|asrep|pa)\$[^\s'"]+)/g, kind: 'HASH' },
  {
    re: /()(\$(?:1|5|6|apr1)\$[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{8,}|\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}|\$y\$[./A-Za-z0-9]+\$[./A-Za-z0-9]+\$[./A-Za-z0-9]{8,}|\$[PH]\$[./A-Za-z0-9]{31}|\$argon2(?:id|i|d)\$[^\s'"]+)/g,
    kind: 'HASH',
  },
  // ── passwords in commands ────────────────────────────────────────────────
  // scheme://user:pass@host
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:)([^\s@/'"]+)(?=@)/gi, kind: 'PASSWORD' },
  // impacket style: domain/user:pass@host
  { re: /((?:^|[\s'"])[\w.-]+\/[\w.$-]+:)([^\s@'"]+)(?=@[\w.-]+)/g, kind: 'PASSWORD' },
  // curl -u user:pass / --user user:pass (not a URL: gobuster/ffuf/sqlmap -u http://...)
  { re: /((?:\s-u|--user)[\s=]+['"]?[^\s:'"/]+:)(?!\/\/)([^\s'"]+)/g, kind: 'PASSWORD' },
  // smbclient -U 'user%pass'
  { re: /((?:\s-U|--user(?:name)?)[\s=]+['"]?[^\s%'"]+%)([^\s'"]+)/g, kind: 'PASSWORD' },
  // mysql -pSECRET (attached)
  { re: /(\bmysql(?:dump|admin)?\b[^\n|;&]*?\s-p['"]?)([^\s'"-][^\s'"]*)/g, kind: 'PASSWORD' },
  // tools where -p / -w / --password is a password and -H an NT hash
  {
    re: /(\b(?:sshpass|hydra|crackmapexec|cme|nxc|netexec|evil-winrm|smbmap|kerbrute|enum4linux(?:-ng)?|rpcclient|ldapsearch|bloodhound-python|certipy(?:-ad)?|impacket-[\w-]+|xfreerdp|rdesktop)\b[^\n|;&]*?\s(?:-p|-w|-H|--password|--hashes)[\s=]+['"]?)([^\s'"]+)/g,
    kind: pre => (/-H[\s=]+['"]?$|--hashes[\s=]+['"]?$/.test(pre) ? 'HASH' : 'PASSWORD'),
  },
  // --password X, --token=X, -pass pass:X ...
  {
    re: /((?:^|\s)--?(?:password|passwd|pass|pwd|token|api-key|apikey|secret|client-secret)(?:\s+|=)['"]?)([^\s'"-][^\s'"]*)/gi,
    kind: pre => kindForKey(pre),
    accept: secret => !NOT_A_VALUE.test(secret),
  },
  // ── .env files: every value ──────────────────────────────────────────────
  {
    re: /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*['"]?)([^\s'"#][^'"\n#]*?)(?=['"]?\s*(?:#|$))/gm,
    kind: 'SECRET',
    only: opts => opts.envFile === true,
  },
  // ── credential lists: user:secret per line ───────────────────────────────
  {
    re: /^(\s*[^\s:]{1,64}:)(\S{3,})(?=\s*$)/gm,
    kind: 'PASSWORD',
    only: opts => opts.credFile === true,
  },
  // ── key = value / key: value with a sensitive key name ───────────────────
  {
    re: new RegExp(
      `((?:^|[\\s"'{(,;&?])["']?[A-Za-z0-9_.-]*(?:${SENSITIVE_KEY})[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*["']?)([^\\s"',;&}<>\\[\\]()][^\\s"',;&}<>()]*)`,
      'gim',
    ),
    kind: pre => kindForKey(pre),
    accept: (secret, pre, input, index) => {
      // `password = getPassword()`: a call, not a value
      if (input[index + pre.length + secret.length] === '(') return false
      const key = pre.replace(/["'\s:=]+$/, '')
      if (NOT_A_KEY.test(key) && !/session[_-]?id$/i.test(key)) return false
      if (NOT_A_VALUE.test(secret)) return false
      if (/^\d{1,5}$/.test(secret)) return false
      // `password: password` (code passing a variable through)
      if (key.toLowerCase().endsWith(secret.toLowerCase())) return false
      return true
    },
  },
  // ── bare hex digests (MD5/NTLM 32, SHA1 40 with context, SHA2 64/96/128) ─
  {
    re: /(^|[^A-Za-z0-9])([a-fA-F0-9]{128}|[a-fA-F0-9]{96}|[a-fA-F0-9]{64}|[a-fA-F0-9]{40}|[a-fA-F0-9]{32})(?![A-Za-z0-9])/gm,
    kind: (_pre, secret, opts) => (opts.flagFile && secret.length === 32 ? 'FLAG' : 'HASH'),
    accept: hexAccept,
  },
]

type Found = { start: number; end: number; secret: string; kind: SecretKind }

export class Redactor {
  private readonly memo = new Map<string, string>()
  private knownRe: RegExp | null = null

  constructor(
    private readonly key: Uint8Array,
    public state: RedactState,
  ) {}

  /** keyB64: 32 random bytes as base64, kept in $.store. */
  static async create(keyB64: string, state: RedactState): Promise<Redactor> {
    return new Redactor(Uint8Array.from(atob(keyB64), c => c.charCodeAt(0)), state)
  }

  static newKey(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return btoa(bin)
  }

  private async digest(secret: string): Promise<string> {
    // Keyed hash: the key comes first, so without it the digest can't be recomputed.
    const value = new TextEncoder().encode(secret)
    const data = new Uint8Array(this.key.length + value.length)
    data.set(this.key)
    data.set(value, this.key.length)
    const sum = await crypto.subtle.digest('SHA-256', data)
    return [...new Uint8Array(sum)]
      .slice(0, 16)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  }

  /** The placeholder for a secret, minting a new one the first time. */
  async label(secret: string, kind: SecretKind): Promise<string> {
    const hit = this.memo.get(secret)
    if (hit) return hit
    const d = await this.digest(secret)
    let label = this.state.labels[d]
    if (!label) {
      const n = (this.state.counters[kind] ?? 0) + 1
      this.state.counters[kind] = n
      label = `[${kind}-${n}]`
      this.state.labels[d] = label
    }
    this.memo.set(secret, label)
    this.knownRe = null
    return label
  }

  async redact(text: string, opts: RedactOptions = {}): Promise<string> {
    if (!text) return text
    let out = text
    for (const rule of RULES) {
      if (rule.only && !rule.only(opts)) continue
      const found: Found[] = []
      for (const m of out.matchAll(rule.re)) {
        const pre = m[1] ?? ''
        const secret = m[2]
        if (!secret || PLACEHOLDER.test(secret)) continue
        if (rule.accept && !rule.accept(secret, pre, out, m.index ?? 0)) continue
        const kind = typeof rule.kind === 'function' ? rule.kind(pre, secret, opts) : rule.kind
        const start = (m.index ?? 0) + pre.length
        found.push({ start, end: start + secret.length, secret, kind })
      }
      if (found.length > 0) out = await this.replace(out, found)
    }
    return this.replaceKnown(out)
  }

  /** Redacts every string inside a JSON-like value. */
  async redactDeep(value: unknown, opts: RedactOptions = {}): Promise<unknown> {
    if (typeof value === 'string') return this.redact(value, opts)
    if (Array.isArray(value)) return Promise.all(value.map(v => this.redactDeep(v, opts)))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[k] = await this.redactDeep(v, opts)
      return out
    }
    return value
  }

  private async replace(text: string, found: Found[]): Promise<string> {
    let out = ''
    let last = 0
    for (const f of found) {
      if (f.start < last) continue
      out += text.slice(last, f.start) + (await this.label(f.secret, f.kind))
      last = f.end
    }
    return out + text.slice(last)
  }

  /**
   * A secret seen once is hidden everywhere after, even with no context
   * around it (`echo hunter2!`). Short or plain-word values are skipped so a
   * password like "admin" doesn't erase every "admin" in the story.
   */
  private replaceKnown(text: string): string {
    const known = [...this.memo.keys()].filter(
      s => s.length >= 8 || (s.length >= 6 && /[^A-Za-z]/.test(s)),
    )
    if (known.length === 0) return text
    if (!this.knownRe) {
      const alts = known
        .sort((a, b) => b.length - a.length)
        .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      this.knownRe = new RegExp(alts.join('|'), 'g')
    }
    return text.replace(this.knownRe, s => this.memo.get(s) ?? s)
  }
}

/** Command reads a .env-style file (cat .env, Read .env.local ...). */
export function readsEnvFile(text: string): boolean {
  return /(^|[\s/'"])\.env(\.[\w-]+)?\b/.test(text) && !/\.env\.(example|sample|template)\b/.test(text)
}

/** Command reads a credentials list. */
export function readsCredFile(text: string): boolean {
  return /(^|[\s/'"])[\w.-]*(cred|passw|secret|login|hash|users?\.txt|loot)[\w.-]*/i.test(text)
}

/** Command reads a CTF flag file. */
export function readsFlagFile(text: string): boolean {
  return /(^|[\s/'"])(user|root|local|proof)\.txt\b|(^|[\s/'"])flag[\w.-]*/i.test(text)
}
