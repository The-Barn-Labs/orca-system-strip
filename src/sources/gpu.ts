export type GpuReading = { utilization: number; models: string[] }

const UTILIZATION = /"Device Utilization %"\s*=\s*(\d+)/
const MODEL = /"model"\s*=\s*"([^"]*)"/

/** Reads `ioreg -r -d 1 -c IOAccelerator`: the busiest accelerator's utilisation and every model. */
export function parseGpu(ioreg: string): GpuReading | null {
  let utilization: number | null = null
  const models: string[] = []
  for (const block of ioreg.split(/^\+-o /m)) {
    const use = UTILIZATION.exec(block)
    if (use) utilization = Math.max(utilization ?? 0, Math.min(100, Number(use[1])))
    const model = MODEL.exec(block)
    if (model && model[1]) models.push(model[1])
  }
  return utilization === null ? null : { utilization, models }
}
