// Turns raw terminal bytes (what `script` saved) into the text a person saw.

/**
 * Drops escape strings, then replays each line the way a terminal draws it:
 * \r and backspace move the cursor, cursor-left/right/column escapes move it
 * (REPLs and shells redraw the whole line on every key this way), erase
 * escapes clear, and later text overwrites earlier text. Colors and vertical
 * moves are ignored. zsh's end-of-output marker ("%" + spaces + "\r \r")
 * renders as an empty line and disappears.
 */
export function cleanTerminal(raw: string): string {
  const flat = raw
    .replace(/\x9b/g, '\x1b[') // 8-bit CSI -> 7-bit
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '') // OSC: window titles, hyperlinks
    .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, '') // DCS / PM / APC / SOS strings
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '') // charset selection
    .replace(/\x1b(?!\[)[ -~]/g, '') // other two-byte escapes (CSI is kept for renderLine)

  return flat
    .split('\n')
    .map(renderLine)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const CSI_PARAM = /[0-?]/
const CSI_INTER = /[ -/]/

function renderLine(line: string): string {
  let cells: string[] = []
  let col = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? ''
    if (ch === '\x1b' && line[i + 1] === '[') {
      let j = i + 2
      let params = ''
      while (j < line.length && CSI_PARAM.test(line[j] ?? '')) params += line[j++]
      while (j < line.length && CSI_INTER.test(line[j] ?? '')) j++
      const final = line[j] ?? ''
      i = j
      const first = Number.parseInt(params.split(';')[0] ?? '', 10)
      const n = Number.isNaN(first) ? 1 : Math.max(1, first)
      switch (final) {
        case 'D': // cursor left
          col = Math.max(0, col - n)
          break
        case 'C': // cursor right
          col += n
          break
        case 'G': // cursor to column
          col = n - 1
          break
        case 'K': // erase in line: 0 to end, 1 to start, 2 all
          if (Number.isNaN(first) || first === 0) cells = cells.slice(0, col)
          else if (first === 1) for (let c = 0; c <= col; c++) cells[c] = ' '
          else cells = []
          break
        case 'P': // delete characters
          cells.splice(col, n)
          break
        case '@': // insert blanks
          cells.splice(col, 0, ...Array.from({ length: n }, () => ' '))
          break
        case 'X': // erase characters
          for (let c = col; c < col + n; c++) cells[c] = ' '
          break
        default: // colors (m), vertical moves, modes: no effect on the text
      }
      continue
    }
    if (ch === '\r') col = 0
    else if (ch === '\b') col = Math.max(0, col - 1)
    else if (ch === '\t' || (ch >= ' ' && ch !== '\x7f')) {
      cells[col] = ch
      col += 1
    }
    // other control characters (bell, NUL, ...) are dropped
  }
  return Array.from(cells, c => c ?? ' ')
    .join('')
    .replace(/\s+$/, '')
}

export type Excerpt = {
  /** The whole output, when short. */
  text?: string
  /** First and last part, when long. */
  head?: string
  tail?: string
  chars: number
  lines: number
}

export const FULL_LIMIT = 4000
const HEAD_LINES = 40
const TAIL_LINES = 30

/** Keeps short outputs whole, long ones as head + tail. */
export function excerpt(text: string): Excerpt {
  const lines = text === '' ? 0 : text.split('\n').length
  if (text.length <= FULL_LIMIT) return { text, chars: text.length, lines }
  const all = text.split('\n')
  const head = all.slice(0, HEAD_LINES).join('\n').slice(0, 2000)
  const tail = all.slice(-TAIL_LINES).join('\n').slice(-1500)
  return { head, tail, chars: text.length, lines }
}
