// The panel <-> worker contract, declared once: src/panel.tsx and src/strip.ts both read it.
import type { ItemId, Tone } from './format.ts'
import type { Settings } from './settings.ts'
import type { IconName, Style, StyledId } from './styles.ts'

/** One style of an item, drawn with its live value. */
export type Sample = { style: Style; label: string; text: string; icon: IconName }

/** An item's card: `value` is null while the item is hidden, has no reading yet, or is dashed. */
export type Card = { id: StyledId; shown: boolean; value: string | null; samples: Sample[] }

export type Snapshot = {
  /** The settings as the worker reads them: already validated. */
  settings: Settings
  /** The items shown in the bar now, in bar order. */
  bar: { id: ItemId; text: string; icon?: IconName; tone: Tone }[]
  /** cpu, gpu, memory, disk, network, space, battery; the battery card has no samples on a Mac without one. */
  cards: Card[]
  clock: { h24: string; h12: string }
  /** True until a battery reading says there is none. */
  hasBattery: boolean
}

declare module 'orca' {
  interface PluginRequests {
    'strip.snapshot': { output: Snapshot }
    'strip.openActivityMonitor': { output: { message: string } }
  }
  interface PluginPanelEvents {
    /** Posted when what the panel shows changes. */
    'strip.snapshot': Snapshot
  }
}
