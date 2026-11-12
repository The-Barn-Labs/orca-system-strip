# Item styles and settings panel: implementation plan

**Goal:** Each of CPU, GPU, memory and battery gets a chosen style (words, number, bar, trend,
level), and a System Strip panel in Orca's right sidebar sets every option with live samples.

**Architecture:** A new pure module `src/styles.ts` turns a percentage (and, for trend, a short
history) into item text. `format.ts` builds each item with its style and icon. `strip.ts` keeps
the history, redraws an item when its style changes, and answers the panel: the worker computes
every sample, so the panel (`src/panel.tsx`) only renders what the worker sends and writes settings.

**Tech stack:** TypeScript run by Orca with no build step; Orca components panel (`"ui": "components"`);
`node --test` for unit tests; `orca/testing` (`mountWorker`, `mount`, `mockHost`, `defineCheck`).

**Spec:** [design-styles-panel.md](design-styles-panel.md), building on [design.md](design.md).

## Global constraints

- Orca capability stays exactly `settings:own`. No new commands run on the Mac; no interval gets shorter.
- Every style of CPU, GPU, memory and battery shows an icon; the clock never has one.
  Icons: cpu `activity`, gpu `gauge`, memory `layers`, battery `plug` on power, `zap` on battery.
- Numbers are padded with figure spaces (U+2007) to two digits plus `%`; `100%` is one wider.
- Bar: 5 cells, filled `▰` = `round(p / 20)` clamped 0–5, rest `▱`, no number.
- Level: one of `▁▂▃▄▅▆▇█`, index `min(7, floor(p / 12.5))`, then the number.
- Trend: 6 slots, oldest first, same 8 glyphs, missing older slots are figure spaces, then a space and the number. CPU and GPU only.
- Words: `CPU`, `GPU`, `Mem`, `Bat`, a space, the number. The trailing `⚡` is gone in every style.
- Defaults: `number` for all four. Settings keys `cpuStyle`, `gpuStyle`, `memoryStyle`, `batteryStyle`.
- Tooltips ≤ 256 characters, item text ≤ 64.
- A hidden item is never polled, its trend history is empty when it comes back, and opening the panel starts no polling.
- Clicking a bar item still opens Activity Monitor.
- Commit messages describe the change only. No `--no-verify`.

## Review focus

1. **Settings holding an unknown or wrong-item style** (`memoryStyle: 'trend'`, `cpuStyle: 7`, from an old or hand-edited file): fall back to `number` for that item; never crash or send an empty text. Test in Task 2.
2. **Values outside 0–100** (CPU rounding to 101, a negative value, NaN from a bad reading): bar, level and trend clamp, and nothing throws. Test in Task 1.
3. **A style change while the item is dashed** (three failures): the dash stays, in the new style's dash form, until a reading succeeds. Test in Task 4.
4. **The panel opened before the first reading, or on a Mac without a battery:** cards show `–` or "No battery on this Mac", with no errors. Test in Task 6.
5. **Long app names in hover text:** every tooltip is cut to 256 characters, ending in `…`. Test in Task 3.

---

### Task 1: Style rendering (`src/styles.ts`)

**Files:** Create `src/styles.ts`, `src/styles.unit.test.ts`. Modify `tsconfig.ci.json` (add `src/styles.ts`).

**Interfaces — produces:**
```ts
export type Style = 'words' | 'number' | 'bar' | 'trend' | 'level'
export type StyledId = 'cpu' | 'gpu' | 'memory' | 'battery'
export const STYLES: Record<StyledId, readonly Style[]>   // cpu, gpu: all 5; memory, battery: no 'trend'
export const LABEL: Record<StyledId, string>               // CPU, GPU, Mem, Bat
export const TREND_LENGTH = 6
export function num(p: number): string                      // figure-space padded, rounded, clamped 0–100
export function bar(p: number): string
export function level(p: number): string
export function trend(history: readonly number[]): string  // last TREND_LENGTH values, padded on the left
export function styledText(id: StyledId, style: Style, p: number, history: readonly number[]): string
export function dashText(id: StyledId, style: Style): string // words → 'CPU –'; others → '–'
export type IconName = 'activity' | 'gauge' | 'layers' | 'plug' | 'zap'
export const ICON: Record<StyledId, IconName>               // cpu activity, gpu gauge, memory layers, battery zap
export function batteryIcon(onPower: boolean): IconName      // plug on power, zap on battery
export const STYLE_LABEL: Record<Style, string>             // the five enumLabels of Task 2, same wording
```

- [ ] **Step 1: Write the failing tests** in `src/styles.unit.test.ts`:
```ts
const F = ' '
test('num pads with a figure space and clamps', () =>
  assert.deepEqual([4, 34, 100, 100.4, 101, -3, NaN].map(num), [`${F}4%`, '34%', '100%', '100%', '100%', `${F}0%`, `${F}0%`]))
test('bar has five cells of 20%', () =>
  assert.deepEqual([0, 9, 10, 34, 50, 85, 90, 140].map(bar), ['▱▱▱▱▱', '▱▱▱▱▱', '▰▱▱▱▱', '▰▰▱▱▱', '▰▰▰▱▱', '▰▰▰▰▱', '▰▰▰▰▰', '▰▰▰▰▰']))
test('level has eight steps', () =>
  assert.deepEqual([0, 12.4, 12.5, 34, 87.5, 100, -1].map(level), ['▁', '▁', '▂', '▃', '█', '█', '▁']))
test('trend keeps the last six, oldest first, padded on the left', () => {
  assert.equal(trend([]), F.repeat(6))
  assert.equal(trend([10, 90]), F.repeat(4) + '▁█')
  assert.equal(trend([0, 10, 20, 30, 40, 50, 60, 70]), '▂▃▄▅▅▆')
})
test('styledText per style', () => {
  assert.equal(styledText('cpu', 'words', 34, []), 'CPU 34%')
  assert.equal(styledText('memory', 'number', 7, []), `${F}7%`)
  assert.equal(styledText('gpu', 'bar', 34, []), '▰▰▱▱▱')
  assert.equal(styledText('cpu', 'trend', 34, [10, 34]), F.repeat(4) + '▁▃ 34%')
  assert.equal(styledText('battery', 'level', 87, []), '▇87%')
})
test('every styled text fits Orca\'s 64-character limit', () => {
  for (const id of Object.keys(STYLES) as StyledId[])
    for (const s of STYLES[id]) assert.ok(styledText(id, s, 100, Array(20).fill(100)).length <= 64)
})
test('dashText', () => {
  assert.equal(dashText('cpu', 'words'), 'CPU –')
  assert.equal(dashText('cpu', 'bar'), '–')
})
test('only cpu and gpu offer trend', () => {
  assert.ok(STYLES.cpu.includes('trend') && STYLES.gpu.includes('trend'))
  assert.ok(!STYLES.memory.includes('trend') && !STYLES.battery.includes('trend'))
})
```
- [ ] **Step 2:** `node --test src/styles.unit.test.ts` → FAIL: cannot find module `./styles.ts`.
- [ ] **Step 3: Implement** `src/styles.ts`. Clamp with `Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0` before every rule. `styledText` with `style` not in `STYLES[id]` renders as `number`.
- [ ] **Step 4:** `node --test src/styles.unit.test.ts && npm run typecheck` → all pass.
- [ ] **Step 5: Commit** `feat(styles): text for the words, number, bar, trend and level styles`.

### Task 2: Style settings and manifest

**Files:** Modify `src/settings.ts`, `src/settings.unit.test.ts`, `orca-plugin.json`.

**Interfaces:** Consumes `Style`, `StyledId`, `STYLES` (Task 1). Produces `Settings` with
`cpuStyle`, `gpuStyle`, `memoryStyle`, `batteryStyle: Style`, and `export const STYLE_KEY: Record<StyledId, 'cpuStyle' | 'gpuStyle' | 'memoryStyle' | 'batteryStyle'>`.

- [ ] **Step 1: Failing tests:**
```ts
test('styles default to number', () => {
  const s = readSettings({})
  assert.deepEqual([s.cpuStyle, s.gpuStyle, s.memoryStyle, s.batteryStyle], ['number', 'number', 'number', 'number'])
})
test('a valid style is kept', () => assert.equal(readSettings({ cpuStyle: 'trend' }).cpuStyle, 'trend'))
test('a style the item does not offer falls back to number', () => {
  const s = readSettings({ memoryStyle: 'trend', batteryStyle: 'sparkle', gpuStyle: 7 })
  assert.deepEqual([s.memoryStyle, s.batteryStyle, s.gpuStyle], ['number', 'number', 'number'])
})
```
test('style labels in the manifest match STYLE_LABEL', () => {
  /* read orca-plugin.json with readFileSync; for each *Style setting, enumLabels deep-equals enum.map(v => STYLE_LABEL[v]) */
})
```
Also add the four `*Style: 'number'` keys to the existing full `DEFAULTS` literal in `settings.unit.test.ts:7-8`.
- [ ] **Step 2:** `npm run test:unit` → the new tests FAIL.
- [ ] **Step 3: Implement.** Validate each key against `STYLES[id]`. In `orca-plugin.json`:
  - Add four settings after `showClock`: `type: "string"`, `enum` = that item's `STYLES` in the order words, number, bar, trend, level; `enumLabels` = the matching subset of "Words and number", "Icon and number", "Bar", "Trend and number", "Level and number" (memory and battery have four: no "Trend and number"); `default: "number"`. Titles: "CPU style", "GPU style", "Memory style", "Battery style".
  - Battery status bar item: add `"icon": "zap"`. Placeholder texts in the manifest become `–` for cpu, gpu, memory and battery, since the default style is `number`.
- [ ] **Step 4:** `npm run test:unit && npm run typecheck && orca plugin validate .` → pass, validate `ok`.
- [ ] **Step 5: Commit** `feat(settings): a style setting per item`.

### Task 3: Items built with their style

**Files:** Modify `src/format.ts`, `src/format.unit.test.ts`, `src/strip.ts` (call sites only), `src/strip.worker.test.ts` (existing expectations only).

**Interfaces:**
- Consumes Tasks 1–2.
- Produces:
  - `ItemState` gains `icon?: IconName` (from `styles.ts`).
  - New signatures: `cpuItem(percent, smoothed, top, style: Style, history: readonly number[])`, `gpuItem(r, smoothed, style, history)`, `memoryItem(used, totalBytes, pressure, top, style)`, `batteryItem(b, style)`, `dashItem(id, reason, style: Style)` (the clock ignores the style), and `placeholderItem(id: ItemId, style: Style): { text: string; icon?: IconName }` (the battery placeholder uses `zap`, the clock `--:--` with no icon).
  - `export const TOOLTIP_MAX = 256`.
  - `pct` is removed in favour of `num`. `PLACEHOLDER` is removed in favour of `placeholderItem`.
- **Keeps the plugin working at this commit:** `strip.ts` passes `settings[STYLE_KEY[id]]` at every builder call (strip.ts:116, 158, 171, 176, 202, 219) and `[]` as history (Task 4 adds the real one). The worker test helper `mount()` defaults its settings to `{ cpuStyle: 'words', gpuStyle: 'words', memoryStyle: 'words', batteryStyle: 'words' }` merged under `options.settings`, so existing text expectations keep their meaning.
- **Existing tests whose expected objects gain `icon` (or swap `PLACEHOLDER` for `placeholderItem(id, 'words')`):** format.unit.test.ts:54, 69, 73-85, 89-95, 108, 123; strip.worker.test.ts:6, 111-114, 271, 318. The battery words text loses its `⚡`.

- [ ] **Step 1: Failing tests** (replace the `pct pads` test and every text expectation that assumed words):
```ts
test('cpu number style has the activity icon', () => {
  const s = cpuItem(34, 34, null, 'number', [])
  assert.deepEqual([s.text, s.icon], ['34%', 'activity'])
})
test('battery icon is plug on power and zap on battery, never a trailing ⚡', () => {
  assert.deepEqual(pick(batteryItem(onPower87, 'words')), ['Bat 87%', 'plug'])
  assert.deepEqual(pick(batteryItem(discharging40, 'number')), ['40%', 'zap'])
})
test('dash follows the style', () => {
  assert.equal(dashItem('gpu', 'ioreg failed', 'words').text, 'GPU –')
  assert.equal(dashItem('gpu', 'ioreg failed', 'bar').text, '–')
  assert.equal(dashItem('gpu', 'ioreg failed', 'bar').icon, 'gauge')
})
test('tooltips are cut to 256 characters', () => {
  const top = Array.from({ length: 3 }, (_, i) => ({ name: 'A'.repeat(120) + i, value: 2 ** 30 }))
  const t = memoryItem({ usedBytes: 2 ** 34, percent: 50 }, 2 ** 35, 'normal', top, 'number').tooltip
  assert.equal(t.length, 256)
  assert.ok(t.endsWith('…'))
})
```
(`pick(s) = [s.text, s.icon]`; `onPower87` and `discharging40` are battery readings built from existing fixtures or literals.)
- [ ] **Step 2:** `npm run test:unit` → new tests FAIL.
- [ ] **Step 3: Implement.** Each builder uses `styledText` and sets `icon`. `dashItem` uses `dashText` plus the icon. A tooltip longer than `TOOLTIP_MAX` keeps its first 255 characters and adds `…`.
- [ ] **Step 4:** `npm run test:unit && npm run typecheck && npx tsc -p . && orca plugin test .` → all pass.
- [ ] **Step 5: Commit** `feat(format): items drawn in their chosen style with an icon`.

### Task 4: The strip applies styles

**Files:** Modify `src/strip.ts`, `src/strip.worker.test.ts`.

**Interfaces:**
- Consumes Tasks 1–3.
- Produces, inside `startStrip`:
  - `cpuHistory: number[]` and `gpuHistory: number[]`: raw percents, capped at `TREND_LENGTH`.
  - Last readings kept for redraw: `gpuLast: GpuReading | null` and `batteryLast: BatteryReading | null`.
  - `reset(source)` clears that source's history and every last-reading field it owns (`cpuLast`, `gpuLast`, `memoryLast`, `batteryLast`), so a re-enabled item never redraws from a stale reading.
  - `same()` compares `icon` too.

- [ ] **Step 1: Failing tests** in `src/strip.worker.test.ts`. The `mount` settings type widens to `Record<string, boolean | number | string>`. `fakeDeps` gains a `cpusCalls` counter, incremented by `cpus()`.
```ts
test('default style sends icon and number', async () => { /* after first ticks: last('cpu') has icon 'activity' and text matching /^[ \d]{2,3}%$/ */ })
test('changing a style redraws that item at once, without a new reading', async () => {
  /* host settings change cpuStyle → 'bar'; await strip.settled(); last('cpu').text matches /^[▰▱]{5}$/;
     deps.cpusCalls is unchanged by the change */
})
test('trend shows up to six readings and restarts empty after the item is switched off and on', async () => { /* … */ })
test('a style change while dashed keeps the dash in the new form', async () => {
  /* gpu fails 3 times → last('gpu').text 'GPU –' with gpuStyle 'words'; change to 'bar' → text '–'; next good reading → bar */
})
test('battery icon switches between plug and zap with power', async () => { /* … */ })
```
- [ ] **Step 2:** `orca plugin test .` → new tests FAIL.
- [ ] **Step 3: Implement.**
  - On each reading, push to the history, then build the item with `settings[STYLE_KEY[id]]`.
  - In `apply()`, for each styled id whose style changed and which is shown: redraw it from its last reading. If there is no reading yet, or it is dashed (`fails ≥ FAILS_BEFORE_DASH`), redraw the placeholder or dash in the new style.
  - `placeholder()` uses `placeholderItem` with the current style (text and icon).
- [ ] **Step 4:** `orca plugin test . && npx tsc -p . && npm run typecheck` → all pass.
- [ ] **Step 5: Commit** `feat(strip): apply each item's style, keep trend history, redraw on style change`.

### Task 5: Worker answers the panel

**Files:** Create `src/protocol.ts`. Modify `src/strip.ts`, `src/strip.worker.test.ts`.

**Interfaces — produces (`src/protocol.ts`, declared into `orca` like the scaffold's protocol):**
```ts
type Sample = { style: Style; label: string; text: string; icon: IconName }  // label = STYLE_LABEL[style]
type Card = { id: StyledId; shown: boolean; value: string | null; samples: Sample[] }
type Snapshot = {
  settings: Settings                                                // readSettings() as the worker holds it
  bar: { id: ItemId; text: string; icon?: IconName; tone: Tone }[]   // shown items only, in bar order
  cards: Card[]                                                     // cpu, gpu, memory, battery; battery has no samples when hasBattery is false
  clock: { h24: string; h12: string }
  hasBattery: boolean                                               // batteryLast?.present !== false (true until a reading says otherwise)
}
// PluginRequests: 'strip.snapshot': { output: Snapshot }; 'strip.openActivityMonitor': { output: { message: string } }
// PluginPanelEvents: 'strip.snapshot': Snapshot
```
- `value` is `num(p)` from the last reading, and `null` when the item is hidden, has no reading yet, or is dashed.
- The samples cover every style in `STYLES[id]`, drawn from that last reading and history.
- With `value === null`, each sample is that style's dash text with the item's icon.

- [ ] **Step 1: Failing tests** (`worker.request` and `worker.posts` from `mountWorker`):
```ts
test('snapshot has a card per item with a sample per offered style', async () => {
  /* request 'strip.snapshot' → cards ids ['cpu','gpu','memory','battery'];
     cards[cpu].samples.map(s => s.style) deep-equals STYLES.cpu; memory has no 'trend' */
})
test('a hidden item has value null and dash samples, and is not polled for the panel', async () => {
  /* showGpu false → card gpu shown false, value null; ioreg never ran */
})
test('each send posts a fresh snapshot', async () => { /* after a cpu tick, worker.posts.at(-1).event === 'strip.snapshot' */ })
test('openActivityMonitor request runs open -a "Activity Monitor"', async () => { /* … */ })
test('no battery: hasBattery false and no battery card', async () => { /* … */ })
```
- [ ] **Step 2:** `orca plugin test .` → FAIL: `unknown_method`.
- [ ] **Step 3: Implement.**
  - In `startStrip`, register `orca.panels.handle('strip.snapshot', …)` and `orca.panels.handle('strip.openActivityMonitor', …)`, sharing one `openActivityMonitor()` with the command. Push both returned Disposables onto `disposables`.
  - At the end of every `tick()` and `apply()`, build `snapshot()`. Post it with `orca.panels.post('strip.snapshot', …)` only when its JSON differs from the last one posted. This doesn't depend on status-bar sends, so a rate-limited status bar doesn't freeze the panel.
  - Add a test: a posted snapshot still arrives while `statusBar.update` answers `rate_limited`.
- [ ] **Step 4:** `orca plugin test . && npx tsc -p .` → pass.
- [ ] **Step 5: Commit** `feat(strip): snapshot and Activity Monitor requests for the panel`.

### Task 6: The System Strip panel

**Files:** Create `src/panel.tsx`, `src/panel.test.tsx`, `src/panel.check.ts`. Modify `orca-plugin.json`.

**Interfaces:**
- Consumes the Task 5 protocol (type-only imports) and `settings.set` from `orca`. The panel reads settings only from `snapshot.settings`, which the worker has already validated with `readSettings`. The worker posts a new snapshot after every settings change, so the panel needs no `settings.get` or `onDidChange` and imports no plugin module at runtime.
- Every control has a `key` that the tests query as `testId`: `${id}-show`, `${id}-${style}`, `clock-show`, `clock-24`, `clock-12`, `refresh`, `activity-monitor`. Switch labels are distinct too ("Show CPU", "Show GPU", …).
- Manifest: `contributes.panels: [{ "id": "system-strip", "title": "System Strip", "icon": "gauge", "entry": "src/panel.tsx", "ui": "components" }]`.

Layout, top to bottom:
1. **Header row:** a `Heading` "System Strip" and a `Button` "Activity Monitor" with icon `open-external`.
2. **"Your bar now":** a `Row` of the snapshot's `bar` entries. Each is a non-pressing `Button`, variant `ghost`, with the item's `icon`, its `tone`, and its text.
3. **A `Card` per `cards` entry,** titled CPU, GPU, Memory or Battery. Each holds:
   - a `Switch` labelled "Show" bound to the item's `show*` setting;
   - a `Text` showing `value ?? '–'`;
   - a `Row` with one `Button` per sample (`icon` = sample icon, label = sample text, `tooltip` = the style's label from the manifest). The selected style is `variant="solid"` and the others `outline`; pressing one calls `settings.set(STYLE_KEY[id], style)`.
4. **When `hasBattery` is false:** the Battery card holds only a muted `Text` "No battery on this Mac", with no switch and no samples.
5. **A Clock card:**
   - a Show switch;
   - two sample `Button`s, `clock.h24` and `clock.h12`, that set `clock24h`.
6. **A Refresh `RadioGroup`** (1, 2, 5 seconds) with the note "GPU updates no faster than every 4 seconds."
   - Its option values are strings: `value={String(settings.refreshSeconds)}`.
   - `onChange` calls `settings.set('refreshSeconds', Number(v))`, because the setting is declared `integer`.

`setup()`:
- subscribes to the `strip.snapshot` post first, then requests `strip.snapshot`;
- keeps the snapshot in an atom;
- ignores the request's answer if a post has already arrived;
- catches a rejected request (`unavailable` or `timeout`) and shows a muted "Waiting for System Strip…" until a snapshot arrives.

- [ ] **Step 1: Failing tests** with `mount(panel, { host })`. The host's `requests` answer a fixed `Snapshot`, and its `settings` start empty:
```ts
test('shows a card per item and highlights the selected style', /* testId 'cpu-number' is variant solid, 'cpu-bar' outline */)
test('pressing a sample writes that item\'s style', /* press testId 'gpu-bar' → host.data().settings.gpuStyle === 'bar' */)
test('the Show switch writes showMemory', /* toggle testId 'memory-show' → showMemory false */)
test('refresh writes a number', /* select '5' in testId 'refresh' → host.data().settings.refreshSeconds === 5 (a number) */)
test('a posted snapshot updates the samples', /* view.post('strip.snapshot', next) → new text visible */)
test('a failed first request shows waiting, then the posted snapshot', /* request rejects with 'timeout' → 'Waiting for System Strip…'; then view.post → cards shown */)
test('without a battery the card says so', /* hasBattery false → 'No battery on this Mac'; no testId 'battery-number' */)
```
Each test ends with `assert.deepEqual(view.errors, [])` and `assert.deepEqual(view.refusals, [])`.
- [ ] **Step 2:** `orca plugin test .` → panel tests FAIL (module missing).
- [ ] **Step 3: Implement** `src/panel.tsx`. In `src/panel.check.ts`, add scenarios `fresh: {}`, `styled: { settings: { cpuStyle: 'trend', gpuStyle: 'bar', memoryStyle: 'level' } }` and `minimal: { settings: { showGpu: false, showBattery: false } }`.
- [ ] **Step 4:** `orca plugin test . && orca plugin check . && orca plugin validate . && npx tsc -p .` → all pass; `check` renders every scenario with no errors.
- [ ] **Step 5: Commit** `feat(panel): System Strip settings panel with live style samples`.

### Task 7: Check in Orca, docs, gates

**Files:** Modify `README.md`, and `docs/design-styles-panel.md` only if a glyph is replaced.

- [ ] **Step 1: Load into Orca.** Update the installed folder copy (git-archive export, as before) and approve it. Then check each of the following and write down what you see:
  1. `orca plugin shot` of the panel.
  2. In the status bar, every style of every item: do `▰▱` and `▁…█` render, with even widths?
  3. Does an item keep its position when its number changes from one digit to two?
  4. Is every tooltip readable?
- [ ] **Step 2: If a glyph set renders badly,** pick replacements, update the constants and their tests in Task 1's file, and update the design's table. Commit `fix(styles): …`.
- [ ] **Step 3: README.**
  - Change "What it shows" to the five styles, each with an example.
  - Add a "Settings panel" section: open it from the System Strip icon in the right sidebar.
  - Note that Orca's compact status bar shows icons only.
  - Change the Node line to "Node 22.18 or newer".
- [ ] **Step 4: Gates.** Run `npm run test:unit`, `npm run typecheck`, `npx tsc -p .`, `orca plugin test .`, `orca plugin check .`, `orca plugin validate .` and `actionlint`. All must pass.
- [ ] **Step 5: Commit** `docs(readme): styles and the settings panel`.
