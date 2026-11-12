export type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number }
export type CpuSample = { busy: number; total: number }

/** Sums every core's tick counters (as `os.cpus()` reports them). */
export function sampleCpu(cpus: readonly { times: CpuTimes }[]): CpuSample {
  let busy = 0
  let total = 0
  for (const { times } of cpus) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq
    total += all
    busy += all - times.idle
  }
  return { busy, total }
}

/** Whole-machine busy percent between two samples; null when no time has passed. */
export function cpuPercent(prev: CpuSample, next: CpuSample): number | null {
  const total = next.total - prev.total
  if (total <= 0) return null
  const percent = Math.round(((next.busy - prev.busy) / total) * 100)
  return Math.min(100, Math.max(0, percent))
}
