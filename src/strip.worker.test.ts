// Runs under `orca plugin test .` only: it needs orca/testing, which exists inside that runner.
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { BATTERY_MS, COMMAND_ID, DISK_MIN_MS, FAILS_BEFORE_DASH, GAP_FACTOR, GPU_MIN_MS, NETTOP_MS, PROCS_MS, SPACE_MS, startStrip } from './strip.ts'
import type { Deps, Strip } from './strip.ts'
import { ITEM_IDS, placeholderItem } from './format.ts'
import { fixture } from './fixtures/read.ts'
import type { Snapshot } from './protocol.ts'
import { STYLES, pairText } from './styles.ts'

const IOREG = 'ioreg -r -d 1 -c IOAccelerator'
const VM_STAT = 'vm_stat'
const PRESSURE = 'sysctl -n kern.memorystatus_vm_pressure_level'
const PMSET = 'pmset -g batt'
const PS = 'ps -Aeo pid=,pcpu=,rss=,comm='
const OPEN = 'open -a Activity Monitor'
const DISK = 'ioreg -c IOBlockStorageDriver -r -k Statistics -d 1'
const NETSTAT = 'netstat -ibn'
const NETTOP = 'nettop -P -L 1 -x -t external -J bytes_in,bytes_out'
const DATA = '/System/Volumes/Data'

/** One disk driver's counters as `ioreg` prints them. */
const diskOut = (read: number, written: number) =>
  `+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x10, registered>\n      "Statistics" = {"Bytes (Read)"=${read},"Bytes (Write)"=${written}}\n`
/** `netstat -ibn` link rows: [name, bytes in, bytes out]. */
const netOut = (...rows: [string, number, number][]) =>
  'Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\n' +
  rows.map(([name, i, o]) => `${name} 1500 <Link#9> 02:00:00:00:00:01 1 0 ${i} 1 0 ${o} 0`).join('\n') +
  '\n'
const GPU_OUT = '"model" = "Test GPU"\n"Device Utilization %"=15'

type Outputs = Record<string, string | Error>

function baseOutputs(): Outputs {
  return {
    [IOREG]: GPU_OUT,
    [VM_STAT]: fixture('vm_stat.txt'),
    [PRESSURE]: '1\n',
    [PMSET]: fixture('pmset-discharging.txt'),
    [PS]: fixture('ps.txt'),
    [OPEN]: '',
    [DISK]: diskOut(1000, 1000),
    [NETSTAT]: netOut(['en0', 1000, 1000]),
    [NETTOP]: ',bytes_in,bytes_out,\n'
  }
}

type Timer = { kind: 'every' | 'after'; ms: number; fn: () => void; cancelled: boolean }
type Fake = Deps & {
  outputs: Outputs
  /** A pending answer for a command, to hold it "running". */
  hold: Record<string, Promise<string>>
  runs: string[]
  timers: Timer[]
  clock: number
  /** Ticks added per os.cpus() call: busy and idle. */
  cpuStep: { busy: number; idle: number }
  cpusCalls: number
  /** The monotonic clock, in ms; tests advance it. */
  mono: number
  space: Record<string, { total: number; available: number } | Error>
  statfsCalls: string[]
}

function fakeDeps(outputs: Outputs = baseOutputs(), platform = 'darwin'): Fake {
  let busy = 0
  let idle = 0
  const fake: Fake = {
    outputs,
    hold: {},
    runs: [],
    timers: [],
    clock: new Date(2026, 10, 12, 14, 5, 30).getTime(),
    cpuStep: { busy: 100, idle: 300 },
    cpusCalls: 0,
    mono: 1_000,
    space: { [DATA]: { total: 994e9, available: 312e9 }, '/': { total: 500e9, available: 400e9 } },
    statfsCalls: [],
    platform,
    async statfs(path) {
      fake.statfsCalls.push(path)
      const out = fake.space[path]
      if (out === undefined) throw new Error('no fake statfs for ' + path)
      if (out instanceof Error) throw out
      return out
    },
    monotonic: () => fake.mono,
    async run(cmd, args) {
      const key = [cmd, ...args].join(' ')
      fake.runs.push(key)
      if (key in fake.hold) return fake.hold[key]
      const out = fake.outputs[key]
      if (out === undefined) throw new Error('no fake output for ' + key)
      if (out instanceof Error) throw out
      return out
    },
    cpus() {
      fake.cpusCalls += 1
      busy += fake.cpuStep.busy
      idle += fake.cpuStep.idle
      return [{ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }]
    },
    totalmem: () => 24 * 1024 ** 3,
    now: () => fake.clock,
    every(ms, fn) {
      const t = { kind: 'every' as const, ms, fn, cancelled: false }
      fake.timers.push(t)
      return () => {
        t.cancelled = true
      }
    },
    after(ms, fn) {
      const t = { kind: 'after' as const, ms, fn, cancelled: false }
      fake.timers.push(t)
      return () => {
        t.cancelled = true
      }
    }
  }
  return fake
}

type Update = { id: string; text: string; icon?: string; tone: string; tooltip: string; visible: boolean }

/** Existing tests read words text; tests of the styles set their own. */
const WORDS = { cpuStyle: 'words', gpuStyle: 'words', memoryStyle: 'words', diskStyle: 'words', networkStyle: 'words', diskSpaceStyle: 'words', batteryStyle: 'words' }

async function mount(options: { settings?: Record<string, boolean | number | string>; deps?: Fake; results?: Record<string, unknown> } = {}) {
  const deps = options.deps ?? fakeDeps()
  const host = mockHost({ settings: { ...WORDS, ...options.settings }, results: options.results })
  let api: OrcaWorkerApi | undefined
  let strip: Strip | undefined
  const worker = await mountWorker(
    {
      default: async (o: OrcaWorkerApi) => {
        api = o
        strip = await startStrip(o, deps)
      }
    },
    { host }
  )
  await strip!.settled()
  const updates = () => host.callsOf('statusBar.update') as Update[]
  const last = (id: string) => updates().filter((u) => u.id === id).at(-1)
  return { deps, host, worker, api: api!, strip: strip!, updates, last }
}

test('start-up sends every item with visible, even with empty settings', async () => {
  const { updates, worker } = await mount()
  assert.deepEqual(
    updates().slice(0, ITEM_IDS.length),
    ITEM_IDS.map((id) => ({ id, ...placeholderItem(id, 'words'), tone: 'neutral', tooltip: 'System Strip', visible: true }))
  )
  await worker.deactivate()
})

test('the first ticks fill in the items', async () => {
  const { last, strip, worker } = await mount()
  await strip.tick('cpu')
  assert.equal(last('gpu')!.text, 'GPU 15%')
  assert.equal(last('memory')!.text.startsWith('Mem '), true)
  assert.equal(last('battery')!.text, 'Bat 100%')
  assert.equal(last('clock')!.text, '14:05')
  assert.equal(last('cpu')!.text, 'CPU 25%')
  await worker.deactivate()
})

test('switched-off items are hidden and their commands never run', async () => {
  const { last, strip, deps, worker } = await mount({ settings: { showGpu: false } })
  await strip.tick('gpu')
  assert.equal(last('gpu')!.visible, false)
  assert.equal(deps.runs.includes(IOREG), false)
  await worker.deactivate()
})

const fireLive = async (deps: Fake, strip: Strip) => {
  for (const t of deps.timers.filter((t) => !t.cancelled)) t.fn()
  await strip.settled()
}

test('turning an item back on shows it and polls again', async () => {
  const { api, last, strip, deps, worker } = await mount({ settings: { showGpu: false } })
  await api.settings.set('showGpu', true)
  await strip.settled()
  assert.equal(deps.runs.includes(IOREG), true)
  assert.deepEqual([last('gpu')!.visible, last('gpu')!.text], [true, 'GPU 15%'])
  const gpuTimer = deps.timers.find((t) => t.kind === 'every' && t.ms === GPU_MIN_MS && !t.cancelled)
  assert.ok(gpuTimer)
  const runs = deps.runs.filter((r) => r === IOREG).length
  gpuTimer.fn()
  await strip.settled()
  assert.equal(deps.runs.filter((r) => r === IOREG).length, runs + 1)
  await worker.deactivate()
})

test('turning an item off stops its own polling and nothing else', async () => {
  const { api, last, strip, deps, worker } = await mount()
  await api.settings.set('showGpu', false)
  await strip.settled()
  assert.equal(last('gpu')!.visible, false)
  assert.equal(deps.timers.some((t) => !t.cancelled && t.kind === 'every' && t.ms === GPU_MIN_MS), false, 'gpu timer cancelled')
  deps.runs.length = 0
  await fireLive(deps, strip)
  assert.equal(deps.runs.includes(IOREG), false)
  assert.equal(deps.runs.includes(VM_STAT), true)
  await worker.deactivate()
})

test('a source that is still running is not started again', async () => {
  const { deps, strip, worker } = await mount()
  let release: (out: string) => void = () => undefined
  deps.hold[IOREG] = new Promise<string>((resolve) => {
    release = resolve
  })
  deps.runs.length = 0
  const first = strip.tick('gpu')
  const second = strip.tick('gpu')
  assert.equal(deps.runs.filter((r) => r === IOREG).length, 1)
  release(GPU_OUT)
  await Promise.all([first, second])
  await worker.deactivate()
})

test('colour follows the smoothed CPU, the number the latest', async () => {
  const { deps, last, strip, worker } = await mount()
  deps.cpuStep = { busy: 10, idle: 90 }
  await strip.tick('cpu')
  await strip.tick('cpu')
  deps.cpuStep = { busy: 95, idle: 5 }
  await strip.tick('cpu')
  assert.deepEqual([last('cpu')!.text, last('cpu')!.tone], ['CPU 95%', 'neutral'])
  await worker.deactivate()
})

test('clock lines up with the minute and re-aligns on every fire', async () => {
  const { deps, last, strip, worker } = await mount()
  const first = deps.timers.filter((t) => !t.cancelled && t.kind === 'after')
  assert.deepEqual(first.map((t) => t.ms), [30_000])
  assert.equal(deps.timers.some((t) => t.ms === 60_000 && t.kind === 'every'), false)
  deps.clock = new Date(2026, 10, 12, 14, 6, 0, 400).getTime()
  first[0].fn()
  await strip.settled()
  assert.equal(last('clock')!.text, '14:06')
  const next = deps.timers.filter((t) => !t.cancelled && t.kind === 'after')
  assert.deepEqual(next.map((t) => t.ms), [59_600])
  await worker.deactivate()
})

test('a stale clock is corrected by the next CPU tick (after sleep)', async () => {
  const { deps, last, strip, worker } = await mount()
  deps.clock = new Date(2026, 10, 12, 15, 0, 10).getTime()
  await strip.tick('cpu')
  assert.equal(last('clock')!.text, '15:00')
  await worker.deactivate()
})

test('a memory dash is not undone by a ps tick', async () => {
  const { deps, last, strip, worker } = await mount()
  deps.outputs[VM_STAT] = new Error('vm_stat broke')
  for (let i = 0; i < FAILS_BEFORE_DASH; i++) await strip.tick('memory')
  assert.equal(last('memory')!.text, 'Mem –')
  await strip.tick('procs')
  assert.equal(last('memory')!.text, 'Mem –')
  await worker.deactivate()
})

test('nothing runs or is sent after stop', async () => {
  const { deps, host, strip, worker } = await mount()
  const sent = host.callsOf('statusBar.update').length
  strip.stop()
  deps.runs.length = 0
  for (const t of deps.timers) t.fn()
  await strip.tick('gpu')
  await strip.flush()
  await strip.settled()
  assert.deepEqual(deps.runs, [])
  assert.equal(host.callsOf('statusBar.update').length, sent)
  await worker.deactivate()
})

test('non-darwin hides gpu, memory and battery', async () => {
  const { last, strip, deps, worker } = await mount({ deps: fakeDeps(baseOutputs(), 'linux') })
  await strip.tick('gpu')
  await strip.tick('memory')
  await strip.tick('battery')
  assert.deepEqual(['gpu', 'memory', 'battery'].map((id) => last(id)!.visible), [false, false, false])
  assert.equal(last('cpu')!.visible, true)
  assert.deepEqual(deps.runs, [])
  await worker.deactivate()
})

test('no battery hides battery, not a failure', async () => {
  const deps = fakeDeps({ ...baseOutputs(), [PMSET]: fixture('pmset-desktop.txt') })
  const { last, strip, updates, worker } = await mount({ deps })
  for (let i = 0; i < FAILS_BEFORE_DASH; i++) await strip.tick('battery')
  assert.equal(last('battery')!.visible, false)
  assert.equal(updates().some((u) => u.id === 'battery' && u.tooltip !== 'System Strip' && u.text === 'Bat –' && u.visible), false)
  await worker.deactivate()
})

test('a failing source keeps its value, then dashes at the third failure, others untouched', async () => {
  const { deps, last, strip, updates, worker } = await mount()
  assert.equal(last('gpu')!.text, 'GPU 15%')
  deps.outputs[IOREG] = new Error('boom')
  const sent = updates().length
  await strip.tick('gpu')
  await strip.tick('gpu')
  assert.equal(updates().length, sent)
  await strip.tick('gpu')
  assert.deepEqual(updates().slice(sent), [{ id: 'gpu', text: 'GPU –', icon: 'gauge', tone: 'neutral', tooltip: 'ioreg failed', visible: true }])
  await worker.deactivate()
})

test('a source recovers after a dash', async () => {
  const { deps, last, strip, worker } = await mount()
  deps.outputs[IOREG] = new Error('boom')
  for (let i = 0; i < FAILS_BEFORE_DASH; i++) await strip.tick('gpu')
  deps.outputs[IOREG] = GPU_OUT
  await strip.tick('gpu')
  assert.equal(last('gpu')!.text, 'GPU 15%')
  await worker.deactivate()
})

test('nothing is sent when nothing changed', async () => {
  const { strip, updates, worker } = await mount()
  const gpuSends = () => updates().filter((u) => u.id === 'gpu').length
  const before = gpuSends()
  await strip.tick('gpu')
  await strip.tick('gpu')
  assert.equal(gpuSends(), before)
  await worker.deactivate()
})

test('rate_limited waits retryAfterMs and then sends the latest state', async () => {
  let calls = 0
  const results = {
    'statusBar.update': () => {
      calls += 1
      if (calls === 6) throw hostError('rate_limited', 'slow down', 1500)
      return { ok: true }
    }
  }
  const deps = fakeDeps()
  const { host, strip, worker } = await mount({ deps, results })
  const retry = deps.timers.filter((t) => t.kind === 'after' && t.ms === 1500)
  assert.equal(retry.length, 1)
  const refusedId = (host.calls.filter((c) => c.method === 'statusBar.update')[5].params as Update).id
  const sentBefore = host.callsOf('statusBar.update').length
  deps.outputs[IOREG] = '"model" = "Test GPU"\n"Device Utilization %"=40'
  await strip.tick('gpu')
  assert.equal(host.callsOf('statusBar.update').length, sentBefore, 'nothing is sent while blocked')
  retry[0].fn()
  await strip.settled()
  const resent = (host.callsOf('statusBar.update') as Update[]).slice(sentBefore)
  const refused = resent.find((u) => u.id === refusedId)
  assert.ok(refused)
  assert.notEqual(refused.text, placeholderItem(refusedId as (typeof ITEM_IDS)[number], 'words').text)
  assert.equal(resent.find((u) => u.id === 'gpu')!.text, 'GPU 40%')
  await worker.deactivate()
})

test('rate_limited without retryAfterMs waits the default, and 0 is not a tight loop', async () => {
  for (const [retryAfterMs, expected] of [[undefined, 2000], [0, 250]] as const) {
    let calls = 0
    const results = {
      'statusBar.update': () => {
        calls += 1
        if (calls === 6) throw hostError('rate_limited', 'slow down', retryAfterMs)
        return { ok: true }
      }
    }
    const deps = fakeDeps()
    const { worker } = await mount({ deps, results })
    assert.deepEqual(deps.timers.filter((t) => t.kind === 'after' && t.ms !== 30_000).map((t) => t.ms), [expected])
    await worker.deactivate()
  }
})

test('memory: sysctl failure is Pressure: unknown, not a dash', async () => {
  const deps = fakeDeps({ ...baseOutputs(), [PRESSURE]: new Error('nope') })
  const { last, strip, worker } = await mount({ deps })
  for (let i = 0; i < FAILS_BEFORE_DASH; i++) await strip.tick('memory')
  const memory = last('memory')!
  assert.equal(memory.text.startsWith('Mem '), true)
  assert.notEqual(memory.text, 'Mem –')
  assert.equal(memory.tooltip.split('\n')[1], 'Pressure: unknown')
  assert.equal(memory.tone, 'neutral')
  await worker.deactivate()
})

test('memory tooltip keeps top apps through two ps failures and drops them at the third', async () => {
  const { deps, last, strip, worker } = await mount()
  assert.equal(last('memory')!.tooltip.includes('Top apps: Google Chrome'), true)
  deps.outputs[PS] = new Error('ps broke')
  await strip.tick('procs')
  await strip.tick('procs')
  assert.equal(last('memory')!.tooltip.includes('Top apps: Google Chrome'), true)
  await strip.tick('procs')
  assert.equal(last('memory')!.tooltip.includes('Top apps'), false)
  assert.notEqual(last('memory')!.text, 'Mem –')
  await worker.deactivate()
})

test('clock24h change redraws the clock at once', async () => {
  const { api, last, strip, worker } = await mount()
  assert.equal(last('clock')!.text, '14:05')
  await api.settings.set('clock24h', false)
  await strip.settled()
  assert.equal(last('clock')!.text, '2:05 PM')
  await worker.deactivate()
})

test('refresh setting sets the load timers', async () => {
  const { api, deps, strip, worker } = await mount({ settings: { refreshSeconds: 5 } })
  const live = () => deps.timers.filter((t) => t.kind === 'every' && !t.cancelled).map((t) => t.ms).sort((a, b) => a - b)
  // cpu, gpu, memory, disk, network; then procs, battery, space, nettop.
  assert.deepEqual(live(), [5000, 5000, 5000, 5000, 5000, PROCS_MS, BATTERY_MS, SPACE_MS, NETTOP_MS])
  await api.settings.set('refreshSeconds', 1)
  await strip.settled()
  assert.deepEqual(live(), [1000, 1000, 1000, GPU_MIN_MS, DISK_MIN_MS, PROCS_MS, BATTERY_MS, SPACE_MS, NETTOP_MS])
  assert.deepEqual([GPU_MIN_MS, DISK_MIN_MS, PROCS_MS, BATTERY_MS, SPACE_MS, NETTOP_MS], [4000, 5000, 15_000, 30_000, 30_000, 30_000])
  await worker.deactivate()
})

test('open command: darwin runs open -a, a failed open returns a message, linux runs nothing', async () => {
  const mac = await mount()
  assert.equal(await mac.worker.command(COMMAND_ID), 'Opened Activity Monitor')
  assert.equal(mac.deps.runs.includes(OPEN), true)
  mac.deps.outputs[OPEN] = new Error('no app')
  assert.equal(await mac.worker.command(COMMAND_ID), 'Could not open Activity Monitor')
  await mac.worker.deactivate()
  const linux = await mount({ deps: fakeDeps(baseOutputs(), 'linux') })
  assert.equal(await linux.worker.command(COMMAND_ID), 'Activity Monitor is macOS-only')
  assert.equal(linux.deps.runs.includes(OPEN), false)
  await linux.worker.deactivate()
})

test('stop cancels every timer', async () => {
  const { deps, strip, worker } = await mount()
  strip.stop()
  assert.equal(deps.timers.every((t) => t.cancelled), true)
  await worker.deactivate()
})

const F = '\u2007'

test('default style sends icon and number', async () => {
  const { last, strip, worker } = await mount({ settings: { cpuStyle: 'number', gpuStyle: 'number' } })
  await strip.tick('cpu')
  assert.deepEqual([last('cpu')!.text, last('cpu')!.icon], ['25%', 'activity'])
  assert.deepEqual([last('gpu')!.text, last('gpu')!.icon], ['15%', 'gauge'])
  await worker.deactivate()
})

test('changing a style redraws that item at once, without a new reading', async () => {
  const { api, deps, last, strip, worker } = await mount({ settings: { cpuStyle: 'number' } })
  await strip.tick('cpu')
  const calls = deps.cpusCalls
  await api.settings.set('cpuStyle', 'bar')
  await strip.settled()
  assert.equal(last('cpu')!.text, '▰▱▱▱▱')
  assert.equal(deps.cpusCalls, calls)
  await worker.deactivate()
})

test('trend shows up to six readings and restarts empty after the item is switched off and on', async () => {
  const { api, last, strip, worker } = await mount({ settings: { cpuStyle: 'trend' } })
  await strip.tick('cpu')
  assert.equal(last('cpu')!.text, F.repeat(5) + '▃ 25%')
  for (let i = 0; i < 7; i++) await strip.tick('cpu')
  assert.equal(last('cpu')!.text, '▃▃▃▃▃▃ 25%')
  await api.settings.set('showCpu', false)
  await strip.settled()
  await api.settings.set('showCpu', true)
  await strip.settled()
  await strip.tick('cpu')
  assert.equal(last('cpu')!.text, F.repeat(5) + '▃ 25%')
  await worker.deactivate()
})

test('a style change while dashed keeps the dash in the new form', async () => {
  const { api, deps, last, strip, worker } = await mount()
  deps.outputs[IOREG] = new Error('boom')
  for (let i = 0; i < FAILS_BEFORE_DASH; i++) await strip.tick('gpu')
  assert.equal(last('gpu')!.text, 'GPU –')
  await api.settings.set('gpuStyle', 'bar')
  await strip.settled()
  assert.deepEqual([last('gpu')!.text, last('gpu')!.icon, last('gpu')!.tooltip], ['–', 'gauge', 'ioreg failed'])
  deps.outputs[IOREG] = GPU_OUT
  await strip.tick('gpu')
  assert.equal(last('gpu')!.text, '▰▱▱▱▱')
  await worker.deactivate()
})

test('a style change before the first reading redraws the placeholder', async () => {
  const { api, last, strip, worker } = await mount()
  assert.equal(last('cpu')!.text, 'CPU –')
  await api.settings.set('cpuStyle', 'level')
  await strip.settled()
  assert.deepEqual([last('cpu')!.text, last('cpu')!.icon], ['–', 'activity'])
  await worker.deactivate()
})

test('battery icon switches between plug and zap with power', async () => {
  const { deps, last, strip, worker } = await mount()
  assert.equal(last('battery')!.icon, 'zap')
  deps.outputs[PMSET] = fixture('pmset-charging.txt')
  await strip.tick('battery')
  assert.equal(last('battery')!.icon, 'plug')
  await worker.deactivate()
})

const snapshotOf = async (worker: { request(name: 'strip.snapshot'): Promise<unknown> }) => (await worker.request('strip.snapshot')) as Snapshot
const card = (snap: Snapshot, id: string) => snap.cards.find((c) => c.id === id)!

test('snapshot has a card per item with a sample per offered style', async () => {
  const { strip, worker } = await mount({ settings: { cpuStyle: 'bar' } })
  await strip.tick('cpu')
  const snap = await snapshotOf(worker)
  assert.deepEqual(snap.cards.map((c) => c.id), ['cpu', 'gpu', 'memory', 'disk', 'network', 'space', 'battery'])
  assert.deepEqual(card(snap, 'cpu').samples.map((s) => s.style), STYLES.cpu)
  assert.equal(card(snap, 'memory').samples.some((s) => s.style === 'trend'), false)
  assert.equal(card(snap, 'cpu').value, '25%')
  assert.deepEqual(card(snap, 'cpu').samples.find((s) => s.style === 'bar'), { style: 'bar', label: 'Bar', text: '▰▱▱▱▱', icon: 'activity' })
  assert.equal(snap.settings.cpuStyle, 'bar')
  assert.equal(snap.bar.find((b) => b.id === 'cpu')!.text, '▰▱▱▱▱')
  assert.equal(snap.clock.h24, '14:05')
  assert.equal(snap.clock.h12, '2:05 PM')
  assert.equal(snap.hasBattery, true)
  await worker.deactivate()
})

test('a hidden item has value null and dash samples, and is not polled for the panel', async () => {
  const { deps, worker } = await mount({ settings: { showGpu: false } })
  const snap = await snapshotOf(worker)
  const gpu = card(snap, 'gpu')
  assert.deepEqual([gpu.shown, gpu.value], [false, null])
  assert.deepEqual(gpu.samples.map((s) => s.text), ['GPU –', '–', '–', '–', '–'])
  assert.equal(snap.bar.some((b) => b.id === 'gpu'), false)
  assert.equal(deps.runs.includes(IOREG), false)
  await worker.deactivate()
})

test('a tick that changes something posts a fresh snapshot, an unchanged one does not', async () => {
  const { strip, worker } = await mount()
  await strip.tick('cpu')
  const posts = worker.posts.filter((p) => p.event === 'strip.snapshot')
  assert.ok(posts.length > 0)
  assert.equal(card(posts.at(-1)!.payload as Snapshot, 'cpu').value, '25%')
  const count = posts.length
  await strip.tick('battery')
  assert.equal(worker.posts.filter((p) => p.event === 'strip.snapshot').length, count)
  await worker.deactivate()
})

test('a snapshot is still posted while the status bar is rate limited', async () => {
  const results = { 'statusBar.update': () => { throw hostError('rate_limited', 'slow down', 1500) } }
  const { strip, worker } = await mount({ results })
  const count = worker.posts.length
  await strip.tick('cpu')
  assert.ok(worker.posts.length > count)
  await worker.deactivate()
})

test('openActivityMonitor request runs open -a "Activity Monitor"', async () => {
  const { deps, worker } = await mount()
  assert.deepEqual(await worker.request('strip.openActivityMonitor'), { message: 'Opened Activity Monitor' })
  assert.equal(deps.runs.includes(OPEN), true)
  await worker.deactivate()
})

test('no battery: hasBattery false and a battery card with no samples', async () => {
  const deps = fakeDeps({ ...baseOutputs(), [PMSET]: fixture('pmset-desktop.txt') })
  const { worker } = await mount({ deps })
  const snap = await snapshotOf(worker)
  assert.equal(snap.hasBattery, false)
  assert.deepEqual([card(snap, 'battery').value, card(snap, 'battery').samples], [null, []])
  await worker.deactivate()
})

// Disk activity, network and disk space.

const liveTimers = (deps: Fake) => deps.timers.filter((t) => t.kind === 'every' && !t.cancelled).map((t) => t.ms).sort((a, b) => a - b)

test('disk: the first read is a baseline, the second shows both speeds', async () => {
  const { deps, last, strip, worker } = await mount({ settings: { diskStyle: 'number' } })
  assert.equal(last('disk')!.text, '–')
  deps.outputs[DISK] = diskOut(1000 + 60e6, 1000 + 10e6)
  deps.mono += 5000
  await strip.tick('disk')
  assert.equal(last('disk')!.text, pairText('disk', 'number', 12e6, 2e6, []))
  assert.equal(last('disk')!.icon, 'database')
  assert.equal(last('disk')!.tone, 'neutral')
  await worker.deactivate()
})

test('disk: a gap or no elapsed time starts a new baseline and keeps the value', async () => {
  const { deps, last, strip, worker } = await mount({ settings: { diskStyle: 'number' } })
  deps.outputs[DISK] = diskOut(1000 + 60e6, 1000 + 10e6)
  deps.mono += 5000
  await strip.tick('disk')
  const shown = last('disk')!.text
  deps.outputs[DISK] = diskOut(9e12, 9e12)
  deps.mono += GAP_FACTOR * DISK_MIN_MS + 1
  await strip.tick('disk')
  assert.equal(last('disk')!.text, shown, 'after a gap')
  deps.outputs[DISK] = diskOut(9e12 + 5e6, 9e12)
  await strip.tick('disk')
  assert.equal(last('disk')!.text, shown, 'no time passed')
  deps.outputs[DISK] = diskOut(9e12 + 5e6 + 5e6, 9e12)
  deps.mono += 5000
  await strip.tick('disk')
  assert.equal(last('disk')!.text, pairText('disk', 'number', 1e6, 0, []))
  await worker.deactivate()
})

test('network: a counter that went down counts as 0, others still count', async () => {
  const { deps, last, strip, worker } = await mount({ settings: { networkStyle: 'number' } })
  deps.outputs[NETSTAT] = netOut(['en0', 1000, 1000], ['en1', 5000, 5000])
  deps.mono += 2000
  await strip.tick('network')
  deps.outputs[NETSTAT] = netOut(['en0', 1000 + 2e6, 1000 + 1e6], ['en1', 10, 10])
  deps.mono += 2000
  await strip.tick('network')
  assert.equal(last('network')!.text, pairText('network', 'number', 1e6, 5e5, []))
  assert.equal(last('network')!.tone, 'neutral')
  await worker.deactivate()
})

test('timers at the default refresh', async () => {
  const { deps, worker } = await mount()
  // cpu, memory, network 2 s; gpu 4 s; disk 5 s; ps 15 s; battery, disk space, nettop 30 s.
  assert.deepEqual(liveTimers(deps), [2000, 2000, 2000, GPU_MIN_MS, DISK_MIN_MS, PROCS_MS, BATTERY_MS, SPACE_MS, NETTOP_MS])
  await worker.deactivate()
})

test('network hidden: neither netstat nor nettop runs; disk hidden: its ioreg never runs', async () => {
  const { deps, strip, worker } = await mount({ settings: { showNetwork: false, showDisk: false } })
  for (const source of ['network', 'nettop', 'disk'] as const) await strip.tick(source)
  await fireLive(deps, strip)
  assert.equal(deps.runs.some((r) => r === NETSTAT || r === NETTOP || r === DISK), false)
  await worker.deactivate()
})

test('ps runs while only network needs its names, and not when nothing does', async () => {
  const a = await mount({ settings: { showCpu: false, showMemory: false } })
  assert.equal(a.deps.runs.includes(PS), true)
  await a.worker.deactivate()
  const b = await mount({ settings: { showCpu: false, showMemory: false, showNetwork: false } })
  await b.strip.tick('procs')
  assert.equal(b.deps.runs.includes(PS), false)
  await b.worker.deactivate()
})

test('network hover: no apps after one nettop read, then apps named by ps', async () => {
  const deps = fakeDeps({ ...baseOutputs(), [NETTOP]: 'Google Chrome H.101,1000,0,\n' })
  const { last, strip, worker } = await mount({ deps })
  deps.mono += 2000
  await strip.tick('network')
  assert.equal(last('network')!.tooltip.includes('Top apps'), false)
  deps.outputs[NETTOP] = 'Google Chrome H.101,4000,0,\n'
  await strip.tick('nettop')
  assert.equal(last('network')!.tooltip.split('\n')[1], 'Top apps, open connections, last 30 s: Google Chrome 3.0 KB')
  await worker.deactivate()
})

test('nettop failing three times drops the apps but never dashes Network', async () => {
  const deps = fakeDeps({ ...baseOutputs(), [NETTOP]: 'node.101,1000,0,\n' })
  const { last, strip, worker } = await mount({ deps })
  deps.outputs[NETTOP] = 'node.101,4000,0,\n'
  await strip.tick('nettop')
  deps.mono += 2000
  await strip.tick('network')
  assert.equal(last('network')!.tooltip.includes('Top apps'), true)
  deps.outputs[NETTOP] = new Error('nettop broke')
  for (let i = 0; i < FAILS_BEFORE_DASH; i++) await strip.tick('nettop')
  assert.equal(last('network')!.tooltip.includes('Top apps'), false)
  assert.notEqual(last('network')!.text, 'Net –')
  await worker.deactivate()
})

test('netstat and the disk ioreg dash after three failures', async () => {
  const { deps, last, strip, worker } = await mount()
  deps.outputs[NETSTAT] = new Error('netstat broke')
  deps.outputs[DISK] = new Error('ioreg broke')
  for (let i = 0; i < FAILS_BEFORE_DASH; i++) {
    deps.mono += 5000
    await strip.tick('network')
    await strip.tick('disk')
  }
  assert.deepEqual([last('network')!.text, last('network')!.tooltip], ['Net –', 'netstat failed'])
  assert.deepEqual([last('disk')!.text, last('disk')!.tooltip], ['Disk –', 'ioreg failed'])
  await worker.deactivate()
})

test('disk switched back on starts from a new baseline with an empty trend', async () => {
  const { api, deps, last, strip, worker } = await mount({ settings: { diskStyle: 'trend' } })
  deps.outputs[DISK] = diskOut(1000 + 60e6, 1000 + 10e6)
  deps.mono += 5000
  await strip.tick('disk')
  await api.settings.set('showDisk', false)
  await strip.settled()
  await api.settings.set('showDisk', true)
  await strip.settled()
  assert.equal(last('disk')!.text, '–')
  deps.outputs[DISK] = diskOut(1000 + 60e6 + 5e6, 1000 + 10e6)
  deps.mono += 5000
  await strip.tick('disk')
  assert.equal(last('disk')!.text, pairText('disk', 'trend', 1e6, 0, [1e6]))
  await worker.deactivate()
})

test('disk space: percent used, warning at 90%, from the Data volume on macOS', async () => {
  const { deps, last, strip, worker } = await mount()
  assert.deepEqual([last('space')!.text, last('space')!.icon, last('space')!.tone], ['Space 69%', 'folder', 'neutral'])
  assert.deepEqual(deps.statfsCalls, [DATA])
  deps.space[DATA] = { total: 1000e9, available: 100e9 }
  await strip.tick('space')
  assert.equal(last('space')!.tone, 'warning')
  await worker.deactivate()
})

test('disk space: off macOS it reads /, and disk and network never show or run', async () => {
  const { deps, last, strip, worker } = await mount({ deps: fakeDeps(baseOutputs(), 'linux') })
  await strip.tick('disk')
  await strip.tick('network')
  await strip.tick('nettop')
  assert.deepEqual(deps.statfsCalls, ['/'])
  assert.equal(last('space')!.text, 'Space 20%')
  assert.deepEqual([last('disk')!.visible, last('network')!.visible], [false, false])
  assert.deepEqual(deps.runs, [])
  await worker.deactivate()
})

test('disk space: statfs failing three times dashes it', async () => {
  const { deps, last, strip, worker } = await mount()
  deps.space[DATA] = new Error('statfs broke')
  for (let i = 0; i < FAILS_BEFORE_DASH; i++) await strip.tick('space')
  assert.equal(last('space')!.text, 'Space –')
  await worker.deactivate()
})

test('disk space switched on is read at once', async () => {
  const { api, deps, last, strip, worker } = await mount({ settings: { showDiskSpace: false } })
  assert.deepEqual(deps.statfsCalls, [])
  await api.settings.set('showDiskSpace', true)
  await strip.settled()
  assert.deepEqual(deps.statfsCalls, [DATA])
  assert.equal(last('space')!.text, 'Space 69%')
  await worker.deactivate()
})

test('a network style change redraws from the last speeds without a new read', async () => {
  const { api, deps, last, strip, worker } = await mount({ settings: { networkStyle: 'number' } })
  deps.outputs[NETSTAT] = netOut(['en0', 1000 + 2e6, 1000 + 1e6])
  deps.mono += 2000
  await strip.tick('network')
  const reads = deps.runs.filter((r) => r === NETSTAT).length
  await api.settings.set('networkStyle', 'bar')
  await strip.settled()
  assert.equal(last('network')!.text, pairText('network', 'bar', 1e6, 5e5, []))
  assert.equal(deps.runs.filter((r) => r === NETSTAT).length, reads)
  await worker.deactivate()
})

test('the disk card shows the number form and a sample per style', async () => {
  const { deps, strip, worker } = await mount()
  deps.outputs[DISK] = diskOut(1000 + 60e6, 1000 + 10e6)
  deps.mono += 5000
  await strip.tick('disk')
  const disk = card(await snapshotOf(worker), 'disk')
  assert.equal(disk.value, pairText('disk', 'number', 12e6, 2e6, []))
  assert.deepEqual(
    disk.samples.map((s) => [s.style, s.text, s.icon]),
    STYLES.disk.map((style) => [style, pairText('disk', style, 12e6, 2e6, [14e6]), 'database'])
  )
  await worker.deactivate()
})

test('after a dash, a read that only restarts the count clears the old speed from the card too', async () => {
  const { deps, last, strip, worker } = await mount({ settings: { diskStyle: 'number' } })
  deps.outputs[DISK] = diskOut(1000 + 60e6, 1000 + 10e6)
  deps.mono += 5000
  await strip.tick('disk')
  deps.outputs[DISK] = new Error('ioreg broke')
  for (let i = 0; i < FAILS_BEFORE_DASH; i++) {
    deps.mono += 5000
    await strip.tick('disk')
  }
  assert.equal(last('disk')!.text, '–')
  deps.outputs[DISK] = diskOut(2e9, 2e9)
  deps.mono += 5000
  await strip.tick('disk')
  assert.equal(card(await snapshotOf(worker), 'disk').value, null, 'no stale speed while the bar has no reading')
  deps.outputs[DISK] = diskOut(2e9 + 5e6, 2e9)
  deps.mono += 5000
  await strip.tick('disk')
  assert.equal(last('disk')!.text, pairText('disk', 'number', 1e6, 0, []))
  await worker.deactivate()
})

test('a disk read still running when Disk is switched off and on is thrown away', async () => {
  const { api, deps, last, strip, worker } = await mount({ settings: { diskStyle: 'number' } })
  let release: (out: string) => void = () => undefined
  deps.hold[DISK] = new Promise<string>((resolve) => {
    release = resolve
  })
  const stale = strip.tick('disk')
  // settled() would wait for the held read, so let the two settings changes run by turns instead.
  const turns = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await api.settings.set('showDisk', false)
  await turns()
  await api.settings.set('showDisk', true)
  await turns()
  delete deps.hold[DISK]
  release(diskOut(1000, 1000))
  await stale
  await strip.settled()
  deps.outputs[DISK] = diskOut(1000 + 60e6, 1000 + 10e6)
  deps.mono += 5000
  await strip.tick('disk')
  assert.equal(last('disk')!.text, '–', 'the first read after switching on is the baseline, not the stale one')
  await worker.deactivate()
})

test('per-app traffic after a missed nettop read starts a new baseline instead of a long total', async () => {
  const deps = fakeDeps({ ...baseOutputs(), [NETTOP]: 'node.101,1000,0,\n' })
  const { last, strip, worker } = await mount({ deps })
  deps.mono += 2000
  await strip.tick('network')
  deps.outputs[NETTOP] = 'node.101,90000,0,\n'
  deps.mono += 2 * NETTOP_MS
  await strip.tick('nettop')
  assert.equal(last('network')!.tooltip.includes('Top apps'), false, 'a baseline older than one interval is not reported')
  deps.outputs[NETTOP] = 'node.101,93000,0,\n'
  deps.mono += NETTOP_MS
  await strip.tick('nettop')
  assert.equal(last('network')!.tooltip.split('\n')[1], 'Top apps, open connections, last 30 s: Google Chrome 3.0 KB')
  await worker.deactivate()
})
