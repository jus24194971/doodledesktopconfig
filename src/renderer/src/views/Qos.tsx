import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useActiveRadio, useActiveStatus, useApp } from '../state'
import { ApplyLog, Field, Panel, SaveButton, Spinner, Toggle } from '../components/ui'
import type { ApplyResult, UciChange } from '@shared/types'

interface Opt {
  key: string
  path: string
  label: string
  hint: string
  kind: 'bool' | 'number'
  suffix?: string
}

const OPTIONS: Opt[] = [
  {
    key: 'enabled',
    path: 'diffserv.@general[0].enabled',
    label: 'Enable DiffServ',
    hint: 'Master switch for traffic prioritisation. Everything below needs this on.',
    kind: 'bool'
  },
  {
    key: 'optimized_cc',
    path: 'diffserv.@general[0].optimized_cc',
    label: 'Optimise for command & control',
    hint: 'Prioritises small, latency-critical control packets (MAVLink, telemetry) over bulk traffic.',
    kind: 'bool'
  },
  {
    key: 'optimized_vi',
    path: 'diffserv.@general[0].optimized_vi',
    label: 'Optimise for video',
    hint: 'Gives video streams their own queue and lets them shed frames on a poor link instead of stalling.',
    kind: 'bool'
  },
  {
    key: 'low_latency',
    path: 'diffserv.@general[0].low_latency',
    label: 'Latency over throughput',
    hint: 'Shrinks aggregation and queue depth. Lower latency, lower peak throughput.',
    kind: 'bool'
  },
  {
    key: 'diversity_rates',
    path: 'diffserv.@general[0].diversity_rates',
    label: 'Optimise for robustness',
    hint: 'Uses more conservative rates so the link degrades gracefully rather than dropping.',
    kind: 'bool'
  },
  {
    key: 'vi_drop_signal_threshold',
    path: 'diffserv.@general[0].vi_drop_signal_threshold',
    label: 'Video bad-link threshold',
    hint: 'RSSI in dBm below which video frames start being dropped, e.g. -95.',
    kind: 'number',
    suffix: 'dBm'
  },
  {
    key: 'vi_drop_signal_ratio',
    path: 'diffserv.@general[0].vi_drop_signal_ratio',
    label: 'Video drop percentage',
    hint: 'How aggressively video is shed once below the threshold, e.g. 90.',
    kind: 'number',
    suffix: '%'
  }
]

export function Qos(): React.JSX.Element {
  const radio = useActiveRadio()
  const status = useActiveStatus()
  const { notify, guard } = useApp()

  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState<Record<string, string | undefined>>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ApplyResult | null>(null)

  const load = useCallback(async () => {
    if (!radio) return
    setLoading(true)
    setResult(null)
    await guard('Could not read QoS config', async () => {
      const values = await window.api.uci.getMany(
        radio.id,
        OPTIONS.map((o) => o.path)
      )
      const byKey: Record<string, string | undefined> = {}
      for (const o of OPTIONS) byKey[o.key] = values[o.path]
      setSaved(byKey)
      setDraft(Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, v ?? ''])))
    })
    setLoading(false)
  }, [radio?.id, guard])

  useEffect(() => {
    void load()
  }, [load])

  const changes: UciChange[] = useMemo(
    () =>
      OPTIONS.filter((o) => {
        const next = (draft[o.key] ?? '').trim()
        return next !== (saved[o.key] ?? '') && next !== ''
      }).map((o) => ({ path: o.path, value: (draft[o.key] ?? '').trim() })),
    [draft, saved]
  )

  const apply = async (): Promise<void> => {
    if (!radio || !changes.length) return
    setBusy(true)
    setResult(null)
    const res = await guard('Apply failed', async () =>
      window.api.uci.apply(radio.id, {
        changes,
        commit: ['diffserv'],
        restart: ['diffserv']
      })
    )
    setBusy(false)
    if (res) {
      setResult(res)
      notify(
        res.ok ? 'ok' : 'err',
        res.ok ? 'Applied' : 'Apply incomplete',
        res.ok ? 'DiffServ committed and restarted' : 'See the step log'
      )
      if (res.ok) setTimeout(() => void load(), 1500)
    }
  }

  if (!radio) return <div className="empty">Select a radio first.</div>
  if (status?.state !== 'online') return <div className="callout err">Radio is not reachable.</div>
  if (loading) {
    return (
      <div className="row" style={{ padding: 24, color: 'var(--text-dim)' }}>
        <Spinner /> Reading QoS configuration…
      </div>
    )
  }

  const enabled = draft.enabled === '1'
  const bools = OPTIONS.filter((o) => o.kind === 'bool')
  const nums = OPTIONS.filter((o) => o.kind === 'number')

  return (
    <>
      <div className="callout info">
        DiffServ classifies traffic so command-and-control keeps flowing when the link gets busy.
        These are the same knobs as the radio's Traffic Prioritisation page, but written with an
        explicit commit and service restart.
      </div>

      <Panel title="Traffic prioritisation" note="diffserv">
        {bools.map((o) => (
          <div key={o.key} style={{ marginBottom: 14 }}>
            <Toggle
              checked={draft[o.key] === '1'}
              disabled={o.key !== 'enabled' && !enabled}
              onChange={(v) => setDraft((d) => ({ ...d, [o.key]: v ? '1' : '0' }))}
              label={<b style={{ fontWeight: 500 }}>{o.label}</b>}
            />
            <div className="hint" style={{ marginLeft: 42 }}>
              {o.hint}
            </div>
          </div>
        ))}
      </Panel>

      <Panel title="Video link thresholds">
        <div className="grid c2">
          {nums.map((o) => (
            <Field key={o.key} label={`${o.label}${o.suffix ? ` (${o.suffix})` : ''}`} hint={o.hint}>
              <input
                className="input mono"
                type="number"
                disabled={!enabled}
                value={draft[o.key] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [o.key]: e.target.value }))}
              />
            </Field>
          ))}
        </div>
      </Panel>

      <div className="row end" style={{ gap: 8 }}>
        {changes.length > 0 && (
          <span style={{ color: 'var(--warn)', fontSize: 12.5, marginRight: 'auto' }}>
            {changes.length} unsaved change{changes.length === 1 ? '' : 's'}
          </span>
        )}
        <button className="btn" onClick={() => void load()} disabled={busy}>
          Reload
        </button>
        <SaveButton onClick={apply} busy={busy} dirty={changes.length > 0} />
      </div>

      {result && (
        <Panel title="Apply log" note={result.ok ? 'all steps succeeded' : 'a step failed'}>
          <ApplyLog result={result} />
        </Panel>
      )}
    </>
  )
}
