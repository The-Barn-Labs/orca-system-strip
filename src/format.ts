import type { BatteryReading } from './sources/battery.ts'
import type { GpuReading } from './sources/gpu.ts'
import type { Pressure } from './sources/memory.ts'
import type { TopApp } from './sources/processes.ts'
import { ICON, batteryIcon, dashText, pairText, percentText, styledText } from './styles.ts'
import type { IconName, Style } from './styles.ts'

export type ItemId = 'cpu' | 'gpu' | 'memory' | 'battery' | 'clock'
export type Tone = 'neutral' | 'warning' | 'danger'
export type ItemState = { text: string; icon?: IconName; tone: Tone; tooltip: string; visible: boolean }

export const ITEM_IDS: readonly ItemId[] = ['cpu', 'gpu', 'memory', 'battery', 'clock']

/** Orca's limit on hover text. */
export const TOOLTIP_MAX = 256

/** Shown until the first reading. At the default style it matches the manifest. */
export function placeholderItem(id: ItemId, style: Style): { text: string; icon?: IconName } {
  return id === 'clock' ? { text: '--:--' } : { text: dashText(id, style), icon: ICON[id] }
}

export const SMOOTH_MS = 10_000

/** Mean of the samples taken within `windowMs` of the newest one. */
export class Smoother {
  readonly windowMs: number
  private samples: { at: number; value: number }[] = []

  constructor(windowMs: number) {
    this.windowMs = windowMs
  }

  push(atMs: number, value: number): void {
    this.samples.push({ at: atMs, value })
    this.samples = this.samples.filter((s) => s.at > atMs - this.windowMs)
  }

  average(): number | null {
    if (this.samples.length === 0) return null
    return this.samples.reduce((sum, s) => sum + s.value, 0) / this.samples.length
  }
}

export function loadTone(smoothed: number | null): Tone {
  if (smoothed === null) return 'neutral'
  if (smoothed >= 90) return 'danger'
  if (smoothed >= 70) return 'warning'
  return 'neutral'
}

export function pressureTone(p: Pressure | null): Tone {
  if (p === 'critical') return 'danger'
  if (p === 'warn') return 'warning'
  return 'neutral'
}

/** Only warns on battery power: a plugged-in Mac held at a low charge is fine. */
export function batteryTone(b: BatteryReading): Tone {
  if (!b.present || b.onPower) return 'neutral'
  if (b.percent <= 10) return 'danger'
  if (b.percent <= 20) return 'warning'
  return 'neutral'
}

export function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1) + ' GB'
}

const clip = (tooltip: string) => (tooltip.length > TOOLTIP_MAX ? tooltip.slice(0, TOOLTIP_MAX - 1) + '…' : tooltip)

const shown = (text: string, icon: IconName | undefined, tone: Tone, tooltip: string): ItemState => ({
  text,
  ...(icon ? { icon } : {}),
  tone,
  tooltip: clip(tooltip),
  visible: true
})

export function cpuItem(percent: number, smoothed: number | null, top: TopApp[] | null, style: Style, history: readonly number[]): ItemState {
  const tooltip = top && top.length ? 'Top apps: ' + top.map((a) => `${a.name} ${a.value}%`).join(' · ') : 'CPU busy across all cores'
  return shown(styledText('cpu', style, percent, history), ICON.cpu, loadTone(smoothed), tooltip)
}

export function gpuItem(r: GpuReading, smoothed: number | null, style: Style, history: readonly number[]): ItemState {
  return shown(styledText('gpu', style, r.utilization, history), ICON.gpu, loadTone(smoothed), r.models.join(', ') || 'GPU')
}

const PRESSURE_WORD: Record<Pressure, string> = { normal: 'normal', warn: 'warning', critical: 'critical' }

export function memoryItem(used: { usedBytes: number; percent: number }, totalBytes: number, pressure: Pressure | null, top: TopApp[] | null, style: Style): ItemState {
  const lines = [`${gb(used.usedBytes)} of ${gb(totalBytes)} used`, 'Pressure: ' + (pressure ? PRESSURE_WORD[pressure] : 'unknown')]
  if (top && top.length) lines.push('Top apps: ' + top.map((a) => `${a.name} ${gb(a.value)}`).join(' · '))
  return shown(styledText('memory', style, used.percent, []), ICON.memory, pressureTone(pressure), lines.join('\n'))
}

function batteryTooltip(b: Extract<BatteryReading, { present: true }>): string {
  switch (b.state) {
    case 'discharging':
      return b.remaining ? `Discharging · ${b.remaining} left` : 'Discharging'
    case 'charging':
      return b.remaining ? `Charging · ${b.remaining} until full` : 'Charging'
    case 'charged':
      return 'On power, fully charged'
    case 'not-charging':
      return 'On power, not charging'
  }
}

export function batteryItem(b: BatteryReading, style: Style): ItemState {
  if (!b.present) return { ...placeholderItem('battery', style), tone: 'neutral', tooltip: 'No battery', visible: false }
  return shown(styledText('battery', style, b.percent, []), batteryIcon(b.onPower), batteryTone(b), batteryTooltip(b))
}

export function clockItem(now: Date, h24: boolean): ItemState {
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const hours = now.getHours()
  const text = h24 ? `${String(hours).padStart(2, '0')}:${minutes}` : `${hours % 12 || 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`
  const tooltip = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  return shown(text, undefined, 'neutral', tooltip)
}

export function dashItem(id: ItemId, reason: string, style: Style): ItemState {
  const p = placeholderItem(id, style)
  return shown(p.text, p.icon, 'neutral', reason)
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Bytes in powers of 1000, as macOS shows them: '0 B', '310 KB', '5.1 TB'. */
export function decimalBytes(n: number): string {
  let value = Number.isFinite(n) && n > 0 ? n : 0
  let unit = 0
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const draw = (v: number) => (unit === 0 || v >= 10 ? String(Math.round(v)) : v.toFixed(1) === '10.0' ? '10' : v.toFixed(1))
  let text = draw(value)
  if (text === '1000' && unit < BYTE_UNITS.length - 1) {
    value /= 1000
    unit += 1
    text = draw(value)
  }
  return `${text} ${BYTE_UNITS[unit]}`
}

export const rateText = (bytesPerSecond: number) => decimalBytes(bytesPerSecond) + '/s'

export function spaceTone(percentUsed: number): Tone {
  if (percentUsed >= 95) return 'danger'
  if (percentUsed >= 90) return 'warning'
  return 'neutral'
}

/** Speeds never colour the bar: there is no "too fast". */
export function diskItem(speed: { read: number; write: number }, totals: { read: number; written: number } | null, style: Style, history: readonly number[]): ItemState {
  const lines = [`Disk: reading ${rateText(speed.read)}, writing ${rateText(speed.write)}`]
  if (totals) lines.push(`Since start-up: ${decimalBytes(totals.read)} read · ${decimalBytes(totals.written)} written`)
  return shown(pairText('disk', style, speed.read, speed.write, history), 'database', 'neutral', lines.join('\n'))
}

export function networkItem(speed: { down: number; up: number }, top: TopApp[] | null, style: Style, history: readonly number[]): ItemState {
  const lines = [`Network: down ${rateText(speed.down)}, up ${rateText(speed.up)}`]
  if (top && top.length) lines.push('Top apps, open connections, last 30 s: ' + top.map((a) => `${a.name} ${decimalBytes(a.value)}`).join(' · '))
  return shown(pairText('network', style, speed.down, speed.up, history), 'globe', 'neutral', lines.join('\n'))
}

export function diskSpaceItem(space: { total: number; available: number }, style: Style): ItemState {
  const percent = space.total > 0 ? ((space.total - space.available) / space.total) * 100 : 0
  const text = percentText('Space', style === 'trend' ? 'number' : style, percent, [])
  return shown(text, 'folder', spaceTone(percent), `${decimalBytes(space.available)} free of ${decimalBytes(space.total)}`)
}
