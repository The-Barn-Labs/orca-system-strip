# System Strip: item styles and settings panel

Status: proposed, 2026-11-12. It builds on [design.md](design.md), which covers what the strip
measures and how. This document changes only how the items look and adds a settings panel.

## Why

The strip exists to show at a glance whether the Mac is straining: the fans are loud, and you
want to know if it is CPU, GPU or memory, without opening anything. Today every item reads
`CPU 34%`. That is clear, but wide, and it is the only way to show a value. Different people
glance differently: some read numbers, some read shapes, some want to see whether a spike is
rising or falling. So each item gets a choice of style, and a panel to choose it in, where you
see what each style looks like with your own live numbers before you pick it.

## Goals

1. Each of CPU, GPU, memory and battery has its own **style**, chosen from the set below.
2. A **System Strip panel** in Orca's right sidebar holds every setting, laid out as one card per
   item, with each style shown as a real sample using live numbers.
3. Once a style is chosen, its item keeps a steady width while the numbers change (no jitter
   when 9% becomes 10%). Switching style may change the width; that is expected.

## Non-goals (later, each with its own design)

- **A details view** (top apps, history) in the panel. The panel is built so a "Details" tab can
  be added later, but this work ships settings only.
- **A per-session process view**: which agent session and its child processes (tests, hooks,
  pushes) use how much. Note that Orca's built-in Resource Manager already shows CPU and memory
  per workspace and session; that design must start by checking what it lacks.
- **Temperatures.** macOS needs `sudo`, or a helper program, to read them. It needs a feasibility check first.
- **A popover over the bar**, like Orca's built-in usage popover. Orca does not offer one to
  plugins (see Constraints); if it adds one, the panel's content moves there.

## Anti-goals

- **No new Orca permission.** The plugin keeps asking only for `settings:own`. That rules out a
  click that opens the sidebar (`commands.run` needs `workspace:write`).
- **No new commands run on the Mac**, and no faster polling. The styles reuse the readings the
  strip already takes.
- **Not two sources of truth.** The panel and Orca's Settings page edit the same settings.

## Constraints (verified in Orca's source and typings, `.orca/types`)

| Fact | Consequence |
|---|---|
| A status bar item is text (≤ 64 chars) plus at most one icon from Orca's fixed set, plus one tone for the whole item | Bars and trends are text characters; the empty part of a bar cannot be dimmer |
| `statusBar.update` replaces only the fields it is given; an absent field keeps its value | An icon, once shown, cannot be removed until Orca restarts. So every style of CPU, GPU, memory and battery shows an icon, and the clock never has one |
| Hover text is plain, ≤ 256 characters (`PLUGIN_STATUS_BAR_TOOLTIP_MAX_LENGTH`) | The current tooltips must be checked against that limit (memory's lists three apps) |
| A click on an item can only run one of the plugin's commands; no method opens a plugin panel | A click keeps opening Activity Monitor. The panel is opened from its icon in the right sidebar |
| Orca has a compact status bar mode that shows only the icon of plugin items that have one (`status-bar-density.ts`) | Nothing to do; worth one line in the README |
| Panels are `"ui": "components"` panels: Orca's component set (Card, Button with `icon`, Switch, RadioGroup, Select, Tabs, Text, …), no DOM | The samples are drawn with Orca's own icons and text, so they match the bar closely |

## The styles

`p` is the item's current percentage. Every number is padded to a fixed width with figure spaces
(U+2007) so `9%` and `34%` take the same space; `100%` may be one character wider.

| Style (setting value) | CPU example | Rule |
|---|---|---|
| Words, `words` | icon + `CPU 34%` | Today's text: `CPU`, `GPU`, `Mem`, `Bat` and the number |
| Icon and number, `number` | icon + `34%` | Number only |
| Bar, `bar` | icon + `▰▰▱▱▱` | 5 cells; filled = `round(p / 20)`, clamped 0–5. No number |
| Trend, `trend` | icon + `▂▃▇▇▅▃ 34%` | The last 6 readings, oldest first, each one of `▁▂▃▄▅▆▇█` (level = `min(7, floor(p / 12.5))`), then the number. CPU and GPU only |
| Level, `level` | icon + `▃34%` | One character of `▁▂▃▄▅▆▇█` (same rule), then the number |

- **Which item offers which style:** CPU and GPU offer all five. Memory and battery offer words,
  number, bar and level. They change too slowly for a trend to say anything.
- **Trend history:** CPU adds a reading every refresh, GPU every GPU poll (≥ 4 s). Until six
  readings exist, the missing older slots are figure spaces, so the trend is six characters wide from the start.
  History is kept in memory only. It starts empty when the plugin starts or the item is switched
  back on, and it records nothing while the item is hidden. *(My call: steady width.)*
- **The one width exception:** `100%` is one character wider than `99%`. Padding every number to
  three digits would make the default style wider all the time for a change that happens rarely.
  *(My call.)*
- **Battery:** the icon is `plug` while on power and `zap` on battery. In the `words` and `number` styles
  the trailing `⚡` goes away, since the icon now says it. *(Builder's call is fine if this reads badly in Orca.)*
- **The clock** has no styles. It keeps the 24-hour switch.
- **Tone (colour), hover text, the dash after repeated failures, and the click** behave exactly as
  today, in every style.
- **Defaults:** `number` for CPU, GPU, memory and battery. *(My call: it is the most glanceable
  style that still shows the value, and the hover explains the icons. Words, today's look, is one
  click away.)*

## Settings

Four new settings in the manifest, so they also appear on Orca's Settings page:

| Key | Values | Default |
|---|---|---|
| `cpuStyle` | words, number, bar, trend, level | number |
| `gpuStyle` | words, number, bar, trend, level | number |
| `memoryStyle` | words, number, bar, level | number |
| `batteryStyle` | words, number, bar, level | number |

The existing seven settings are unchanged. A changed style applies on the next update of that
item, with no restart, like the other settings.

## The panel

Contributed as `contributes.panels`: id `system-strip`, title "System Strip", icon `gauge`,
`"ui": "components"`. Laid out top to bottom:

1. **Header:** the title and an **Activity Monitor** button that opens it, as clicking the bar does.
2. **Your bar now:** the items currently shown, as they look in the bar right now, with their tones.
3. **A card per item** (CPU, GPU, Memory, Battery): a **Show** switch, the item's current value,
   and one sample per style the item offers, drawn with the real icon and live numbers. The
   selected style is highlighted; pressing a sample selects it. A hidden item is not polled
   (as today), so its card shows `–` for its value and its samples, still pressable, so you can pick a
   style before switching it on. Opening the panel never starts polling a hidden item. *(My call:
   keeps "a closed panel costs nothing" and "no faster polling".)* On a Mac without a battery, the
   battery card says so and has no samples.
4. **Clock card:** Show switch and a 24-hour / 12-hour choice, each shown as a sample of the time.
5. **Refresh:** 1, 2 or 5 seconds, with the note that the GPU updates no faster than every 4 s.

Live data: when the panel opens, it asks the worker for the current readings. While it is open,
the worker sends it each new reading, so the samples move with the bar. A closed panel costs nothing.
The panel writes settings with `settings.set`. A change made on Orca's Settings page shows in an
open panel too.

## Checks before it ships

1. **Glyphs in Orca's font:** look at `▰▱` and `▁…█` in the real status bar (and with
   `orca plugin shot` for the panel). If a set renders badly (wrong width, missing glyph), pick
   replacement characters and update this table.
2. **Tooltip length:** every tooltip stays ≤ 256 characters with long app names.
3. **Width:** within one style, changing numbers do not shift the items to their right (except at 100%).
4. Tests for every style rule above (unit), the panel (`orca/testing`), and `orca plugin check`.
5. README: the styles, the panel, and how to open it.

## Left to the builder

How the code is split into files; how the panel and worker talk (`plugin.request`, `panels.post`); the
exact component used for each sample and how the header and spacing look; the panel's wording.
