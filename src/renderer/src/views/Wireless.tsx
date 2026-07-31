import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useActiveRadio, useActiveStatus, useApp } from '../state'
import { ApplyLog, Field, Panel, SaveButton, Spinner } from '../components/ui'
import { BANDWIDTHS } from '../lib/format'
import type { ApplyResult, FreqEntry, UciChange } from '@shared/types'

/** UCI options this page owns, resolved against the Mesh Rider PHY. */
function paths(phy: string): Record<string, string> {
  return {
    channel: `wireless.radio${phy}.channel`,
    chanbw: `wireless.radio${phy}.chanbw`,
    txpower: `wireless.radio${phy}.txpower`,
    distance: `wireless.radio${phy}.distance`,
    mode: `wireless.wifi${phy}.mode`,
    meshId: `wireless.wifi${phy}.mesh_id`,
    ssid: `wireless.wifi${phy}.ssid`,
    encryption: `wireless.wifi${phy}.encryption`,
    key: `wireless.wifi${phy}.key`
  }
}

const ENCRYPTION_OPTIONS = [
  { value: 'none', label: 'None (open)' },
  { value: 'psk2', label: 'WPA2-PSK' },
  { value: 'psk2+ccmp', label: 'WPA2-PSK (CCMP)' },
  { value: 'sae', label: 'WPA3-SAE' },
  { value: 'psk-mixed', label: 'WPA/WPA2 mixed' }
]

export function Wireless(): React.JSX.Element {
  const radio = useActiveRadio()
  const status = useActiveStatus()
  const { notify, guard } = useApp()

  const [phy, setPhy] = useState('0')
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState<Record<string, string | undefined>>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [freqs, setFreqs] = useState<FreqEntry[]>([])
  const [subModels, setSubModels] = useState<string[]>([])
  const [pending, setPending] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ApplyResult | null>(null)

  const P = useMemo(() => paths(phy), [phy])

  const load = useCallback(async () => {
    if (!radio) return
    setLoading(true)
    setResult(null)
    await guard('Could not read wireless config', async () => {
      const snap = await window.api.radio.snapshot(radio.id)
      const activePhy = snap.phy ?? '0'
      setPhy(activePhy)

      const p = paths(activePhy)
      const [values, changes] = await Promise.all([
        window.api.uci.getMany(radio.id, Object.values(p)),
        window.api.radio.pending(radio.id)
      ])

      const byKey: Record<string, string | undefined> = {}
      for (const [key, uciPath] of Object.entries(p)) byKey[key] = values[uciPath]
      setSaved(byKey)
      setDraft(Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, v ?? ''])))
      setPending(changes)

      // These are best-effort; a radio mid-reconfigure may not answer them.
      void window.api.radio.freqList(radio.id).then(setFreqs, () => setFreqs([]))
      void window.api.radio.validSubModels(radio.id).then(setSubModels, () => setSubModels([]))
    })
    setLoading(false)
  }, [radio?.id, guard])

  useEffect(() => {
    void load()
  }, [load])

  const changes: UciChange[] = useMemo(() => {
    const out: UciChange[] = []
    for (const [key, uciPath] of Object.entries(P)) {
      const next = (draft[key] ?? '').trim()
      const prev = saved[key] ?? ''
      if (next !== prev && next !== '') out.push({ path: uciPath, value: next })
    }
    return out
  }, [draft, saved, P])

  const dirty = changes.length > 0

  const apply = async (): Promise<void> => {
    if (!radio || !dirty) return
    setBusy(true)
    setResult(null)
    const res = await guard('Apply failed', async () =>
      window.api.uci.apply(radio.id, {
        changes,
        commit: ['wireless'],
        // `network` restart also restarts wireless, but wireless alone is enough here and
        // is far less disruptive to the rest of the link.
        restart: ['wireless']
      })
    )
    setBusy(false)
    if (res) {
      setResult(res)
      if (res.ok) {
        notify('ok', 'Applied', `${changes.length} setting(s) committed and wireless restarted`)
        // Re-read so the form reflects what the radio actually stored.
        setTimeout(() => void load(), 2500)
      } else {
        notify('err', 'Apply incomplete', 'See the step log for the failing command')
      }
    }
  }

  const revert = async (): Promise<void> => {
    if (!radio) return
    const res = await guard('Revert failed', async () => window.api.uci.revert(radio.id, ['wireless']))
    if (res) {
      notify('ok', 'Reverted staged changes')
      void load()
    }
  }

  if (!radio) return <div className="empty">Select a radio first.</div>
  if (status?.state !== 'online') {
    return <div className="callout err">Radio is not reachable — cannot read or change its configuration.</div>
  }
  if (loading) {
    return (
      <div className="row" style={{ padding: 24, color: 'var(--text-dim)' }}>
        <Spinner /> Reading configuration…
      </div>
    )
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }))

  return (
    <>
      <div className="callout info">
        <div>
          Changes are written with <code>uci set</code>, then <b>committed</b> and the wireless
          service is <b>restarted</b> — the step the stock web GUI often skips, which is why
          settings there appear to revert.
        </div>
      </div>

      {pending && (
        <div className="dirty-strip">
          <span className="badge warn">uncommitted</span>
          <span style={{ flex: 1 }}>
            This radio has staged UCI changes that were never committed:{' '}
            <code style={{ fontSize: 11 }}>{pending.split('\n').slice(0, 3).join('; ')}</code>
          </span>
          <button className="btn sm" onClick={revert}>
            Discard them
          </button>
        </div>
      )}

      <div className="grid c2">
        <Panel title="Channel & bandwidth" note={`radio${phy}`}>
          <Field
            label="Channel"
            hint={
              freqs.length
                ? `${freqs.length} channels available in the current band.`
                : 'Channel list unavailable — enter the channel number directly.'
            }
          >
            {freqs.length ? (
              <select className="select" value={draft.channel ?? ''} onChange={set('channel')}>
                <option value="">(unset)</option>
                {freqs.map((f) => (
                  <option key={f.channel} value={String(f.channel)}>
                    {f.channel} — {f.mhz} MHz{f.restricted ? ' (restricted)' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input className="input mono" value={draft.channel ?? ''} onChange={set('channel')} />
            )}
          </Field>

          <Field label="Channel bandwidth" hint="Narrower channels trade throughput for range and robustness.">
            <select className="select" value={draft.chanbw ?? ''} onChange={set('chanbw')}>
              <option value="">(unset)</option>
              {BANDWIDTHS.map((b) => (
                <option key={b} value={b}>
                  {b} MHz
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Operating distance (m)"
            hint="Sets the ACK timeout. Too low breaks long links; too high wastes airtime."
          >
            <input
              className="input mono"
              type="number"
              value={draft.distance ?? ''}
              onChange={set('distance')}
              placeholder="e.g. 5000"
            />
          </Field>
        </Panel>

        <Panel title="Transmit power">
          <Field
            label="TX power"
            hint={
              <>
                Use <code>auto</code> to let the radio manage power, or a fixed value in dBm.
                Regulatory limits still apply.
              </>
            }
          >
            <input
              className="input mono"
              value={draft.txpower ?? ''}
              onChange={set('txpower')}
              placeholder="auto or e.g. 27"
            />
          </Field>

          <div className="row wrap" style={{ marginTop: -4, marginBottom: 12 }}>
            {['auto', '10', '15', '20', '25', '27', '30'].map((v) => (
              <button
                key={v}
                className="btn sm"
                onClick={() => setDraft((d) => ({ ...d, txpower: v }))}
              >
                {v === 'auto' ? 'auto' : `${v} dBm`}
              </button>
            ))}
          </div>

          <div className="callout">
            The value above is the persistent UCI setting. To change power immediately without a
            wireless restart, use the live control on the Console page (<code>iw … set txpower</code>).
          </div>
        </Panel>
      </div>

      <div className="grid c2">
        <Panel title="Mesh / network identity">
          <Field label="Mode" hint="mesh, ap (WDS AP), sta (WDS client), or adhoc.">
            <input className="input mono" value={draft.mode ?? ''} onChange={set('mode')} placeholder="mesh" />
          </Field>
          <Field label="Mesh ID" hint="Every node in the same mesh must match exactly.">
            <input className="input mono" value={draft.meshId ?? ''} onChange={set('meshId')} />
          </Field>
          <Field label="SSID" hint="Used in WDS AP/Client mode.">
            <input className="input mono" value={draft.ssid ?? ''} onChange={set('ssid')} />
          </Field>
        </Panel>

        <Panel title="Encryption">
          <Field label="Algorithm">
            <select className="select" value={draft.encryption ?? ''} onChange={set('encryption')}>
              <option value="">(unset)</option>
              {ENCRYPTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {draft.encryption &&
                !ENCRYPTION_OPTIONS.some((o) => o.value === draft.encryption) && (
                  <option value={draft.encryption}>{draft.encryption} (current)</option>
                )}
            </select>
          </Field>
          <Field
            label="Key"
            hint="8–63 characters. Changing this on one node only will drop it from the mesh — push it to every node together from the Fleet page."
          >
            <input
              className="input mono"
              value={draft.key ?? ''}
              onChange={set('key')}
              placeholder="(unchanged)"
            />
          </Field>
        </Panel>
      </div>

      <BandSwitchPanel radioId={radio.id} subModels={subModels} currentSubModel={status?.board?.sub_model} />

      <div
        className="row end"
        style={{
          position: 'sticky',
          bottom: 0,
          background: 'linear-gradient(transparent, var(--bg) 30%)',
          padding: '14px 0 4px',
          gap: 8
        }}
      >
        {dirty && (
          <span style={{ color: 'var(--warn)', fontSize: 12.5, marginRight: 'auto' }}>
            {changes.length} unsaved change{changes.length === 1 ? '' : 's'}
          </span>
        )}
        <button className="btn" onClick={() => void load()} disabled={busy}>
          Reload
        </button>
        <SaveButton onClick={apply} busy={busy} dirty={dirty} />
      </div>

      {result && (
        <Panel title="Apply log" note={result.ok ? 'all steps succeeded' : 'a step failed'}>
          <ApplyLog result={result} />
        </Panel>
      )}
    </>
  )
}

/**
 * Band switching goes through Doodle Labs' `band_switching.sh`, not raw UCI, because moving to a
 * different sub-model also has to load that band's calibration data.
 */
function BandSwitchPanel({
  radioId,
  subModels,
  currentSubModel
}: {
  radioId: string
  subModels: string[]
  currentSubModel?: string
}): React.JSX.Element {
  const { notify, guard } = useApp()
  const [subModel, setSubModel] = useState(currentSubModel ?? '')
  const [channel, setChannel] = useState('')
  const [bandwidth, setBandwidth] = useState('20')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (currentSubModel) setSubModel(currentSubModel)
  }, [currentSubModel])

  const run = async (): Promise<void> => {
    if (!subModel || !channel) return
    setBusy(true)
    const step = await guard('Band switch failed', async () =>
      window.api.wireless.bandSwitch(radioId, { subModel, channel, bandwidth })
    )
    setBusy(false)
    if (step) {
      notify(
        step.ok ? 'ok' : 'err',
        step.ok ? 'Band switch issued' : 'Band switch failed',
        step.tolerated
          ? 'The radio restarted its wireless stack, so the session dropped. That is expected.'
          : (step.stderr ?? step.stdout)
      )
    }
  }

  return (
    <Panel
      title="Band switch"
      note="changes the operating band, channel and width together"
    >
      <div className="callout warn">
        Switching bands reloads calibration and restarts the radio's wireless stack. The link will
        drop for several seconds, and any peer not moved to the same band will be lost.
      </div>
      <div className="grid c3">
        <Field label="Sub-model (band)">
          {subModels.length ? (
            <select className="select" value={subModel} onChange={(e) => setSubModel(e.target.value)}>
              <option value="">Select…</option>
              {subModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                  {m === currentSubModel ? ' (current)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input mono"
              value={subModel}
              onChange={(e) => setSubModel(e.target.value)}
              placeholder="RM-915v3-2L-X"
            />
          )}
        </Field>
        <Field label="Channel">
          <input
            className="input mono"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            placeholder="e.g. 8"
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
        <button className="btn danger" onClick={run} disabled={busy || !subModel || !channel}>
          {busy && <Spinner />}
          Switch band
        </button>
      </div>
    </Panel>
  )
}
