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
  diskItem,
  diskSpaceItem,
  gpuItem,
  memoryItem,
  networkItem,
  placeholderItem,
  spacePercent
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
import { appName, parsePs, topApps } from './sources/processes.ts'
import { perSecond } from './sources/counters.ts'
import type { Counters } from './sources/counters.ts'
import { parseDiskIo } from './sources/disk.ts'
import { parseNetstat, parseNettop, topTraffic } from './sources/network.ts'
import type { TopApp } from './sources/processes.ts'
import { ICON, STYLES, STYLE_LABEL, TREND_LENGTH, batteryIcon, dashText, pairText, styledText } from './styles.ts'
import type { Card, Snapshot } from './protocol.ts'
import type { Style, StyledId } from './styles.ts'

export type Source = 'cpu' | 'gpu' | 'memory' | 'disk' | 'network' | 'space' | 'battery' | 'clock' | 'procs' | 'nettop'

export type Deps = {
  platform: string
  /** Rejects on a non-zero exit, a timeout or a missing command. */
  run(cmd: string, args: readonly string[]): Promise<string>
  cpus(): readonly { times: CpuTimes }[]
  totalmem(): number
  /** Size and free space of the volume holding `path`, in bytes. */
  statfs(path: string): Promise<{ total: number; available: number }>
  now(): number
  /** Milliseconds on a clock that never jumps (not the wall clock). */
  monotonic(): number
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
/** The disk `ioreg` costs as much as the GPU's: Activity Monitor's own default rate. */
export const DISK_MIN_MS = 5_000
export const NETTOP_MS = 30_000
export const SPACE_MS = 30_000
/** A read more than this many intervals after the last one (sleep, a stall) starts a new baseline. */
export const GAP_FACTOR = 3
const DATA_VOLUME = '/System/Volumes/Data'
/** The sources whose interval follows the refresh setting. */
const REFRESHED: readonly Source[] = ['cpu', 'gpu', 'memory', 'disk', 'network']
const SOURCES: readonly Source[] = ['cpu', 'gpu', 'memory', 'disk', 'network', 'space', 'battery', 'clock', 'procs', 'nettop']

const COMMANDS = {
  gpu: ['ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator']],
  vmStat: ['vm_stat', []],
  pressure: ['sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']],
  battery: ['pmset', ['-g', 'batt']],
  procs: ['ps', ['-Aeo', 'pid=,pcpu=,rss=,comm=']],
  disk: ['ioreg', ['-c', 'IOBlockStorageDriver', '-r', '-k', 'Statistics', '-d', '1']],
  netstat: ['netstat', ['-ibn']],
  nettop: ['nettop', ['-P', '-L', '1', '-x', '-t', 'external', '-J', 'bytes_in,bytes_out']]
} as const satisfies Record<string, readonly [string, readonly string[]]>

const SHOW_KEY: Record<ItemId, keyof Settings> = {
  cpu: 'showCpu',
  gpu: 'showGpu',
  memory: 'showMemory',
  disk: 'showDisk',
  network: 'showNetwork',
  space: 'showDiskSpace',
  battery: 'showBattery',
  clock: 'showClock'
}

/** A speed source: the last read's counters, the last speeds and the past totals for the trend. */
type SpeedState = { prev: { at: number; counters: Counters } | null; last: readonly [number, number] | null; history: number[] }
const freshSpeed = (): SpeedState => ({ prev: null, last: null, history: [] })

const same = (a: ItemState | undefined, b: ItemState) =>
  !!a && a.text === b.text && a.icon === b.icon && a.tone === b.tone && a.tooltip === b.tooltip && a.visible === b.visible

export async function startStrip(orca: OrcaWorkerApi, deps: Deps): Promise<Strip> {
  const mac = deps.platform === 'darwin'
  const cores = Math.max(1, deps.cpus().length)
  let settings: Settings = readSettings(await orca.settings.get())

  const latest = {} as Record<ItemId, ItemState>
  const lastSent: Partial<Record<ItemId, ItemState>> = {}
  const fails: Record<Source, number> = { cpu: 0, gpu: 0, memory: 0, disk: 0, network: 0, space: 0, battery: 0, clock: 0, procs: 0, nettop: 0 }
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
  let disk = freshSpeed()
  let network = freshSpeed()
  let diskTotals: { read: number; written: number } | null = null
  /** Bytes per pid at the last `nettop` read; null until the first read. */
  let nettopPrev: Map<number, number> | null = null
  let topNetwork: TopApp[] | null = null
  /** App names by pid from the last `ps` read, so network apps match the CPU hover's names. */
  let psNames = new Map<number, string>()
  let spaceLast: { total: number; available: number } | null = null
  let blockedUntil = 0
  let cancelRetry: (() => void) | null = null
  const busy = new Set<Source>()
  let sending: Promise<void> = Promise.resolve()
  let stopped = false

  const available = (source: Source) => source === 'cpu' || source === 'clock' || source === 'space' || mac
  const shown = (id: ItemId, s: Settings = settings) => available(id) && (s[SHOW_KEY[id]] as boolean)
  const enabled = (source: Source, s: Settings = settings) => {
    if (source === 'procs') return mac && (s.showCpu || s.showMemory || s.showNetwork)
    if (source === 'nettop') return mac && s.showNetwork
    return shown(source, s)
  }

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

  function fail(source: 'gpu' | 'memory' | 'disk' | 'network' | 'space' | 'battery', reason: string): void {
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

  function redrawDisk(): void {
    if (disk.last && fails.disk < FAILS_BEFORE_DASH) {
      set('disk', diskItem({ read: disk.last[0], write: disk.last[1] }, diskTotals, styleOf('disk'), disk.history))
    }
  }

  function redrawNetwork(): void {
    if (network.last && fails.network < FAILS_BEFORE_DASH) {
      set('network', networkItem({ down: network.last[0], up: network.last[1] }, topNetwork, styleOf('network'), network.history))
    }
  }

  function redrawSpace(): void {
    if (spaceLast && fails.space < FAILS_BEFORE_DASH) set('space', diskSpaceItem(spaceLast, styleOf('space')))
  }

  /** After a style change: the item from its last reading, or its dash or placeholder in the new style. */
  function restyle(id: StyledId): void {
    const dashed = id !== 'cpu' && fails[id] >= FAILS_BEFORE_DASH
    const last = { cpu: cpuLast, gpu: gpuLast, memory: memoryLast, disk: disk.last, network: network.last, space: spaceLast, battery: batteryLast }[id]
    if (dashed) set(id, dashItem(id, latest[id].tooltip, styleOf(id)))
    else if (last === null) latest[id] = placeholder(id)
    else if (id === 'cpu') redrawCpu()
    else if (id === 'gpu') redrawGpu()
    else if (id === 'memory') redrawMemory()
    else if (id === 'disk') redrawDisk()
    else if (id === 'network') redrawNetwork()
    else if (id === 'space') redrawSpace()
    else redrawBattery()
  }

  /**
   * Takes a new read of a speed source. True when it gave new speeds; false for the first read, and
   * for a read after no time or after a gap (sleep, a stall), which only becomes the new baseline.
   */
  function advance(state: SpeedState, counters: Counters, intervalMs: number): boolean {
    const at = deps.monotonic()
    const prev = state.prev
    state.prev = { at, counters }
    if (!prev) return false
    const elapsed = at - prev.at
    if (elapsed <= 0 || elapsed > GAP_FACTOR * intervalMs) return false
    const speeds = perSecond(prev.counters, counters, elapsed / 1000)
    state.last = speeds
    state.history = remember(state.history, speeds[0] + speeds[1])
    return true
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
      case 'disk': {
        const out = await read('disk')
        const counters = out === null ? null : parseDiskIo(out)
        if (!counters) return fail('disk', 'ioreg failed')
        fails.disk = 0
        diskTotals = { read: 0, written: 0 }
        for (const [read, written] of counters.values()) {
          diskTotals.read += read
          diskTotals.written += written
        }
        if (advance(disk, counters, intervalOf('disk'))) redrawDisk()
        return
      }
      case 'network': {
        const out = await read('netstat')
        const counters = out === null ? null : parseNetstat(out)
        if (!counters) return fail('network', 'netstat failed')
        fails.network = 0
        if (advance(network, counters, intervalOf('network'))) redrawNetwork()
        return
      }
      case 'nettop': {
        const out = await read('nettop')
        if (out === null) {
          fails.nettop += 1
          if (fails.nettop < FAILS_BEFORE_DASH) return
          topNetwork = null
          nettopPrev = null
        } else {
          fails.nettop = 0
          const rows = parseNettop(out)
          if (nettopPrev) topNetwork = topTraffic(nettopPrev, rows, psNames)
          nettopPrev = new Map()
          for (const row of rows) nettopPrev.set(row.pid, (nettopPrev.get(row.pid) ?? 0) + row.bytes)
        }
        redrawNetwork()
        return
      }
      case 'space': {
        try {
          spaceLast = await deps.statfs(mac ? DATA_VOLUME : '/')
        } catch {
          return fail('space', 'statfs failed')
        }
        fails.space = 0
        redrawSpace()
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
          psNames = new Map(rows.map((row) => [row.pid, appName(row.path)]))
        }
        redrawCpu()
        redrawMemory()
        return
      }
    }
  }

  /** The item's text in a style from its last reading, or null while it is hidden, unread or dashed. */
  function draw(id: StyledId, style: Style): string | null {
    if (!shown(id)) return null
    if (id !== 'cpu' && fails[id] >= FAILS_BEFORE_DASH) return null
    switch (id) {
      case 'cpu':
        return cpuLast === null ? null : styledText('cpu', style, cpuLast, cpuHistory)
      case 'gpu':
        return gpuLast ? styledText('gpu', style, gpuLast.utilization, gpuHistory) : null
      case 'memory':
        return memoryLast ? styledText('memory', style, memoryLast.used.percent, []) : null
      case 'disk':
        return disk.last ? pairText('disk', style, disk.last[0], disk.last[1], disk.history) : null
      case 'network':
        return network.last ? pairText('network', style, network.last[0], network.last[1], network.history) : null
      case 'space':
        return spaceLast ? styledText('space', style, spacePercent(spaceLast), []) : null
      case 'battery':
        return batteryLast?.present ? styledText('battery', style, batteryLast.percent, []) : null
    }
  }

  function card(id: StyledId, hasBattery: boolean): Card {
    const icon = id === 'battery' && batteryLast?.present ? batteryIcon(batteryLast.onPower) : ICON[id]
    const samples =
      id === 'battery' && !hasBattery
        ? []
        : STYLES[id].map((style) => ({ style, label: STYLE_LABEL[style], text: draw(id, style) ?? dashText(id, style), icon }))
    return { id, shown: shown(id), value: draw(id, 'number'), samples }
  }

  function snapshot(): Snapshot {
    const hasBattery = batteryLast?.present !== false
    const now = new Date(deps.now())
    return {
      settings,
      bar: ITEM_IDS.filter((id) => latest[id].visible).map((id) => {
        const { text, icon, tone } = latest[id]
        return icon ? { id, text, icon, tone } : { id, text, tone }
      }),
      cards: (Object.keys(STYLE_KEY) as StyledId[]).map((id) => card(id, hasBattery)),
      clock: { h24: clockItem(now, true).text, h12: clockItem(now, false).text },
      hasBattery
    }
  }

  let lastPosted = ''

  /** Independent of status bar sends, so a rate-limited bar never freezes an open panel. */
  function post(): void {
    if (stopped) return
    const snap = snapshot()
    const json = JSON.stringify(snap)
    if (json === lastPosted) return
    lastPosted = json
    orca.panels.post('strip.snapshot', snap)
  }

  async function openActivityMonitor(): Promise<string> {
    if (!mac) return 'Activity Monitor is macOS-only'
    try {
      await deps.run('open', ['-a', 'Activity Monitor'])
      return 'Opened Activity Monitor'
    } catch {
      return 'Could not open Activity Monitor'
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
    post()
    await send()
  }

  const fire = (source: Source) => () => void track(tick(source))

  function intervalOf(source: Exclude<Source, 'clock'>): number {
    if (source === 'battery') return BATTERY_MS
    if (source === 'procs') return PROCS_MS
    if (source === 'nettop') return NETTOP_MS
    if (source === 'space') return SPACE_MS
    if (source === 'gpu') return Math.max(GPU_MIN_MS, settings.refreshSeconds * 1000)
    if (source === 'disk') return Math.max(DISK_MIN_MS, settings.refreshSeconds * 1000)
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
    if (source === 'disk') {
      disk = freshSpeed()
      diskTotals = null
    }
    if (source === 'network') network = freshSpeed()
    if (source === 'nettop') {
      nettopPrev = null
      topNetwork = null
    }
    if (source === 'space') spaceLast = null
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
        if (source !== 'procs' && source !== 'nettop') latest[source] = placeholder(source)
        startTimer(source)
        ticks.push(tick(source))
      }
      if (was && now && REFRESHED.includes(source) && before.refreshSeconds !== next.refreshSeconds) {
        startTimer(source)
      }
    }
    for (const id of Object.keys(STYLE_KEY) as StyledId[]) {
      if (shown(id) && before[STYLE_KEY[id]] !== next[STYLE_KEY[id]]) restyle(id)
    }
    for (const id of ITEM_IDS) latest[id] = { ...latest[id], visible: latest[id].visible && shown(id) }
    if (before.clock24h !== next.clock24h) ticks.push(tick('clock'))
    post()
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
    orca.commands.register(COMMAND_ID, openActivityMonitor),
    orca.panels.handle('strip.snapshot', () => snapshot()),
    orca.panels.handle('strip.openActivityMonitor', async () => ({ message: await openActivityMonitor() }))
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
