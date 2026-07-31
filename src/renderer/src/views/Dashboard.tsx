import React, { useEffect, useRef, useState } from 'react'
import { useActiveRadio, useActiveStatus, useApp } from '../state'
import { Empty, Panel, SignalBars, Stat } from '../components/ui'
import {
  bytes,
  duration,
  macOf,
  mcsOf,
  meshOf,
  num,
  pick,
  rssiOf,
  rssiTone,
  stationsOf,
  str,
  timeAgo
} from '../lib/format'
import type { SystemSnapshot } from '@shared/types'

/** Rolling RSSI history, drawn as a sparkline so link stability is visible at a glance. */
function Sparkline({ points, min = -95, max = -30 }: { points: number[]; min?: number; max?: number }): React.JSX.Element {
  const w = 240
  const h = 42
  if (points.length < 2) {
    return (
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <line x1="0" y1={h / 2} x2={w} y2={h / 2} stroke="var(--border)" strokeDasharray="3 3" />
      </svg>
    )
  }
  const norm = (v: number): number => h - ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * h
  const step = w / (points.length - 1)
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${norm(p).toFixed(1)}`).join(' ')
  const area = `${d} L${w},${h} L0,${h} Z`
  const last = points[points.length - 1]
  const stroke = last >= -65 ? 'var(--ok)' : last >= -80 ? 'var(--warn)' : 'var(--err)'
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={area} fill={stroke} opacity="0.13" />
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function Dashboard(): React.JSX.Element {
  const radio = useActiveRadio()
  const status = useActiveStatus()
  const { guard } = useApp()
  const [snap, setSnap] = useState<SystemSnapshot | null>(null)
  const history = useRef<Map<string, number[]>>(new Map())

  useEffect(() => {
    setSnap(null)
    history.current.clear()
    if (!radio) return
    void guard('Could not read system info', async () => {
      const s = await window.api.radio.snapshot(radio.id)
      setSnap(s)
      return s
    })
  }, [radio?.id, guard])

  const link = status?.link
  const stations = stationsOf(link)
  const mesh = meshOf(link)

  // Track RSSI per station across polls.
  for (const s of stations) {
    const mac = macOf(s)
    const r = rssiOf(s)
    if (r == null) continue
    const arr = history.current.get(mac) ?? []
    if (arr[arr.length - 1] !== r || arr.length === 0) {
      arr.push(r)
      if (arr.length > 60) arr.shift()
      history.current.set(mac, arr)
    }
  }

  if (!radio) {
    return <Empty title="No radio selected">Add a radio from the sidebar to get started.</Empty>
  }

  if (status?.state === 'auth-error') {
    return (
      <>
        <div className="callout err">
          <div>
            <b>Authentication failed.</b> {status.error}
            <br />
            Mesh Rider firmware from June 2024 onward defaults to{' '}
            <code>user / DoodleSmartRadio</code>; older builds use <code>root / DoodleSmartRadio</code>.
            Set the right credentials in Settings, or per-radio via Edit.
          </div>
        </div>
      </>
    )
  }

  if (status?.state === 'offline') {
    return (
      <div className="callout err">
        <div>
          <b>Unreachable.</b> {status.error}
          <br />
          Check that {radio.host} is on a subnet this machine can route to, and that JSON-RPC is
          enabled on the radio.
        </div>
      </div>
    )
  }

  const board = status?.board
  const load = snap?.loadavg?.[0]
  const memUsedPct =
    snap?.memTotal && snap?.memFree
      ? Math.round(((snap.memTotal - snap.memFree) / snap.memTotal) * 100)
      : undefined

  const channel = str(pick(link as Record<string, unknown>, 'operating_channel', 'channel'))
  const freq = str(pick(link as Record<string, unknown>, 'operating_freq', 'frequency', 'freq'))
  const width = str(pick(link as Record<string, unknown>, 'channel_width', 'chanbw', 'bandwidth'))
  const noise = num(pick(link as Record<string, unknown>, 'noise', 'background_noise'))
  const activity = num(pick(link as Record<string, unknown>, 'activity', 'congestion'))
  const lna = str(pick(link as Record<string, unknown>, 'lna_status', 'lna'))

  const bestRssi = stations.length
    ? Math.max(...stations.map((s) => rssiOf(s) ?? -120))
    : undefined

  return (
    <>
      <div className="grid c4" style={{ marginBottom: 14 }}>
        <Stat
          label="Peers"
          value={stations.length}
          sub={mesh.length ? `${mesh.length} mesh originator${mesh.length === 1 ? '' : 's'}` : 'no mesh data'}
          tone={stations.length ? 'ok' : undefined}
        />
        <Stat
          label="Best RSSI"
          value={bestRssi != null && bestRssi > -120 ? bestRssi : '—'}
          unit={bestRssi != null && bestRssi > -120 ? 'dBm' : undefined}
          tone={rssiTone(bestRssi)}
          sub={noise != null ? `noise ${noise} dBm` : undefined}
        />
        <Stat
          label="Channel"
          value={channel ?? '—'}
          sub={[freq ? `${freq} MHz` : null, width ? `${width} MHz wide` : null].filter(Boolean).join(' · ') || undefined}
        />
        <Stat
          label="Airtime"
          value={activity != null ? activity : '—'}
          unit={activity != null ? '%' : undefined}
          tone={activity != null ? (activity > 70 ? 'err' : activity > 40 ? 'warn' : 'ok') : undefined}
          sub={lna ? `LNA ${lna}` : undefined}
        />
      </div>

      <div className="grid c2">
        <Panel title="Radio" note={status?.lastSeen ? `updated ${timeAgo(status.lastSeen)}` : undefined}>
          <dl className="kv">
            <dt>Hostname</dt>
            <dd>{board?.hostname ?? '—'}</dd>
            <dt>Model</dt>
            <dd>{board?.parent_model ?? '—'}</dd>
            <dt>Band (submodel)</dt>
            <dd>{board?.sub_model ?? '—'}</dd>
            <dt>Firmware</dt>
            <dd>{board?.release?.version ?? '—'}</dd>
            <dt>Kernel</dt>
            <dd>{board?.kernel ?? '—'}</dd>
            <dt>SoC</dt>
            <dd>{board?.system ?? '—'}</dd>
            <dt>Address</dt>
            <dd>
              {radio.host}
              {snap?.netmask ? ` / ${snap.netmask}` : ''}
            </dd>
          </dl>
        </Panel>

        <Panel title="Health">
          <div className="grid c2" style={{ marginBottom: 12 }}>
            <Stat
              label="CPU load (1m)"
              value={load != null ? (load / 65536).toFixed(2) : '—'}
              tone={load != null ? (load / 65536 > 2 ? 'err' : load / 65536 > 1 ? 'warn' : 'ok') : undefined}
            />
            <Stat
              label="Memory used"
              value={memUsedPct ?? '—'}
              unit={memUsedPct != null ? '%' : undefined}
              tone={memUsedPct != null ? (memUsedPct > 88 ? 'err' : memUsedPct > 70 ? 'warn' : 'ok') : undefined}
              sub={snap?.memFree != null ? `${bytes(snap.memFree)} free` : undefined}
            />
            <Stat label="Uptime" value={duration(snap?.uptime)} />
            <Stat
              label="Temperature"
              value={snap?.temperature != null ? snap.temperature.toFixed(1) : '—'}
              unit={snap?.temperature != null ? '°C' : undefined}
              tone={
                snap?.temperature != null
                  ? snap.temperature > 80
                    ? 'err'
                    : snap.temperature > 65
                      ? 'warn'
                      : 'ok'
                  : undefined
              }
              sub={snap?.voltage != null ? `${snap.voltage.toFixed(1)} V in` : undefined}
            />
          </div>
          {snap?.gps?.lat != null && (
            <div className="hint">
              GPS {snap.gps.lat.toFixed(5)}, {snap.gps.lon?.toFixed(5)}
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Connected peers"
        note={`${stations.length} station${stations.length === 1 ? '' : 's'}`}
        tight
      >
        {stations.length === 0 ? (
          <Empty title="No peers associated">
            The radio is up but nothing is linked to it yet.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>MAC</th>
                <th>Signal</th>
                <th>RSSI</th>
                <th style={{ width: 150 }}>Trend</th>
                <th>TX</th>
                <th>RX</th>
                <th className="num">Inactive</th>
                <th className="num">Retries</th>
              </tr>
            </thead>
            <tbody>
              {stations.map((s, i) => {
                const mac = macOf(s)
                const rssi = rssiOf(s)
                const hist = history.current.get(mac) ?? []
                const inactive = num(pick(s as Record<string, unknown>, 'inactive', 'inactive_time'))
                const retries = num(pick(s as Record<string, unknown>, 'tx_retries', 'retries'))
                return (
                  <tr key={mac + i}>
                    <td className="mono">{mac}</td>
                    <td>
                      <SignalBars rssi={rssi} />
                    </td>
                    <td className="num" style={{ color: `var(--${rssiTone(rssi) ?? 'text'})` }}>
                      {rssi != null ? `${rssi}` : '—'}
                    </td>
                    <td style={{ padding: '2px 12px' }}>
                      <Sparkline points={hist} />
                    </td>
                    <td className="mono">{mcsOf(s, 'tx')}</td>
                    <td className="mono">{mcsOf(s, 'rx')}</td>
                    <td className="num">{inactive != null ? `${inactive} ms` : '—'}</td>
                    <td className="num">{retries ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {mesh.length > 0 && (
        <Panel title="Mesh originators" note="batman-adv routing table" tight>
          <table className="table">
            <thead>
              <tr>
                <th>Originator</th>
                <th className="num">TQ</th>
                <th>Next hop</th>
                <th className="num">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {mesh.map((m, i) => {
                const tq = num(pick(m, 'tq', 'quality'))
                const seen = num(pick(m, 'last_seen_msecs', 'last_seen'))
                return (
                  <tr key={i}>
                    <td className="mono">{str(pick(m, 'orig_address', 'originator', 'mac')) ?? '—'}</td>
                    <td
                      className="num"
                      style={{
                        color: tq != null ? `var(--${tq > 200 ? 'ok' : tq > 120 ? 'warn' : 'err'})` : undefined
                      }}
                    >
                      {tq ?? '—'}
                    </td>
                    <td className="mono">{str(pick(m, 'next_hop', 'nexthop')) ?? '—'}</td>
                    <td className="num">{seen != null ? `${(seen / 1000).toFixed(1)} s` : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  )
}
