import type { Counters } from './counters.ts'

const DRIVER = /^\+-o IOBlockStorageDriver\s.*?\bid (0x[0-9a-f]+)/
const READ = /"Bytes \(Read\)"=(\d+)/
const WRITTEN = /"Bytes \(Write\)"=(\d+)/

/** Reads `ioreg -c IOBlockStorageDriver -r -k Statistics -d 1`: bytes read and written per disk driver. */
export function parseDiskIo(out: string): Counters | null {
  const disks: Counters = new Map()
  let id: string | null = null
  for (const line of out.split('\n')) {
    const driver = DRIVER.exec(line)
    if (driver) {
      id = `id ${driver[1]}`
      continue
    }
    if (!id || !line.includes('"Statistics"')) continue
    const read = READ.exec(line)
    const written = WRITTEN.exec(line)
    if (read && written) disks.set(id, [Number(read[1]), Number(written[1])])
    id = null
  }
  return disks.size ? disks : null
}
