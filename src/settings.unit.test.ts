import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULTS, STYLE_KEY, readSettings } from './settings.ts'
import { STYLES, STYLE_LABEL } from './styles.ts'
import type { StyledId } from './styles.ts'

test('empty settings give the spec defaults', () => assert.deepEqual(readSettings({}), DEFAULTS))

test('defaults are all items on, 24h clock, 2 s', () =>
  assert.deepEqual(DEFAULTS, { showCpu: true, showGpu: true, showMemory: true, showBattery: true, showClock: true, clock24h: true, refreshSeconds: 2, cpuStyle: 'number', gpuStyle: 'number', memoryStyle: 'number', batteryStyle: 'number' }))

test('valid values are kept', () =>
  assert.deepEqual(readSettings({ showGpu: false, clock24h: false, refreshSeconds: 5 }), { ...DEFAULTS, showGpu: false, clock24h: false, refreshSeconds: 5 }))

test('wrong types and out-of-enum values fall back', () =>
  assert.deepEqual(readSettings({ showCpu: 'no', refreshSeconds: 3, extra: 1 }), DEFAULTS))

test('non-objects fall back', () => {
  for (const raw of [null, undefined, 7, 'x', []]) assert.deepEqual(readSettings(raw), DEFAULTS)
})

test('styles default to number', () => {
  const s = readSettings({})
  assert.deepEqual([s.cpuStyle, s.gpuStyle, s.memoryStyle, s.batteryStyle], ['number', 'number', 'number', 'number'])
})

test('a valid style is kept', () => assert.equal(readSettings({ cpuStyle: 'trend' }).cpuStyle, 'trend'))

test('a style the item does not offer falls back to number', () => {
  const s = readSettings({ memoryStyle: 'trend', batteryStyle: 'sparkle', gpuStyle: 7 })
  assert.deepEqual([s.memoryStyle, s.batteryStyle, s.gpuStyle], ['number', 'number', 'number'])
})

test('style settings in the manifest match STYLES and STYLE_LABEL', () => {
  const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  const settings: { key: string; enum?: string[]; enumLabels?: string[]; default?: unknown }[] = manifest.contributes.settings
  for (const id of Object.keys(STYLE_KEY) as StyledId[]) {
    const entry = settings.find((s) => s.key === STYLE_KEY[id])
    assert.ok(entry, `${STYLE_KEY[id]} is declared`)
    assert.deepEqual(entry.enum, STYLES[id])
    assert.deepEqual(entry.enumLabels, STYLES[id].map((v) => STYLE_LABEL[v]))
    assert.equal(entry.default, 'number')
  }
})
