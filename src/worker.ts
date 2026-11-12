// System Strip: CPU, GPU, memory, battery and a clock in Orca's status bar.
// Orca transpiles this file when it loads: no build step.
import { execFile } from 'node:child_process'
import os from 'node:os'
import type { OrcaWorkerApi } from 'orca/worker'
import { startStrip } from './strip.ts'
import type { Deps, Strip } from './strip.ts'

const ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' }

export const nodeDeps: Deps = {
  platform: process.platform,
  run(cmd, args) {
    return new Promise((resolve, reject) => {
      execFile(cmd, [...args], { timeout: 8000, maxBuffer: 8 * 1024 * 1024, env: ENV }, (error, stdout) => {
        if (error) reject(error)
        else resolve(String(stdout))
      })
    })
  },
  cpus: () => os.cpus(),
  totalmem: () => os.totalmem(),
  now: () => Date.now(),
  every(ms, fn) {
    const timer = setInterval(fn, ms)
    return () => clearInterval(timer)
  },
  after(ms, fn) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  }
}

let strip: Strip | null = null

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  orca.log(`started pid ${process.pid}`)
  strip = await startStrip(orca, nodeDeps)
}

export function deactivate(): void {
  strip?.stop()
  strip = null
}
