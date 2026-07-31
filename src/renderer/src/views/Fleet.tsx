import React, { useState } from 'react'
import { useApp } from '../state'
import { ConfirmPhrase, Empty, Field, Panel, Spinner } from '../components/ui'
import { BANDWIDTHS, rssiOf, rssiTone, stationsOf } from '../lib/format'
import type { ApplyResult, BulkOutcome, ServiceName, UciChange } from '@shared/types'

type PresetId = 'channel' | 'bandwidth' | 'txpower' | 'distance' | 'meshkey' | 'meshid' | 'custom'

interface Preset {
  id: PresetId
  label: string
  hint: string
  /** Build the UCI change for a given PHY. */
  build: (value: string, phy: string) => UciChange[]
  commit: string[]
  restart: ServiceName[]
  placeholder?: string
}

const PRESETS: Preset[] = [
  {
    id: 'channel',
    label: 'Channel',
    hint: 'Sets wireless.radioN.channel on every selected radio. All nodes must land on the same channel to stay linked.',
    build: (v, phy) => [{ path: `wireless.radio${phy}.channel`, value: v }],
    commit: ['wireless'],
    restart: ['wireless'],
    placeholder: '8'
  },
  {
    id: 'bandwidth',
    label: 'Channel bandwidth',
    hint: 'Sets wireless.radioN.chanbw. Mismatched widths will not link.',
    build: (v, phy) => [{ path: `wireless.radio${phy}.chanbw`, value: v }],
    commit: ['wireless'],
    restart: ['wireless'],
    placeholder: '20'
  },
  {
    id: 'txpower',
    label: 'TX power',
    hint: 'Sets wireless.radioN.txpower — a number in dBm, or "auto".',
    build: (v, phy) => [{ path: `wireless.radio${phy}.txpower`, value: v }],
    commit: ['wireless'],
    restart: ['wireless'],
    placeholder: 'auto'
  },
  {
    id: 'distance',
    label: 'Operating distance',
    hint: 'Sets wireless.radioN.distance in metres, which drives the ACK timeout.',
    build: (v, phy) => [{ path: `wireless.radio${phy}.distance`, value: v }],
    commit: ['wireless'],
    restart: ['wireless'],
    placeholder: '5000'
  },
  {
    id: 'meshid',
    label: 'Mesh ID',
    hint: 'Sets wireless.wifiN.mesh_id. Every node in one mesh must match.',
    build: (v, phy) => [{ path: `wireless.wifi${phy}.mesh_id`, value: v }],
    commit: ['wireless'],
    restart: ['wireless']
  },
  {
    id: 'meshkey',
    label: 'Encryption key',
    hint: 'Sets wireless.wifiN.key. Push to the whole mesh at once — a partial change splits the network.',
    build: (v, phy) => [{ path: `wireless.wifi${phy}.key`, value: v }],
    commit: ['wireless'],
    restart: ['wireless']
  },
  {
    id: 'custom',
    label: 'Custom UCI option',
    hint: 'Enter a full assignment, e.g. diffserv.@general[0].low_latency=1',
    build: (v) => {
      const eq = v.indexOf('=')
      if (eq <= 0) return []
      return [{ path: v.slice(0, eq).trim(), value: v.slice(eq + 1).trim() }]
    },
    commit: [],
    restart: [],
    placeholder: 'diffserv.@general[0].low_latency=1'
  }
]

export function Fleet(): React.JSX.Element {
  const { radios, statuses, selectedIds, notify, setSelected } = useApp()
  const [preset, setPreset] = useState<Preset>(PRESETS[0])
  const [value, setValue] = useState('')
  const [restartAfter, setRestartAfter] = useState<ServiceName | 'none'>('wireless')
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<BulkOutcome<ApplyResult>[]>([])
  const [confirm, setConfirm] = useState(false)

  const selected = radios.filter((r) => selectedIds.includes(r.id))

  const doApply = async (): Promise<void> => {
    setConfirm(false)
    if (!selected.length || !value.trim()) return
    setBusy(true)
    setOutcomes([])

    // Each radio resolves its own PHY, so dual-radio units are handled correctly.
    const results: BulkOutcome<ApplyResult>[] = []
    for (const r of selected) {
      const snap = await window.api.radio.snapshot(r.id).catch(() => null)
      const phy = snap?.phy ?? '0'
      const changes = preset.build(value.trim(), phy)
      if (!changes.length) {
        results.push({
          radioId: r.id,
          host: r.host,
          ok: false,
          error: 'Could not parse the value into a UCI assignment',
          durationMs: 0
        })
        continue
      }
      const commit =
        preset.commit.length > 0 ? preset.commit : [changes[0].path.split('.')[0]]
      const restart: ServiceName[] = restartAfter === 'none' ? [] : [restartAfter]
      const started = Date.now()
      try {
        const res = await window.api.uci.apply(r.id, { changes, commit, restart })
        results.push({
          radioId: r.id,
          host: r.host,
          ok: res.ok,
          value: res,
          durationMs: Date.now() - started
        })
      } catch (err) {
        results.push({
          radioId: r.id,
          host: r.host,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started
        })
      }
      setOutcomes([...results])
    }

    setBusy(false)
    const okCount = results.filter((r) => r.ok).length
    notify(
      okCount === results.length ? 'ok' : 'warn',
      `Applied to ${okCount} of ${results.length} radios`,
      okCount === results.length ? undefined : 'Check the results table for failures'
    )
  }

  if (radios.length === 0) {
    return <Empty title="No radios">Add radios from the sidebar to use fleet operations.</Empty>
  }

  return (
    <>
      <Panel
        title="Selection"
        note={`${selected.length} of ${radios.length} radios ticked`}
        actions={
          <>
            <button className="btn sm" onClick={() => setSelected(radios.map((r) => r.id))}>
              Select all
            </button>
            <button className="btn sm ghost" onClick={() => setSelected([])} disabled={!selected.length}>
              Clear
            </button>
          </>
        }
        tight
      >
        {selected.length === 0 ? (
          <Empty title="Nothing selected">
            Tick the checkbox next to radios in the sidebar to include them.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Radio</th>
                <th>Address</th>
                <th>State</th>
                <th>Band</th>
                <th>Firmware</th>
                <th>Peers</th>
                <th className="num">Best RSSI</th>
              </tr>
            </thead>
            <tbody>
              {selected.map((r) => {
                const st = statuses[r.id]
                const stations = stationsOf(st?.link)
                const best = stations.length
                  ? Math.max(...stations.map((s) => rssiOf(s) ?? -120))
                  : undefined
                return (
                  <tr key={r.id}>
                    <td>{r.name || r.host}</td>
                    <td className="mono">{r.host}</td>
                    <td>
                      <span className={`badge ${st?.state === 'online' ? 'ok' : st?.state === 'auth-error' ? 'err' : ''}`}>
                        {st?.state ?? 'unknown'}
                      </span>
                    </td>
                    <td className="mono">{st?.board?.sub_model ?? '—'}</td>
                    <td className="mono">{st?.board?.release?.version ?? '—'}</td>
                    <td className="num">{stations.length || '—'}</td>
                    <td className="num" style={{ color: `var(--${rssiTone(best) ?? 'text'})` }}>
                      {best != null && best > -120 ? best : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Apply a setting to every selected radio">
        <div className="callout warn">
          Fleet changes are applied one radio at a time, each with its own commit and service
          restart. A wireless parameter that differs between nodes will break the link, so push
          channel, bandwidth, mesh ID and key changes to <b>all</b> nodes together.
        </div>

        <div className="grid c3">
          <Field label="Setting">
            <select
              className="select"
              value={preset.id}
              onChange={(e) => {
                setPreset(PRESETS.find((p) => p.id === e.target.value) ?? PRESETS[0])
                setValue('')
              }}
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Value">
            {preset.id === 'bandwidth' ? (
              <select className="select" value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">Select…</option>
                {BANDWIDTHS.map((b) => (
                  <option key={b} value={b}>
                    {b} MHz
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input mono"
                value={value}
                placeholder={preset.placeholder}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </Field>

          <Field label="Restart after commit">
            <select
              className="select"
              value={restartAfter}
              onChange={(e) => setRestartAfter(e.target.value as ServiceName | 'none')}
            >
              <option value="wireless">wireless</option>
              <option value="network">network (also restarts wireless)</option>
              <option value="diffserv">diffserv</option>
              <option value="firewall">firewall</option>
              <option value="none">none (applies at next reboot)</option>
            </select>
          </Field>
        </div>

        <div className="hint" style={{ marginBottom: 12 }}>{preset.hint}</div>

        <div className="row end">
          <button
            className="btn primary"
            disabled={!selected.length || !value.trim() || busy}
            onClick={() => setConfirm(true)}
          >
            {busy && <Spinner />}
            Apply to {selected.length} radio{selected.length === 1 ? '' : 's'}
          </button>
        </div>
      </Panel>

      {outcomes.length > 0 && (
        <Panel title="Results" note={`${outcomes.filter((o) => o.ok).length}/${outcomes.length} succeeded`} tight>
          <table className="table">
            <thead>
              <tr>
                <th>Radio</th>
                <th>Result</th>
                <th>Detail</th>
                <th className="num">Time</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.map((o) => {
                const failing = o.value?.steps.find((s) => !s.ok)
                return (
                  <tr key={o.radioId}>
                    <td className="mono">{o.host}</td>
                    <td>
                      <span className={`badge ${o.ok ? 'ok' : 'err'}`}>{o.ok ? 'applied' : 'failed'}</span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                      {o.error ??
                        (failing
                          ? `${failing.label}: ${failing.stderr ?? failing.stdout ?? `exit ${failing.code}`}`
                          : (o.value?.steps.map((s) => s.label).join(' → ') ?? ''))}
                    </td>
                    <td className="num">{o.durationMs} ms</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Panel>
      )}

      <NetworkWidePanel />

      {confirm && (
        <ConfirmPhrase
          title="Apply to the whole selection?"
          phrase="APPLY"
          onCancel={() => setConfirm(false)}
          onConfirm={doApply}
          body={
            <>
              <p style={{ marginTop: 0 }}>
                About to set <code>{preset.label}</code> to <code>{value}</code> on{' '}
                <b>{selected.length}</b> radio{selected.length === 1 ? '' : 's'}, then commit and
                restart <code>{restartAfter}</code>.
              </p>
              <div className="callout warn">
                Links will drop briefly on every affected radio. If a node does not receive the
                change it may be left stranded on the old setting.
              </div>
            </>
          }
        />
      )}
    </>
  )
}

/**
 * The coordinated channel switch: the radio announces the change across the mesh so every node
 * moves together, instead of stranding nodes one at a time.
 */
function NetworkWidePanel(): React.JSX.Element {
  const { radios, statuses, activeId, notify, guard } = useApp()
  const [model, setModel] = useState('')
  const [frequency, setFrequency] = useState('')
  const [bandwidth, setBandwidth] = useState('20')
  const [count, setCount] = useState('3')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)

  const active = radios.find((r) => r.id === activeId)
  const activeStatus = activeId ? statuses[activeId] : undefined
  const detectedModel = activeStatus?.board?.sub_model ?? ''

  const run = async (): Promise<void> => {
    setConfirm(false)
    if (!active) return
    setBusy(true)
    const res = await guard('Network-wide switch failed', async () =>
      window.api.wireless.networkWideChannel(active.id, {
        model: model || detectedModel,
        frequency: Number(frequency),
        bandwidth,
        count: Number(count) || 3
      })
    )
    setBusy(false)
    if (res !== undefined) {
      notify(
        'ok',
        'Channel switch announced',
        `Every node hearing ${active.name || active.host} should move to ${frequency} MHz.`
      )
    }
  }

  const ready = Boolean(active && frequency && (model || detectedModel))

  return (
    <Panel title="Network-wide channel switch" note="ubus message-system chswitch">
      <div className="callout info">
        Sent to one radio, which propagates it across the mesh so all nodes hop together. This is
        the safe way to change channel on a live network — unlike setting each radio individually,
        which strands nodes as they move one by one.
      </div>

      <div className="grid c4">
        <Field label="Announce from">
          <input className="input" disabled value={active ? active.name || active.host : 'no radio selected'} />
        </Field>
        <Field label="Model (submodel)" hint={detectedModel ? `Detected: ${detectedModel}` : undefined}>
          <input
            className="input mono"
            value={model || detectedModel}
            onChange={(e) => setModel(e.target.value)}
            placeholder="RM-915v3-2L-X"
          />
        </Field>
        <Field label="Frequency (MHz)">
          <input
            className="input mono"
            type="number"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            placeholder="915"
          />
        </Field>
        <Field label="Bandwidth">
          <select className="select" value={bandwidth} onChange={(e) => setBandwidth(e.target.value)}>
            {BANDWIDTHS.map((b) => (
              <option key={b} value={b}>
                {b} MHz
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="row end">
        <Field label="Announcements">
          <input
            className="input mono"
            style={{ width: 80 }}
            type="number"
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </Field>
        <div className="spacer" />
        <button className="btn danger" disabled={!ready || busy} onClick={() => setConfirm(true)}>
          {busy && <Spinner />}
          Switch the whole network
        </button>
      </div>

      {confirm && (
        <ConfirmPhrase
          title="Switch the entire mesh?"
          phrase="SWITCH"
          onCancel={() => setConfirm(false)}
          onConfirm={run}
          body={
            <>
              <p style={{ marginTop: 0 }}>
                Every node that hears this announcement will move to <b>{frequency} MHz</b> at{' '}
                <b>{bandwidth} MHz</b> wide.
              </p>
              <div className="callout warn">
                Nodes out of range when the announcement is sent will be left on the old channel and
                must be recovered individually.
              </div>
            </>
          }
        />
      )}
    </Panel>
  )
}
