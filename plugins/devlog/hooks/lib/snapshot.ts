// Git snapshots of the working tree into a hidden ref, refs/devlog/<journal id>.
//
// The trick: GIT_INDEX_FILE points git at a private index file, so `git add`
// stages into it instead of your real index. Then write-tree + commit-tree make
// a commit object that only refs/devlog/<id> points to: no branch moves, no
// HEAD change, nothing in `git log` (unless you ask for --all).
// A folder that is not a git repo gets a private repo in .devlog/snapshots.git.
import type { Host } from './io'
import type { Journal, JournalEvent, SnapshotState } from './journal'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * Never snapshotted: files that are secrets by nature. (.devlog itself is kept
 * out by .gitignore: git refuses `add` when a pathspec names an ignored path.)
 */
export const SNAPSHOT_EXCLUDES = [
  ':(exclude,glob)**/.env',
  ':(exclude,glob)**/.env.*',
  ':(exclude,glob)**/*.pem',
  ':(exclude,glob)**/*.key',
  ':(exclude,glob)**/*.p12',
  ':(exclude,glob)**/*.pfx',
  ':(exclude,glob)**/*.kdbx',
  ':(exclude,glob)**/id_rsa*',
  ':(exclude,glob)**/id_dsa*',
  ':(exclude,glob)**/id_ecdsa*',
  ':(exclude,glob)**/id_ed25519*',
]

/** Files above this size are left out (wordlists, pcaps, binaries). */
const BIG_FILE = '+10M'

type GitResult = { ok: boolean; out: string; err: string }

/** Runs git in the project with the private index (and private repo if any). */
async function git($: Host, root: string, snap: SnapshotState, args: string[]): Promise<GitResult> {
  const env: Record<string, string> = {
    GIT_INDEX_FILE: snap.index,
    GIT_AUTHOR_NAME: 'devlog',
    GIT_AUTHOR_EMAIL: 'devlog@localhost',
    GIT_COMMITTER_NAME: 'devlog',
    GIT_COMMITTER_EMAIL: 'devlog@localhost',
    GIT_TERMINAL_PROMPT: '0',
  }
  if (snap.isPrivate) {
    env.GIT_DIR = snap.gitDir
    env.GIT_WORK_TREE = root
  }
  const r = await $.process.run(['git', ...args], { cwd: root, env, timeoutMs: 120_000 })
  return { ok: r.exitCode === 0, out: r.stdout.trim(), err: r.stderr.trim() }
}

/** Picks the project's repo, or sets up the private one. */
export async function setupSnapshots($: Host, j: Journal): Promise<SnapshotState> {
  const r = await $.process.run(['git', 'rev-parse', '--absolute-git-dir'], { cwd: j.root })
  const ref = `refs/devlog/${j.state.id}`
  if (r.exitCode === 0) {
    const gitDir = r.stdout.trim()
    return { gitDir, isPrivate: false, ref, index: `${gitDir}/devlog-${j.state.id}.index` }
  }
  const gitDir = `${j.dir}/snapshots.git`
  if (!(await $.fs.exists(`${gitDir}/HEAD`))) {
    const init = await $.process.run(['git', 'init', '--bare', '-q', gitDir])
    if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`)
    await $.fs.write(`${gitDir}/info/exclude`, '.devlog/\n')
  }
  return { gitDir, isPrivate: true, ref, index: `${gitDir}/devlog-${j.state.id}.index` }
}

export type Change = { s: string; p: string }

/**
 * Takes one snapshot into j.state.snapshot. Returns the journal event, or
 * null when nothing changed since the last one.
 */
export async function takeSnapshot($: Host, j: Journal, now: number): Promise<JournalEvent | null> {
  if (!j.state.snapshot) j.state.snapshot = await setupSnapshots($, j)
  const snap = j.state.snapshot
  const root = j.root

  // First run: start the private index from HEAD, so `add` only has to hash changes.
  if (!(await $.fs.exists(snap.index))) {
    const head = snap.isPrivate ? null : await git($, root, snap, ['rev-parse', '-q', '--verify', 'HEAD^{tree}'])
    const seeded = await git($, root, snap, head?.ok ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'])
    if (!seeded.ok) throw new Error(`git read-tree failed: ${seeded.err}`)
  }

  // The journal must never land in a snapshot.
  const ignored = await git($, root, snap, ['check-ignore', '-q', '.devlog/'])
  if (!ignored.ok) throw new Error('.devlog/ is not ignored by git: add it to .gitignore (/journal start does)')

  const big = await bigFiles($, root)
  const add = await git($, root, snap, [
    'add', '-A', '--', '.', ...SNAPSHOT_EXCLUDES, ...big.map(p => `:(exclude,literal)${p}`),
  ])
  if (!add.ok) throw new Error(`git add failed: ${add.err}`)
  const tree = await git($, root, snap, ['write-tree'])
  if (!tree.ok) throw new Error(`git write-tree failed: ${tree.err}`)
  if (tree.out === snap.tree) return null

  const parent = snap.last
  const commit = await git($, root, snap, [
    'commit-tree', tree.out, ...(parent ? ['-p', parent] : []), '-m', `devlog snapshot ${new Date(now).toISOString()}`,
  ])
  if (!commit.ok) throw new Error(`git commit-tree failed: ${commit.err}`)
  const upd = await git($, root, snap, ['update-ref', snap.ref, commit.out, ...(parent ? [parent] : [])])
  if (!upd.ok) throw new Error(`git update-ref failed: ${upd.err}`)

  // What changed: since the last snapshot, or (first one) since HEAD.
  let base = parent
  if (!base && !snap.isPrivate) {
    const head = await git($, root, snap, ['rev-parse', '-q', '--verify', 'HEAD'])
    if (head.ok) base = head.out
  }
  const diff = await git($, root, snap, ['diff-tree', '-r', '-M', '--no-commit-id', '--name-status', base ?? EMPTY_TREE, commit.out])
  const changes = parseNameStatus(diff.out)

  snap.last = commit.out
  snap.tree = tree.out
  snap.at = now
  return {
    t: now,
    src: 'files',
    kind: 'snapshot',
    ref: snap.ref,
    commit: commit.out,
    ...(parent ? { parent } : {}),
    base: base ?? null,
    baseline: !parent,
    changes: changes.slice(0, 200),
    changed: changes.length,
    ...(big.length > 0 ? { skippedBig: big.slice(0, 20) } : {}),
  }
}

export function parseNameStatus(text: string): Change[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [s = '', ...paths] = line.split('\t')
      return { s: s.charAt(0), p: paths.join(' -> ') }
    })
}

async function bigFiles($: Host, root: string): Promise<string[]> {
  const r = await $.process.run(
    [
      'find', '.', '(', '-name', '.git', '-o', '-name', '.devlog', '-o', '-name', 'node_modules', '-o', '-name', '.venv', ')',
      '-prune', '-o', '-type', 'f', '-size', BIG_FILE, '-print',
    ],
    { cwd: root, timeoutMs: 30_000 },
  )
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map(p => p.replace(/^\.\//, ''))
    .slice(0, 500)
}

/**
 * What changed in the files over the whole journal: from the first snapshot
 * (the baseline) to the last one, as `git diff` shows it. Raw text: the caller
 * redacts it. Null when there is no snapshot or git fails.
 */
export async function snapshotDiff($: Host, j: Journal): Promise<{ stat: string; diff: string } | null> {
  const snap = j.state.snapshot
  if (!snap?.last) return null
  const roots = await git($, j.root, snap, ['rev-list', '--max-parents=0', snap.ref])
  const base = roots.ok ? roots.out.split('\n')[0] : ''
  if (!base) return null
  const stat = await git($, j.root, snap, ['diff', '--stat', base, snap.ref])
  const diff = await git($, j.root, snap, ['diff', '--no-color', '--no-ext-diff', base, snap.ref])
  if (!stat.ok || !diff.ok) return null
  return { stat: stat.out, diff: diff.out }
}
