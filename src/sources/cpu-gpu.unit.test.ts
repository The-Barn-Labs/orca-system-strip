import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpuPercent, sampleCpu } from './cpu.ts'
import { parseGpu } from './gpu.ts'
import { fixture } from '../fixtures/read.ts'

test('cpu: busy share of the tick delta', () => {
  const a = sampleCpu([{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }])
  const b = sampleCpu([{ times: { user: 200, nice: 0, sys: 100, idle: 1050, irq: 0 } }])
  assert.equal(cpuPercent(a, b), 43)
})

test('cpu: sums cores', () =>
  assert.deepEqual(
    sampleCpu([{ times: { user: 1, nice: 1, sys: 1, idle: 1, irq: 1 } }, { times: { user: 1, nice: 0, sys: 0, idle: 3, irq: 0 } }]),
    { busy: 5, total: 9 }
  ))

test('cpu: no elapsed ticks is null, not NaN', () => {
  const s = { busy: 5, total: 9 }
  assert.equal(cpuPercent(s, s), null)
})

test('cpu: clamps to 0..100', () => assert.equal(cpuPercent({ busy: 0, total: 0 }, { busy: 10, total: 5 }), 100))

test('gpu: real Apple Silicon output', () => assert.deepEqual(parseGpu(fixture('ioreg-gpu.txt')), { utilization: 7, models: ['Apple M5 Pro'] }))

test('gpu: two accelerators show the highest', () =>
  assert.deepEqual(parseGpu(fixture('ioreg-gpu-two.txt')), { utilization: 63, models: ['AMD Radeon Pro 5500M', 'Intel UHD Graphics 630'] }))

test('gpu: no utilisation key is null', () => {
  assert.equal(parseGpu('"model" = "Intel HD"'), null)
  assert.equal(parseGpu(''), null)
})
