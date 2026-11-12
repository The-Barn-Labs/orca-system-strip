# System Strip — design

An Orca plugin that shows CPU, GPU, memory, battery and a clock in Orca's bottom status bar.

- Repo: `The-Barn-Labs/orca-system-strip` (public, MIT)
- Plugin id: `system-strip`, display name **System Strip**. Installed from the directory or Git it
  is `The-Barn-Labs.system-strip`; installed from a local folder it is `local.system-strip`, a
  separate plugin with its own settings.
- Status: approved 2026-11-12

## Why

The owner's Mac was running hot with the fan loud, and there was no way to see from inside Orca how
much CPU, GPU and memory were in use, or what was using them. Orca already shows Claude usage in its
bottom bar; this puts the machine's vitals in the same place so a glance answers "is my Mac
struggling, and why?"

## Goals

1. Five bottom-bar items: **CPU**, **GPU**, **Memory**, **Battery**, **Clock** (owner's choice).
2. Each item can be switched on or off in Orca's Settings for the plugin.
3. Colour warns before trouble: an item turns `warning` (yellow) when high and `danger` (red) when
   critical.
4. Hovering CPU or Memory shows the top 3 apps behind the number. (design choice: this is what
   answers "what is heating my Mac".)
5. Fit for the Orca community directory: passes Orca's validator and listing policy.

## Non-goals (v1)

- Fan speed and temperature: macOS gives them only to `sudo` tools such as `powermetrics`.
- Linux and Windows support beyond what falls out for free (see Platform).
- Quitting or managing processes.
- A sidebar panel, charts or history.
- Network, disk or other items (Orca allows 8; the owner picked 5).

## Anti-goals (a failure even if it works)

- **The monitor heats the Mac.** The worker must stay light: target under 1% of one core on
  average. Nothing Node can read in-process is read by spawning a command.
- **Asking for access it does not need.** The only Orca capability is `settings:own`. No terminal,
  agent, workspace, network, secrets or storage access. No `sudo`.
- **Hiding what it does.** It runs as a `trusted-worker` — full Node with the user's privileges —
  because it must run `ps`, `ioreg` and friends. The README says so plainly and lists every command
  it runs and how often. "Only one permission" is never claimed.
- **Any network traffic, tracking or analytics.** None at all (also a listing-policy rule).
- **Flicker.** Numbers and colours must not jump on every tick; colours change on smoothed values.

## Constraints (from Orca, verified against Orca 1.4.257 docs and typings)

- `execution: "trusted-worker"`, `main: "src/worker.ts"` (Orca transpiles TS when it loads; no
  build step), `engines.orca: ">=1.4.248"` (status bar items arrived in 1.4.248).
- `contributes.statusBarItems`: at most 8; fields `id`, `text`, `icon`, `tone`
  (`neutral|accent|success|warning|danger`), `tooltip`, `command`. Text and icon only — no custom
  drawing, **no grey/disabled tone**, **no `visible` field in the manifest**, **no order or position
  field**.
- The worker changes items with `orca.host.call('statusBar.update', { id, text?, icon?, tone?,
  tooltip?, visible? })`. No capability needed. Desktop app only. Updates last until Orca restarts.
  The worker is started when the plugin is enabled and kept running, so it may poll. The host may
  answer `rate_limited` with `retryAfterMs`.
- Settings: `contributes.settings` (`type: boolean | number | integer | string`, `enum`,
  `enumLabels`, `default`); read with `orca.settings`; `orca.settings.onDidChange` fires with the
  changed `key` when the person edits them. Needs `settings:own`.
- A contributed command is also a command-palette entry; `when` is only `global` or `workspace`.
- Icons come from a fixed set (`activity`, `gauge`, `layers`, `zap`, `calendar`, …). There is no
  clock or battery icon.
- Listing: publisher is the GitHub owner; ids starting `orca-` are reserved; a license is required;
  no binaries, no obfuscated code, no tracking. Listed by GitHub topic `orca-plugin` plus a `vX.Y.Z`
  tag; each tag is permanent.

## Data sources (macOS, all verified without `sudo` on the owner's M5 Pro)

| Item | Source | Notes |
|---|---|---|
| CPU % | `os.cpus()` tick deltas, in-process | No spawn. Whole-machine busy % (all cores together). |
| GPU % | `ioreg -r -d 1 -c IOAccelerator` → `"Device Utilization %"` | One cheap spawn. Several accelerators: show the highest, list each model in the tooltip. Key missing: treat as a failed read. |
| Memory | Page counts from one `sysctl` or one `vm_stat` call; total from `os.totalmem()` (read once); pressure from `sysctl -n kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical) | **Used % matches macOS Activity Monitor's "Memory Used"**: app memory (anonymous/internal − purgeable) + wired + compressed, over total. Not `total − free`, which reads ~95% on any Mac because of file cache. **Colour comes from the pressure level**, not the %. Combine reads into as few spawns as possible (design choice). |
| Battery | `pmset -g batt` → percent, power source, charging state, time remaining | Every 30 s. Hidden when the Mac has no battery. |
| Top apps | `ps -Aeo pid,pcpu,rss,comm` | For CPU and Memory tooltips. Every ~5 s, not every tick. |
| Clock | `Date` | Updates on the minute boundary, not on the poll tick. |

All commands run through `execFile` with fixed arguments (no shell), a timeout, and a C locale.

### Top apps in tooltips (design choice)

- Processes with the same name are **added together** before taking the top 3, so twenty
  `Google Chrome Helper (Renderer)` processes count as one Chrome entry. Names are taken from the
  executable's basename (not truncated by `-c`).
- `ps` %CPU is per core (one process can read 250%) and is a decayed average on macOS. Divide it by
  the core count so tooltip numbers use the same scale as the headline.

### When a read fails (design choice)

- One failed read keeps the last value.
- About 3 failures in a row: show a dash (`GPU –`) in `neutral`, with the reason in the tooltip.
- Permanently absent (no battery, not macOS): hide with `visible: false`.
- A failure in one source never affects the other items.

## Behaviour

### Start-up (design choice)

The manifest can't hide items, so every item shows its manifest text from enable or Orca start
until the worker's first update. Each item's manifest `text` is a short placeholder (`CPU –`,
`GPU –`, `Mem –`, `Bat –`, `--:--`). In `activate()`, before the first poll, the worker reads
settings and sends every field of every item, `visible` included. A brief flash of the placeholders
is accepted.

### Items (listed in this order in the manifest; Orca decides where they sit)

| id | Text example | Icon (design choice) | Tooltip |
|---|---|---|---|
| `cpu` | `CPU 34%` | `activity` | Top 3 apps by CPU, e.g. `claude 6% · WindowServer 1% · Chrome 1%` |
| `gpu` | `GPU 15%` | `gauge` | GPU model(s) |
| `memory` | `Mem 71%` | `layers` | Used / total in GB, pressure level, top 3 apps by memory |
| `battery` | `Bat 87%`, `Bat 87% ⚡` on power | none | State and time, e.g. `Discharging · 19:58 left` or `On power, not charging` |
| `clock` | `14:05` or `2:05 PM` | none | Full date |

### Colours (design choice; thresholds become settings only if the owner asks)

| Item | `warning` | `danger` |
|---|---|---|
| CPU | smoothed ≥ 70% | smoothed ≥ 90% |
| GPU | smoothed ≥ 70% | smoothed ≥ 90% |
| Memory | pressure level 2 | pressure level 4 |
| Battery | ≤ 20% on battery power | ≤ 10% on battery power |
| Clock | never | never |

"Smoothed" means an average over roughly the last 10 seconds, so a one-tick spike does not colour
the bar. The number shown may be the latest sample; the colour uses the smoothed value. Battery
never warns while on power, charging or not (macOS often holds a plugged-in Mac at 80%).

### Updates (design choice)

`statusBar.update` is called only when an item's text, tone, tooltip or visibility actually
changed. On `rate_limited` the worker waits `retryAfterMs` before sending again.

### Settings

| key | type | default | Purpose |
|---|---|---|---|
| `showCpu` | boolean | true | Show the CPU item |
| `showGpu` | boolean | true | Show the GPU item |
| `showMemory` | boolean | true | Show the Memory item |
| `showBattery` | boolean | true | Show the Battery item (still hidden if there is no battery) |
| `showClock` | boolean | true | Show the Clock item |
| `clock24h` | boolean | true | 24-hour clock; off means 12-hour with AM/PM |
| `refreshSeconds` | integer, enum 1 / 2 / 5 | 2 | How often CPU, GPU and Memory refresh |

A switched-off item is hidden with `visible: false`, and its data source stops being polled.
Changes apply immediately through `settings.onDidChange` (the worker re-reads settings).

### Click (design choice — the owner may strike it)

Clicking CPU, GPU or Memory opens macOS's own Activity Monitor (`open -a "Activity Monitor"`), the
quickest route from "it's hot" to doing something about it. One contributed command, titled
**System Strip: Open Activity Monitor**, `when: "global"`; it also appears in the command palette.
On other platforms it returns "Activity Monitor is macOS-only" and runs nothing. No capability.

### Platform

macOS on Apple Silicon is the tested target; Intel Macs should work but are not verified. On other
platforms, CPU (from `os.cpus()`) and Clock work as-is; GPU, Memory and Battery are hidden.

## Repo layout (builder may adjust)

```
orca-plugin.json
package.json             dev-only: typescript, @types/node; nothing bundled or shipped
tsconfig.json            includes the Orca typings and node types
src/worker.ts            activate(): wires settings, timers and statusBar.update; takes an
                         injectable command runner so tests can fake commands
src/sources/*.ts         one module per data source; pure parse functions + a thin runner
src/format.ts            text, tone and tooltip from parsed values
src/*.unit.test.ts       parsers and formatters; node:test + node:assert only
src/*.worker.test.ts     worker behaviour through orca/testing (mountWorker)
src/fixtures/            recorded real command output
LICENSE                  MIT
README.md                what it shows, how it runs (trusted worker, exact commands, intervals,
                         no network), how to install; remove a local copy before installing from
                         the directory
```

Relative imports use explicit `.ts` extensions. Confirm with `orca plugin dev watch` that Orca
loads a multi-file worker this way before writing many modules.

Started from `orca plugin create --template hook`, which gives the worker skeleton, typings in
`.orca/types` and an `orca plugin test` setup; the hook itself is removed.

## Testing

- Every parser has a test on recorded real output plus a negative control (empty, garbled, missing
  field).
- Formatter tests cover each threshold edge (69/70/89/90, pressure 1/2/4, battery 21/20/11/10, on
  power vs on battery) and process grouping and scaling.
- Worker tests (`orca plugin test`) cover: start-up sends every item including `visible`; items
  hidden by settings; a settings change applied without restart; a failing command dashes then
  leaves the other items untouched; no update sent when nothing changed.
- Overhead check before release: run it for a few minutes at the 1 s and 2 s settings and confirm
  the worker's own CPU stays under the 1% target.

## CI (design choice)

GitHub Actions on `macos-latest` (free for public repos), Node 22.6 or newer: `tsc --noEmit` and
the `*.unit.test.ts` files with Node's built-in test runner. `orca/testing` exists only inside
`orca plugin test`, so worker tests, `orca plugin test` and `orca plugin validate` run locally
before each release.

## Shipping

1. The owner installs it locally from the folder (`local.system-strip`) and uses it for a while.
2. Remove the local copy. Keep `version` in `orca-plugin.json` equal to the tag. Add the
   `orca-plugin` topic and a cover image (optional), then push tag `v0.1.0`.
3. Check the listing status page (`orca.dev/plugins/<owner>/<repo>`, per orca.dev/plugins/add;
   confirm the form before relying on it).

## Left to the builder

Exact smoothing window; text widths and number padding so the bar does not shift as numbers change;
how often each source polls within the stated limits; which single `sysctl`/`vm_stat` call carries
the memory counters; module boundaries; README wording.
