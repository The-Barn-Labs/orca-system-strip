import type { Counters } from './counters.ts'
import type { TopApp } from './processes.ts'

/** Loopback, tunnels, bridges and VM links: their traffic also crosses a real interface. */
const COUNTED_ELSEWHERE = /^(lo|utun|ipsec|gif|stf|bridge|vmenet|ap)\d+$/

/**
 * Reads `netstat -ibn`: bytes in and out per interface, from the `<Link#…>` rows. Columns are read
 * from the right, since some rows have no Address. Null when there is no link row at all.
 */
export function parseNetstat(out: string): Counters | null {
  const nets: Counters = new Map()
  let links = 0
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 8 || !cols[2].startsWith('<Link#')) continue
    links += 1
    const name = cols[0].replace(/\*$/, '')
    if (COUNTED_ELSEWHERE.test(name)) continue
    const bytesIn = Number(cols[cols.length - 5])
    const bytesOut = Number(cols[cols.length - 2])
    if (Number.isFinite(bytesIn) && Number.isFinite(bytesOut)) nets.set(name, [bytesIn, bytesOut])
  }
  return links ? nets : null
}

export type NettopRow = { pid: number; name: string; bytes: number }

const NETTOP_ROW = /^(.*)\.(\d+),(\d+),(\d+),?\s*$/

/**
 * Reads `nettop -P -L 1 -x -J bytes_in,bytes_out`: rows of `name.pid,in,out,`. The pid is after
 * the last dot, since names can hold dots (Claude Code's processes are named after their version).
 */
export function parseNettop(out: string): NettopRow[] {
  const rows: NettopRow[] = []
  for (const line of out.split('\n')) {
    const m = NETTOP_ROW.exec(line)
    if (m) rows.push({ pid: Number(m[2]), name: m[1], bytes: Number(m[3]) + Number(m[4]) })
  }
  return rows
}

/**
 * The apps with the most traffic since the previous `nettop` read. Counters cover open connections
 * only, so they can go down: a pid's delta is clamped at 0. A pid new since then counts from 0.
 */
export function topTraffic(prev: ReadonlyMap<number, number>, rows: readonly NettopRow[], names: ReadonlyMap<number, string>, n = 3): TopApp[] {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const delta = Math.max(0, row.bytes - (prev.get(row.pid) ?? 0))
    const name = names.get(row.pid) ?? row.name
    totals.set(name, (totals.get(name) ?? 0) + delta)
  }
  return [...totals]
    .map(([name, value]) => ({ name, value }))
    .filter((app) => app.value > 0)
    .sort((a, b) => b.value - a.value || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, n)
}
