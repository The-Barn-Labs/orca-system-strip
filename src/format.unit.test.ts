import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ITEM_IDS,
  Smoother,
  batteryItem,
  batteryTone,
  clockItem,
  cpuItem,
  decimalBytes,
  diskItem,
  diskSpaceItem,
  networkItem,
  rateText,
  spaceTone,
  dashItem,
  gb,
  gpuItem,
  loadTone,
  memoryItem,
  placeholderItem,
  pressureTone
} from './format.ts'
import type { BatteryReading } from './sources/battery.ts'
import type { Pressure } from './sources/memory.ts'
import { pairText } from './styles.ts'

const F = '\u2007'
const pick = (s: { text: string; icon?: string }) => [s.text, s.icon]

const onBattery = (percent: number): BatteryReading => ({ present: true, percent, onPower: false, state: 'discharging', remaining: null })

test('item ids, and placeholders that match the manifest at the default style', () => {
  assert.deepEqual(ITEM_IDS, ['cpu', 'gpu', 'memory', 'disk', 'network', 'space', 'battery', 'clock'])
  assert.deepEqual(ITEM_IDS.map((id) => placeholderItem(id, 'number')), [
    { text: '–', icon: 'activity' },
    { text: '–', icon: 'gauge' },
    { text: '–', icon: 'layers' },
    { text: '–', icon: 'database' },
    { text: '–', icon: 'globe' },
    { text: '–', icon: 'folder' },
    { text: '–', icon: 'zap' },
    { text: '--:--' }
  ])
  assert.equal(placeholderItem('memory', 'words').text, 'Mem –')
  assert.equal(placeholderItem('disk', 'words').text, 'Disk –')
})

test('loadTone edges', () => assert.deepEqual([null, 69, 70, 89, 90].map(loadTone), ['neutral', 'neutral', 'warning', 'warning', 'danger']))

test('pressureTone', () =>
  assert.deepEqual(([null, 'normal', 'warn', 'critical'] as (Pressure | null)[]).map(pressureTone), ['neutral', 'neutral', 'warning', 'danger']))

test('batteryTone edges on battery', () => assert.deepEqual([21, 20, 11, 10].map((p) => batteryTone(onBattery(p))), ['neutral', 'warning', 'warning', 'danger']))

test('batteryTone never warns on power', () =>
  assert.equal(batteryTone({ present: true, percent: 5, onPower: true, state: 'not-charging', remaining: null }), 'neutral'))

test('gb has one decimal', () => assert.deepEqual([12 * 1024 ** 3, 1.25 * 1024 ** 3, 0].map(gb), ['12.0 GB', '1.3 GB', '0.0 GB']))

test('smoother averages the window', () => {
  const s = new Smoother(10_000)
  s.push(0, 100)
  s.push(5_000, 50)
  s.push(12_000, 20)
  assert.equal(s.average(), 35)
})

test('smoother empty is null', () => assert.equal(new Smoother(10_000).average(), null))

test('cpu item: tone from smoothed, text from latest', () =>
  assert.deepEqual(cpuItem(95, 60, [{ name: 'claude', value: 9 }], 'words', []), { text: 'CPU 95%', icon: 'activity', tone: 'neutral', tooltip: 'Top apps: claude 9%', visible: true }))

test('cpu item: three top apps and no top apps', () => {
  const top = [
    { name: 'claude', value: 9 },
    { name: 'Google Chrome', value: 7 },
    { name: 'WindowServer', value: 0.6 }
  ]
  assert.equal(cpuItem(30, 92, top, 'number', []).tooltip, 'Top apps: claude 9% · Google Chrome 7% · WindowServer 0.6%')
  assert.equal(cpuItem(30, 92, top, 'number', []).tone, 'danger')
  assert.equal(cpuItem(30, null, null, 'number', []).tooltip, 'CPU busy across all cores')
  assert.equal(cpuItem(30, null, [], 'number', []).tooltip, 'CPU busy across all cores')
})

test('gpu item', () => {
  assert.deepEqual(gpuItem({ utilization: 7, models: ['Apple M5 Pro'] }, 75, 'words', []), { text: `GPU ${F}7%`, icon: 'gauge', tone: 'warning', tooltip: 'Apple M5 Pro', visible: true })
  assert.equal(gpuItem({ utilization: 63, models: ['AMD Radeon Pro 5500M', 'Intel UHD Graphics 630'] }, null, 'number', []).tooltip, 'AMD Radeon Pro 5500M, Intel UHD Graphics 630')
})

test('memory item copy', () =>
  assert.deepEqual(
    memoryItem({ usedBytes: 12 * 1024 ** 3, percent: 50 }, 24 * 1024 ** 3, 'warn', [{ name: 'Google Chrome', value: 1.25 * 1024 ** 3 }], 'words'),
    { text: 'Mem 50%', icon: 'layers', tone: 'warning', tooltip: '12.0 GB of 24.0 GB used\nPressure: warning\nTop apps: Google Chrome 1.3 GB', visible: true }
  ))

test('memory item without pressure or top apps', () =>
  assert.deepEqual(memoryItem({ usedBytes: 12 * 1024 ** 3, percent: 50 }, 24 * 1024 ** 3, null, null, 'words'), {
    text: 'Mem 50%',
    icon: 'layers',
    tone: 'neutral',
    tooltip: '12.0 GB of 24.0 GB used\nPressure: unknown',
    visible: true
  }))

test('memory item critical', () => assert.equal(memoryItem({ usedBytes: 1, percent: 99 }, 2, 'critical', [], 'number').tooltip.split('\n')[1], 'Pressure: critical'))

test('battery item on power', () =>
  assert.deepEqual(batteryItem({ present: true, percent: 80, onPower: true, state: 'not-charging', remaining: null }, 'words'), {
    text: 'Bat 80%',
    icon: 'plug',
    tone: 'neutral',
    tooltip: 'On power, not charging',
    visible: true
  }))

test('battery item tooltips', () => {
  const at = (state: 'charging' | 'discharging' | 'charged' | 'not-charging', onPower: boolean, remaining: string | null) =>
    batteryItem({ present: true, percent: 50, onPower, state, remaining }, 'number').tooltip
  assert.equal(at('discharging', false, '19:58'), 'Discharging · 19:58 left')
  assert.equal(at('discharging', false, null), 'Discharging')
  assert.equal(at('charging', true, '1:05'), 'Charging · 1:05 until full')
  assert.equal(at('charging', true, null), 'Charging')
  assert.equal(at('charged', true, null), 'On power, fully charged')
  assert.equal(at('not-charging', true, null), 'On power, not charging')
})

test('battery item on battery: text and tone', () => assert.deepEqual(batteryItem(onBattery(9), 'words'), { text: `Bat ${F}9%`, icon: 'zap', tone: 'danger', tooltip: 'Discharging', visible: true }))

test('battery item absent', () => assert.equal(batteryItem({ present: false }, 'number').visible, false))

test('clock 24h and 12h', () => {
  const d = new Date(2026, 10, 12, 14, 5)
  assert.equal(clockItem(d, true).text, '14:05')
  assert.equal(clockItem(d, false).text, '2:05 PM')
  assert.equal(clockItem(new Date(2026, 10, 12, 0, 7), false).text, '12:07 AM')
  assert.equal(clockItem(new Date(2026, 10, 12, 9, 3), true).text, '09:03')
  assert.equal(clockItem(new Date(2026, 10, 12, 12, 0), false).text, '12:00 PM')
})

test('clock tooltip is the full date', () => assert.deepEqual(clockItem(new Date(2026, 10, 12, 14, 5), true), { text: '14:05', tone: 'neutral', tooltip: 'Thursday, November 12, 2026', visible: true }))

test('dash item', () => assert.deepEqual(dashItem('gpu', 'ioreg failed', 'words'), { text: 'GPU –', icon: 'gauge', tone: 'neutral', tooltip: 'ioreg failed', visible: true }))

test('cpu number style has the activity icon', () => assert.deepEqual(pick(cpuItem(34, 34, null, 'number', [])), ['34%', 'activity']))

test('cpu trend style uses the history', () => assert.equal(cpuItem(34, 34, null, 'trend', [10, 34]).text, F.repeat(4) + '▁▃ 34%'))

test('battery icon is plug on power and zap on battery, never a trailing ⚡', () => {
  assert.deepEqual(pick(batteryItem({ present: true, percent: 87, onPower: true, state: 'charging', remaining: null }, 'words')), ['Bat 87%', 'plug'])
  assert.deepEqual(pick(batteryItem({ present: true, percent: 40, onPower: false, state: 'discharging', remaining: null }, 'number')), ['40%', 'zap'])
})

test('dash follows the style', () => {
  assert.equal(dashItem('gpu', 'ioreg failed', 'words').text, 'GPU –')
  assert.equal(dashItem('gpu', 'ioreg failed', 'bar').text, '–')
  assert.equal(dashItem('gpu', 'ioreg failed', 'bar').icon, 'gauge')
})

test('tooltips are cut to 256 characters', () => {
  const top = Array.from({ length: 3 }, (_, i) => ({ name: 'A'.repeat(120) + i, value: 2 ** 30 }))
  const t = memoryItem({ usedBytes: 2 ** 34, percent: 50 }, 2 ** 35, 'normal', top, 'number').tooltip
  assert.equal(t.length, 256)
  assert.ok(t.endsWith('…'))
  const cpuTop = Array.from({ length: 3 }, (_, i) => ({ name: 'B'.repeat(120) + i, value: 9 }))
  assert.equal(cpuItem(1, 1, cpuTop, 'number', []).tooltip.length, 256)
})

test('decimalBytes uses powers of 1000', () =>
  assert.deepEqual(
    [0, 999, 1000, 310e3, 999_960, 12e6, 312e9, 5.1e12].map(decimalBytes),
    ['0 B', '999 B', '1.0 KB', '310 KB', '1.0 MB', '12 MB', '312 GB', '5.1 TB']
  ))

test('rateText', () => assert.equal(rateText(4.2e6), '4.2 MB/s'))

test('disk item: both speeds, totals on hover, never coloured', () =>
  assert.deepEqual(diskItem({ read: 12e6, write: 85e6 }, { read: 5.1e12, written: 4.0e12 }, 'number', []), {
    text: pairText('disk', 'number', 12e6, 85e6, []),
    icon: 'database',
    tone: 'neutral',
    tooltip: 'Disk: reading 12 MB/s, writing 85 MB/s\nSince start-up: 5.1 TB read · 4.0 TB written',
    visible: true
  }))

test('disk item without totals has one line', () =>
  assert.equal(diskItem({ read: 0, write: 0 }, null, 'number', []).tooltip, 'Disk: reading 0 B/s, writing 0 B/s'))

test('network item: speeds and top apps on open connections', () => {
  const item = networkItem({ down: 4.2e6, up: 310e3 }, [{ name: 'Chrome', value: 12e6 }], 'number', [])
  assert.deepEqual(pick(item), [pairText('network', 'number', 4.2e6, 310e3, []), 'globe'])
  assert.equal(item.tone, 'neutral')
  assert.equal(item.tooltip, 'Network: down 4.2 MB/s, up 310 KB/s\nTop apps, open connections, last 30 s: Chrome 12 MB')
  assert.equal(networkItem({ down: 1, up: 1 }, null, 'number', []).tooltip, 'Network: down 1 B/s, up 1 B/s')
  assert.equal(networkItem({ down: 1, up: 1 }, [], 'number', []).tooltip, 'Network: down 1 B/s, up 1 B/s')
})

test('network tooltip with long names stays within 256', () => {
  const top = ['a', 'b', 'c'].map((c) => ({ name: c.repeat(200), value: 1e6 }))
  assert.ok(networkItem({ down: 1, up: 1 }, top, 'number', []).tooltip.length <= 256)
})

test('disk space item', () => {
  const space = { total: 994e9, available: 312e9 }
  assert.deepEqual(diskSpaceItem(space, 'number'), { text: '69%', icon: 'folder', tone: 'neutral', tooltip: '312 GB free of 994 GB', visible: true })
  assert.equal(diskSpaceItem(space, 'words').text, 'Space 69%')
  assert.equal(diskSpaceItem(space, 'trend').text, '69%')
})

test('spaceTone edges', () => assert.deepEqual([89.9, 90, 94.9, 95].map(spaceTone), ['neutral', 'warning', 'warning', 'danger']))
