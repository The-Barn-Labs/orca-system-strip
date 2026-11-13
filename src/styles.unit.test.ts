import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STYLES, bar, dashText, level, num, pairText, percentText, speed, speedPosition, styledText, trend } from './styles.ts'
import type { SpeedId, Style, StyledId } from './styles.ts'

const F = ' '

test('num pads with a figure space and clamps', () =>
  assert.deepEqual([4, 34, 100, 100.4, 101, -3, NaN].map(num), [`${F}4%`, '34%', '100%', '100%', '100%', `${F}0%`, `${F}0%`]))

test('bar has five cells of 20%', () =>
  assert.deepEqual(
    [0, 9, 10, 34, 50, 85, 90, 140].map(bar),
    ['▱▱▱▱▱', '▱▱▱▱▱', '▰▱▱▱▱', '▰▰▱▱▱', '▰▰▰▱▱', '▰▰▰▰▱', '▰▰▰▰▰', '▰▰▰▰▰']
  ))

test('level has eight steps', () =>
  assert.deepEqual([0, 12.4, 12.5, 34, 87.5, 100, -1].map(level), ['▁', '▁', '▂', '▃', '█', '█', '▁']))

test('trend keeps the last six, oldest first, padded on the left', () => {
  assert.equal(trend([]), F.repeat(6))
  assert.equal(trend([10, 90]), F.repeat(4) + '▁█')
  assert.equal(trend([0, 10, 20, 30, 40, 50, 60, 70]), '▂▃▄▅▅▆')
})

test('styledText per style', () => {
  assert.equal(styledText('cpu', 'words', 34, []), 'CPU 34%')
  assert.equal(styledText('memory', 'number', 7, []), `${F}7%`)
  assert.equal(styledText('gpu', 'bar', 34, []), '▰▰▱▱▱')
  assert.equal(styledText('cpu', 'trend', 34, [10, 34]), F.repeat(4) + '▁▃ 34%')
  assert.equal(styledText('battery', 'level', 87, []), '▇87%')
})

test('a style the item does not offer renders as number', () => assert.equal(styledText('memory', 'trend', 34, [34]), '34%'))

test("every styled text fits Orca's 64-character limit", () => {
  for (const id of Object.keys(STYLES) as StyledId[])
    for (const s of STYLES[id]) assert.ok(styledText(id, s, 100, Array(20).fill(100)).length <= 64)
})

test('dashText', () => {
  assert.equal(dashText('cpu', 'words'), 'CPU –')
  assert.equal(dashText('cpu', 'bar'), '–')
})

test('only cpu and gpu offer trend', () => {
  assert.ok(STYLES.cpu.includes('trend') && STYLES.gpu.includes('trend'))
  assert.ok(!STYLES.memory.includes('trend') && !STYLES.battery.includes('trend'))
})

const P = ' '
const s = speed

test('speed picks the unit and keeps three digits and a point of width', () =>
  assert.deepEqual(
    [0, 960, 4_200_000, 12_000_000, 310_000, 9_970, 999_600, 1.5e9, 2e12, -5, NaN].map(speed),
    [`${F}0.0K`, `${F}1.0K`, `${F}4.2M`, `${F}${P}12M`, `${P}310K`, `${F}${P}10K`, `${F}1.0M`, `${F}1.5G`, `${P}2000G`, `${F}0.0K`, `${F}0.0K`]
  ))

test('speedPosition is 20 per ×10 above 1 KB/s, clamped', () =>
  assert.deepEqual([0, 1000, 10_000, 1e6, 1e8, 1e10, NaN].map(speedPosition), [0, 0, 20, 60, 100, 100, 0]))

test('pairText per style', () => {
  assert.equal(pairText('disk', 'number', 12e6, 85e6, []), `R ${s(12e6)} W ${s(85e6)}`)
  assert.equal(pairText('network', 'number', 4.2e6, 310e3, []), `↓${s(4.2e6)} ↑${s(310e3)}`)
  assert.equal(pairText('network', 'words', 4.2e6, 310e3, []), `Net ↓${s(4.2e6)} ↑${s(310e3)}`)
  assert.equal(pairText('disk', 'words', 12e6, 85e6, []), `Disk R ${s(12e6)} W ${s(85e6)}`)
  assert.equal(pairText('disk', 'bar', 12e6, 85e6, []), 'R ▰▰▰▰▱ W ▰▰▰▰▰')
  assert.equal(pairText('network', 'bar', 4.2e6, 310e3, []), '↓▰▰▰▰▱ ↑▰▰▱▱▱')
  assert.equal(pairText('disk', 'level', 12e6, 85e6, []), `▇R ${s(12e6)} █W ${s(85e6)}`)
  assert.equal(pairText('network', 'level', 4.2e6, 310e3, []), `▆↓${s(4.2e6)} ▄↑${s(310e3)}`)
  assert.equal(pairText('disk', 'trend', 12e6, 85e6, [97e6]), `${F.repeat(5)}█ R ${s(12e6)} W ${s(85e6)}`)
})

test('every pair text fits 64 characters', () => {
  const styles: Style[] = ['words', 'number', 'bar', 'trend', 'level']
  for (const id of ['disk', 'network'] as SpeedId[])
    for (const style of styles) assert.ok(pairText(id, style, 2e12, 2e12, Array(20).fill(4e12)).length <= 64, `${id} ${style}`)
})

test('percentText draws a labelled percent like styledText', () => {
  assert.equal(percentText('Space', 'words', 62, []), 'Space 62%')
  assert.equal(styledText('cpu', 'words', 34, []), 'CPU 34%')
})
