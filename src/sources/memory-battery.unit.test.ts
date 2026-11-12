import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryUsed, parsePressure, parseVmStat } from './memory.ts'
import { parseBattery } from './battery.ts'
import type { BatteryReading } from './battery.ts'
import { fixture } from '../fixtures/read.ts'

test('vm_stat: recorded output', () =>
  assert.deepEqual(parseVmStat(fixture('vm_stat.txt')), { pageSize: 16384, anonymous: 589705, purgeable: 5212, wired: 203490, compressed: 454553 }))

test('memoryUsed: activity-monitor formula', () =>
  assert.deepEqual(memoryUsed({ pageSize: 4096, anonymous: 1000, purgeable: 200, wired: 300, compressed: 100 }, 4096 * 2000), { usedBytes: 1200 * 4096, percent: 60 }))

test('memoryUsed: clamps', () => assert.equal(memoryUsed({ pageSize: 1, anonymous: 10, purgeable: 0, wired: 10, compressed: 10 }, 10).percent, 100))

test('vm_stat: missing field is null', () =>
  assert.equal(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1.'), null))

test('vm_stat: the tag-storage wired line is not taken for wired', () => {
  const text = fixture('vm_stat.txt').replace(/^Pages wired down:.*$/m, '')
  assert.equal(parseVmStat(text + '\nPages tag-storage non-tag wired: 8.'), null)
})

test('pressure', () => {
  assert.equal(parsePressure('1\n'), 'normal')
  assert.equal(parsePressure('2'), 'warn')
  assert.equal(parsePressure('4'), 'critical')
  assert.equal(parsePressure('x'), null)
})

test('battery: discharging', () =>
  assert.deepEqual(parseBattery(fixture('pmset-discharging.txt')), { present: true, percent: 100, onPower: false, state: 'discharging', remaining: '19:52' }))

test('battery: charging', () =>
  assert.deepEqual(parseBattery(fixture('pmset-charging.txt')), { present: true, percent: 64, onPower: true, state: 'charging', remaining: '1:05' }))

test('battery: AC attached, not charging', () =>
  assert.deepEqual(parseBattery(fixture('pmset-ac-not-charging.txt')), { present: true, percent: 80, onPower: true, state: 'not-charging', remaining: null }))

test('battery: charged', () =>
  assert.deepEqual(parseBattery(fixture('pmset-charged.txt')), { present: true, percent: 100, onPower: true, state: 'charged', remaining: null }))

test('battery: no estimate', () =>
  assert.equal((parseBattery(fixture('pmset-no-estimate.txt')) as Extract<BatteryReading, { present: true }>).remaining, null))

test('battery: finishing charge counts as charging', () =>
  assert.equal(
    (parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t99%; finishing charge; 0:05 remaining present: true") as Extract<BatteryReading, { present: true }>).state,
    'charging'
  ))

test('battery: desktop Mac has none', () => assert.deepEqual(parseBattery(fixture('pmset-desktop.txt')), { present: false }))

test('battery: garbage is null', () => assert.equal(parseBattery('hello'), null))
