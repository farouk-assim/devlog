# devlog

A [Claude Code](https://claude.com/claude-code) mod that keeps a journal of everything you do in a
project — terminal commands and their outputs, SSH / netcat / REPL sessions, your Claude Code
sessions, file changes — then finds the **gaps in the story**, asks you about them, and writes a
**paper** from it: a pentest report, a lab write-up, a portfolio presentation.

Made for security labs (HackTheBox, TryHackMe, CTFs), pentests and coding projects, where the
hard part is not doing the work but writing it up afterwards.

## What it does

- **Captures** — a zsh hook logs every command (time, duration, exit code, folder); in a tab
  where you run `devlog-tab`, outputs are captured too, including inside `ssh`, `nc` or a REPL.
  Claude Code sessions are logged, and files are snapshotted every 5 minutes into a hidden git
  ref (`refs/devlog/*`) without touching your branches, index or history.
- **Redacts at capture time** — passwords, hashes, tokens, private keys, `.env` values and flags
  become stable placeholders (`[PASSWORD-1]`, `[HASH-2]`, `[TOKEN-3]`…) before anything is
  written to the journal or sent to a model. Real values are never stored.
- **A band above the prompt** — recording / paused, active time, event count, open gaps,
  Pause / Resume, Generate paper, End.
- **Finds gaps** — a fast model (Haiku) reads each step A → B with its output and flags the ones
  with no clear thread ("where did that username come from?"); a stronger one (Sonnet) confirms
  them and asks you. Your answers become context for the next checks.
- **Writes the paper** — `/paper` gathers the story, your explanations and the file diffs, and a
  normal Claude turn writes it to `.devlog/papers/`. Unexplained steps are marked as such.

## Requirements

- Claude Code with mods (function hooks) — 2.1.32x or later
- zsh, macOS (`devlog-tab` uses macOS `script -F`; Linux support is welcome, see Contributing)
- git (for file snapshots; optional)

## Install

1. The mod, in Claude Code:

   ```
   /plugin install devlog --marketplace farouk-assim/devlog
   ```

2. The zsh side (logs commands, `devlog-tab` captures outputs):

   ```bash
   mkdir -p ~/.config/devlog
   curl -fsSL https://raw.githubusercontent.com/farouk-assim/devlog/main/zsh/devlog.zsh -o ~/.config/devlog/devlog.zsh
   echo '[[ -r ~/.config/devlog/devlog.zsh ]] && source ~/.config/devlog/devlog.zsh' >> ~/.zshrc
   ```

   Read `zsh/devlog.zsh` first: its header documents exactly what it writes and when.

## Use

1. Open Claude Code **in the project folder** and run `/journal start` (or click
   **Start journaling** in the band). `.devlog/` is created and added to `.gitignore`.
2. In a terminal tab, inside the project folder (or a subfolder): `devlog-tab`. Work normally;
   `exit` stops the capture.
3. `/gaps` to look for gaps now (it also runs every 5 minutes) and explain them.
4. `/paper [fr|en] [pentest|portfolio|lab|custom]` to write the paper.

| Command | What |
| --- | --- |
| `/journal start \| pause \| resume \| end \| status` | the journal |
| `/gaps` | check now, open the gaps pane |
| `/paper [fr\|en] [type]` | open the paper form |
| `devlog-tab` (zsh) | capture this tab's outputs |
| `devlog-status` (zsh) | what devlog sees from here |

Start a command with a space to keep it out of the journal.

## Privacy and security

- Everything stays in `<project>/.devlog/` (owner-only permissions). Never commit or share it:
  the raw zsh files (`terminal.jsonl`, `tty-*.log`) are **not** redacted.
- The journal, the context sent to models and the papers only hold placeholders.
- Model calls go through your own Claude Code session (Haiku and Sonnet for gaps, your main
  model for the paper).
- Redaction is pattern-based: it catches a lot, not everything. Read a paper before you publish it.

Found a way a secret slips through? Please open an issue (with a fake value), or a PR with a
test in `plugins/devlog/tests/redact.test.ts`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Ideas, bug reports and false-positive gaps are all welcome.

## License

Copyright (C) 2026 farouk-assim

devlog is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of
the License, or (at your option) any later version. See [LICENSE](LICENSE).
