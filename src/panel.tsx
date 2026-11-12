// System Strip settings panel. Orca strips the types and compiles the JSX when it loads: no build step.
// It draws only what the worker sends (src/protocol.ts) and writes settings; every rule lives in the worker.
import { Button, Card, Heading, RadioGroup, Row, Stack, Switch, Text, atom, plugin, read, set, settings, type PanelContext } from 'orca'
import type { Card as CardData, Snapshot } from './protocol.ts'

const snap = atom<Snapshot | null>(null)
const failed = atom(false)
/** Why the last Activity Monitor press did not open it; null after a success. */
const openNote = atom<string | null>(null)

const TITLE = { cpu: 'CPU', gpu: 'GPU', memory: 'Memory', battery: 'Battery' } as const
const SHOW_KEY = { cpu: 'showCpu', gpu: 'showGpu', memory: 'showMemory', battery: 'showBattery' } as const
const STYLE_KEY = { cpu: 'cpuStyle', gpu: 'gpuStyle', memory: 'memoryStyle', battery: 'batteryStyle' } as const
const REFRESH = [
  { value: '1', label: '1 second' },
  { value: '2', label: '2 seconds' },
  { value: '5', label: '5 seconds' }
]

function openActivityMonitor(): void {
  plugin.request('strip.openActivityMonitor').then(
    ({ message }) => set(openNote, message === 'Opened Activity Monitor' ? null : message),
    () => set(openNote, 'Could not reach System Strip')
  )
}

export function setup(ctx: PanelContext): void {
  let posted = false
  ctx.subscriptions.push(
    plugin.on('strip.snapshot', (payload) => {
      posted = true
      set(snap, payload)
    })
  )
  plugin.request('strip.snapshot').then(
    (answer) => {
      // A post that arrived first is newer than this answer.
      if (!posted) set(snap, answer)
    },
    () => set(failed, true)
  )
}

function ItemCard({ card, data }: { card: CardData; data: Snapshot }) {
  const { settings: s } = data
  if (card.id === 'battery' && !data.hasBattery) {
    return (
      <Card title="Battery">
        <Text muted size="sm">
          No battery on this Mac
        </Text>
      </Card>
    )
  }
  const selected = s[STYLE_KEY[card.id]]
  return (
    <Card title={TITLE[card.id]}>
      <Stack gap="sm">
        <Row justify="between">
          <Switch
            key={`${card.id}-show`}
            label={`Show ${card.id === 'cpu' || card.id === 'gpu' ? TITLE[card.id] : TITLE[card.id].toLowerCase()}`}
            checked={s[SHOW_KEY[card.id]]}
            onChange={(on) => settings.set(SHOW_KEY[card.id], on)}
          />
          <Text muted size="sm">
            {card.value ?? '–'}
          </Text>
        </Row>
        <Row gap="xs" wrap>
          {card.samples.map((sample) => (
            <Button
              key={`${card.id}-${sample.style}`}
              size="sm"
              variant={sample.style === selected ? 'solid' : 'outline'}
              tone={sample.style === selected ? 'accent' : undefined}
              icon={sample.icon}
              tooltip={sample.label}
              onPress={() => settings.set(STYLE_KEY[card.id], sample.style)}
            >
              {sample.text}
            </Button>
          ))}
        </Row>
      </Stack>
    </Card>
  )
}

export default function Panel() {
  const data = read(snap)
  if (!data) {
    return (
      <Stack gap="md">
        <Heading>System Strip</Heading>
        <Text muted size="sm">
          {read(failed) ? 'Waiting for System Strip…' : 'Loading…'}
        </Text>
      </Stack>
    )
  }
  const s = data.settings
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>System Strip</Heading>
        <Button key="activity-monitor" size="sm" variant="ghost" icon="open-external" onPress={openActivityMonitor}>
          Activity Monitor
        </Button>
      </Row>
      {read(openNote) ? (
        <Text muted size="xs">
          {read(openNote)}
        </Text>
      ) : null}
      <Stack gap="xs">
        <Text muted size="xs">
          Your bar now
        </Text>
        <Row gap="xs" wrap>
          {data.bar.map((item) => (
            <Button key={`bar-${item.id}`} size="xs" variant="ghost" tone={item.tone} icon={item.icon}>
              {item.text}
            </Button>
          ))}
        </Row>
      </Stack>
      {data.cards.map((card) => (
        <ItemCard key={card.id} card={card} data={data} />
      ))}
      <Card title="Clock">
        <Stack gap="sm">
          <Switch key="clock-show" label="Show clock" checked={s.showClock} onChange={(on) => settings.set('showClock', on)} />
          <Row gap="xs">
            <Button key="clock-24" size="sm" variant={s.clock24h ? 'solid' : 'outline'} tone={s.clock24h ? 'accent' : undefined} tooltip="24-hour" onPress={() => settings.set('clock24h', true)}>
              {data.clock.h24}
            </Button>
            <Button key="clock-12" size="sm" variant={s.clock24h ? 'outline' : 'solid'} tone={s.clock24h ? undefined : 'accent'} tooltip="12-hour" onPress={() => settings.set('clock24h', false)}>
              {data.clock.h12}
            </Button>
          </Row>
        </Stack>
      </Card>
      <Stack gap="xs">
        <RadioGroup
          key="refresh"
          label="Refresh every"
          orientation="horizontal"
          value={String(s.refreshSeconds)}
          options={REFRESH}
          onChange={(v) => settings.set('refreshSeconds', Number(v))}
        />
        <Text muted size="xs">
          GPU updates no faster than every 4 seconds.
        </Text>
      </Stack>
    </Stack>
  )
}
