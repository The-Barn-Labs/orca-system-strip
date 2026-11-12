// Runs under `orca plugin test .` only: it needs orca/testing, which exists inside that runner.
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { COMMAND_ID, FAILS_BEFORE_DASH, startStrip } from './strip.ts'
import type { Deps, Strip } from './strip.ts'
import { ITEM_IDS, PLACEHOLDER } from './format.ts'
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

type Fake = Deps & { outputs: Outputs; runs: string[]; timers: { kind: 'every' | 'after'; ms: number; fn: () => void; cancelled: boolean }[]; clock: number }

function fakeDeps(outputs: Outputs = baseOutputs(), platform = 'darwin'): Fake {
  let ticks = 0
  const fake: Fake = {
    outputs,
    runs: [],
    timers: [],
    clock: new Date(2026, 10, 12, 14, 5, 30).getTime(),
    platform,
    async run(cmd, args) {
      const key = [cmd, ...args].join(' ')
      fake.runs.push(key)
      const out = fake.outputs[key]
      if (out === undefined) throw new Error('no fake output for ' + key)
      if (out instanceof Error) throw out
      return out
    },
    cpus() {
      ticks += 1
      return [{ times: { user: 100 * ticks, nice: 0, sys: 0, idle: 300 * ticks, irq: 0 } }]
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

async function mount(options: { settings?: Record<string, boolean | number>; deps?: Fake; results?: Record<string, unknown> } = {}) {
  const deps = options.deps ?? fakeDeps()
  const host = mockHost({ settings: options.settings ?? {}, results: options.results })
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
    ITEM_IDS.map((id) => ({ id, text: PLACEHOLDER[id], tone: 'neutral', tooltip: 'System Strip', visible: true }))
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

test('turning an item back on shows it and polls again', async () => {
  const { api, last, strip, deps, worker } = await mount({ settings: { showGpu: false } })
  await api.settings.set('showGpu', true)
  await strip.settled()
  assert.equal(deps.runs.includes(IOREG), true)
  assert.deepEqual([last('gpu')!.visible, last('gpu')!.text], [true, 'GPU 15%'])
  await worker.deactivate()
})

test('turning an item off stops its timer', async () => {
  const { api, last, strip, deps, worker } = await mount()
  const gpuTimer = deps.timers.find((t) => t.kind === 'every' && t.ms === 2000 && !t.cancelled)
  assert.ok(gpuTimer)
  const before = deps.timers.filter((t) => !t.cancelled).length
  await api.settings.set('showGpu', false)
  await strip.settled()
  assert.equal(last('gpu')!.visible, false)
  assert.equal(deps.timers.filter((t) => !t.cancelled).length, before - 1)
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
  assert.deepEqual(updates().slice(sent), [{ id: 'gpu', text: 'GPU –', tone: 'neutral', tooltip: 'ioreg failed', visible: true }])
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
  await strip.flush()
  const resent = (host.callsOf('statusBar.update') as Update[]).slice(sentBefore).find((u) => u.id === refusedId)
  assert.ok(resent)
  assert.notEqual(resent.text, PLACEHOLDER[refusedId as keyof typeof PLACEHOLDER])
  await worker.deactivate()
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
  assert.deepEqual(live(), [5000, 5000, 5000, 5000, 30000])
  await api.settings.set('refreshSeconds', 1)
  await strip.settled()
  assert.deepEqual(live(), [1000, 1000, 1000, 5000, 30000])
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
