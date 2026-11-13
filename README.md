# System Strip

CPU, GPU, memory, disk activity, network, disk space, battery and a clock in [Orca](https://github.com/stablyai/orca)'s bottom status bar, so a
glance tells you whether your Mac is struggling and what is behind it.

Each item is an icon and its value, drawn in the style you pick:

| Style | CPU at 34% |
|---|---|
| Words and number | `CPU 34%` |
| Icon and number (default) | `34%` |
| Bar | `▰▰▱▱▱` (five steps of 20%, no number) |
| Trend and number | `▂▃▇▇▅▃ 34%` (the last six readings; CPU, GPU, disk activity and network only) |
| Level and number | `▃34%` |

Disk activity and network show both directions, read and write (`R 12M W 85M`) or down and up
(`↓4.2M ↑310K`), in K, M or G per second. Their bar, level and trend go up in steps of ×10:
an empty bar is 1 KB/s or less, a full one 100 MB/s or more.

## What it shows

| Item | Icon | Hover | Yellow | Red |
|---|---|---|---|---|
| CPU, the whole machine | activity | The top 3 apps by CPU | ≥ 70% | ≥ 90% |
| GPU | gauge | The GPU model | ≥ 70% | ≥ 90% |
| Memory, counted like macOS Activity Monitor's "Memory Used" | layers | Used of total, memory pressure, the top 3 apps by memory | pressure *warning* | pressure *critical* |
| Disk activity, read and write speed of all disks | database | Both speeds and the totals since start-up | — | — |
| Network, download and upload speed | globe | Both speeds and the top 3 apps by traffic over the last 30 s | — | — |
| Disk space, how full the startup disk is | folder | Free of total | ≥ 90% full | ≥ 95% full |
| Battery | a plug on power, ⚡ on battery | Charging state and time left | ≤ 20% on battery | ≤ 10% on battery |
| Clock, `14:05` or `2:05 PM` | none | The full date | — | — |

- CPU and GPU colours follow a 10-second average, so a short spike does not flash the bar.
- Memory colour follows macOS memory pressure, which predicts slowdown better than a percentage.
- Battery never warns while the Mac is on power, even when macOS holds the charge below full.
- Processes of one app are added together, so twenty Chrome helpers show up as one Chrome.
- Speeds never change colour: there is no "too fast".
- Disk space counts purgeable files (caches macOS can clear) as used, so it can read a few percent
  fuller than Finder. It covers every volume in the disk's APFS container, so it can also differ
  slightly from `df`, which counts one volume.
- Clicking CPU, GPU, Memory, Disk activity, Network or Disk space opens macOS Activity Monitor
  (also in the command palette as **System Strip: Open Activity Monitor**).
- If a reading keeps failing, its item shows a dash (`–`) and the reason on hover.
- Numbers keep their width (`9%` takes the space of `34%`), so the bar does not shift as they change.
- In Orca's compact status bar, Orca shows only the icons.

## How it runs

System Strip is a **trusted worker**: Orca runs it in a separate Node.js process with your user
account's access to the machine, which it needs to read system statistics. It runs only these
read-only macOS commands:

| Command | What for | How often |
|---|---|---|
| `ioreg -r -d 1 -c IOAccelerator` | GPU use and model | every refresh, but no faster than every 4 s |
| `vm_stat` | Memory in use | every refresh |
| `sysctl -n kern.memorystatus_vm_pressure_level` | Memory pressure | every refresh |
| `pmset -g batt` | Battery | every 30 s |
| `ps -Aeo pid=,pcpu=,rss=,comm=` | Top apps on hover | every 15 s |
| `ioreg -c IOBlockStorageDriver -r -k Statistics -d 1` | Disk activity | every refresh, but no faster than every 5 s |
| `netstat -ibn` | Network speed | every refresh |
| `nettop -P -L 1 -x -t external -J bytes_in,bytes_out` | Top apps by network traffic | every 30 s |
| `open -a "Activity Monitor"` | Opening Activity Monitor | only when you click |

CPU comes from Node's own `os.cpus()` and disk space from Node's `fs.statfs`, with no command. A switched-off item stops its command
(`ps` keeps running while Network is shown, to name its apps).
System Strip makes no network connections (network speed comes from the Mac's own counters),
collects nothing about you and stores nothing.

Orca capability requested: `settings:own`, to read its own settings. As a trusted worker it also
runs with your full user access, as described above.

## Settings panel

Open **System Strip** from its icon in Orca's right sidebar. It has a card per item: switch it on
or off, and pick its style from samples drawn with your live numbers. Below the cards are the
clock format, the refresh rate and an **Activity Monitor** button.

The same settings are also in **Settings → Plugins → System Strip**:

| Setting | Default |
|---|---|
| Show CPU / GPU / memory / disk activity / network / disk space / battery / clock | on (battery is hidden anyway on a Mac without one) |
| CPU / GPU / memory / disk activity / network / disk space / battery style | Icon and number |
| 24-hour clock | on (off shows `2:05 PM`) |
| Refresh every | 2 seconds (1, 2 or 5) — how often CPU, memory and network update; the GPU no faster than every 4 s, disk activity every 5 s |

Changes apply immediately.

## Install

From Orca's plugin directory: search for **System Strip**.

For testing from a folder: `orca plugin install <folder>`. A folder install is a separate plugin
(`local.system-strip`) with its own settings, so remove it before installing from the directory,
or the bar shows every item twice.

## Limits

- GPU, memory, disk activity, network and battery work on macOS only; on other systems CPU, disk
  space and the clock still show. Tested on Apple Silicon.
- Disk activity has no per-app list: macOS gives it only to tools run with `sudo`.
- The network apps list covers open connections only: a connection that opens and closes between
  two reads (30 s apart) is not counted for its app, though it still counts in the speed.
- Fan speed and temperature are not shown: macOS only gives them to tools run with `sudo`.

## Develop

```sh
npm install
npm run test:unit        # parsers, styles and formatting, plain Node 22.18 or newer
npm run typecheck
orca plugin types .      # writes Orca's typings to .orca/types
orca plugin test .       # every test, including the worker and panel tests
orca plugin check .      # renders the panel in a few scenarios
orca plugin validate .
orca plugin dev watch .  # load this folder into Orca with live reload and logs
```

## License

MIT
