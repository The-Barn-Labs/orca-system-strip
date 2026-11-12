// `orca plugin check` renders the panel once per scenario, each with the real worker on a fresh host.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  fresh: {},
  styled: { settings: { cpuStyle: 'trend', gpuStyle: 'bar', memoryStyle: 'level' } },
  minimal: { settings: { showGpu: false, showBattery: false } }
})
