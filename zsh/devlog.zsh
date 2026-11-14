# devlog.zsh: terminal capture for the "devlog" Claude Code mod.
# Copyright (C) 2026 farouk-assim. Licensed under GPL-3.0-or-later: https://github.com/farouk-assim/devlog
# Sourced from the "devlog" block in ~/.zshrc. Only does anything in interactive shells.
#
# ── What it writes (the contract the mod reads) ────────────────────────────────
#
# <project>/.devlog/terminal.jsonl   one JSON object per finished command:
#   {"t":1763130000123,"dur":842,"exit":0,"cwd":"L1VzZXJz...","cmd":"bm1hcCAt...",
#    "tty":"tty-20261114-153012-4242.log","o0":10240,"o1":13377}
#   t     command start, Unix epoch in milliseconds
#   dur   duration in milliseconds
#   exit  exit status ($?); 130 = Ctrl-C, 127 = command not found
#   cwd   base64 of the directory the command started in (UTF-8, no wrapping)
#   cmd   base64 of the command line exactly as typed (may contain newlines)
#   tty   file name (inside the same .devlog/) of this tab's capture, "" if none
#   o0/o1 byte range [o0, o1) of the command's output inside that capture,
#         both -1 when the tab isn't captured. Raw bytes: ANSI escapes,
#         \r, backspaces, echoed typeahead and zsh's end-of-output marker
#         ("%" + spaces + "\r \r", PROMPT_SP) may be included.
#
# <project>/.devlog/tty-YYYYMMDD-HHMMSS-<pid>.log   raw terminal capture made by
#   `devlog-tab` (macOS `script -q -F`). Contains everything the tab displayed,
#   including ssh / nc / REPL sessions, and keeps growing while the tab is open.
#
# ── Rules ───────────────────────────────────────────────────────────────────────
# * The project is the nearest parent directory (starting at $PWD) that has a
#   journal (.devlog/state.json, made by /journal start). Your home folder and
#   / never count. Lines go to that project's terminal.jsonl.
# * Nothing is logged unless <project>/.devlog/recording exists (the mod creates
#   it on start/resume and deletes it on pause/end).
# * A command typed with a leading space is never logged (private command).
# * devlog-tab / devlog-status themselves are not logged.
# * Each line is written with a single O_APPEND write(), so several tabs can
#   append at the same time. To rotate, the mod should rename terminal.jsonl
#   and then read the renamed file; the next command recreates terminal.jsonl.
# * Files are created owner-only (0600 / 0700). They hold RAW data, secrets
#   included: the mod redacts when it reads, never commit .devlog/.

[[ -o interactive ]] || return 0

zmodload zsh/datetime            # $EPOCHREALTIME, strftime
zmodload -F zsh/stat b:zstat     # zstat only (doesn't shadow /usr/bin/stat)
zmodload zsh/system              # sysopen, syswrite
zmodload zsh/zselect             # zselect: sleep without forking

# Find the project root: nearest dir with a journal (.devlog/state.json), never
# $HOME or / (same rule as the mod). Result in $REPLY.
_devlog_root() {
  emulate -L zsh
  local d=${1:-$PWD}
  while true; do
    if [[ $d != $HOME && $d != / && -f $d/.devlog/state.json ]]; then REPLY=$d; return 0; fi
    [[ $d == / ]] && return 1
    d=${d:h}
  done
}

# Current size of this tab's capture file, waiting until it stops growing
# (`script` writes asynchronously). Result in $REPLY, -1 on failure.
_devlog_ttysize() {
  emulate -L zsh
  local -a s
  local prev=-1 n=0
  REPLY=-1
  while (( n++ < 20 )); do               # at most ~200 ms
    zstat -A s +size -- $DEVLOG_TTY 2>/dev/null || return 1
    (( s[1] == prev )) && break
    prev=$s[1]
    zselect -t 1                          # 1/100 s
  done
  REPLY=$prev
}

# Runs right before a command executes. $1 = command line as typed.
_devlog_preexec() {
  emulate -L zsh
  typeset -g _devlog_cmd=
  local typed=${1:-$3}
  [[ -z $typed || $typed == ' '* ]] && return
  local -a words=(${(z)typed})          # split like the shell would
  [[ $words[1] == (devlog-tab|devlog-status) ]] && return
  _devlog_root || return
  local dir=$REPLY/.devlog
  [[ -e $dir/recording ]] || return

  typeset -g _devlog_dir=$dir _devlog_cwd=$PWD _devlog_t0=$EPOCHREALTIME
  typeset -g _devlog_o0=-1
  # Only reference the capture if it lives in this same project's .devlog/.
  if [[ -n $DEVLOG_TTY && ${DEVLOG_TTY:h:A} == ${dir:A} ]] && _devlog_ttysize; then
    _devlog_o0=$REPLY
  fi
  _devlog_cmd=$typed
}

# Runs right after a command finishes, before the prompt is drawn.
_devlog_precmd() {
  local ex=$?                            # must be first: emulate resets $?
  emulate -L zsh
  [[ -n $_devlog_cmd ]] || return $ex

  local -i now=$(( EPOCHREALTIME * 1000 )) t0=$(( _devlog_t0 * 1000 ))
  local tty= o0=-1 o1=-1
  if (( _devlog_o0 >= 0 )) && _devlog_ttysize; then
    tty=${DEVLOG_TTY:t} o0=$_devlog_o0 o1=$REPLY
  fi
  local c64 w64
  c64=$(print -rn -- $_devlog_cmd | base64)
  w64=$(print -rn -- $_devlog_cwd | base64)

  local line fd
  printf -v line '{"t":%d,"dur":%d,"exit":%d,"cwd":"%s","cmd":"%s","tty":"%s","o0":%d,"o1":%d}\n' \
    $t0 $(( now - t0 )) $ex "$w64" "$c64" "$tty" $o0 $o1   # quoted: zsh drops empty unquoted args
  if sysopen -w -a -o creat,nofollow -m 600 -u fd -- $_devlog_dir/terminal.jsonl 2>/dev/null; then
    syswrite -o $fd -- $line             # one write() = one atomic append
    exec {fd}>&-
  fi
  _devlog_cmd=
  return $ex
}

# Start a captured sub-shell in this tab. Type `exit` to stop capturing.
devlog-tab() {
  emulate -L zsh
  if [[ -n $DEVLOG_TTY ]]; then
    print -u2 "devlog: this tab is already captured (${DEVLOG_TTY:t})"
    return 1
  fi
  if ! _devlog_root; then
    print -u2 "devlog: no journal here. Open Claude Code in this project and run /journal start first."
    return 1
  fi
  local root=$REPLY
  local f=$root/.devlog/tty-$(strftime %Y%m%d-%H%M%S $EPOCHSECONDS)-$$.log
  print "devlog: capturing this tab to ${f#$root/}   (type 'exit' to stop)"
  ( umask 077; DEVLOG_TTY=$f script -q -F $f )   # no command = runs $SHELL -i
  print "devlog: capture stopped (${f:t})"
}

# Show what devlog sees from here.
devlog-status() {
  emulate -L zsh
  if _devlog_root; then
    print "project:   $REPLY"
    if [[ -e $REPLY/.devlog/recording ]]; then print "recording: yes"; else print "recording: no (paused or not started)"; fi
  else
    print "project:   none (no journal here or above; run /journal start in Claude Code)"
  fi
  if [[ -n $DEVLOG_TTY ]]; then print "capture:   ${DEVLOG_TTY:t}"; else print "capture:   off (run devlog-tab to capture outputs)"; fi
}

# Register hooks: precmd first so it sees the real $?, preexec last so the
# timer starts as late as possible. The :# filters avoid duplicates on re-source.
typeset -ga precmd_functions preexec_functions
precmd_functions=(_devlog_precmd ${precmd_functions:#_devlog_precmd})
preexec_functions=(${preexec_functions:#_devlog_preexec} _devlog_preexec)
