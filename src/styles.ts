// How an item's value is drawn in the status bar: words, number, bar, trend or level.

export type Style = 'words' | 'number' | 'bar' | 'trend' | 'level'
export type StyledId = 'cpu' | 'gpu' | 'memory' | 'battery'
export type IconName = 'activity' | 'gauge' | 'layers' | 'database' | 'globe' | 'folder' | 'plug' | 'zap'
export type SpeedId = 'disk' | 'network'

/** Memory and battery move too slowly for a trend to say anything. */
export const STYLES: Record<StyledId, readonly Style[]> = {
  cpu: ['words', 'number', 'bar', 'trend', 'level'],
  gpu: ['words', 'number', 'bar', 'trend', 'level'],
  memory: ['words', 'number', 'bar', 'level'],
  battery: ['words', 'number', 'bar', 'level']
}

export const STYLE_LABEL: Record<Style, string> = {
  words: 'Words and number',
  number: 'Icon and number',
  bar: 'Bar',
  trend: 'Trend and number',
  level: 'Level and number'
}

export const LABEL: Record<StyledId, string> = { cpu: 'CPU', gpu: 'GPU', memory: 'Mem', battery: 'Bat' }

export const ICON: Record<StyledId, IconName> = { cpu: 'activity', gpu: 'gauge', memory: 'layers', battery: 'zap' }

export function batteryIcon(onPower: boolean): IconName {
  return onPower ? 'plug' : 'zap'
}

export const TREND_LENGTH = 6

const FIGURE_SPACE = ' '
const LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

const clamp = (p: number) => (Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0)

/** A rounded percent padded to two digits with a figure space, so the item keeps its width. */
export function num(p: number): string {
  return String(Math.round(clamp(p))).padStart(2, FIGURE_SPACE) + '%'
}

export function bar(p: number): string {
  const filled = Math.min(5, Math.max(0, Math.round(clamp(p) / 20)))
  return '▰'.repeat(filled) + '▱'.repeat(5 - filled)
}

export function level(p: number): string {
  return LEVELS[Math.min(7, Math.floor(clamp(p) / 12.5))]
}

export function trend(history: readonly number[]): string {
  const recent = history.slice(-TREND_LENGTH).map(level).join('')
  return FIGURE_SPACE.repeat(TREND_LENGTH - Math.min(TREND_LENGTH, history.length)) + recent
}

export function styledText(id: StyledId, style: Style, p: number, history: readonly number[]): string {
  return percentText(LABEL[id], STYLES[id].includes(style) ? style : 'number', p, history)
}

/** A percentage drawn in a style; `label` is the words-style prefix. */
export function percentText(label: string, style: Style, p: number, history: readonly number[]): string {
  switch (style) {
    case 'words':
      return `${label} ${num(p)}`
    case 'bar':
      return bar(p)
    case 'trend':
      return `${trend(history)} ${num(p)}`
    case 'level':
      return level(p) + num(p)
    default:
      return num(p)
  }
}

export const SPEED_LABEL: Record<SpeedId, string> = { disk: 'Disk', network: 'Net' }

const PUNCTUATION_SPACE = '\u2008'
const UNITS = ['K', 'M', 'G'] as const

function speedNumber(n: number): string {
  if (n < 10) {
    const fixed = n.toFixed(1)
    return fixed === '10.0' ? '10' : fixed
  }
  return String(Math.round(n))
}

/**
 * Bytes per second as a number and a unit letter (K, M or G, powers of 1000), padded to the width
 * of three digits and a point: a figure space per missing digit, a punctuation space for a missing point.
 */
export function speed(bytesPerSecond: number): string {
  let n = Number.isFinite(bytesPerSecond) && bytesPerSecond > 0 ? bytesPerSecond / 1000 : 0
  let unit = 0
  while (n >= 1000 && unit < UNITS.length - 1) {
    n /= 1000
    unit += 1
  }
  let text = speedNumber(n)
  if (text === '1000' && unit < UNITS.length - 1) {
    n /= 1000
    unit += 1
    text = speedNumber(n)
  }
  const digits = text.replace('.', '').length
  return FIGURE_SPACE.repeat(Math.max(0, 3 - digits)) + (text.includes('.') ? '' : PUNCTUATION_SPACE) + text + UNITS[unit]
}

/** A speed's place on a 0–100 scale of tens: 1 KB/s is 0, each ×10 adds 20, 100 MB/s is 100. */
export function speedPosition(bytesPerSecond: number): number {
  if (!(bytesPerSecond > 0)) return 0
  return clamp(20 * Math.log10(bytesPerSecond / 1000))
}

const MARK: Record<SpeedId, readonly [string, string]> = { disk: ['R ', 'W '], network: ['↓', '↑'] }

/** Two speeds drawn in a style: `a` is read or down, `b` write or up; `totals` are past a + b, oldest first. */
export function pairText(id: SpeedId, style: Style, a: number, b: number, totals: readonly number[]): string {
  const [ma, mb] = MARK[id]
  const numbers = `${ma}${speed(a)} ${mb}${speed(b)}`
  switch (style) {
    case 'words':
      return `${SPEED_LABEL[id]} ${numbers}`
    case 'bar':
      return `${ma}${bar(speedPosition(a))} ${mb}${bar(speedPosition(b))}`
    case 'trend':
      return `${trend(totals.map(speedPosition))} ${numbers}`
    case 'level':
      return `${level(speedPosition(a))}${ma}${speed(a)} ${level(speedPosition(b))}${mb}${speed(b)}`
    default:
      return numbers
  }
}

export function dashText(id: StyledId, style: Style): string {
  return style === 'words' ? `${LABEL[id]} –` : '–'
}
