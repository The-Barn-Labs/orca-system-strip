import type { BatteryReading } from './sources/battery.ts'
import type { GpuReading } from './sources/gpu.ts'
import type { Pressure } from './sources/memory.ts'
import type { TopApp } from './sources/processes.ts'

export type ItemId = 'cpu' | 'gpu' | 'memory' | 'battery' | 'clock'
export type Tone = 'neutral' | 'warning' | 'danger'
export type ItemState = { text: string; tone: Tone; tooltip: string; visible: boolean }

export const ITEM_IDS: readonly ItemId[] = ['cpu', 'gpu', 'memory', 'battery', 'clock']

/** Shown until the first reading, and when a source keeps failing. Same text as the manifest. */
export const PLACEHOLDER: Record<ItemId, string> = { cpu: 'CPU –', gpu: 'GPU –', memory: 'Mem –', battery: 'Bat –', clock: '--:--' }

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

/** A percent padded with a figure space so one-digit values keep the bar from shifting. */
export function pct(n: number): string {
  return String(Math.round(n)).padStart(2, ' ') + '%'
}

export function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1) + ' GB'
}

const shown = (text: string, tone: Tone, tooltip: string): ItemState => ({ text, tone, tooltip, visible: true })

export function cpuItem(percent: number, smoothed: number | null, top: TopApp[] | null): ItemState {
  const tooltip = top && top.length ? 'Top apps: ' + top.map((a) => `${a.name} ${a.value}%`).join(' · ') : 'CPU busy across all cores'
  return shown('CPU ' + pct(percent), loadTone(smoothed), tooltip)
}

export function gpuItem(r: GpuReading, smoothed: number | null): ItemState {
  return shown('GPU ' + pct(r.utilization), loadTone(smoothed), r.models.join(', ') || 'GPU')
}

const PRESSURE_WORD: Record<Pressure, string> = { normal: 'normal', warn: 'warning', critical: 'critical' }

export function memoryItem(used: { usedBytes: number; percent: number }, totalBytes: number, pressure: Pressure | null, top: TopApp[] | null): ItemState {
  const lines = [`${gb(used.usedBytes)} of ${gb(totalBytes)} used`, 'Pressure: ' + (pressure ? PRESSURE_WORD[pressure] : 'unknown')]
  if (top && top.length) lines.push('Top apps: ' + top.map((a) => `${a.name} ${gb(a.value)}`).join(' · '))
  return shown('Mem ' + pct(used.percent), pressureTone(pressure), lines.join('\n'))
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

export function batteryItem(b: BatteryReading): ItemState {
  if (!b.present) return { text: PLACEHOLDER.battery, tone: 'neutral', tooltip: 'No battery', visible: false }
  return shown('Bat ' + pct(b.percent) + (b.onPower ? ' ⚡' : ''), batteryTone(b), batteryTooltip(b))
}

export function clockItem(now: Date, h24: boolean): ItemState {
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const hours = now.getHours()
  const text = h24 ? `${String(hours).padStart(2, '0')}:${minutes}` : `${hours % 12 || 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`
  const tooltip = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  return shown(text, 'neutral', tooltip)
}

export function dashItem(id: ItemId, reason: string): ItemState {
  return shown(PLACEHOLDER[id], 'neutral', reason)
}
