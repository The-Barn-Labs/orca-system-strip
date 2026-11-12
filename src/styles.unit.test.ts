import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STYLES, bar, dashText, level, num, styledText, trend } from './styles.ts'
import type { StyledId } from './styles.ts'

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
