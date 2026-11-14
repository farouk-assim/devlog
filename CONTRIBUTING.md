# Contributing to devlog

Thanks for helping! Issues, ideas and pull requests are welcome.

## Good first contributions

- **Gaps that should not have been asked** (false positives) or **missed gaps**: open an issue with
  the two steps (redacted), the question devlog asked, and why it was wrong. The detection is tuned
  through the model prompts in `plugins/devlog/hooks/lib/gaps.ts`.
- **Secrets that slip through redaction**: an issue with a *fake* value, or a PR adding a rule in
  `hooks/lib/redact.ts` and a test in `tests/redact.test.ts`.
- **Linux support** for `devlog-tab` (`script` takes different flags there).
- Other shells (bash, fish).

## Layout

```
.claude-plugin/marketplace.json   the marketplace (this repo)
plugins/devlog/                   the mod: hooks module, lib/, tests/, types/
zsh/devlog.zsh                    the zsh side (its header is the file-format contract)
```

`plugins/devlog/PLAN.md` explains the design, the on-disk files and the journal event format.

## Before a pull request

```bash
claude plugin validate plugins/devlog
claude plugin test plugins/devlog
```

Both must pass. Keep changes small and focused, add a test for what you fix, and never commit a
real secret, a `.devlog/` folder or a capture.

## License of contributions

devlog is licensed under GPL-3.0-or-later. By sending a contribution, you agree that it is
released under the same license.
