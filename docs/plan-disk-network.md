# Disk activity, network and disk space: implementation plan

**Goal:** Three new status bar items, each with a Show switch, a style and a panel card: disk
activity (read and write speed), network (down and up speed) and disk space (percent used).

**Architecture:** Parsers in `src/sources/` turn command output into per-key byte counters;
a pure `counters.ts` turns two reads into a speed. `styles.ts` learns a speed's text and its log
scale; `format.ts` builds the three items; `strip.ts` polls the new sources on their own timers and
feeds the panel the same `Card` shape as today. The panel only adds three cards.

**Tech stack:** TypeScript run by Orca with no build step; `node --test` for unit tests;
`orca/testing` (`mountWorker`, `mount`, `mockHost`, `defineCheck`).

**Spec:** [design-disk-network.md](design-disk-network.md), building on
[design-styles-panel.md](design-styles-panel.md) and [design.md](design.md).

## Global constraints

- Orca capability stays exactly `settings:own`. No `sudo`. Commands run through `deps.run`
  (`execFile`, fixed arguments, C locale, timeout).
- New commands, exactly: `ioreg -c IOBlockStorageDriver -r -k Statistics -d 1`, `netstat -ibn`,
  `nettop -P -L 1 -x -t external -J bytes_in,bytes_out`. Disk space uses `fs.statfs`, no command.
- Intervals: disk `max(5000, refresh)`; network every refresh; `nettop` 30 s; disk space 30 s and
  at once when switched on. `ps` also runs while Network is shown.
- A hidden item runs none of its commands. `nettop` runs only while Network is shown.
- Item order: `cpu, gpu, memory, disk, network, diskSpace, battery, clock` (manifest, `ITEM_IDS`,
  `STYLE_KEY`, panel cards).
- Icons: disk `database`, network `globe`, diskSpace `folder`. Click opens Activity Monitor.
- Speed text: ≤ 4 characters of number and unit (`K`, `M`, `G`, decimal: 1 K = 1,000 bytes/s),
  padded to the width of three digits and one point with U+2007 (per missing digit) and U+2008
  (when there is no point).
- Log scale: `p = 20 × log10(bytesPerSecond ÷ 1000)`, clamped 0–100; then the existing
  `bar`, `level`, `trend` rules.
- Tones: speeds always `neutral`; disk space `warning` at ≥ 90%, `danger` at ≥ 95%.
- Words labels `Disk`, `Net`, `Space`. Defaults: all three shown, style `number`.
- Tooltips ≤ 256 characters, item text ≤ 64.
- Commit messages describe the change only. No `--no-verify`.

## Review focus

1. **The Mac sleeps, or the clock is set back:** elapsed (monotonic) ≤ 0 or > 3× the interval →
   new baseline, last value kept, no zero or infinite speed. Test in Task 5.
2. **A disk or interface appears or disappears between reads:** no spike, no dip. Test in Task 3.
3. **A counter goes down (interface reset):** that key adds 0. Test in Task 3.
4. **Network shown with CPU and memory hidden:** `ps` still runs (for names) and `nettop` runs;
   Network hidden: neither `netstat` nor `nettop` runs. Test in Task 5.
5. **Not macOS:** disk and network never shown and never run; disk space shown from `statfs('/')`.
   A failing `statfs` dashes after 3 tries. Test in Task 5.

---

### Task 1: Speed text and styles (`src/styles.ts`)

**Files:** Modify `src/styles.ts`, `src/styles.unit.test.ts`.

**Interfaces — produces:**
```ts
export type StyledId = 'cpu' | 'gpu' | 'memory' | 'disk' | 'network' | 'diskSpace' | 'battery'
export type SpeedId = 'disk' | 'network'
export type PercentId = Exclude<StyledId, SpeedId>
export type IconName = 'activity' | 'gauge' | 'layers' | 'database' | 'globe' | 'folder' | 'plug' | 'zap'
// STYLES: disk, network all five; diskSpace words, number, bar, level. LABEL: Disk, Net, Space.
// ICON: disk database, network globe, diskSpace folder.
export function speed(bytesPerSecond: number): string        // padded, e.g. ' 4.2M'
export function speedPosition(bytesPerSecond: number): number // 0–100, log scale
/** a = read or down, b = write or up, in bytes/s; totals = past totals (a + b), oldest first. */
export function pairText(id: SpeedId, style: Style, a: number, b: number, totals: readonly number[]): string
export function styledText(id: PercentId, style: Style, p: number, history: readonly number[]): string // unchanged body
```

- [ ] **Step 1: Write the failing tests** (`F = ' '`, `P = ' '`):
```ts
test('speed picks the unit and keeps three digits and a point of width', () =>
  assert.deepEqual(
    [0, 960, 4_200_000, 12_000_000, 310_000, 9_970, 999_600, 1.5e9, 2e12, -5, NaN].map(speed),
    [`${F}0.0K`, `${F}1.0K`, `${F}4.2M`, `${F}${P}12M`, `${P}310K`, `${F}${P}10K`, `${F}1.0M`, `${F}1.5G`, `${P}2000G`, `${F}0.0K`, `${F}0.0K`]
  ))
test('speedPosition is 20 per ×10 above 1 KB/s, clamped', () =>
  assert.deepEqual([0, 1000, 10_000, 1e6, 1e8, 1e10, NaN].map(speedPosition), [0, 0, 20, 60, 100, 100, 0]))
test('pairText per style', () => {
  const s = (n: number) => speed(n)
  assert.equal(pairText('disk', 'number', 12e6, 85e6, []), `R ${s(12e6)} W ${s(85e6)}`)
  assert.equal(pairText('network', 'words', 4.2e6, 310e3, []), `Net ↓${s(4.2e6)} ↑${s(310e3)}`)
  assert.equal(pairText('disk', 'bar', 12e6, 85e6, []), 'R ▰▰▰▰▱ W ▰▰▰▰▰')
  assert.equal(pairText('network', 'bar', 4.2e6, 310e3, []), '↓▰▰▰▰▱ ↑▰▰▱▱▱')
  assert.equal(pairText('disk', 'level', 12e6, 85e6, []), `▇R ${s(12e6)} █W ${s(85e6)}`)
  assert.equal(pairText('network', 'level', 4.2e6, 310e3, []), `▆↓${s(4.2e6)} ▄↑${s(310e3)}`)
  assert.equal(pairText('disk', 'trend', 12e6, 85e6, [97e6]), `${F.repeat(5)}█ R ${s(12e6)} W ${s(85e6)}`)
})
test('diskSpace has no trend; its styles render like memory', () => {
  assert.ok(!STYLES.diskSpace.includes('trend'))
  assert.equal(styledText('diskSpace', 'words', 62, []), 'Space 62%')
})
test('dashText for the new items', () => {
  assert.equal(dashText('disk', 'words'), 'Disk –')
  assert.equal(dashText('network', 'number'), '–')
})
```
  Extend the existing 64-character test to every `pairText` style at `2e12` both ways with 20 totals.

- [ ] **Step 2: Run** `npm run test:unit`. Expected: FAIL (`speed` is not exported).
- [ ] **Step 3: Implement.** Number part: `n = bps / unit`; `n < 10` → `toFixed(1)`, and if that
  reads `10.0`, use `'10'`; else `String(Math.round(n))`; if that reaches `1000` and a bigger unit
  exists, step up and redo. Prefix `F.repeat(max(0, 3 − digits)) + (hasPoint ? '' : P)`. `speed`
  treats non-finite or negative input as 0. `pairText` follows the design's styles table; the
  trend is `trend(totals.map(speedPosition))` then a space and the number form.
- [ ] **Step 4: Run** `npm run test:unit`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(styles): speed text, log scale and pair styles for disk and network`.

### Task 2: Settings and manifest

**Files:** Modify `src/settings.ts`, `src/settings.unit.test.ts`, `orca-plugin.json`.

**Interfaces — produces:** `Settings` gains `showDisk`, `showNetwork`, `showDiskSpace` (boolean,
true) and `diskStyle`, `networkStyle`, `diskSpaceStyle` (`'number'`). `STYLE_KEY` gains
`disk: 'diskStyle'`, `network: 'networkStyle'`, `diskSpace: 'diskSpaceStyle'`, with keys in the
global item order.

- [ ] **Step 1: Failing tests:** `readSettings({})` has the six defaults;
  `readSettings({ diskSpaceStyle: 'trend', networkStyle: 'bar', showDisk: false })` →
  `diskSpaceStyle: 'number'`, `networkStyle: 'bar'`, `showDisk: false`;
  `Object.keys(STYLE_KEY)` equals `['cpu','gpu','memory','disk','network','diskSpace','battery']`.
  Add a manifest test (unit, reads `orca-plugin.json`): status bar ids in the global order; every
  `*Style` setting's `enum` equals `STYLES[id]` and its `enumLabels` equal `STYLE_LABEL` of each.
- [ ] **Step 2: Run** `npm run test:unit`. Expected: FAIL.
- [ ] **Step 3: Implement.** Manifest items: `{"id":"disk","text":"–","icon":"database","tooltip":"System Strip","command":"system-strip.openActivityMonitor"}`, same for `network` (`globe`) and `diskSpace` (`folder`), placed after `memory`. Settings titles: "Show disk activity", "Show network", "Show disk space", "Disk activity style", "Network style", "Disk space style", placed after the memory ones. `refreshSeconds.description`: "How often CPU, memory and network update. The GPU updates no faster than every 4 seconds, disk activity every 5."
- [ ] **Step 4: Run** `npm run test:unit && npm run typecheck && orca plugin validate .`. Expected: pass, `validate` ok.
- [ ] **Step 5: Commit** `feat(settings): show and style settings for disk activity, network and disk space`.

### Task 3: Parsers and counter math (`src/sources/`)

**Files:** Create `src/sources/disk.ts`, `src/sources/network.ts`, `src/sources/counters.ts`,
`src/sources/disk-network.unit.test.ts`, fixtures `src/fixtures/ioreg-disk.txt`,
`src/fixtures/netstat.txt`, `src/fixtures/nettop.txt`. Modify `tsconfig.ci.json` only if a new
path is outside `src/sources`.

**Interfaces — produces:**
```ts
export type Counters = Map<string, readonly [number, number]>
// disk.ts
export function parseDiskIo(out: string): Counters | null   // key: registry id 'id 0x…'; [read, written]; null if no Statistics
// network.ts
export function parseNetstat(out: string): Counters | null  // key: interface name without '*'; [in, out]; null if no <Link#> row
export type NettopRow = { pid: number; name: string; bytes: number }  // bytes = in + out
export function parseNettop(out: string): NettopRow[]       // name.pid split at the LAST dot
export function topTraffic(prev: ReadonlyMap<number, number>, rows: readonly NettopRow[], names: ReadonlyMap<number, string>, n?: number): TopApp[]
// counters.ts
export function perSecond(prev: Counters, next: Counters, seconds: number): [number, number]
```

- [ ] **Step 1: Capture fixtures** on this Mac with the three commands (`> src/fixtures/…`). Hand-
  edit nothing except to trim `netstat` to its `<Link#…>` rows plus header, keeping `lo0`, `gif0*`,
  `utun0`, `bridge0`, `ap1*`, `en0`, `awdl0`, and add one `bridge100` and one `vmenet0` line in the
  same column shape. Trim `nettop` to its header plus 6 rows, and add one row `2.1.322.54107,1000,500,`.
- [ ] **Step 2: Failing tests:**
  - `parseDiskIo(fixture)`: keys are the drivers' `id 0x…`; the `0x100000afa`-style entry with non-zero bytes is present; the sum of reads equals the sum computed by hand from the fixture.
  - `parseNetstat(fixture)`: has `en0` and `awdl0`; has none of `lo0`, `gif0`, `utun0`, `bridge0`, `bridge100`, `vmenet0`, `ap1`; `Ibytes`/`Obytes` read from the right on rows with and without an Address.
  - `parseNettop`: `2.1.322.54107` → `{ pid: 54107, name: '2.1.322', bytes: 1500 }`; header and blank lines skipped.
  - `topTraffic`: deltas per pid clamped at 0 (a pid whose bytes went down adds 0); a pid not in `prev` counts from 0; names from `names` win over the nettop name; same app names added together; top `n` by bytes, ties by name.
  - `perSecond`: `[a,b]` deltas ÷ seconds; a key only in `next` or only in `prev` adds nothing; a key whose counter went down adds 0; `seconds ≤ 0` returns `[0, 0]`.
  - `parseDiskIo('')`, `parseNetstat('')` → `null`.
- [ ] **Step 3: Run** `npm run test:unit`. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement.** Netstat exclusions: `/^(lo|utun|ipsec|gif|stf|bridge|vmenet|ap)\d+$/` on the name after removing `*`.
- [ ] **Step 5: Run** `npm run test:unit && npm run typecheck`. Expected: pass.
- [ ] **Step 6: Commit** `feat(sources): disk, network and per-app traffic parsers with per-key speed math`.

### Task 4: Items (`src/format.ts`)

**Files:** Modify `src/format.ts`, `src/format.unit.test.ts`.

**Interfaces — produces:**
```ts
export type ItemId = 'cpu' | 'gpu' | 'memory' | 'disk' | 'network' | 'diskSpace' | 'battery' | 'clock'
export const ITEM_IDS: readonly ItemId[]   // global order
export function decimalBytes(n: number): string   // '312 GB', '5.1 TB', '12 MB', '310 KB', '0 B'
export function rateText(bps: number): string     // decimalBytes + '/s'
export function diskItem(speed: { read: number; write: number }, totals: { read: number; written: number } | null, style: Style, history: readonly number[]): ItemState
export function networkItem(speed: { down: number; up: number }, top: TopApp[] | null, style: Style, history: readonly number[]): ItemState
export function diskSpaceItem(space: { total: number; available: number }, style: Style): ItemState
export function spaceTone(percentUsed: number): Tone
```

- [ ] **Step 1: Failing tests:**
  - `diskItem({ read: 12e6, write: 85e6 }, { read: 5.1e12, written: 4.0e12 }, 'number', [])` → text `pairText('disk','number',…)`, icon `database`, tone `neutral`, tooltip `'Disk: reading 12 MB/s, writing 85 MB/s\nSince start-up: 5.1 TB read · 4.0 TB written'`.
  - `networkItem({ down: 4.2e6, up: 310e3 }, [{ name: 'Chrome', value: 12e6 }], 'number', [])` → icon `globe`, tooltip `'Network: down 4.2 MB/s, up 310 KB/s\nTop apps, open connections, last 30 s: Chrome 12 MB'`; with `top` null or empty, only the first line.
  - `diskSpaceItem({ total: 994e9, available: 312e9 }, 'number')` → text `'69%'`, icon `folder`, tooltip `'312 GB free of 994 GB'`; `spaceTone` 89.9 neutral, 90 warning, 95 danger.
  - A network tooltip with three 200-character names is ≤ 256 characters.
  - `placeholderItem('disk', 'words')` → `{ text: 'Disk –', icon: 'database' }`.
- [ ] **Step 2: Run** `npm run test:unit`. Expected: FAIL.
- [ ] **Step 3: Implement.** `decimalBytes`: one decimal below 10 of the unit, none from 10 (`5.1 TB`, `12 MB`, `312 GB`).
- [ ] **Step 4: Run** `npm run test:unit && npm run typecheck`. Expected: pass.
- [ ] **Step 5: Commit** `feat(format): disk activity, network and disk space items`.

### Task 5: The strip polls the new sources (`src/strip.ts`, `src/worker.ts`)

**Files:** Modify `src/strip.ts`, `src/worker.ts`, `src/strip.worker.test.ts`.

**Interfaces — consumes:** Tasks 1–4. **Produces:**
```ts
export type Source = 'cpu' | 'gpu' | 'memory' | 'disk' | 'network' | 'diskSpace' | 'battery' | 'clock' | 'procs' | 'nettop'
export type Deps = { /* existing */ statfs(path: string): Promise<{ total: number; available: number }>; monotonic(): number }
export const DISK_MIN_MS = 5_000
export const NETTOP_MS = 30_000
export const SPACE_MS = 30_000
export const GAP_FACTOR = 3
```
`worker.ts`: `statfs` via `fs.promises.statfs(path)` → `{ total: blocks × bsize, available: bavail × bsize }`; `monotonic` via `performance.now()`.

- [ ] **Step 1: Failing worker tests** (fake deps gain `statfs` from a settable `{ total, available } | Error`, and `mono` advanced by the tests; `baseOutputs` gains the three commands with fixtures):
  - **First read dashes, second shows speeds:** after one disk tick the item is `–`; advance `mono` 5000 and swap in a fixture with +60 MB read, +10 MB written → text `pairText('disk','number',12e6,2e6,…)`.
  - **Gap:** advance `mono` by `3 × 5000 + 1` between reads → text unchanged from the previous value; the next normal interval shows a fresh speed. Same for `mono` not advancing (0 elapsed).
  - **Intervals:** at refresh 2 the disk timer is 5000 ms, the network timer 2000, `nettop` 30000, diskSpace 30000; at refresh 5, disk 5000 and network 5000.
  - **Hidden runs nothing:** `showNetwork: false` → no `netstat` or `nettop` in `deps.runs` after ticking every source; `showCpu: false, showMemory: false, showNetwork: true` → `ps` runs; all three false → `ps` does not run.
  - **Network hover names:** after a `ps` tick and two `nettop` ticks, the network tooltip names the app by its `ps` name.
  - **nettop failing 3 times** drops the list but never dashes Network; `netstat` failing 3 times dashes Network.
  - **Switched back on:** hide then show Disk → first tick after showing is a new baseline (`–`), trend history empty.
  - **diskSpace:** shows `69%` with tone `neutral`, `warning` at 90%; on `platform: 'linux'` it reads `statfs('/')`, disk and network stay hidden and never run; on darwin it reads `/System/Volumes/Data`; `statfs` throwing 3 times → dash.
  - **Restyle:** changing `networkStyle` to `bar` redraws from the last speeds without a new read.
  - **Snapshot:** `cards` ids in the global order; the disk card's `value` is the number-style text and its samples are `pairText` for each style.
- [ ] **Step 2: Run** `orca plugin test .`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Keep the speed state per source as `{ at: number; counters: Counters } | null` (`at` from `deps.monotonic()`), last speed, history (totals), and for disk the last totals for the hover. `enabled('procs')` adds `s.showNetwork`; `enabled('nettop') = mac && s.showNetwork`; `available` adds `diskSpace` on every platform. The refresh-change restart applies to `cpu`, `gpu`, `memory`, `disk`, `network`. `reset` clears counters, last speed, history and the `nettop` table. A `ps` tick keeps a `pid → appName` map for `topTraffic`. Change `valueOf`/`card` so a card's value and samples come from one per-item drawing function; the `Card` shape stays.
- [ ] **Step 4: Run** `orca plugin test . && npm run typecheck && npx tsc -p .`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(strip): poll disk activity, network and disk space`.

### Task 6: Panel cards

**Files:** Modify `src/panel.tsx`, `src/panel.test.tsx`, `src/panel.check.ts`, `src/protocol.ts` (comment only).

- [ ] **Step 1: Failing panel tests:** cards titled "Disk activity", "Network", "Disk space" appear between Memory and Battery; switch labels "Show disk activity", "Show network", "Show disk space" with keys `disk-show`, `network-show`, `diskSpace-show`; pressing `network-bar` writes `networkStyle: 'bar'`; `diskSpace-trend` does not exist; the refresh note reads "GPU updates no faster than every 4 seconds, disk activity every 5."
- [ ] **Step 2: Run** `orca plugin test .`. Expected: FAIL.
- [ ] **Step 3: Implement** in `TITLE`, `SHOW_KEY`, `STYLE_KEY` maps and the note; show label rule: CPU/GPU keep capitals, others lower-cased title. Add check scenario `speeds: { settings: { diskStyle: 'trend', networkStyle: 'level', diskSpaceStyle: 'bar' } }`.
- [ ] **Step 4: Run** `orca plugin test . && orca plugin check .`. Expected: pass, 4 scenarios render.
- [ ] **Step 5: Commit** `feat(panel): cards for disk activity, network and disk space`.

### Task 7: README, in-Orca checks, overhead, gates

**Files:** Modify `README.md`.

- [ ] **Step 1: README:** the three items in "What it shows" (icon, hover, colours); the three commands in "How it runs" with their intervals; the disk-space caveat (purgeable files; container vs `df`); "Limits": no per-app disk activity, network apps cover open connections only; the refresh row; the settings table.
- [ ] **Step 2: Install in Orca** from a `git archive` export into the scratchpad install folder, approve, and check: icons `database`, `globe`, `folder` render (not the fallback); speeds move; U+2008 renders at a point's width; numbers against Activity Monitor with a large file copy and a download. Take `orca plugin shot` of the panel. Record the width observation (check 2).
- [ ] **Step 3: Overhead:** with every item on at refresh 2, sample the worker's CPU time and its children's for 5 minutes (a scratchpad script summing `ps -o time` of the worker plus the per-run `rusage` of `ioreg`, `netstat`, `nettop`, `ps`, `vm_stat`, `sysctl`, `pmset`). Expected: under 1% of one core. If over, set `DISK_MIN_MS = 8_000`, update the design's Cost section, the manifest description and the panel note, re-run. Record the 1 s figure too.
- [ ] **Step 4: Gates:** `npm run test:unit`, `npm run typecheck`, `npx tsc -p .`, `orca plugin test .`, `orca plugin check .`, `orca plugin validate .`, `actionlint`. Expected: all pass.
- [ ] **Step 5: Commit** `docs(readme): disk activity, network and disk space`.
