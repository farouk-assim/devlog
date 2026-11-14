# devlog

A Claude Code mod that journals everything you do in a project (terminal, SSH and
REPL sessions, Claude Code sessions, file changes) so a paper can be written from it
later: a pentest report, a portfolio presentation, a lab write-up.

**All four stages are built**: capture, the band, gaps, papers (see PLAN.md).

## Setup

1. The zsh side: `~/.config/devlog/devlog.zsh`, sourced by the `devlog` block in `~/.zshrc`.
2. In a project: `/journal start`. In a terminal tab of that project: `devlog-tab`
   to capture outputs too (type `exit` to stop capturing).

## Commands

`/journal start | pause | resume | end | status` · `/gaps` (look for new gaps now, open the gaps pane) ·
`/paper [fr|en] [pentest|portfolio|lab|custom]` (open the paper form)

## The band above the prompt

- No journal here: `Journal off` and **Start journaling** (nothing in `~` or `/`).
- Recording: active time (pauses excluded), event count, gap badge, **Pause**,
  **Generate paper**, **End**. `Run devlog-tab to capture outputs` shows when the
  last commands came from a tab without a capture.
- Paused: frozen timer, **Resume** instead of Pause.
- End asks `End the session without a paper?` first (Cancel / End session).

## Gaps

Every 5 minutes (and on `/gaps`) the steps journaled since the last check are read: commands
captured by `devlog-tab` with their outputs, file and folder changes, Claude's actions and your
prompts, and the silences between them (a hint, never a gap by itself). A fast model (Haiku)
lists the steps that don't follow from the ones before; a stronger one (Sonnet) confirms each
with a question, or drops it. Your earlier answers are context for both.
While 20 gaps wait for an answer, checking stops (the band says `checking paused`); it picks up
where it stopped once you explain some. In the gaps pane (`/gaps` or the band's
`N gaps · Explain`), the grey line under each gap is why it was flagged. Answer the question;
the model closes the gap or asks a follow-up. Answers are redacted before they are stored or sent.

## Papers

`/paper` (or **Generate paper** in the band) opens the form: type (Pentest report, Portfolio
presentation, Lab write-up, Custom), language (Français, English) and what it should focus on.
Unexplained gaps can be explained first; the ones left are marked as unexplained in the paper.
Then choose **Generate and end session** or **Generate and keep journaling**. The mod gathers the
story (commands with outputs, file changes, your work with Claude), the gaps with your answers
and the redacted file diffs into `.devlog/papers/.context-<name>.md`, and a normal Claude turn
writes the paper to `.devlog/papers/<date>-<type>.md`. **Open** shows it.

In the terminal, click a button or focus the band with ctrl+x tab; ctrl+x ctrl+a
collapses it.

## What it records, where

Everything lives in `<project>/.devlog/` (added to `.gitignore`, owner-only):
the journal `YYYY-MM-DD[.N].jsonl` (rotated under 3 MiB), `state.json`, the raw
`terminal.jsonl` and `tty-*.log` written by zsh, and git snapshots in
`refs/devlog/<journal id>` (or `.devlog/snapshots.git` outside a git repo).

Secrets are replaced with stable placeholders (`[PASSWORD-1]`, `[HASH-2]`, `[TOKEN-3]`,
`[KEY-1]`, `[SECRET-1]`, `[FLAG-1]`) before anything reaches the journal or a model.
The raw zsh files (`terminal.jsonl`, `tty-*.log`) are NOT redacted: never share `.devlog/`.
Start a command with a space to keep it out of the journal.

## Develop

Tests: `claude plugin test plugins/devlog`. Validation: `claude plugin validate plugins/devlog`.
Type-check: `npx -p typescript tsc -p plugins/devlog` once Claude Code has loaded the mod
(it writes the API types into `.claude-plugin/types/`).
`devlog-tab` only works in a project that has a journal (never in `~` or `/`).
