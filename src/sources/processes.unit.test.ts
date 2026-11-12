import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appName, parsePs, topApps } from './processes.ts'
import { fixture } from '../fixtures/read.ts'

const rows = parsePs(fixture('ps.txt'))

test('ps: parses rows, keeps spaces, skips garbage', () => {
  assert.equal(rows.length, 7)
  assert.equal(rows[1].path.endsWith('Google Chrome Helper (Renderer)'), true)
  assert.deepEqual(rows[0], { pid: 101, cpu: 10, rssKb: 400000, path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
})

test('appName: outermost .app wins', () => {
  assert.equal(appName(rows[1].path), 'Google Chrome')
  assert.equal(appName('/usr/local/bin/claude'), 'claude')
})

test('topApps cpu: grouped and per-machine scale', () =>
  assert.deepEqual(topApps(rows, 'cpu', 10), [
    { name: 'claude', value: 9 },
    { name: 'Google Chrome', value: 7 },
    { name: 'WindowServer', value: 0.6 }
  ]))

test('topApps memory: grouped bytes', () =>
  assert.deepEqual(topApps(rows, 'memory', 10, 2), [
    { name: 'Google Chrome', value: 1300000 * 1024 },
    { name: 'claude', value: 500000 * 1024 }
  ]))

test('topApps: empty input', () => assert.deepEqual(topApps([], 'cpu', 8), []))

test('topApps: ties sort by name', () =>
  assert.deepEqual(
    topApps(
      [
        { pid: 1, cpu: 5, rssKb: 1, path: '/b' },
        { pid: 2, cpu: 5, rssKb: 1, path: '/a' }
      ],
      'cpu',
      1
    ),
    [
      { name: 'a', value: 5 },
      { name: 'b', value: 5 }
    ]
  ))
