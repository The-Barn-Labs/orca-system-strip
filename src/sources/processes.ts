export type ProcRow = { pid: number; cpu: number; rssKb: number; path: string }
export type TopApp = { name: string; value: number }

const ROW = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/

/** Reads `ps -Aeo pid=,pcpu=,rss=,comm=`; the path is the rest of the line, spaces kept. */
export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of out.split('\n')) {
    const m = ROW.exec(line)
    if (m) rows.push({ pid: Number(m[1]), cpu: Number(m[2]), rssKb: Number(m[3]), path: m[4] })
  }
  return rows
}

/** The app a process belongs to: its outermost `<Name>.app` bundle, else the executable's name. */
export function appName(path: string): string {
  const bundle = /(?:^|\/)([^/]+)\.app(?:\/|$)/.exec(path)
  if (bundle) return bundle[1]
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

/**
 * The top apps by CPU or memory, with every process of one app added together.
 * CPU is divided by the core count so it reads on the same whole-machine scale as the status bar.
 */
export function topApps(rows: readonly ProcRow[], by: 'cpu' | 'memory', cores: number, n = 3): TopApp[] {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const value = by === 'cpu' ? row.cpu : row.rssKb * 1024
    const name = appName(row.path)
    totals.set(name, (totals.get(name) ?? 0) + value)
  }
  const divisor = by === 'cpu' ? Math.max(1, cores) : 1
  return [...totals]
    .map(([name, total]) => ({ name, value: by === 'cpu' ? Math.round((total / divisor) * 10) / 10 : total }))
    .filter((app) => app.value > 0)
    .sort((a, b) => b.value - a.value || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, n)
}
