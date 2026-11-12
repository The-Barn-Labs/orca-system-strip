# System Strip Implementation Plan


**Goal:** An Orca trusted-worker plugin that shows CPU, GPU, memory, battery and a clock as five status bar items, each switchable in Settings.

**Architecture:** Pure, Orca-free modules parse each macOS source (`src/sources/*`) and turn readings into item states (`src/format.ts`); one controller (`src/strip.ts`) owns settings, timers, failure counting, change-diffing and rate-limit back-off, and talks to Orca only through `orca.settings`, `orca.commands` and `orca.host.call('statusBar.update')`. `src/worker.ts` wires real Node dependencies into the controller.

**Tech Stack:** TypeScript run directly by Orca (no build), Node built-ins only at runtime (`node:os`, `node:child_process`), `node:test` for unit tests, `orca/testing` for worker tests, dev-only `typescript` + `@types/node`.

**Spec:** `docs/design.md` — read it first; this plan argues from it.

## Global Constraints

- The repository root is the plugin root.
- Manifest: `manifestVersion: 2`, `id: "system-strip"`, `name: "System Strip"`, `version: "0.1.0"`, `execution: "trusted-worker"`, `pluginApi: 1`, `main: "src/worker.ts"`, `engines.orca: ">=1.4.248"`, `license: "MIT"`, `repository: "https://github.com/The-Barn-Labs/orca-system-strip"`.
- Only capability: `settings:own`. No network, no storage, no secrets, no `sudo`.
- Runtime imports: Node built-ins and relative `.ts` files only, always with the explicit `.ts` extension (verified: Orca's loader and `node --test` both resolve them). No runtime npm dependencies.
- Pure modules (`src/settings.ts`, `src/sources/*`, `src/format.ts`) must not import `orca/*` — CI type-checks and tests them without the Orca CLI.
- Node runs the `.ts` files in strip-only mode: import types with `import type { … }` (a plain `import { SomeType }` crashes at runtime), and use no enums, namespaces or constructor parameter properties. `verbatimModuleSyntax` + `erasableSyntaxOnly` in both tsconfigs enforce this.
- Unit tests are `src/**/*.unit.test.ts` (import `node:test` + `node:assert/strict`). Worker tests are `src/**/*.worker.test.ts` (import `orca/testing`). `orca plugin test .` runs both; CI runs only unit tests.
- Commands run via `execFile` with fixed args, no shell, an 8 s timeout, `env: { ...process.env, LC_ALL: 'C', LANG: 'C' }`.
- Commits: `<type>(<area>): <what>`.
- Fixtures are committed to a public repo: no usernames, home paths, serial numbers or hostnames. The `ps` fixture is hand-written.
- Placeholder dash is the en dash `–` (U+2013).

## Review Focus

1. **Settings never set** — real Orca may return `{}` from `orca.settings.get()` (the mock does): every item must still appear with spec defaults. Pinned in Task 1 (`readSettings({})`) and Task 6 (start-up test with empty settings).
2. **A Mac with no battery** (Mac mini/Studio) — Battery must be hidden, not dashed, and must not count as failures. Pinned in Task 3 (desktop fixture) and Task 6.
3. **Wrapped/odd command output** — process names with spaces and parentheses, `(no estimate)` battery time, `ioreg` with two accelerators or no utilisation key. Pinned in Tasks 2–4 negative controls.
4. **Orca returns `rate_limited`** — must not throw, must not spin; the next send waits `retryAfterMs` and then resends the latest state. Pinned in Task 6.
5. **Turning an item off then on again** — the item reappears with fresh data and its polling restarts; turning it off stops its commands. Pinned in Task 6.

---

### Task 1: Repo skeleton, manifest and settings

**Files:**
- Create (from scaffold, then edit): `orca-plugin.json`, `tsconfig.json`, `.gitignore`, `.gitattributes`
- Create: `package.json`, `tsconfig.ci.json`, `LICENSE`, `src/settings.ts`, `src/settings.unit.test.ts`
- Already committed separately: `docs/design.md`, `docs/plan.md`

**Interfaces:**
- Produces:
  ```ts
  export type Settings = { showCpu: boolean; showGpu: boolean; showMemory: boolean; showBattery: boolean; showClock: boolean; clock24h: boolean; refreshSeconds: 1 | 2 | 5 }
  export const DEFAULTS: Settings   // all show* true, clock24h true, refreshSeconds 2
  export function readSettings(raw: unknown): Settings
  ```

- [ ] **Step 1: Scaffold into a temp folder and copy the keepers**

```bash
T=$(mktemp -d) && orca plugin create "$T/s" --template hook --id system-strip --name "System Strip" \
 && cp "$T/s/.gitignore" "$T/s/.gitattributes" "$T/s/tsconfig.json" . && orca plugin types .
```
Expected: `.orca/types/` exists; `.gitignore` contains `node_modules/` and `.orca/`. Do not copy the scaffold's `src/` or README.

- [ ] **Step 2: Write `orca-plugin.json`**

Global-constraint fields, plus `description: "CPU, GPU, memory, battery and a clock in Orca's bottom status bar."`, `capabilities: [{ "kind": "settings:own" }]`, and `contributes`:
- `statusBarItems` in this order: `cpu` (`text "CPU –"`, `icon "activity"`, `command "system-strip.openActivityMonitor"`), `gpu` (`"GPU –"`, `"gauge"`, same command), `memory` (`"Mem –"`, `"layers"`, same command), `battery` (`"Bat –"`), `clock` (`"--:--"`). Each `tooltip: "System Strip"`.
- `commands`: `[{ "id": "system-strip.openActivityMonitor", "title": "System Strip: Open Activity Monitor", "when": "global" }]`.
- `settings`: the seven keys from the spec's Settings table with those types and defaults; `refreshSeconds` is `type "integer"`, `enum [1,2,5]`, `enumLabels ["1 second","2 seconds","5 seconds"]`. Titles: "Show CPU", "Show GPU", "Show memory", "Show battery", "Show clock", "24-hour clock", "Refresh every".

Run: `orca plugin validate .` — Expected: lists "Read and change the plugin's own settings", the command and five status bar items; no errors. (It fails on missing `main` until Task 6 — if so, create an empty `src/worker.ts` exporting `export default function activate(): void {}` now.)

- [ ] **Step 3: Tooling files**

- `package.json`: `{ "private": true, "scripts": { "typecheck": "tsc -p tsconfig.ci.json", "test:unit": "node --test \"src/**/*.unit.test.ts\"" }, "devDependencies": { "typescript": "^5.8", "@types/node": "^22" } }` — no `"type"` field. Run `npm install` to create `package-lock.json`.
- `tsconfig.ci.json`: `strict`, `noEmit`, `target/lib ES2022`, `module ESNext`, `moduleResolution Bundler`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `types ["node"]`, `include ["src/settings.ts", "src/format.ts", "src/sources", "src/fixtures/read.ts", "src/**/*.unit.test.ts"]`.
- `tsconfig.json` (scaffold, extends `.orca/types/tsconfig.json`): add `verbatimModuleSyntax` and `erasableSyntaxOnly`, override `compilerOptions.typeRoots` to `[".orca/types", "node_modules/@types"]` and `compilerOptions.types` to the scaffold's six orca entries plus `"node"`, so `npx tsc -p tsconfig.json` checks everything locally (needs `.orca/types`, which is gitignored and regenerated by `orca plugin types .`).
- `LICENSE`: MIT, `Copyright (c) 2026 The Barn Labs`.

- [ ] **Step 4: Write the failing test `src/settings.unit.test.ts`**

```ts
test('empty settings give the spec defaults', () => assert.deepEqual(readSettings({}), DEFAULTS))
test('defaults are all items on, 24h clock, 2 s', () => assert.deepEqual(DEFAULTS, { showCpu: true, showGpu: true, showMemory: true, showBattery: true, showClock: true, clock24h: true, refreshSeconds: 2 }))
test('valid values are kept', () => assert.deepEqual(readSettings({ showGpu: false, clock24h: false, refreshSeconds: 5 }), { ...DEFAULTS, showGpu: false, clock24h: false, refreshSeconds: 5 }))
test('wrong types and out-of-enum values fall back', () => assert.deepEqual(readSettings({ showCpu: 'no', refreshSeconds: 3, extra: 1 }), DEFAULTS))
test('non-objects fall back', () => { for (const raw of [null, undefined, 7, 'x', []]) assert.deepEqual(readSettings(raw), DEFAULTS) })
```

- [ ] **Step 5: Run — `npm run test:unit`** — Expected: FAIL, cannot find `./settings.ts`.
- [ ] **Step 6: Implement `src/settings.ts`** per the interface.
- [ ] **Step 7: Run `npm run test:unit && npm run typecheck`** — Expected: PASS, no type errors.
- [ ] **Step 8: Commit**

```bash
git add orca-plugin.json package.json package-lock.json tsconfig.json tsconfig.ci.json .gitignore .gitattributes LICENSE src/settings.ts src/settings.unit.test.ts
git commit -m "feat(settings): plugin manifest, tooling and settings defaults" -- orca-plugin.json package.json package-lock.json tsconfig.json tsconfig.ci.json .gitignore .gitattributes LICENSE src/settings.ts src/settings.unit.test.ts
```
(Include `src/worker.ts` if the Step 2 stub was created.)

---

### Task 2: CPU and GPU sources

**Files:** Create `src/sources/cpu.ts`, `src/sources/gpu.ts`, `src/sources/cpu-gpu.unit.test.ts`, `src/fixtures/ioreg-gpu.txt`, `src/fixtures/ioreg-gpu-two.txt`

**Interfaces:**
- Produces:
  ```ts
  // cpu.ts
  export type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number }
  export type CpuSample = { busy: number; total: number }
  export function sampleCpu(cpus: readonly { times: CpuTimes }[]): CpuSample   // summed over all cores
  export function cpuPercent(prev: CpuSample, next: CpuSample): number | null  // Math.round(busyΔ / totalΔ × 100), then clamp 0..100; null when totalΔ <= 0
  // gpu.ts
  export type GpuReading = { utilization: number; models: string[] }          // highest utilisation; every model, in output order
  export function parseGpu(ioreg: string): GpuReading | null                   // null when no "Device Utilization %" anywhere
  ```

- [ ] **Step 1: Record fixtures.** `ioreg -r -d 1 -c IOAccelerator` on this Mac → keep only the lines containing `"Device Utilization %"` and `"model"` plus enough structure to show one block; save as `src/fixtures/ioreg-gpu.txt`. Hand-write `ioreg-gpu-two.txt`: two blocks, models `"AMD Radeon Pro 5500M"` (util 63) and `"Intel UHD Graphics 630"` (util 12), in that order.
- [ ] **Step 2: Write failing tests**

```ts
test('cpu: busy share of the tick delta', () => {
  const a = sampleCpu([{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }])
  const b = sampleCpu([{ times: { user: 200, nice: 0, sys: 100, idle: 1050, irq: 0 } }])
  assert.equal(cpuPercent(a, b), 43)   // busy 150 of 350
})
test('cpu: sums cores', () => assert.deepEqual(sampleCpu([{ times: { user: 1, nice: 1, sys: 1, idle: 1, irq: 1 } }, { times: { user: 1, nice: 0, sys: 0, idle: 3, irq: 0 } }]), { busy: 5, total: 9 }))
test('cpu: no elapsed ticks is null, not NaN', () => { const s = { busy: 5, total: 9 }; assert.equal(cpuPercent(s, s), null) })
test('cpu: clamps to 0..100', () => assert.equal(cpuPercent({ busy: 0, total: 0 }, { busy: 10, total: 5 }), 100))
test('gpu: real Apple Silicon output', () => assert.deepEqual(parseGpu(fixture('ioreg-gpu.txt')), { utilization: 15, models: ['Apple M5 Pro'] }))  // use the recorded values
test('gpu: two accelerators show the highest', () => assert.deepEqual(parseGpu(fixture('ioreg-gpu-two.txt')), { utilization: 63, models: ['AMD Radeon Pro 5500M', 'Intel UHD Graphics 630'] }))
test('gpu: no utilisation key is null', () => { assert.equal(parseGpu('"model" = "Intel HD"'), null); assert.equal(parseGpu(''), null) })
```
`fixture(name)` reads `new URL('../fixtures/' + name, import.meta.url)` — put this helper in `src/fixtures/read.ts` (Orca-free) for Tasks 2–4.

- [ ] **Step 3: Run `npm run test:unit`** — Expected: FAIL (modules missing).
- [ ] **Step 4: Implement both modules** to the interfaces. `idle` is the only non-busy field.
- [ ] **Step 5: Run `npm run test:unit && npm run typecheck`** — Expected: PASS.
- [ ] **Step 6: Commit** — `feat(sources): cpu and gpu readings` with the files above and `src/fixtures/read.ts`.

---

### Task 3: Memory and battery sources

**Files:** Create `src/sources/memory.ts`, `src/sources/battery.ts`, `src/sources/memory-battery.unit.test.ts`, fixtures `vm_stat.txt`, `pmset-discharging.txt`, `pmset-charging.txt`, `pmset-ac-not-charging.txt`, `pmset-charged.txt`, `pmset-no-estimate.txt`, `pmset-desktop.txt`

**Interfaces:**
- Produces:
  ```ts
  // memory.ts
  export type MemoryPages = { pageSize: number; anonymous: number; purgeable: number; wired: number; compressed: number }
  export function parseVmStat(out: string): MemoryPages | null   // "page size of N bytes", "Anonymous pages", "Pages purgeable", "Pages wired down", "Pages occupied by compressor"; null if any missing
  export function memoryUsed(p: MemoryPages, totalBytes: number): { usedBytes: number; percent: number }  // used = (anonymous − purgeable + wired + compressed) × pageSize; percent integer, clamped 0..100
  export type Pressure = 'normal' | 'warn' | 'critical'
  export function parsePressure(out: string): Pressure | null    // trimmed "1" normal, "2" warn, "4" critical, else null
  // battery.ts
  export type BatteryState = 'charging' | 'discharging' | 'charged' | 'not-charging'
  export type BatteryReading = { present: false } | { present: true; percent: number; onPower: boolean; state: BatteryState; remaining: string | null }
  export function parseBattery(pmset: string): BatteryReading | null  // null only when output is unrecognisable
  ```
  Memory source command per tick: `vm_stat` and `sysctl -n kern.memorystatus_vm_pressure_level` (verified: compressor pages are not exposed by `sysctl`, so one call is not possible).

- [ ] **Step 1: Record fixtures.** `vm_stat` → `vm_stat.txt` as-is. `pmset -g batt` → `pmset-discharging.txt`; replace the `(id=…)` number with `(id=1234567)`. Hand-write the others from that shape:
  - charging: `Now drawing from 'AC Power'` / ` -InternalBattery-0 (id=1234567)\t64%; charging; 1:05 remaining present: true`
  - AC not charging: `Now drawing from 'AC Power'` / ` -InternalBattery-0 (id=1234567)\t80%; AC attached; not charging present: true`
  - charged: `Now drawing from 'AC Power'` / ` -InternalBattery-0 (id=1234567)\t100%; charged; 0:00 remaining present: true`
  - no estimate: `Now drawing from 'Battery Power'` / ` -InternalBattery-0 (id=1234567)\t55%; discharging; (no estimate) present: true`
  - desktop: only `Now drawing from 'AC Power'`

  Parsing rules: `onPower` comes only from line 1 (`'AC Power'` → true). `remaining` comes from `H:MM remaining`; `0:00` and `(no estimate)` → `null`. A `Now drawing from` line with no `InternalBattery` line → `{ present: false }`.
- [ ] **Step 2: Write failing tests**

```ts
test('vm_stat: recorded output', () => assert.deepEqual(parseVmStat(fixture('vm_stat.txt')), { pageSize: 16384, anonymous: /*recorded*/, purgeable: /*recorded*/, wired: /*recorded*/, compressed: /*recorded*/ }))
test('memoryUsed: activity-monitor formula', () => assert.deepEqual(memoryUsed({ pageSize: 4096, anonymous: 1000, purgeable: 200, wired: 300, compressed: 100 }, 4096 * 2000), { usedBytes: 1200 * 4096, percent: 60 }))
test('memoryUsed: clamps', () => assert.equal(memoryUsed({ pageSize: 1, anonymous: 10, purgeable: 0, wired: 10, compressed: 10 }, 10).percent, 100))
test('vm_stat: missing field is null', () => assert.equal(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1.'), null))
test('pressure', () => { assert.equal(parsePressure('1\n'), 'normal'); assert.equal(parsePressure('2'), 'warn'); assert.equal(parsePressure('4'), 'critical'); assert.equal(parsePressure('x'), null) })
test('battery: discharging', () => assert.deepEqual(parseBattery(fixture('pmset-discharging.txt')), { present: true, percent: /*recorded*/, onPower: false, state: 'discharging', remaining: /*recorded*/ }))
test('battery: charging', () => assert.deepEqual(parseBattery(fixture('pmset-charging.txt')), { present: true, percent: 64, onPower: true, state: 'charging', remaining: '1:05' }))
test('battery: AC attached, not charging', () => assert.deepEqual(parseBattery(fixture('pmset-ac-not-charging.txt')), { present: true, percent: 80, onPower: true, state: 'not-charging', remaining: null }))
test('battery: charged', () => assert.deepEqual(parseBattery(fixture('pmset-charged.txt')), { present: true, percent: 100, onPower: true, state: 'charged', remaining: null }))
test('battery: no estimate', () => assert.equal((parseBattery(fixture('pmset-no-estimate.txt')) as any).remaining, null))
test('battery: desktop Mac has none', () => assert.deepEqual(parseBattery(fixture('pmset-desktop.txt')), { present: false }))
test('battery: garbage is null', () => assert.equal(parseBattery('hello'), null))
```
`finishing charge` maps to `charging`. `0:00 remaining` maps to `remaining: null`.

- [ ] **Step 3: Run** — Expected: FAIL. **Step 4: Implement.** **Step 5: Run `npm run test:unit && npm run typecheck`** — Expected: PASS.
- [ ] **Step 6: Commit** — `feat(sources): memory and battery readings`.

---

### Task 4: Process list and top apps

**Files:** Create `src/sources/processes.ts`, `src/sources/processes.unit.test.ts`, `src/fixtures/ps.txt` (hand-written)

**Interfaces:**
- Produces:
  ```ts
  export type ProcRow = { pid: number; cpu: number; rssKb: number; path: string }
  export function parsePs(out: string): ProcRow[]            // output of `ps -Aeo pid=,pcpu=,rss=,comm=`; path is the rest of the line, spaces kept; bad lines skipped
  export function appName(path: string): string              // outermost "<Name>.app" segment → "<Name>"; else the basename
  export type TopApp = { name: string; value: number }
  export function topApps(rows: readonly ProcRow[], by: 'cpu' | 'memory', cores: number, n?: number): TopApp[]
  // groups by appName; cpu value = summed pcpu / cores, rounded to 1 decimal; memory value = summed rssKb × 1024 (bytes);
  // sorted desc, ties by name asc, first n (default 3), zero values dropped
  ```

- [ ] **Step 1: Write `ps.txt`** (no real paths — a deliberate deviation from the spec's "recorded real output", because a real process list carries usernames and home paths; real piped `ps -Aeo pid=,pcpu=,rss=,comm=` prints full untruncated paths, which this shape matches): rows for `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (pcpu 10, rss 400000), three `/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)` (pcpu 20 each, rss 300000 each), `/usr/local/bin/claude` (pcpu 90, rss 500000), `/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer` (pcpu 6, rss 100000), `/sbin/launchd` (pcpu 0, rss 1000), and one garbage line `abc`.
- [ ] **Step 2: Write failing tests**

```ts
const rows = parsePs(fixture('ps.txt'))
test('ps: parses rows, keeps spaces, skips garbage', () => { assert.equal(rows.length, 7); assert.equal(rows[1].path.endsWith('Google Chrome Helper (Renderer)'), true) })
test('appName: outermost .app wins', () => { assert.equal(appName(rows[1].path), 'Google Chrome'); assert.equal(appName('/usr/local/bin/claude'), 'claude') })
test('topApps cpu: grouped and per-machine scale', () => assert.deepEqual(topApps(rows, 'cpu', 10), [{ name: 'claude', value: 9 }, { name: 'Google Chrome', value: 7 }, { name: 'WindowServer', value: 0.6 }]))
test('topApps memory: grouped bytes', () => assert.deepEqual(topApps(rows, 'memory', 10, 2), [{ name: 'Google Chrome', value: 1300000 * 1024 }, { name: 'claude', value: 500000 * 1024 }]))
test('topApps: empty input', () => assert.deepEqual(topApps([], 'cpu', 8), []))
```

- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run unit tests + typecheck** — PASS.
- [ ] **Step 6: Commit** — `feat(sources): process list grouped by app`.

---

### Task 5: Item formatting

**Files:** Create `src/format.ts`, `src/format.unit.test.ts`

**Interfaces:**
- Consumes: `GpuReading`, `Pressure`, `BatteryReading`, `TopApp` from Tasks 2–4.
- Produces:
  ```ts
  export type ItemId = 'cpu' | 'gpu' | 'memory' | 'battery' | 'clock'
  export const ITEM_IDS: readonly ItemId[]          // in manifest order
  export type Tone = 'neutral' | 'warning' | 'danger'
  export type ItemState = { text: string; tone: Tone; tooltip: string; visible: boolean }
  export const PLACEHOLDER: Record<ItemId, string>  // "CPU –", "GPU –", "Mem –", "Bat –", "--:--" (same as manifest)
  export class Smoother { constructor(windowMs: number); push(atMs: number, value: number): void; average(): number | null }  // mean of samples within windowMs of the newest
  export const SMOOTH_MS = 10_000
  export function loadTone(smoothed: number | null): Tone                 // ≥90 danger, ≥70 warning, else neutral
  export function pressureTone(p: Pressure | null): Tone                  // warn→warning, critical→danger
  export function batteryTone(b: BatteryReading): Tone                    // on battery power only: ≤10 danger, ≤20 warning
  export function pct(n: number): string                                  // integer, padded to 2 digits with U+2007: 4 → " 4%", 34 → "34%", 100 → "100%"
  export function gb(bytes: number): string                               // one decimal, "12.3 GB" (1 GB = 1024³)
  export function cpuItem(percent: number, smoothed: number | null, top: TopApp[] | null): ItemState
  export function gpuItem(r: GpuReading, smoothed: number | null): ItemState
  export function memoryItem(used: { usedBytes: number; percent: number }, totalBytes: number, pressure: Pressure | null, top: TopApp[] | null): ItemState
  export function batteryItem(b: BatteryReading): ItemState               // { present: false } → visible false
  export function clockItem(now: Date, h24: boolean): ItemState
  export function dashItem(id: ItemId, reason: string): ItemState         // PLACEHOLDER text, neutral, tooltip = reason, visible true
  ```
  Exact copy (tooltip lines joined with `\n`):
  - cpu: text `CPU ${pct}`; tooltip `Top apps: claude 9% · Google Chrome 7% · WindowServer 0.6%` (values as `topApps` gives them, `%` appended); `top` null or empty → `CPU busy across all cores`.
  - gpu: text `GPU ${pct}`; tooltip = models joined with `, `.
  - memory: text `Mem ${pct}`; tooltip line 1 `${gb(used)} of ${gb(total)} used`, line 2 `Pressure: normal|warning|critical` (or `Pressure: unknown`), line 3 `Top apps: Google Chrome 1.2 GB · claude 0.5 GB` when `top` is non-empty.
  - battery: text `Bat ${pct}` plus ` ⚡` when `onPower`; tooltip `Discharging · 19:58 left` / `Discharging` (no time) / `Charging · 1:05 until full` / `Charging` / `On power, fully charged` / `On power, not charging`.
  - clock: text `HH:MM` (24h, zero-padded hour) or `h:MM AM|PM`; tooltip `now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })`; tone neutral.

- [ ] **Step 1: Write failing tests** — one per threshold edge and copy line:

```ts
test('loadTone edges', () => assert.deepEqual([null, 69, 70, 89, 90].map(loadTone), ['neutral', 'neutral', 'warning', 'warning', 'danger']))
test('pressureTone', () => assert.deepEqual([null, 'normal', 'warn', 'critical'].map((p) => pressureTone(p as any)), ['neutral', 'neutral', 'warning', 'danger']))
test('batteryTone edges on battery', () => assert.deepEqual([21, 20, 11, 10].map((percent) => batteryTone({ present: true, percent, onPower: false, state: 'discharging', remaining: null })), ['neutral', 'warning', 'warning', 'danger']))
test('batteryTone never warns on power', () => assert.equal(batteryTone({ present: true, percent: 5, onPower: true, state: 'not-charging', remaining: null }), 'neutral'))
test('pct pads', () => assert.deepEqual([4, 34, 100].map(pct), [' 4%', '34%', '100%']))
test('smoother averages the window', () => { const s = new Smoother(10_000); s.push(0, 100); s.push(5_000, 50); s.push(12_000, 20); assert.equal(s.average(), 35) })   // 0 ms sample dropped
test('smoother empty is null', () => assert.equal(new Smoother(10_000).average(), null))
test('cpu item: tone from smoothed, text from latest', () => assert.deepEqual(cpuItem(95, 60, [{ name: 'claude', value: 9 }]), { text: 'CPU 95%', tone: 'neutral', tooltip: 'Top apps: claude 9%', visible: true }))
test('memory item copy', () => assert.deepEqual(memoryItem({ usedBytes: 12 * 1024 ** 3, percent: 50 }, 24 * 1024 ** 3, 'warn', [{ name: 'Google Chrome', value: 1.25 * 1024 ** 3 }]), { text: 'Mem 50%', tone: 'warning', tooltip: '12.0 GB of 24.0 GB used\nPressure: warning\nTop apps: Google Chrome 1.3 GB', visible: true }))
test('battery item on power', () => assert.deepEqual(batteryItem({ present: true, percent: 80, onPower: true, state: 'not-charging', remaining: null }), { text: 'Bat 80% ⚡', tone: 'neutral', tooltip: 'On power, not charging', visible: true }))
test('battery item absent', () => assert.equal(batteryItem({ present: false }).visible, false))
test('clock 24h and 12h', () => { const d = new Date(2026, 10, 12, 14, 5); assert.equal(clockItem(d, true).text, '14:05'); assert.equal(clockItem(d, false).text, '2:05 PM'); assert.equal(clockItem(new Date(2026, 10, 12, 0, 7), false).text, '12:07 AM') })
test('dash item', () => assert.deepEqual(dashItem('gpu', 'ioreg failed'), { text: 'GPU –', tone: 'neutral', tooltip: 'ioreg failed', visible: true }))
```
Also one test each for the gpu tooltip with two models and every battery tooltip variant listed above.

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement `src/format.ts`.** **Step 4: Run unit tests + typecheck** — PASS.
- [ ] **Step 5: Commit** — `feat(format): item text, tone and tooltips`.

---

### Task 6: Controller and worker

**Files:** Create `src/strip.ts`, `src/strip.worker.test.ts`; replace `src/worker.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  // strip.ts
  export type Source = 'cpu' | 'gpu' | 'memory' | 'battery' | 'clock' | 'procs'
  export type Deps = {
    platform: string
    run(cmd: string, args: readonly string[]): Promise<string>   // rejects on non-zero exit, timeout or ENOENT
    cpus(): readonly { times: CpuTimes }[]
    totalmem(): number
    now(): number
    every(ms: number, fn: () => void): () => void                // returns cancel
    after(ms: number, fn: () => void): () => void                // returns cancel
  }
  export type Strip = {
    tick(source: Source): Promise<void>   // resolves without running anything when the source is disabled by settings or unavailable on the platform
    flush(): Promise<void>                // clears blockedUntil, then sends every item whose latest state differs from lastSent
    settled(): Promise<void>              // resolves when start-up ticks and the latest settings change have finished applying
    stop(): void
  }
  export const FAILS_BEFORE_DASH = 3
  export const BATTERY_MS = 30_000
  export const PROCS_MS = 5_000
  export const COMMAND_ID = 'system-strip.openActivityMonitor'
  export function startStrip(orca: OrcaWorkerApi, deps: Deps): Promise<Strip>
  // worker.ts
  export const nodeDeps: Deps
  export default async function activate(orca: OrcaWorkerApi): Promise<void>
  export function deactivate(): void
  ```

Behaviour `startStrip` must implement (the spec's Behaviour section is authoritative):
1. Read settings via `readSettings(await orca.settings.get())`; subscribe `orca.settings.onDidChange` (payload `{ key }`, also fired by the worker's own `settings.set` — verified) → re-read and apply.
2. Start-up: `startStrip` awaits only the five start-up sends — `statusBar.update` for **every** item with all fields `{ id, text, tone, tooltip, visible }`: placeholder text, `tone: 'neutral'`, `tooltip: 'System Strip'`, `visible` from settings (and `false` for gpu/memory/battery when `platform !== 'darwin'`). It then starts one tick of each enabled source without awaiting them (each command may take up to 8 s); `settled()` lets tests wait.
3. Timers: cpu, gpu, memory every `refreshSeconds × 1000`; battery every `BATTERY_MS`; procs every `PROCS_MS` while cpu or memory is shown and platform is darwin; clock via `after(ms to next minute)` then `every(60_000)`. A disabled item's timer is cancelled and it is sent `visible: false`; re-enabling resets that source's failure count, smoother and previous CPU sample, restarts its timer and ticks once immediately. A `refreshSeconds` change restarts the three load timers. A `clock24h` change re-ticks the clock at once.
4. CPU and GPU each have their own `Smoother(SMOOTH_MS)`. CPU's first tick (and first after re-enable) only stores the sample (no text change); later ticks use `cpuPercent`.
5. Failures per source: a rejected `run` or a `null` parse is a failure. Below `FAILS_BEFORE_DASH` consecutive failures keep the last state; at `FAILS_BEFORE_DASH` send `dashItem(id, reason)` with the reason `"<cmd> failed"` (`ioreg failed`, `vm_stat failed`, `pmset failed`). A success resets the count. Memory: only `vm_stat` counts; a `sysctl` failure or a `null` `parsePressure` gives `pressure: null` (`Pressure: unknown`, neutral) and is not a failure. `battery` `{ present: false }` → `visible: false`, not a failure. `procs`: keep the last top apps through failures 1–2; at the third consecutive failure drop the top-apps line from the CPU and Memory tooltips; it never dashes an item.
6. Sending is sequential, item by item. Keep `lastSent` per item; call `statusBar.update` only when text/tone/tooltip/visible differ, and skip sending while `now() < blockedUntil`. On a host error with `code === 'rate_limited'`: `delay = err.retryAfterMs ?? 2000`, `blockedUntil = now() + delay`, stop the batch, and if no flush is scheduled, `after(delay, flush)`. Other host errors are logged with `orca.log` and not retried. Never throws out of a tick.
7. Registers `COMMAND_ID`: on darwin `run('open', ['-a', 'Activity Monitor'])` and return `'Opened Activity Monitor'` (a rejected run returns `'Could not open Activity Monitor'`, never throws); elsewhere return `'Activity Monitor is macOS-only'` without running anything.
8. `stop()` cancels every timer and disposes the `onDidChange` and `commands.register` disposables.

`worker.ts`: `nodeDeps` uses `execFile` per Global Constraints, `os.cpus`, `os.totalmem`, `Date.now`, `setInterval`/`setTimeout` (return cancel functions). `activate` logs `started pid <process.pid>` with `orca.log`, keeps the `Strip` in a module variable; `deactivate` calls `stop()`. Command args: gpu `ioreg -r -d 1 -c IOAccelerator`; memory `vm_stat` + `sysctl -n kern.memorystatus_vm_pressure_level`; battery `pmset -g batt`; procs `ps -Aeo pid=,pcpu=,rss=,comm=`.

- [ ] **Step 1: Write failing worker tests** in `src/strip.worker.test.ts`. A `fakeDeps(outputs: Record<string, string | Error>, platform = 'darwin')` keys `run` by `cmd + ' ' + args.join(' ')` against a **mutable** `outputs` table the test may change between ticks, records `run` calls and timers (`every`/`after` store `{ ms, fn }` without firing), and has a settable clock. Mount with `let api; mountWorker({ default: async (o) => { api = o; strip = await startStrip(o, deps) } }, { host: mockHost({ settings }) })`, then `await strip.settled()` and drive with `await strip.tick(...)`. Change a setting with `await api.settings.set(key, value); await strip.settled()`. Read sends with `host.callsOf('statusBar.update')` (it includes refused calls). GPU output in these tests is the hand-written string `'"model" = "Test GPU"\n"Device Utilization %"=15'` (expected text `GPU 15%`), not the recorded fixture.

```ts
test('start-up sends every item with visible, even with empty settings', …)        // first 5 sends, ids in ITEM_IDS order, each { text: PLACEHOLDER[id], tone: 'neutral', tooltip: 'System Strip', visible: true }
test('switched-off items are hidden and their commands never run', …)              // settings { showGpu: false } → gpu sent visible:false; await strip.tick('gpu') → no 'ioreg' in run calls
test('turning an item back on shows it and polls again', …)                          // api.settings.set('showGpu', true) → a send with gpu visible:true, ioreg runs, text 'GPU 15%'
test('non-darwin hides gpu, memory and battery', …)                                  // platform 'linux'; tick('gpu') runs nothing
test('no battery hides battery, not a failure', …)                                   // pmset-desktop output, three ticks → battery visible:false, never text 'Bat –'
test('a failing source keeps its value, then dashes at the third failure, others untouched', …)  // tick gpu ok → 'GPU 15%'; set outputs[ioreg] = Error; ticks 1–2 → no gpu send; tick 3 → 'GPU –' tooltip 'ioreg failed'; no cpu/memory/battery/clock send caused by it
test('nothing is sent when nothing changed', …)                                      // same outputs, two gpu ticks → one gpu send
test('rate_limited waits retryAfterMs and then sends the latest state', …)          // results 'statusBar.update' throws hostError('rate_limited','',1500) on its first non-start-up call only; tick gpu → an after(1500) scheduled, no second refused call; flush() → a send with 'GPU 15%'
test('memory: sysctl failure is Pressure: unknown, not a dash', …)
test('memory tooltip keeps top apps through two ps failures and drops them at the third', …)
test('clock24h change redraws the clock at once', …)                                  // clock 14:05 → set clock24h false → '2:05 PM' without firing a timer
test('open command: darwin runs open -a, a failed open returns a message, linux runs nothing', …)
```
Write each with concrete assertions on `callsOf` params, using the Task 2–4 fixtures as `run` outputs.

- [ ] **Step 2: Run `orca plugin test .`** — Expected: worker tests FAIL (no `strip.ts`); unit tests still PASS.
- [ ] **Step 3: Implement `src/strip.ts` and `src/worker.ts`.**
- [ ] **Step 4: Run `orca plugin test .` and `npx tsc -p tsconfig.json`** — Expected: all PASS, no type errors.
- [ ] **Step 5: Run `orca plugin validate .`** — Expected: valid; access lists only plugin settings.
- [ ] **Step 6: Commit** — `feat(strip): status bar controller and worker`.

---

### Task 7: README and CI

**Files:** Create `README.md`, `.github/workflows/ci.yml`

- [ ] **Step 1: `README.md`** — sections: what it shows (the five items, with the colour rules table from the spec); **How it runs** — "a trusted worker: Node with your user's access", the exact commands with their intervals (`ioreg`, `vm_stat`, `sysctl`, `pmset`, `ps`, and `open -a "Activity Monitor"` only when clicked), "no network access, no tracking, nothing stored" — this trusted-worker paragraph comes first; then "Orca capability requested: `settings:own` (to read its own settings). As a trusted worker it also runs with your full user access." Never phrase it as "only one permission"; Settings table; install from the Orca plugin directory, or from a local folder for testing — and remove `local.system-strip` before installing from the directory; macOS only for GPU, memory and battery; fan speed and temperature not shown (need `sudo`); Develop (`npm install`, `npm run test:unit`, `orca plugin test .`, `orca plugin validate .`, `orca plugin dev watch .`); License MIT.
- [ ] **Step 2: `.github/workflows/ci.yml`** — `on: [push, pull_request]`, `permissions: contents: read`, one job on `macos-latest`, `timeout-minutes: 10`: `actions/checkout` and `actions/setup-node` pinned to the full commit SHA of each one's latest release (`gh api repos/actions/<repo>/releases/latest` for the tag, then `gh api repos/actions/<repo>/git/ref/tags/<tag>`; if `.object.type` is `"tag"`, dereference with `git/tags/<sha>`), with the version in a trailing comment, `with: persist-credentials: false` on checkout, `node-version: 22`, then `npm ci`, `npm run typecheck`, `npm run test:unit`.
- [ ] **Step 3: Verify locally** — `npm ci && npm run typecheck && npm run test:unit` PASS; `actionlint .github/workflows/ci.yml` if installed (else note it was not run).
- [ ] **Step 4: Commit** — `docs(readme): what it shows, how it runs, how to install` and `ci: unit tests and typecheck on macOS` (two commits).

---

### Task 8: Live check in Orca

No new files unless a defect is found (then fix it in the owning module with a test first).

- [ ] **Step 1: Full local gates** — `orca plugin test .`, `orca plugin validate .`, `npm run typecheck` all pass.
- [ ] **Step 2: Install a clean copy** — export `git archive HEAD` into a stable folder outside the repo that is not purged by the OS (not `mktemp`), then `orca plugin install "<that folder>" --json` → read the access list (must be only plugin settings, trusted worker), then re-run with the printed `--approve` fingerprint. Expected: `orca plugin list` shows `local.system-strip 0.1.0 running`.
- [ ] **Step 3: Look at it** — check `orca plugin logs local.system-strip` is free of errors; confirm the five items show in the bottom bar, the tooltips render (including the multi-line memory tooltip), and clicking CPU opens Activity Monitor. If `\n` does not render as a line break, change the join to ` · ` in `format.ts` and its tests.
- [ ] **Step 4: Settings round-trip** — `orca plugin` Settings: turn GPU off and on; change refresh to 5 s; flip 24-hour clock. Each applies without reloading.
- [ ] **Step 5: Overhead** — read the worker's PID from the `started pid <n>` line in `orca plugin logs local.system-strip`, sample `ps -o pcpu= -p <pid>` every 10 s for 3 minutes at the 2 s and the 1 s settings. Expected: average under 1%. Record the numbers in the final report.
- [ ] **Step 6: Leave it installed.** Publishing (push, `v0.1.0` tag) is a separate step.
