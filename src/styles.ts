// How an item's value is drawn in the status bar: words, number, bar, trend or level.

export type Style = 'words' | 'number' | 'bar' | 'trend' | 'level'
export type StyledId = 'cpu' | 'gpu' | 'memory' | 'battery'
export type IconName = 'activity' | 'gauge' | 'layers' | 'plug' | 'zap'

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
  switch (STYLES[id].includes(style) ? style : 'number') {
    case 'words':
      return `${LABEL[id]} ${num(p)}`
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

export function dashText(id: StyledId, style: Style): string {
  return style === 'words' ? `${LABEL[id]} –` : '–'
}
