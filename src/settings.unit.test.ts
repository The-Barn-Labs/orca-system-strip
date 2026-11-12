import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, readSettings } from './settings.ts'

test('empty settings give the spec defaults', () => assert.deepEqual(readSettings({}), DEFAULTS))

test('defaults are all items on, 24h clock, 2 s', () =>
  assert.deepEqual(DEFAULTS, { showCpu: true, showGpu: true, showMemory: true, showBattery: true, showClock: true, clock24h: true, refreshSeconds: 2 }))

test('valid values are kept', () =>
  assert.deepEqual(readSettings({ showGpu: false, clock24h: false, refreshSeconds: 5 }), { ...DEFAULTS, showGpu: false, clock24h: false, refreshSeconds: 5 }))

test('wrong types and out-of-enum values fall back', () =>
  assert.deepEqual(readSettings({ showCpu: 'no', refreshSeconds: 3, extra: 1 }), DEFAULTS))

test('non-objects fall back', () => {
  for (const raw of [null, undefined, 7, 'x', []]) assert.deepEqual(readSettings(raw), DEFAULTS)
})
