/** Byte counters since start-up, two per key (read and written, or in and out). */
export type Counters = Map<string, readonly [number, number]>

/**
 * Bytes per second between two reads. Only keys in both reads count, so a disk or interface that
 * comes or goes adds no spike; a counter that went down (a reset) adds 0.
 */
export function perSecond(prev: Counters, next: Counters, seconds: number): [number, number] {
  if (!(seconds > 0)) return [0, 0]
  let a = 0
  let b = 0
  for (const [key, [na, nb]] of next) {
    const before = prev.get(key)
    if (!before) continue
    a += Math.max(0, na - before[0])
    b += Math.max(0, nb - before[1])
  }
  return [a / seconds, b / seconds]
}
