import { STYLES } from './styles.ts'
import type { Style, StyledId } from './styles.ts'

export type Settings = {
  showCpu: boolean
  showGpu: boolean
  showMemory: boolean
  showDisk: boolean
  showNetwork: boolean
  showDiskSpace: boolean
  showBattery: boolean
  showClock: boolean
  clock24h: boolean
  refreshSeconds: 1 | 2 | 5
  cpuStyle: Style
  gpuStyle: Style
  memoryStyle: Style
  diskStyle: Style
  networkStyle: Style
  diskSpaceStyle: Style
  batteryStyle: Style
}

export const STYLE_KEY = {
  cpu: 'cpuStyle',
  gpu: 'gpuStyle',
  memory: 'memoryStyle',
  disk: 'diskStyle',
  network: 'networkStyle',
  space: 'diskSpaceStyle',
  battery: 'batteryStyle'
} as const satisfies Record<StyledId, keyof Settings>

export const DEFAULTS: Settings = {
  showCpu: true,
  showGpu: true,
  showMemory: true,
  showDisk: true,
  showNetwork: true,
  showDiskSpace: true,
  showBattery: true,
  showClock: true,
  clock24h: true,
  refreshSeconds: 2,
  cpuStyle: 'number',
  gpuStyle: 'number',
  memoryStyle: 'number',
  diskStyle: 'number',
  networkStyle: 'number',
  diskSpaceStyle: 'number',
  batteryStyle: 'number'
}

const BOOLEAN_KEYS = ['showCpu', 'showGpu', 'showMemory', 'showDisk', 'showNetwork', 'showDiskSpace', 'showBattery', 'showClock', 'clock24h'] as const
const REFRESH: readonly unknown[] = [1, 2, 5]

/** Settings Orca hands back hold only what the person changed; everything else is the default. */
export function readSettings(raw: unknown): Settings {
  const out: Settings = { ...DEFAULTS }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const r = raw as Record<string, unknown>
  for (const key of BOOLEAN_KEYS) if (typeof r[key] === 'boolean') out[key] = r[key]
  if (REFRESH.includes(r.refreshSeconds)) out.refreshSeconds = r.refreshSeconds as Settings['refreshSeconds']
  // A style the item does not offer (an old or hand-edited value) keeps the default.
  for (const id of Object.keys(STYLE_KEY) as StyledId[]) {
    const value = r[STYLE_KEY[id]]
    if ((STYLES[id] as readonly unknown[]).includes(value)) out[STYLE_KEY[id]] = value as Style
  }
  return out
}
