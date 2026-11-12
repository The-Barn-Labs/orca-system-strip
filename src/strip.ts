import type { Disposable } from 'orca'
import type { OrcaWorkerApi } from 'orca/worker'
import { STYLE_KEY, readSettings } from './settings.ts'
import type { Settings } from './settings.ts'
import {
  ITEM_IDS,
  SMOOTH_MS,
  Smoother,
  batteryItem,
  clockItem,
  cpuItem,
  dashItem,
  gpuItem,
  memoryItem,
  placeholderItem
} from './format.ts'
import type { ItemId, ItemState } from './format.ts'
import { cpuPercent, sampleCpu } from './sources/cpu.ts'
import type { CpuSample, CpuTimes } from './sources/cpu.ts'
import { parseGpu } from './sources/gpu.ts'
import type { GpuReading } from './sources/gpu.ts'
import { memoryUsed, parsePressure, parseVmStat } from './sources/memory.ts'
import type { Pressure } from './sources/memory.ts'
import { parseBattery } from './sources/battery.ts'
import type { BatteryReading } from './sources/battery.ts'
import { parsePs, topApps } from './sources/processes.ts'
import type { TopApp } from './sources/processes.ts'
import { TREND_LENGTH } from './styles.ts'
import type { Style, StyledId } from './styles.ts'

export type Source = 'cpu' | 'gpu' | 'memory' | 'battery' | 'clock' | 'procs'

export type Deps = {
  platform: string
  /** Rejects on a non-zero exit, a timeout or a missing command. */
  run(cmd: string, args: readonly string[]): Promise<string>
  cpus(): readonly { times: CpuTimes }[]
  totalmem(): number
  now(): number
  /** Both return a function that cancels the timer. */
  every(ms: number, fn: () => void): () => void
  after(ms: number, fn: () => void): () => void
}

export type Strip = {
  /** Resolves without running anything when the source is switched off or unavailable here. */
  tick(source: Source): Promise<void>
  /** Clears any rate-limit wait, then sends every item whose latest state Orca has not seen. */
  flush(): Promise<void>
  /** Resolves once start-up ticks and the latest settings change have finished. */
  settled(): Promise<void>
  stop(): void
}

export const FAILS_BEFORE_DASH = 3
export const BATTERY_MS = 30_000
export const PROCS_MS = 15_000
export const COMMAND_ID = 'system-strip.openActivityMonitor'
const DEFAULT_RETRY_MS = 2_000
const MIN_RETRY_MS = 250
/** `ioreg` is the costliest read per tick, so the GPU never polls faster than this. */
export const GPU_MIN_MS = 4_000
const SOURCES: readonly Source[] = ['cpu', 'gpu', 'memory', 'battery', 'clock', 'procs']

const COMMANDS = {
  gpu: ['ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator']],
  vmStat: ['vm_stat', []],
  pressure: ['sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']],
  battery: ['pmset', ['-g', 'batt']],
  procs: ['ps', ['-Aeo', 'pid=,pcpu=,rss=,comm=']]
} as const satisfies Record<string, readonly [string, readonly string[]]>

const SHOW_KEY: Record<ItemId, keyof Settings> = {
  cpu: 'showCpu',
  gpu: 'showGpu',
  memory: 'showMemory',
  battery: 'showBattery',
  clock: 'showClock'
}

const same = (a: ItemState | undefined, b: ItemState) =>
  !!a && a.text === b.text && a.icon === b.icon && a.tone === b.tone && a.tooltip === b.tooltip && a.visible === b.visible

export async function startStrip(orca: OrcaWorkerApi, deps: Deps): Promise<Strip> {
  const mac = deps.platform === 'darwin'
  const cores = Math.max(1, deps.cpus().length)
  let settings: Settings = readSettings(await orca.settings.get())

  const latest = {} as Record<ItemId, ItemState>
  const lastSent: Partial<Record<ItemId, ItemState>> = {}
  const fails: Record<Source, number> = { cpu: 0, gpu: 0, memory: 0, battery: 0, clock: 0, procs: 0 }
  const timers = new Map<Source, () => void>()
  const inflight = new Set<Promise<unknown>>()

  let cpuPrev: CpuSample | null = null
  let cpuLast: number | null = null
  let cpuSmooth = new Smoother(SMOOTH_MS)
  let gpuSmooth = new Smoother(SMOOTH_MS)
  let memoryLast: { used: { usedBytes: number; percent: number }; pressure: Pressure | null } | null = null
  let gpuLast: GpuReading | null = null
  let batteryLast: BatteryReading | null = null
  let cpuHistory: number[] = []
  let gpuHistory: number[] = []
  let topCpu: TopApp[] | null = null
  let topMemory: TopApp[] | null = null
  let blockedUntil = 0
  let cancelRetry: (() => void) | null = null
  const busy = new Set<Source>()
  let sending: Promise<void> = Promise.resolve()
  let stopped = false

  const available = (source: Source) => source === 'cpu' || source === 'clock' || mac
  const shown = (id: ItemId, s: Settings = settings) => available(id) && (s[SHOW_KEY[id]] as boolean)
  const enabled = (source: Source, s: Settings = settings) =>
    source === 'procs' ? mac && (s.showCpu || s.showMemory) : shown(source, s)

  function track<T>(p: Promise<T>): Promise<T> {
    inflight.add(p)
    p.finally(() => inflight.delete(p)).catch(() => undefined)
    return p
  }

  const styleOf = (id: ItemId): Style => (id === 'clock' ? 'number' : settings[STYLE_KEY[id as StyledId]])

  function placeholder(id: ItemId): ItemState {
    return { ...placeholderItem(id, styleOf(id)), tone: 'neutral', tooltip: 'System Strip', visible: shown(id) }
  }

  function set(id: ItemId, state: ItemState): void {
    latest[id] = { ...state, visible: state.visible && shown(id) }
  }

  async function sendChanged(): Promise<void> {
    for (const id of ITEM_IDS) {
      if (stopped || deps.now() < blockedUntil) return
      const state = latest[id]
      if (same(lastSent[id], state)) continue
      try {
        await orca.host.call('statusBar.update', { id, ...state })
        lastSent[id] = state
      } catch (error: unknown) {
        const e = error as { code?: string; retryAfterMs?: number; message?: string }
        if (e?.code === 'rate_limited') {
          const delay = Math.max(MIN_RETRY_MS, e.retryAfterMs ?? DEFAULT_RETRY_MS)
          blockedUntil = deps.now() + delay
          if (!cancelRetry) cancelRetry = deps.after(delay, () => void track(flush()))
          return
        }
        orca.log(`statusBar.update ${id} failed: ${e?.message ?? String(error)}`)
        lastSent[id] = state
      }
    }
  }

  function send(): Promise<void> {
    sending = sending.then(sendChanged, sendChanged)
    return sending
  }

  function flush(): Promise<void> {
    blockedUntil = 0
    cancelRetry = null
    return send()
  }

  function fail(source: 'gpu' | 'memory' | 'battery', reason: string): void {
    fails[source] += 1
    if (fails[source] >= FAILS_BEFORE_DASH) set(source, dashItem(source, reason, styleOf(source)))
  }

  async function read(command: keyof typeof COMMANDS): Promise<string | null> {
    const [cmd, args] = COMMANDS[command]
    try {
      return await deps.run(cmd, args)
    } catch {
      return null
    }
  }

  const remember = (history: number[], value: number) => [...history, value].slice(-TREND_LENGTH)

  function redrawCpu(): void {
    if (cpuLast !== null) set('cpu', cpuItem(cpuLast, cpuSmooth.average(), topCpu, styleOf('cpu'), cpuHistory))
  }

  function redrawGpu(): void {
    if (gpuLast && fails.gpu < FAILS_BEFORE_DASH) set('gpu', gpuItem(gpuLast, gpuSmooth.average(), styleOf('gpu'), gpuHistory))
  }

  function redrawBattery(): void {
    if (batteryLast && fails.battery < FAILS_BEFORE_DASH) set('battery', batteryItem(batteryLast, styleOf('battery')))
  }

  /** After a style change: the item from its last reading, or its dash or placeholder in the new style. */
  function restyle(id: StyledId): void {
    const dashed = id !== 'cpu' && fails[id] >= FAILS_BEFORE_DASH
    const last = { cpu: cpuLast, gpu: gpuLast, memory: memoryLast, battery: batteryLast }[id]
    if (dashed) set(id, dashItem(id, latest[id].tooltip, styleOf(id)))
    else if (last === null) latest[id] = placeholder(id)
    else if (id === 'cpu') redrawCpu()
    else if (id === 'gpu') redrawGpu()
    else if (id === 'memory') redrawMemory()
    else redrawBattery()
  }

  function redrawMemory(): void {
    if (memoryLast && fails.memory < FAILS_BEFORE_DASH) {
      set('memory', memoryItem(memoryLast.used, deps.totalmem(), memoryLast.pressure, topMemory, styleOf('memory')))
    }
  }

  async function readSource(source: Source): Promise<void> {
    switch (source) {
      case 'cpu': {
        const sample = sampleCpu(deps.cpus())
        const prev = cpuPrev
        cpuPrev = sample
        if (!prev) return
        const percent = cpuPercent(prev, sample)
        if (percent === null) return
        cpuSmooth.push(deps.now(), percent)
        cpuLast = percent
        cpuHistory = remember(cpuHistory, percent)
        redrawCpu()
        // A free check that also repairs the clock after the Mac wakes from sleep.
        if (enabled('clock')) set('clock', clockItem(new Date(deps.now()), settings.clock24h))
        return
      }
      case 'gpu': {
        const out = await read('gpu')
        const reading = out === null ? null : parseGpu(out)
        if (!reading) return fail('gpu', 'ioreg failed')
        fails.gpu = 0
        gpuSmooth.push(deps.now(), reading.utilization)
        gpuLast = reading
        gpuHistory = remember(gpuHistory, reading.utilization)
        redrawGpu()
        return
      }
      case 'memory': {
        const [vm, level] = await Promise.all([read('vmStat'), read('pressure')])
        const pages = vm === null ? null : parseVmStat(vm)
        if (!pages) return fail('memory', 'vm_stat failed')
        fails.memory = 0
        memoryLast = { used: memoryUsed(pages, deps.totalmem()), pressure: level === null ? null : parsePressure(level) }
        redrawMemory()
        return
      }
      case 'battery': {
        const out = await read('battery')
        const reading = out === null ? null : parseBattery(out)
        if (!reading) return fail('battery', 'pmset failed')
        fails.battery = 0
        batteryLast = reading
        redrawBattery()
        return
      }
      case 'clock':
        set('clock', clockItem(new Date(deps.now()), settings.clock24h))
        return
      case 'procs': {
        const out = await read('procs')
        const rows = out === null ? [] : parsePs(out)
        if (rows.length === 0) {
          fails.procs += 1
          if (fails.procs < FAILS_BEFORE_DASH) return
          topCpu = null
          topMemory = null
        } else {
          fails.procs = 0
          topCpu = topApps(rows, 'cpu', cores)
          topMemory = topApps(rows, 'memory', cores)
        }
        redrawCpu()
        redrawMemory()
        return
      }
    }
  }

  async function tick(source: Source): Promise<void> {
    // A source still waiting on its last command is skipped, so a struggling Mac gets no pile-up.
    if (stopped || !enabled(source) || busy.has(source)) return
    busy.add(source)
    try {
      await readSource(source)
    } catch (error: unknown) {
      orca.log(`${source} tick failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      busy.delete(source)
    }
    await send()
  }

  const fire = (source: Source) => () => void track(tick(source))

  function intervalOf(source: Exclude<Source, 'clock'>): number {
    if (source === 'battery') return BATTERY_MS
    if (source === 'procs') return PROCS_MS
    if (source === 'gpu') return Math.max(GPU_MIN_MS, settings.refreshSeconds * 1000)
    return settings.refreshSeconds * 1000
  }

  function cancelTimer(source: Source): void {
    timers.get(source)?.()
    timers.delete(source)
  }

  function startTimer(source: Source): void {
    cancelTimer(source)
    if (stopped) return
    if (source !== 'clock') {
      timers.set(source, deps.every(intervalOf(source), fire(source)))
      return
    }
    // Re-aimed at the next minute on every fire, so drift and sleep never leave it behind.
    timers.set(
      'clock',
      deps.after(60_000 - (deps.now() % 60_000), () => {
        fire('clock')()
        if (!stopped && enabled('clock')) startTimer('clock')
      })
    )
  }

  function reset(source: Source): void {
    fails[source] = 0
    if (source === 'cpu') {
      cpuPrev = null
      cpuLast = null
      cpuSmooth = new Smoother(SMOOTH_MS)
      cpuHistory = []
    }
    if (source === 'gpu') {
      gpuSmooth = new Smoother(SMOOTH_MS)
      gpuLast = null
      gpuHistory = []
    }
    if (source === 'memory') memoryLast = null
    if (source === 'battery') batteryLast = null
  }

  async function apply(next: Settings): Promise<void> {
    if (stopped) return
    const before = settings
    settings = next
    const ticks: Promise<void>[] = []
    for (const source of SOURCES) {
      const was = enabled(source, before)
      const now = enabled(source)
      if (was && !now) cancelTimer(source)
      if (!was && now) {
        reset(source)
        if (source !== 'procs') latest[source] = placeholder(source)
        startTimer(source)
        ticks.push(tick(source))
      }
      if (was && now && source !== 'clock' && source !== 'battery' && source !== 'procs' && before.refreshSeconds !== next.refreshSeconds) {
        startTimer(source)
      }
    }
    for (const id of Object.keys(STYLE_KEY) as StyledId[]) {
      if (shown(id) && before[STYLE_KEY[id]] !== next[STYLE_KEY[id]]) restyle(id)
    }
    for (const id of ITEM_IDS) latest[id] = { ...latest[id], visible: latest[id].visible && shown(id) }
    if (before.clock24h !== next.clock24h) ticks.push(tick('clock'))
    ticks.push(send())
    await Promise.all(ticks)
  }

  const disposables: Disposable[] = [
    orca.settings.onDidChange(() => {
      void track(
        (async () => {
          await apply(readSettings(await orca.settings.get()))
        })()
      )
    }),
    orca.commands.register(COMMAND_ID, async () => {
      if (!mac) return 'Activity Monitor is macOS-only'
      try {
        await deps.run('open', ['-a', 'Activity Monitor'])
        return 'Opened Activity Monitor'
      } catch {
        return 'Could not open Activity Monitor'
      }
    })
  ]

  for (const id of ITEM_IDS) latest[id] = placeholder(id)
  await send()
  for (const source of SOURCES) {
    if (!enabled(source)) continue
    startTimer(source)
    void track(tick(source))
  }

  return {
    tick: (source) => track(tick(source)),
    flush: () => track(flush()),
    async settled() {
      while (inflight.size) await Promise.allSettled([...inflight])
      await sending
    },
    stop() {
      stopped = true
      for (const source of [...timers.keys()]) cancelTimer(source)
      cancelRetry?.()
      cancelRetry = null
      for (const d of disposables) d.dispose()
    }
  }
}
