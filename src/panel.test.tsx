// Runs under `orca plugin test .` with Orca's own panel runtime and checks.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Card, Snapshot } from './protocol.ts'
import { DEFAULTS } from './settings.ts'
import { STYLES, STYLE_LABEL } from './styles.ts'
import type { StyledId } from './styles.ts'

const ICON = { cpu: 'activity', gpu: 'gauge', memory: 'layers', battery: 'zap' } as const

function cardOf(id: StyledId, value: string | null, text: (style: string) => string): Card {
  return {
    id,
    shown: value !== null,
    value,
    samples: STYLES[id].map((style) => ({ style, label: STYLE_LABEL[style], text: text(style), icon: ICON[id] }))
  }
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    settings: { ...DEFAULTS },
    bar: [
      { id: 'cpu', text: '34%', icon: 'activity', tone: 'neutral' },
      { id: 'memory', text: '71%', icon: 'layers', tone: 'warning' },
      { id: 'clock', text: '14:05', tone: 'neutral' }
    ],
    cards: [
      cardOf('cpu', '34%', (s) => `cpu-${s}`),
      cardOf('gpu', '15%', (s) => `gpu-${s}`),
      cardOf('memory', '71%', (s) => `memory-${s}`),
      cardOf('battery', '87%', (s) => `battery-${s}`)
    ],
    clock: { h24: '14:05', h12: '2:05 PM' },
    hasBattery: true,
    ...overrides
  }
}

async function open(snap: Snapshot | (() => Snapshot | Promise<Snapshot>) = snapshot()) {
  const host = mockHost({ requests: { 'strip.snapshot': snap, 'strip.openActivityMonitor': { message: 'Opened Activity Monitor' } } })
  const view = await mount(panel, { host })
  return { host, view }
}

async function clean(view: Awaited<ReturnType<typeof mount>>) {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
}

test('shows a card per item and highlights the selected style', async () => {
  const { view } = await open()
  for (const title of ['CPU', 'GPU', 'Memory', 'Battery', 'Clock']) assert.ok(view.find({ label: title }), title)
  assert.equal(view.find({ testId: 'cpu-number' })?.props.variant, 'solid')
  assert.equal(view.find({ testId: 'cpu-number' })?.props.tone, 'accent', 'the selected style stands out in dark mode')
  assert.equal(view.find({ testId: 'cpu-bar' })?.props.tone, undefined)
  assert.equal(view.find({ testId: 'cpu-bar' })?.props.variant, 'outline')
  assert.equal(view.find({ testId: 'gpu-trend' })?.text, 'gpu-trend')
  assert.equal(view.find({ testId: 'memory-trend' }), null)
  await clean(view)
})

test('the bar row shows the items as they are now', async () => {
  const { view } = await open()
  assert.equal(view.find({ testId: 'bar-memory' })?.text, '71%')
  assert.equal(view.find({ testId: 'bar-memory' })?.props.tone, 'warning')
  await clean(view)
})

test("pressing a sample writes that item's style", async () => {
  const { host, view } = await open()
  await view.press({ testId: 'gpu-bar' })
  assert.equal(host.data().settings.gpuStyle, 'bar')
  await clean(view)
})

test('the Show switch writes showMemory', async () => {
  const { host, view } = await open()
  assert.equal(view.find({ label: 'Show memory' })?.key, 'memory-show')
  await view.toggle({ testId: 'memory-show' })
  assert.equal(host.data().settings.showMemory, false)
  await clean(view)
})

test('the clock samples write clock24h', async () => {
  const { host, view } = await open()
  assert.equal(view.find({ testId: 'clock-12' })?.text, '2:05 PM')
  assert.equal(view.find({ testId: 'clock-24' })?.props.tone, 'accent')
  await view.press({ testId: 'clock-12' })
  assert.equal(host.data().settings.clock24h, false)
  await clean(view)
})

test('refresh writes a number', async () => {
  const { host, view } = await open()
  await view.select({ testId: 'refresh' }, '5')
  assert.equal(host.data().settings.refreshSeconds, 5)
  await clean(view)
})

test('a posted snapshot updates the samples', async () => {
  const { view } = await open()
  const next = snapshot()
  next.cards[0] = cardOf('cpu', '90%', (s) => `hot-${s}`)
  next.settings = { ...DEFAULTS, cpuStyle: 'level' }
  await view.post('strip.snapshot', next)
  assert.equal(view.find({ testId: 'cpu-level' })?.text, 'hot-level')
  assert.equal(view.find({ testId: 'cpu-level' })?.props.variant, 'solid')
  await clean(view)
})

test('the Activity Monitor button asks the worker', async () => {
  const { host, view } = await open()
  await view.press({ testId: 'activity-monitor' })
  assert.ok(host.calls.some((c) => c.method === 'plugin.request' && (c.params as { name: string }).name === 'strip.openActivityMonitor'))
  await clean(view)
})

test('a failed first request shows waiting, then the posted snapshot', async () => {
  const { view } = await open(() => {
    throw hostError('timeout', 'worker is slow')
  })
  assert.ok(view.find({ text: 'Waiting for System Strip…' }))
  await view.post('strip.snapshot', snapshot())
  assert.ok(view.find({ testId: 'cpu-number' }))
  await clean(view)
})

test('without a battery the card says so', async () => {
  const snap = snapshot({ hasBattery: false })
  snap.cards[3] = { id: 'battery', shown: false, value: null, samples: [] }
  const { view } = await open(snap)
  assert.ok(view.find({ text: 'No battery on this Mac' }))
  assert.equal(view.find({ testId: 'battery-number' }), null)
  assert.equal(view.find({ testId: 'battery-show' }), null)
  await clean(view)
})
