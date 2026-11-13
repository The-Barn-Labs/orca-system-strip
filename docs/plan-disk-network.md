# Disk activity, network and disk space: implementation plan

**Goal:** Three new status bar items, each with a Show switch, a style and a panel card: disk
activity (read and write speed), network (down and up speed) and disk space (percent used).

**Architecture:** Parsers in `src/sources/` turn command output into per-key byte counters;
`counters.ts` turns two reads into a speed. `styles.ts` learns a speed's text and its log scale;
`format.ts` builds the three items; `strip.ts` polls the new sources on their own timers and feeds
the panel the same `Card` shape as today. Tasks 1 and 2 only add code; Task 3 widens the item
types and wires everything at once, because the type change touches settings, manifest, worker and
panel together and each commit must typecheck.

**Tech stack:** TypeScript run by Orca with no build step; `node --test` for unit tests;
`orca/testing` (`mountWorker`, `mount`, `mockHost`, `defineCheck`).

**Spec:** [design-disk-network.md](design-disk-network.md), building on
[design-styles-panel.md](design-styles-panel.md) and [design.md](design.md).

## Global constraints

- Orca capability stays exactly `settings:own`. No `sudo`. Commands run through `deps.run`
  (`execFile`, fixed arguments, C locale, timeout).
- New commands, exactly: `ioreg -c IOBlockStorageDriver -r -k Statistics -d 1`, `netstat -ibn`,
  `nettop -P -L 1 -x -t external -J bytes_in,bytes_out`. Disk space uses `fs.statfs`
  (`/System/Volumes/Data` on macOS, `/` elsewhere), no command.
- Intervals: disk `max(5000, refresh)`; network every refresh; `nettop` 30 s; disk space 30 s and
  at once when switched on. `ps` also runs while Network is shown.
- A hidden item runs none of its commands. `nettop` runs only while Network is shown.
- Item order: `cpu, gpu, memory, disk, network, diskSpace, battery, clock` (manifest, `ITEM_IDS`,
  `STYLE_KEY`, panel cards).
- Icons: disk `database`, network `globe`, diskSpace `folder`. Click opens Activity Monitor.
- Speed text: number and unit (`K`, `M`, `G`; 1 K = 1,000 bytes/s), padded to the width of three
  digits and one point with U+2007 (per missing digit) and U+2008 (when there is no point).
- Log scale: `p = 20 × log10(bytesPerSecond ÷ 1000)`, clamped 0–100; then the existing `bar`,
  `level`, `trend` rules.
- Tones: speeds always `neutral`; disk space `warning` at ≥ 90%, `danger` at ≥ 95%.
- Words labels `Disk`, `Net`, `Space`. Defaults: all three shown, style `number`.
- Tooltips ≤ 256 characters, item text ≤ 64.
- **Every commit passes `npm run test:unit`, `npm run typecheck`, `npx tsc -p .` and
  `orca plugin test .`.**
- Commit messages describe the change only. No `--no-verify`.

## Review focus

1. **The Mac sleeps, or the clock is set back:** monotonic elapsed ≤ 0 or > 3× the interval →
   new baseline, last value kept. Test in Task 3.
2. **A disk or interface appears or disappears between reads:** no spike, no dip. Test in Task 1.
3. **A counter goes down (interface reset):** that key adds 0. Tests in Tasks 1 and 3.
4. **Network shown with CPU and memory hidden:** `ps` and `nettop` run; Network hidden: neither
   `netstat` nor `nettop` runs. Test in Task 3.
5. **Not macOS:** disk and network never shown and never run; disk space from `statfs('/')`;
   `statfs` failing 3 times dashes. Test in Task 3.

---

### Task 1: Parsers and counter math (`src/sources/`)

Adds files only.

**Files:** Create `src/sources/counters.ts`, `src/sources/disk.ts`, `src/sources/network.ts`,
`src/sources/disk-network.unit.test.ts`, `src/fixtures/ioreg-disk.txt`, `src/fixtures/netstat.txt`,
`src/fixtures/nettop.txt`.

**Interfaces — produces:**
```ts
// counters.ts
export type Counters = Map<string, readonly [number, number]>
export function perSecond(prev: Counters, next: Counters, seconds: number): [number, number]
// disk.ts
export function parseDiskIo(out: string): Counters | null   // key 'id 0x…' from the +-o line; [read, written]; null if no Statistics
// network.ts
export function parseNetstat(out: string): Counters | null  // key: name without '*'; [Ibytes, Obytes]; null if no <Link#> row
export type NettopRow = { pid: number; name: string; bytes: number } // bytes = in + out
export function parseNettop(out: string): NettopRow[]       // 'name.pid' split at the LAST dot
export function topTraffic(prev: ReadonlyMap<number, number>, rows: readonly NettopRow[], names: ReadonlyMap<number, string>, n?: number): TopApp[]
```

- [ ] **Step 1: Capture fixtures** on this Mac with the three commands. Trim `netstat` to the
  header plus `<Link#…>` rows for `lo0`, `gif0*`, `utun0`, `bridge0`, `ap1*`, `en0`, `awdl0`, and
  add `bridge100` and `vmenet0` rows in the same column shape. Trim `nettop` to the header plus 6
  rows, and add `2.1.322.54107,1000,500,`.
- [ ] **Step 2: Failing tests:**
  - `parseDiskIo(fixture)`: keys are the drivers' `id 0x…`; the per-key values equal the fixture's numbers; `parseDiskIo('')` → `null`.
  - `parseNetstat(fixture)`: has `en0` and `awdl0`; none of `lo0`, `gif0`, `utun0`, `bridge0`, `bridge100`, `vmenet0`, `ap1`; bytes read from the right on rows with and without an Address; `parseNetstat('')` → `null`.
  - `parseNettop`: `2.1.322.54107,1000,500,` → `{ pid: 54107, name: '2.1.322', bytes: 1500 }`; header and blank lines skipped.
  - `topTraffic`: per-pid delta clamped at 0; a pid not in `prev` counts from 0; `names` win over the nettop name; same names added together; apps with 0 bytes dropped; top `n` by bytes, ties by name; values in bytes.
  - `perSecond`: deltas ÷ seconds per field; a key only in `prev` or only in `next` adds nothing; a key whose counter went down adds 0; `seconds ≤ 0` → `[0, 0]`.
- [ ] **Step 3: Run** `npm run test:unit`. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement.** Netstat exclusions: `/^(lo|utun|ipsec|gif|stf|bridge|vmenet|ap)\d+$/`
  after removing `*`. `TopApp` comes from `processes.ts`.
- [ ] **Step 5: Run** `npm run test:unit && npm run typecheck`. Expected: pass.
- [ ] **Step 6: Commit** `feat(sources): disk, network and per-app traffic parsers with per-key speed math`.

### Task 2: Speed text and the three item builders

Adds functions only; `StyledId` and `ItemId` are not widened yet.

**Files:** Modify `src/styles.ts`, `src/styles.unit.test.ts`, `src/format.ts`, `src/format.unit.test.ts`.

**Interfaces — produces:**
```ts
// styles.ts
export type SpeedId = 'disk' | 'network'
export type IconName = 'activity' | 'gauge' | 'layers' | 'database' | 'globe' | 'folder' | 'plug' | 'zap'
export const SPEED_LABEL: Record<SpeedId, string>          // Disk, Net
export function speed(bytesPerSecond: number): string
export function speedPosition(bytesPerSecond: number): number
/** a = read or down, b = write or up, bytes/s; totals = past totals (a + b), oldest first. */
export function pairText(id: SpeedId, style: Style, a: number, b: number, totals: readonly number[]): string
export function percentText(label: string, style: Style, p: number, history: readonly number[]): string
// styledText(id, …) now returns percentText(LABEL[id], …) after its existing fallback.
// format.ts
export function decimalBytes(n: number): string
export function rateText(bps: number): string              // decimalBytes(bps) + '/s'
export function spaceTone(percentUsed: number): Tone
export function diskItem(speed: { read: number; write: number }, totals: { read: number; written: number } | null, style: Style, history: readonly number[]): ItemState
export function networkItem(speed: { down: number; up: number }, top: TopApp[] | null, style: Style, history: readonly number[]): ItemState
export function diskSpaceItem(space: { total: number; available: number }, style: Style): ItemState // 'trend' draws as 'number'
```

- [ ] **Step 1: Failing tests** (`F = ' '`, `P = ' '`, `s = speed`):
```ts
test('speed picks the unit and keeps three digits and a point of width', () =>
  assert.deepEqual(
    [0, 960, 4_200_000, 12_000_000, 310_000, 9_970, 999_600, 1.5e9, 2e12, -5, NaN].map(speed),
    [`${F}0.0K`, `${F}1.0K`, `${F}4.2M`, `${F}${P}12M`, `${P}310K`, `${F}${P}10K`, `${F}1.0M`, `${F}1.5G`, `${P}2000G`, `${F}0.0K`, `${F}0.0K`]
  ))
test('speedPosition is 20 per ×10 above 1 KB/s, clamped', () =>
  assert.deepEqual([0, 1000, 10_000, 1e6, 1e8, 1e10, NaN].map(speedPosition), [0, 0, 20, 60, 100, 100, 0]))
test('pairText per style', () => {
  assert.equal(pairText('disk', 'number', 12e6, 85e6, []), `R ${s(12e6)} W ${s(85e6)}`)
  assert.equal(pairText('network', 'number', 4.2e6, 310e3, []), `↓${s(4.2e6)} ↑${s(310e3)}`)
  assert.equal(pairText('network', 'words', 4.2e6, 310e3, []), `Net ↓${s(4.2e6)} ↑${s(310e3)}`)
  assert.equal(pairText('disk', 'bar', 12e6, 85e6, []), 'R ▰▰▰▰▱ W ▰▰▰▰▰')
  assert.equal(pairText('network', 'bar', 4.2e6, 310e3, []), '↓▰▰▰▰▱ ↑▰▰▱▱▱')
  assert.equal(pairText('disk', 'level', 12e6, 85e6, []), `▇R ${s(12e6)} █W ${s(85e6)}`)
  assert.equal(pairText('network', 'level', 4.2e6, 310e3, []), `▆↓${s(4.2e6)} ▄↑${s(310e3)}`)
  assert.equal(pairText('disk', 'trend', 12e6, 85e6, [97e6]), `${F.repeat(5)}█ R ${s(12e6)} W ${s(85e6)}`)
})
test('every pair text fits 64 characters', () => { /* each SpeedId × each style at 2e12 both ways, 20 totals */ })
test('styledText is unchanged', () => assert.equal(styledText('cpu', 'words', 34, []), 'CPU 34%'))
```
  `format.unit.test.ts`:
  - `diskItem({ read: 12e6, write: 85e6 }, { read: 5.1e12, written: 4.0e12 }, 'number', [])` → text `pairText('disk','number',12e6,85e6,[])`, icon `database`, tone `neutral`, tooltip `'Disk: reading 12 MB/s, writing 85 MB/s\nSince start-up: 5.1 TB read · 4.0 TB written'`; with totals `null`, only the first line.
  - `networkItem({ down: 4.2e6, up: 310e3 }, [{ name: 'Chrome', value: 12e6 }], 'number', [])` → icon `globe`, tone `neutral`, tooltip `'Network: down 4.2 MB/s, up 310 KB/s\nTop apps, open connections, last 30 s: Chrome 12 MB'`; with `top` null or `[]`, only the first line. Three 200-character names → tooltip ≤ 256.
  - `diskSpaceItem({ total: 994e9, available: 312e9 }, 'number')` → text `'69%'`, icon `folder`, tooltip `'312 GB free of 994 GB'`; `'words'` → `'Space 69%'`; `'trend'` → `'69%'`.
  - `spaceTone`: 89.9 `neutral`, 90 `warning`, 95 `danger`.
  - `decimalBytes`: `0 → '0 B'`, `999 → '999 B'`, `1000 → '1.0 KB'`, `310e3 → '310 KB'`, `999_960 → '1.0 MB'`, `12e6 → '12 MB'`, `5.1e12 → '5.1 TB'`.
- [ ] **Step 2: Run** `npm run test:unit`. Expected: FAIL (`speed` is not exported).
- [ ] **Step 3: Implement.**
  - `speed`: `n = bps / unit`, with `K` as the smallest unit. Below 10, use `toFixed(1)`; if that reads `10.0`, write `'10'`. From 10, use `String(Math.round(n))`. If that reaches `1000` and `G` is not the unit yet, step up a unit and redo. The prefix is `F.repeat(max(0, 3 − digits)) + (hasPoint ? '' : P)`. Non-finite or negative input counts as 0.
  - `decimalBytes`: units `B, KB, MB, GB, TB`. Bytes are always whole numbers. For the other units, one decimal below 10 and none from 10, stepping up a unit when rounding reaches 1000.
  - `pairText`: follow the design's styles table. Trend is `trend(totals.map(speedPosition))`, then a space, then the number form.
- [ ] **Step 4: Run** `npm run test:unit && npm run typecheck && npx tsc -p . && orca plugin test .`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(format): speed text, log scale and builders for disk activity, network and disk space`.

### Task 3: Wire the three items (types, settings, manifest, worker, panel)

**Files:** Modify `src/styles.ts`, `src/settings.ts`, `src/format.ts`, `src/strip.ts`,
`src/worker.ts`, `src/protocol.ts`, `src/panel.tsx`, `src/panel.check.ts`, `orca-plugin.json`,
and the tests `src/styles.unit.test.ts`, `src/settings.unit.test.ts`, `src/strip.worker.test.ts`,
`src/panel.test.tsx`.

**Interfaces — produces:**
```ts
// styles.ts
export type StyledId = 'cpu' | 'gpu' | 'memory' | 'disk' | 'network' | 'diskSpace' | 'battery'
export type PercentId = Exclude<StyledId, SpeedId>
// STYLES: disk, network all five; diskSpace no trend. LABEL adds Disk, Net, Space (SPEED_LABEL reuses it).
// ICON adds database, globe, folder. styledText takes PercentId.
// settings.ts: showDisk, showNetwork, showDiskSpace (true); diskStyle, networkStyle, diskSpaceStyle ('number');
//   STYLE_KEY keys in the global order.
// format.ts
export type ItemId = 'cpu' | 'gpu' | 'memory' | 'disk' | 'network' | 'diskSpace' | 'battery' | 'clock'
export const ITEM_IDS: readonly ItemId[]   // global order
// strip.ts
export type Source = 'cpu' | 'gpu' | 'memory' | 'disk' | 'network' | 'diskSpace' | 'battery' | 'clock' | 'procs' | 'nettop'
export type Deps = { /* existing */ statfs(path: string): Promise<{ total: number; available: number }>; monotonic(): number }
export const DISK_MIN_MS = 5_000
export const NETTOP_MS = 30_000
export const SPACE_MS = 30_000
export const GAP_FACTOR = 3
```
`worker.ts`: `statfs` via `fs.promises.statfs` → `{ total: blocks × bsize, available: bavail × bsize }`;
`monotonic` via `performance.now()`.

- [ ] **Step 1: Update existing tests for the new shape** (they would otherwise fail on the type change, not on the feature):
  - `styles.unit.test.ts`: the 64-character loop uses `pairText` for `SpeedId` and `styledText` otherwise; rename "only cpu and gpu offer trend" to say disk and network offer it too, and assert diskSpace does not.
  - `strip.worker.test.ts`: `WORDS` gains `diskStyle`, `networkStyle`, `diskSpaceStyle: 'words'`; `baseOutputs` gains the three commands; fake deps gain `statfs` (settable result per path, or an Error) and `mono`/`monotonic()`; the start-up test compares `slice(0, ITEM_IDS.length)`; the timer-list test expects the new timers; the card-ids test expects the global order.
  - `panel.test.tsx`: `ICON` and `snapshot()` gain the three cards; the no-battery test finds the battery card with `findIndex`.
- [ ] **Step 2: New failing tests:**
  - **Settings:** `readSettings({})` has the six defaults; `{ diskSpaceStyle: 'trend', networkStyle: 'bar', showDisk: false }` → `number`, `bar`, `false`; `Object.keys(STYLE_KEY)` is the global order minus clock.
  - **Manifest** (unit, reads `orca-plugin.json`): status bar ids in the global order with the new icons. Every `*Style` setting's `enum` equals `STYLES[id]`, and its `enumLabels` equal `STYLE_LABEL` of each.
  - **Worker, first and second read:** with `diskStyle: 'number'`, one disk tick gives `–`. Then advance `mono` 5000 and swap in a fixture with +60 MB read and +10 MB written: the text becomes `pairText('disk','number',12e6,2e6,…)`.
  - **Worker, gaps:** a read `3 × 5000 + 1` ms after the last leaves the text unchanged, and the next normal read shows a fresh speed. The same holds with `mono` not advanced.
  - **Worker, counter going down:** one interface's bytes drop between reads; the speed counts only the others.
  - **Worker, intervals:** at refresh 2, disk 5000, network 2000, `nettop` 30000, diskSpace 30000. At refresh 5, disk and network are both 5000.
  - **Worker, hidden runs nothing:**
    - `showNetwork: false`: no `netstat` or `nettop` after ticking every source.
    - `showCpu: false, showMemory: false`: `ps` runs.
    - All three false: `ps` does not run.
  - **Worker, network names:** a `ps` tick, then two `nettop` ticks with inline output for pid 101 (`ps.txt`'s pid) where the second has more bytes. The tooltip names the `ps` app. After only one `nettop` tick there are no apps (the previous table stays `null` until the first read). The network tone is `neutral`.
  - **Worker, failures:**
    - `nettop` failing 3 times drops the list but never dashes Network.
    - `netstat` failing 3 times dashes Network.
    - Disk `ioreg` failing 3 times dashes Disk.
  - **Worker, switched back on:** hide Disk, then show it. Right after `settled()` it shows `–`, before advancing `mono`. Its trend history is empty.
  - **Worker, diskSpace:**
    - Shows `69%`, `neutral`; at 90% used, `warning`.
    - On darwin it reads `/System/Volumes/Data`.
    - On `platform: 'linux'` it reads `/`, while disk and network stay hidden and never run.
    - `statfs` throwing 3 times dashes it.
    - Switching it on reads it at once.
  - **Worker, restyle:** `networkStyle: 'bar'` redraws from the last speeds without a new read.
  - **Worker, snapshot:** card ids in the global order. The disk card's `value` is the number-style text, and its samples are `pairText` per style.
  - **Panel:**
    - Cards "Disk activity", "Network" and "Disk space" sit between Memory and Battery.
    - The switches are labelled "Show disk activity", "Show network" and "Show disk space", with keys `disk-show`, `network-show`, `diskSpace-show`.
    - Pressing `network-bar` writes `networkStyle: 'bar'`. There is no `diskSpace-trend`.
    - The refresh note reads "GPU updates no faster than every 4 seconds, disk activity every 5."
- [ ] **Step 3: Run** `npm run test:unit; orca plugin test .`. Expected: the new tests FAIL. Updated old tests may fail too, until Step 4.
- [ ] **Step 4: Implement.**
  - **Manifest:**
    - Items `{"id":"disk","text":"–","icon":"database","tooltip":"System Strip","command":"system-strip.openActivityMonitor"}`, then `network` (`globe`) and `diskSpace` (`folder`), all after `memory`.
    - Settings "Show disk activity", "Show network", "Show disk space", "Disk activity style", "Network style" and "Disk space style", after the memory ones.
    - `refreshSeconds.description`: "How often CPU, memory and network update. The GPU updates no faster than every 4 seconds, disk activity every 5."
  - **Strip, speed state:** per speed source, keep the previous read as `{ at: monotonic, counters } | null`, plus the last speed and the history of totals. Disk also keeps its last totals for the hover.
  - **Strip, `nettop`:** keep the previous table as `Map<pid, bytes> | null`, and a `pid → appName` map refreshed on each `ps` tick.
  - **Strip, `enabled`:** `procs` adds `s.showNetwork`. `nettop` is `mac && s.showNetwork`. `available` adds `diskSpace` on every platform.
  - **Strip, timers:** a refresh change restarts `cpu`, `gpu`, `memory`, `disk` and `network`.
  - **Strip, `reset`:** clears the previous read, the last speed, the history and the `nettop` table.
  - **Strip, `card` and `valueOf`:** one drawing function per item gives a card's value and samples. The `Card` shape stays.
  - **Panel:** add the new entries to `TITLE`, `SHOW_KEY` and `STYLE_KEY`, and change the note. CPU and GPU keep capitals in their switch labels; the others use the lower-cased title.
  - **Check scenario:** add `speeds: { settings: { diskStyle: 'trend', networkStyle: 'level', diskSpaceStyle: 'bar' } }`.
- [ ] **Step 5: Run** `npm run test:unit && npm run typecheck && npx tsc -p . && orca plugin test . && orca plugin check . && orca plugin validate .`. Expected: all pass; 4 check scenarios render.
- [ ] **Step 6: Commit** `feat(strip): disk activity, network and disk space items, settings and panel cards`.

### Task 4: README, in-Orca checks, overhead, gates

**Files:** Modify `README.md`, `orca-plugin.json` (top-level `description`).

- [ ] **Step 1: Docs.**
  - **README:**
    - Add the three items to "What it shows", with icon, hover and colours.
    - Add the three commands to "How it runs", with their intervals.
    - Add the disk-space caveat: purgeable files are counted as used, and the figure covers the whole APFS container rather than the single volume `df` reports.
    - Under "Limits", say there is no per-app disk activity and that the network apps list covers open connections only.
    - Update the refresh row and the settings table.
  - **Manifest description:** "CPU, GPU, memory, disk, network, battery and a clock in Orca's bottom status bar."
- [ ] **Step 2: Install in Orca.** Export with `git archive` into the scratchpad install folder, install, approve, then check:
  - The `database`, `globe` and `folder` icons render, not the fallback glyph.
  - The speeds move.
  - U+2008 renders at a point's width.
  - The numbers match Activity Monitor while a large file copy and a download run.
  - Take an `orca plugin shot` of the panel.
  - Record the width observation (check 2).
- [ ] **Step 3: Overhead.** With every item on at refresh 2, sample for 5 minutes the CPU time of the worker and of the commands it runs. Use a scratchpad script that sums `ps -o time` of the worker and the per-run `rusage` of each command.
  - Expected: under 1% of one core.
  - **If over:** set `DISK_MIN_MS = 8_000`, then update together the interval test, the panel-note test and text, the manifest `refreshSeconds` description, the README, and the design's Cost section. Re-run.
  - Record the figure at 1 s too.
- [ ] **Step 4: Gates:** `npm run test:unit`, `npm run typecheck`, `npx tsc -p .`, `orca plugin test .`, `orca plugin check .`, `orca plugin validate .`, `actionlint`. Expected: all pass.
- [ ] **Step 5: Commit** `docs(readme): disk activity, network and disk space`.
