export type Settings = {
  showCpu: boolean
  showGpu: boolean
  showMemory: boolean
  showBattery: boolean
  showClock: boolean
  clock24h: boolean
  refreshSeconds: 1 | 2 | 5
}

export const DEFAULTS: Settings = {
  showCpu: true,
  showGpu: true,
  showMemory: true,
  showBattery: true,
  showClock: true,
  clock24h: true,
  refreshSeconds: 2
}

const BOOLEAN_KEYS = ['showCpu', 'showGpu', 'showMemory', 'showBattery', 'showClock', 'clock24h'] as const
const REFRESH: readonly unknown[] = [1, 2, 5]

/** Settings Orca hands back hold only what the person changed; everything else is the default. */
export function readSettings(raw: unknown): Settings {
  const out: Settings = { ...DEFAULTS }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const r = raw as Record<string, unknown>
  for (const key of BOOLEAN_KEYS) if (typeof r[key] === 'boolean') out[key] = r[key]
  if (REFRESH.includes(r.refreshSeconds)) out.refreshSeconds = r.refreshSeconds as Settings['refreshSeconds']
  return out
}
