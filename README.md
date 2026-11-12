# System Strip

CPU, GPU, memory, battery and a clock in [Orca](https://github.com/stablyai/orca)'s bottom status bar, so a
glance tells you whether your Mac is struggling and what is behind it.

```
CPU 34%   GPU 15%   Mem 71%   Bat 87% ⚡   14:05
```

## What it shows

| Item | Text | Hover | Yellow | Red |
|---|---|---|---|---|
| CPU | `CPU 34%`, the whole machine | The top 3 apps by CPU | ≥ 70% | ≥ 90% |
| GPU | `GPU 15%` | The GPU model | ≥ 70% | ≥ 90% |
| Memory | `Mem 71%`, counted like macOS Activity Monitor's "Memory Used" | Used of total, memory pressure, the top 3 apps by memory | pressure *warning* | pressure *critical* |
| Battery | `Bat 87%`, with ⚡ while on power | Charging state and time left | ≤ 20% on battery | ≤ 10% on battery |
| Clock | `14:05` or `2:05 PM` | The full date | — | — |

- CPU and GPU colours follow a 10-second average, so a short spike does not flash the bar.
- Memory colour follows macOS memory pressure, which predicts slowdown better than a percentage.
- Battery never warns while the Mac is on power, even when macOS holds the charge below full.
- Processes of one app are added together, so twenty Chrome helpers show up as one Chrome.
- Clicking CPU, GPU or Memory opens macOS Activity Monitor (also in the command palette as
  **System Strip: Open Activity Monitor**).
- If a reading keeps failing, its item shows a dash (`GPU –`) and the reason on hover.

## How it runs

System Strip is a **trusted worker**: Orca runs it in a separate Node.js process with your user
account's access to the machine, which it needs to read system statistics. It runs only these
read-only macOS commands:

| Command | What for | How often |
|---|---|---|
| `ioreg -r -d 1 -c IOAccelerator` | GPU use and model | every refresh (default 2 s) |
| `vm_stat` | Memory in use | every refresh |
| `sysctl -n kern.memorystatus_vm_pressure_level` | Memory pressure | every refresh |
| `pmset -g batt` | Battery | every 30 s |
| `ps -Aeo pid=,pcpu=,rss=,comm=` | Top apps on hover | every 5 s |
| `open -a "Activity Monitor"` | Opening Activity Monitor | only when you click |

CPU comes from Node's own `os.cpus()`, with no command. A switched-off item stops its command.
System Strip makes no network connections, collects nothing about you and stores nothing.

Orca capability requested: `settings:own`, to read its own settings. As a trusted worker it also
runs with your full user access, as described above.

## Settings

In Orca: **Settings → Plugins → System Strip**.

| Setting | Default |
|---|---|
| Show CPU / GPU / memory / battery / clock | on (battery is hidden anyway on a Mac without one) |
| 24-hour clock | on (off shows `2:05 PM`) |
| Refresh every | 2 seconds (1, 2 or 5) — how often CPU, GPU and memory update |

Changes apply immediately.

## Install

From Orca's plugin directory: search for **System Strip**.

For testing from a folder: `orca plugin install <folder>`. A folder install is a separate plugin
(`local.system-strip`) with its own settings, so remove it before installing from the directory,
or the bar shows every item twice.

## Limits

- GPU, memory and battery work on macOS only; on other systems CPU and the clock still show.
  Tested on Apple Silicon.
- Fan speed and temperature are not shown: macOS only gives them to tools run with `sudo`.

## Develop

```sh
npm install
npm run test:unit        # parsers and formatting, plain Node 22
npm run typecheck
orca plugin types .      # writes Orca's typings to .orca/types
orca plugin test .       # every test, including the worker tests
orca plugin validate .
orca plugin dev watch .  # load this folder into Orca with live reload and logs
```

## License

MIT
