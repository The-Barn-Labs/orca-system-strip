import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../fixtures/read.ts'
import { perSecond } from './counters.ts'
import type { Counters } from './counters.ts'
import { parseDiskIo } from './disk.ts'
import { parseNetstat, parseNettop, topTraffic } from './network.ts'

test('parseDiskIo keys each driver by its registry id', () => {
  const disks = parseDiskIo(fixture('ioreg-disk.txt'))
  assert.ok(disks)
  assert.deepEqual([...disks], [
    ['id 0x100000ecb', [0, 0]],
    ['id 0x100000afa', [5085139652608, 4020185473024]]
  ])
})

test('parseDiskIo without statistics is null', () => {
  assert.equal(parseDiskIo(''), null)
  assert.equal(parseDiskIo('+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x1, registered>\n'), null)
})

test('parseNetstat keeps real interfaces and reads bytes from the right', () => {
  const nets = parseNetstat(fixture('netstat.txt'))
  assert.ok(nets)
  assert.deepEqual([...nets], [
    ['en0', [99989797893, 22321891501]],
    ['awdl0', [116676180, 3109908]]
  ])
})

test('parseNetstat leaves out loopback, tunnels, bridges and VM links', () => {
  const nets = parseNetstat(fixture('netstat.txt'))!
  for (const name of ['lo0', 'gif0', 'utun0', 'bridge0', 'bridge100', 'vmenet0', 'ap1']) assert.equal(nets.has(name), false, name)
})

test('parseNetstat with no link rows is null', () => assert.equal(parseNetstat(''), null))

test('parseNettop splits the pid at the last dot', () => {
  const rows = parseNettop(fixture('nettop.txt'))
  assert.equal(rows.length, 7)
  assert.deepEqual(rows[0], { pid: 817, name: 'apsd', bytes: 6493 + 99092 })
  assert.deepEqual(rows.at(-1), { pid: 54107, name: '2.1.322', bytes: 1500 })
  assert.deepEqual(rows.find((r) => r.pid === 3868)?.name, 'Claude Usage')
  assert.deepEqual(parseNettop(',bytes_in,bytes_out,\n\n'), [])
})

test('topTraffic adds per-pid deltas by app, clamped at 0, names from ps first', () => {
  const prev = new Map([
    [1, 1000],
    [2, 5000],
    [3, 900]
  ])
  const rows = [
    { pid: 1, name: 'node', bytes: 4000 }, // +3000
    { pid: 2, name: 'curl', bytes: 4000 }, // went down: 0
    { pid: 3, name: 'git', bytes: 900 }, // 0: dropped
    { pid: 4, name: 'node', bytes: 500 }, // new: +500
    { pid: 5, name: 'Chrome Helpe', bytes: 2000 } // new: +2000
  ]
  const names = new Map([[5, 'Google Chrome']])
  assert.deepEqual(topTraffic(prev, rows, names), [
    { name: 'node', value: 3500 },
    { name: 'Google Chrome', value: 2000 }
  ])
})

test('topTraffic keeps the top n, ties by name', () => {
  const rows = ['b', 'a', 'c', 'd'].map((name, i) => ({ pid: i + 1, name, bytes: name === 'd' ? 50 : 100 }))
  assert.deepEqual(topTraffic(new Map(), rows, new Map(), 3), [
    { name: 'a', value: 100 },
    { name: 'b', value: 100 },
    { name: 'c', value: 100 }
  ])
})

const counters = (entries: [string, number, number][]): Counters => new Map(entries.map(([k, a, b]) => [k, [a, b] as const]))

test('perSecond divides per-key deltas by the seconds', () =>
  assert.deepEqual(perSecond(counters([['en0', 1000, 500]]), counters([['en0', 11000, 2500]]), 2), [5000, 1000]))

test('perSecond ignores keys that come or go', () =>
  assert.deepEqual(
    perSecond(
      counters([
        ['en0', 0, 0],
        ['en5', 9e9, 9e9]
      ]),
      counters([
        ['en0', 100, 100],
        ['en7', 9e9, 9e9]
      ]),
      1
    ),
    [100, 100]
  ))

test('perSecond counts a counter that went down as 0', () =>
  assert.deepEqual(
    perSecond(
      counters([
        ['en0', 5000, 5000],
        ['awdl0', 0, 0]
      ]),
      counters([
        ['en0', 10, 6000],
        ['awdl0', 300, 0]
      ]),
      1
    ),
    [300, 1000]
  ))

test('perSecond with no elapsed time is zero', () => {
  assert.deepEqual(perSecond(counters([['en0', 0, 0]]), counters([['en0', 100, 100]]), 0), [0, 0])
  assert.deepEqual(perSecond(counters([['en0', 0, 0]]), counters([['en0', 100, 100]]), -1), [0, 0])
})
