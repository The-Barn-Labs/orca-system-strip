export type BatteryState = 'charging' | 'discharging' | 'charged' | 'not-charging'
export type BatteryReading =
  | { present: false }
  | { present: true; percent: number; onPower: boolean; state: BatteryState; remaining: string | null }

const SOURCE = /^Now drawing from '([^']+)'/m
const BATTERY = /InternalBattery[^\n]*?(\d{1,3})%;\s*([^;]+?)\s*;\s*([^\n]*)/

function stateOf(text: string): BatteryState {
  const s = text.toLowerCase()
  if (s === 'discharging') return 'discharging'
  if (s === 'charged') return 'charged'
  if (s.includes('not charging')) return 'not-charging'
  return 'charging' // "charging", "finishing charge"
}

/** Reads `pmset -g batt`; `{ present: false }` on a Mac without a battery, null when unrecognisable. */
export function parseBattery(pmset: string): BatteryReading | null {
  const source = SOURCE.exec(pmset)
  if (!source) return null
  const battery = BATTERY.exec(pmset)
  if (!battery) return { present: false }
  const time = /(\d+:\d{2}) remaining/.exec(battery[3])
  const remaining = time && time[1] !== '0:00' ? time[1] : null
  return {
    present: true,
    percent: Math.min(100, Number(battery[1])),
    onPower: source[1] === 'AC Power',
    state: /not charging/i.test(battery[2] + ';' + battery[3]) ? 'not-charging' : stateOf(battery[2]),
    remaining
  }
}
