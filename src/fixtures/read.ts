import { readFileSync } from 'node:fs'

/** Recorded command output kept beside the tests. */
export function fixture(name: string): string {
  return readFileSync(new URL('./' + name, import.meta.url), 'utf8')
}
