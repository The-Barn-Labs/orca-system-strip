export type MemoryPages = { pageSize: number; anonymous: number; purgeable: number; wired: number; compressed: number }
export type Pressure = 'normal' | 'warn' | 'critical'

function count(text: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp('^' + escaped + ':\\s+(\\d+)\\.?\\s*$', 'm').exec(text)
  return match ? Number(match[1]) : null
}

/** Reads the page counts `vm_stat` prints; null when any of them is missing. */
export function parseVmStat(out: string): MemoryPages | null {
  const size = /page size of (\d+) bytes/.exec(out)
  const anonymous = count(out, 'Anonymous pages')
  const purgeable = count(out, 'Pages purgeable')
  const wired = count(out, 'Pages wired down')
  const compressed = count(out, 'Pages occupied by compressor')
  if (!size || anonymous === null || purgeable === null || wired === null || compressed === null) return null
  return { pageSize: Number(size[1]), anonymous, purgeable, wired, compressed }
}

/** Memory in use the way macOS Activity Monitor counts it: app memory + wired + compressed. */
export function memoryUsed(p: MemoryPages, totalBytes: number): { usedBytes: number; percent: number } {
  const usedBytes = Math.max(0, p.anonymous - p.purgeable + p.wired + p.compressed) * p.pageSize
  const percent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0
  return { usedBytes, percent: Math.min(100, Math.max(0, percent)) }
}

/** `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parsePressure(out: string): Pressure | null {
  switch (out.trim()) {
    case '1':
      return 'normal'
    case '2':
      return 'warn'
    case '4':
      return 'critical'
    default:
      return null
  }
}
