# devlog: build plan

Journal everything done in a project, find the gaps in the story, ask about them,
and write a paper from it. Built in four stages, each tested before the next.

## Layout

```
devlog/
  .claude-plugin/plugin.json   manifest
  types/index.d.ts             $.state contract: what the band draws from (BandView)
  hooks/hooks.json             names the hooks module
  hooks/register.tsx           wiring: events, commands, timers, the band's drawing and buttons
  hooks/lib/band.ts            the band's numbers: status, active time, pending commands, hint
  hooks/lib/gaps.ts            gap checks: Haiku pass, Sonnet confirmation, answers, the cursor
  hooks/lib/paper.ts           the paper: context file (story, gaps, redacted diffs) and the turn's prompt
  hooks/lib/io.ts              host IO: files, byte ranges, append, lock (via $.fs / $.process)
  hooks/lib/redact.ts          secrets -> stable placeholders ([PASSWORD-1], [HASH-2]...)
  hooks/lib/clean.ts           ANSI/backspace/CR cleanup, head+tail excerpts
  hooks/lib/terminal.ts        reads terminal.jsonl + tty captures, ssh/REPL splitting
  hooks/lib/rows.ts            Claude Code session rows -> journal events
  hooks/lib/snapshot.ts        git snapshots into refs/devlog/<journal id>
  hooks/lib/journal.ts         state.json, daily journal files, start/pause/resume/end
  tests/*.test.ts(x)           claude plugin test
```

## On disk (project/.devlog/, gitignored, owner-only)

| File | Written by | What |
| --- | --- | --- |
| `recording` | mod | flag: the zsh hook logs only while it exists |
| `terminal.jsonl` | zsh | raw command lines (format: header of ~/.config/devlog/devlog.zsh) |
| `tty-*.log` | zsh (`devlog-tab`) | raw terminal captures |
| `YYYY-MM-DD[.N].jsonl` | mod | the journal: redacted events, rotated under 3 MiB |
| `state.json` | mod | status, active time, counters, offsets, redaction label digests, gaps |
| `snapshots.git/` | mod | only when the project is not a git repo |
| `lock/` | mod | short mkdir lock so two Claude sessions don't merge twice |

## Journal event (one JSON line)

`{ id, t, src, kind, ... }` with `src`:
- `journal`: start / pause / resume / end
- `terminal`: `command` (cmd, cwd, exit, dur, out excerpt + pointer to the full byte range),
  `remote-steps` (ssh/nc/REPL capture split into commands by a fast model)
- `claude`: prompt / response / tool-result / notice / ... (normalized blocks)
- `files`: `snapshot` (commit in refs/devlog/<id>, changed paths)

## Stages

1. **Capture** (done): /journal start|pause|resume|end|status, recording flag,
   terminal merge every 5 min, session rows, git snapshots, redaction, rotation, state.
2. **Band** (done): AbovePrompt band (idle / recording / paused / end confirm), timer, counters,
   devlog-tab hint. State mirrored into `$.state` for drawing. The counter adds the
   terminal commands still waiting for the 5-minute merge (re-counted every 5 s).
   Generate paper and the gap badge only toast until stages 3 and 4.
3. **Gaps** (done, test period): every check (5-minute tick, not on pause; /gaps after merging
   the terminal) reads the events written since the last one (cursor `gapScan` in state.json).
   Haiku reads the new steps in chunks of 40 events (a chunk too big for one prompt is halved, never cut) (commands captured by devlog-tab with outputs,
   file changes, Claude actions and prompts, journal pauses; silences of 15+ min marked as a
   hint), with the last 10 checked steps and the person's answers as context, and lists steps
   that don't follow. Sonnet confirms each with a question or drops it. At 20 open gaps checking
   stops (no read, no model call) and resumes right after the gap it stopped at, with the new
   answers as context. Answers: Haiku judges enough / follow-up (3 at most).
   The reason (Haiku's "why") shows grey under each gap, for tuning the prompts.
4. **Paper** (done): `/paper [fr|en] [type]` or the band's Generate paper opens the pane: type, language,
   focus, "N gaps unexplained · Explain first", then "Generate and end session" / "Generate and keep
   journaling". The mod writes `.devlog/papers/.context-<name>.md` (the journal's story in order with
   outputs, the gaps and answers with UNEXPLAINED ones marked, the redacted diff from the first to
   the last snapshot), then submits a normal Claude turn that reads it and writes
   `.devlog/papers/<date>-<type>.md`. turn.start/turn.complete follow that turn: Paper ready (Open /
   Done) or a clear failure. The paper turn is left out of the journal; papers are listed in
   state.json `papers`.
