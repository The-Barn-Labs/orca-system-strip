# System Strip: disk activity, network and disk space

Status: proposed, 2026-11-12. It builds on [design.md](design.md) (what the strip measures and
how) and [design-styles-panel.md](design-styles-panel.md) (styles and the settings panel). This
document adds three items. Everything those two documents say about tone, hover text, the dash
after repeated failures, start-up, updates, the click and the panel applies to the new items
unless this one says otherwise.

## Why

The strip exists for the moment the fans get loud: one glance should say what the Mac is busy
with. CPU, GPU and memory do not show the other common culprit. A pre-push hook, an
`npm install` or a sync can hammer the drive or the network while the CPU looks calm. The user
wants the two numbers Activity Monitor's **Disk** and **Network** tabs show (read and write
speed, download and upload speed), plus how full the drive is.

## Goals

1. Three new items, each with a **Show** switch, a **style** and a card in the panel:
   - **Disk activity:** read and write speed of all disks, as Activity Monitor's Disk tab shows.
   - **Network:** download and upload speed, as Activity Monitor's Network tab shows.
   - **Disk space:** how full the startup disk is.
2. **Both directions are always shown** for disk activity and network (the user picked layout A
   from three mockups): `R 12M W 85M` and `↓4.2M ↑310K`.
3. A steady width while the numbers change, within one style, as for the existing items.

## Non-goals

- **Per-app disk activity.** macOS gives it only to `sudo` tools (`fs_usage`) or to native code
  (`proc_pid_rusage`). Disk activity's hover shows totals, not apps.
- **Per-session process view, temperatures, a details tab, a popover:** still later work, as in
  design-styles-panel.md.
- **Other disks' free space.** Disk space is the startup disk only.

## Anti-goals

- **No `sudo`, no new Orca permission.** The plugin keeps asking only for `settings:own`.
- **No network connections.** Network speed is read from the Mac's own counters; the plugin still
  sends nothing anywhere.
- **No new cost when an item is switched off.** A hidden item runs none of its commands.

## Data sources (all verified without `sudo` on the user's Mac, 2026-11-12)

| Item | Source | How often | Notes |
|---|---|---|---|
| Disk activity | `ioreg -c IOBlockStorageDriver -r -k Statistics -d 1` → `"Bytes (Read)"` and `"Bytes (Write)"` | every refresh, but no faster than every 4 s | Counters since start-up, one per disk driver; add them all up (Activity Monitor counts every disk). Costs about 11 ms of CPU per run, the same as the GPU's `ioreg`, so it follows the GPU's limit: every 1 s would be about 1.1% of a core on its own, over design.md's "under 1% of one core" target. *(My call; the speed is still exact, since it divides by the real time between reads.)* |
| Network | `netstat -ibn` → `Ibytes`, `Obytes` on the `<Link#…>` rows | every refresh (about 1 ms of CPU per run) | Counters since start-up per interface. Add up all interfaces **except** loopback (`lo*`) and tunnels (`utun*`, `ipsec*`, `gif*`, `stf*`), whose traffic also crosses a real interface and would count twice. *(My call.)* Took under 0.01 s. |
| Network top apps | `nettop -P -L 1 -x -J bytes_in,bytes_out` | every 15 s, only while Network is shown | Counters per process, named `name.pid`. Took 5 s wall time but almost no CPU (it waits for one sample), so it must run without blocking other reads. |
| Disk space | Node's `fs.statfs` on `/System/Volumes/Data` (or `/` where that does not exist) | every 30 s, and at once when switched on | No command. Used = (total − available) ÷ total. On the user's Mac: 36%. |

- **Speed = change in the counter ÷ the real time between the two reads** (not the nominal refresh),
  so a late tick does not read as a spike.
- **First read:** a speed needs two reads, so the item shows its dash form (`–`, or `Disk –` in
  words style) until the second read, without counting as a failure.
- **A counter that goes down** (a disk unplugged, an interface reset): skip that interval and keep
  the last value. Not a failure.
- **Units are decimal**, as macOS uses: 1 KB = 1,000 bytes.
- **Disk space will not always match Finder or System Settings.** They count purgeable files
  (caches macOS can delete) as free; `statfs` does not, so the strip can read a few percent fuller.
  This is the figure `df` shows. Getting the purgeable amount needs native code. *(Corrects what I
  said in chat, where I claimed it would match System Settings.)*

## Items

Listed in the manifest after memory, before battery: `cpu, gpu, memory, disk, network, diskSpace,
battery, clock`. Orca decides where they sit.

| id | Number style example | Icon | Hover | `warning` | `danger` |
|---|---|---|---|---|---|
| `disk` | `R 12M W 85M` | `database` | `Disk: reading 12 MB/s, writing 85 MB/s` and the totals since start-up (`5.1 TB read · 4.0 TB written`) | never | never |
| `network` | `↓4.2M ↑310K` | `globe` | `Network: down 4.2 MB/s, up 310 KB/s` and the top 3 apps by traffic over the last 15 s | never | never |
| `diskSpace` | `62%` | `folder` | `312 GB free of 994 GB` | ≥ 90% full | ≥ 95% full |

- **Speeds never colour the bar:** there is no "too fast", and colour stays the "something is
  wrong" signal. *(My call, shown in the mockup.)*
- **Click:** all three open Activity Monitor, like CPU, GPU and memory.
- **Network top apps** use the same rules as CPU's: processes with the same name are added
  together, top 3 by bytes in + out since the previous `nettop` read. The first read has no
  previous one, so the first 15 s show no apps. `nettop` cuts names to about 15 characters; that
  is accepted.
- **Platform:** disk activity and network are macOS-only, like GPU. Disk space uses `fs.statfs`,
  which works everywhere, so it also shows on other systems. *(My call.)*

## Speed numbers

A speed is written in at most 4 characters: a number and one unit letter, `K`
(KB/s), `M` (MB/s) or `G` (GB/s).

- Take the largest unit the value reaches, with `K` as the smallest. Below 10 of that unit: one
  decimal (`4.2M`, `0.0K`). From 10: no decimal (`12M`, `310K`). If rounding reaches 1000, use the
  next unit (`999.6K` → `1.0M`).
- Pad on the left so every number takes the width of three digits and one decimal point: a figure
  space (U+2007) stands in for a missing digit and a punctuation space (U+2008) for a missing
  point. So `4.2M` gets one figure space in front, `12M` gets a figure space and a punctuation
  space, and `310K` gets one punctuation space: all the same width when digits are equally wide.
  *(My call, from the builder check: plain figure-space padding would leave `4.2M` narrower than
  `12M`, since a point is narrower than a digit.)*
- **Width that still moves, accepted** like the `100%` exception: the unit letter changing (`K`,
  `M`, `G` differ in width), and digits of unequal width if the status bar font does not use
  tabular digits. Check 2 records how it looks; it does not block the release. *(My call: the
  user chose layout A's look, and fixing these would change it.)*
- In hover text, units are written out: `12 MB/s`.

## Styles

Disk activity and network offer all five styles; disk space offers words, number, bar and level
(it changes too slowly for a trend), like memory.

**Scale for speeds.** Bar, level and trend need a position from 0 to 100. Speeds run from bytes
to gigabytes, so the position is logarithmic: `p = 20 × log10(bytes per second ÷ 1,000)`, clamped
0–100. So 1 KB/s is 0, 10 KB/s is 20, 100 KB/s is 40, 1 MB/s is 60, 10 MB/s is 80 and 100 MB/s or
more is 100. Then the existing bar, level and trend rules from design-styles-panel.md apply
unchanged (bar cells = `round(p / 20)`). *(My call: the mockup said "one cell per ×10"; this is that
rule with the bar's existing rounding, so 97 MB/s fills all five cells.)*

| Style | Disk activity | Network | Disk space |
|---|---|---|---|
| Words, `words` | `Disk R 12M W 85M` | `Net ↓4.2M ↑310K` | `Space 62%` |
| Icon and number, `number` | `R 12M W 85M` | `↓4.2M ↑310K` | `62%` |
| Bar, `bar` | `R ▰▰▰▰▱ W ▰▰▰▰▰` | `↓▰▰▰▰▱ ↑▰▰▱▱▱` | `▰▰▰▱▱` |
| Trend, `trend` | `▂▃▇▇▅▃ R 12M W 85M` | `▂▃▇▇▅▃ ↓4.2M ↑310K` | — |
| Level, `level` | `▇R 12M █W 85M` | `▆↓4.2M ▄↑310K` | `▅62%` |

- **Trend** for disk and network draws the **total** (read + write, down + up), one reading per
  read (disk at most every 4 s, network every refresh), the last 6, with the same padding rule as CPU's.
- **Labels in words style:** `Disk`, `Net`, `Space`. *(My call: `Space` keeps disk space apart
  from disk activity.)*
- **Defaults:** `number`, like the other items.

## Settings

Six new settings in the manifest, so they also show on Orca's Settings page:

| Key | Values | Default |
|---|---|---|
| `showDisk` | boolean | true |
| `showNetwork` | boolean | true |
| `showDiskSpace` | boolean | true |
| `diskStyle` | words, number, bar, trend, level | number |
| `networkStyle` | words, number, bar, trend, level | number |
| `diskSpaceStyle` | words, number, bar, level | number |

All three are **on by default**. The user said they will switch off what they do not want.

## The panel

Three more cards, after Memory and before Battery, built like the existing ones: a Show switch, the
current value, one sample per style with live numbers, the selected one highlighted. "Your bar
now" includes them. The note under the refresh choice becomes "GPU and disk activity update no
faster than every 4 seconds."; the README's refresh row says the same.

## Checks before it ships

1. **Icons:** `database`, `globe` and `folder` render in the real status bar (they are in Orca's
   `IconName` set; check the status bar draws them, not the fallback glyph).
2. **Width (recorded, not a gate):** within one style, look at how much changing speeds shift
   the items to their right, and note it in the PR. Only the movements listed under "Speed
   numbers" are expected.
7. **Overhead:** with every item on and refresh at 1 s, the worker and its commands stay under
   1% of one core on average (measure CPU time, not wall time). If not, the next lever is
   network's interval, not dropping an item.
3. **Tooltip length:** network's hover with three long app names stays ≤ 256 characters.
4. **Numbers against Activity Monitor:** with a big copy running, disk and network speeds are in
   the same range as Activity Monitor's Disk and Network tabs.
5. **README:** the three items, the three new commands in the "How it runs" table, the disk-space
   caveat (purgeable files), and the per-app disk limit in "Limits".
6. Tests: unit tests for the parsers (with fixtures from this Mac), the speed format and the
   log scale; worker tests for first read, counter going down, hidden items running nothing;
   panel tests for the new cards.

## Left to the builder

How the code is split into files (`strip.ts` is already the largest file; new sources go in
`src/sources/`); how styles take two values instead of one; the wording of hover text beyond the
examples above; whether `nettop` needs a shorter sampling flag, as long as it stays light.
