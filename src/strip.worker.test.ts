// Runs under `orca plugin test .` only: it needs orca/testing, which exists inside that runner.
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { BATTERY_MS, COMMAND_ID, FAILS_BEFORE_DASH, GPU_MIN_MS, PROCS_MS, startStrip } from './strip.ts'
import type { Deps, Strip } from './strip.ts'
import { ITEM_IDS, placeholderItem } from './format.ts'
import { fixture } from './fixtures/read.ts'

const IOREG = 'ioreg -r -d 1 -c IOAccelerator'
const VM_STAT = 'vm_stat'
const PRESSURE = 'sysctl -n kern.memorystatus_vm_pressure_level'
const PMSET = 'pmset -g batt'
const PS = 'ps -Aeo pid=,pcpu=,rss=,comm='
const OPEN = 'open -a Activity Monitor'
const GPU_OUT = '"model" = "Test GPU"\n"Device Utilization %"=15'

type Outputs = Record<string, string | Error>

function baseOutputs(): Outputs {
  return {
    [IOREG]: GPU_OUT,
    [VM_STAT]: fixture('vm_stat.txt'),
    [PRESSURE]: '1\n',
    [PMSET]: fixture('pmset-discharging.txt'),
    [PS]: fixture('ps.txt'),
    [OPEN]: ''
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
    platform,
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

type Update = { id: string; text: string; tone: string; tooltip: string; visible: boolean }

/** Existing tests read words text; tests of the styles set their own. */
const WORDS = { cpuStyle: 'words', gpuStyle: 'words', memoryStyle: 'words', batteryStyle: 'words' }

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
    updates().slice(0, 5),
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
  assert.deepEqual(live(), [5000, 5000, 5000, PROCS_MS, BATTERY_MS])
  await api.settings.set('refreshSeconds', 1)
  await strip.settled()
  assert.deepEqual(live(), [1000, 1000, GPU_MIN_MS, PROCS_MS, BATTERY_MS])
  assert.deepEqual([GPU_MIN_MS, PROCS_MS, BATTERY_MS], [4000, 15_000, 30_000])
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
