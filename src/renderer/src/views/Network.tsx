import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useActiveRadio, useActiveStatus, useApp } from '../state'
import { ApplyLog, Field, Panel, SaveButton, Spinner } from '../components/ui'
import type { ApplyResult, ServiceName, UciChange } from '@shared/types'

/**
 * Mesh Rider bridges its Ethernet and radio into `br-wan`; `network.wan2` carries the primary
 * management address and `network.wan3` the optional secondary.
 */
const FIELDS: { key: string; path: string; label: string; hint?: string; placeholder?: string }[] = [
  {
    key: 'ipaddr',
    path: 'network.wan2.ipaddr',
    label: 'Management IP',
    hint: 'The address you reach this radio on. Changing it will drop your connection — you must re-add the radio at its new address.',
    placeholder: '10.223.30.201'
  },
  { key: 'netmask', path: 'network.wan2.netmask', label: 'Netmask', placeholder: '255.255.0.0' },
  {
    key: 'ipaddr2',
    path: 'network.wan3.ipaddr',
    label: 'Secondary IP',
    hint: 'Optional. Useful for keeping a fixed management address alongside a mission subnet.',
    placeholder: '192.168.1.10'
  },
  { key: 'netmask2', path: 'network.wan3.netmask', label: 'Secondary netmask', placeholder: '255.255.255.0' },
  {
    key: 'multicast',
    path: 'network.bat0.multicast_mode',
    label: 'Group-aware multicast',
    hint: '1 enables batman-adv multicast optimisation. Disable it if multicast video is being dropped.',
    placeholder: '1'
  }
]

export function Network(): React.JSX.Element {
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
    await guard('Could not read network config', async () => {
      const values = await window.api.uci.getMany(
        radio.id,
        FIELDS.map((f) => f.path)
      )
      const byKey: Record<string, string | undefined> = {}
      for (const f of FIELDS) byKey[f.key] = values[f.path]
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
      FIELDS.filter((f) => {
        const next = (draft[f.key] ?? '').trim()
        return next !== (saved[f.key] ?? '') && next !== ''
      }).map((f) => ({ path: f.path, value: (draft[f.key] ?? '').trim() })),
    [draft, saved]
  )

  const changingOwnAddress = changes.some((c) => c.path === 'network.wan2.ipaddr')

  const apply = async (): Promise<void> => {
    if (!radio || !changes.length) return
    setBusy(true)
    setResult(null)
    const res = await guard('Apply failed', async () =>
      window.api.uci.apply(radio.id, {
        changes,
        commit: ['network'],
        restart: ['network'] as ServiceName[]
      })
    )
    setBusy(false)
    if (res) {
      setResult(res)
      if (changingOwnAddress) {
        const next = changes.find((c) => c.path === 'network.wan2.ipaddr')?.value
        notify(
          'warn',
          'Management address changed',
          `This radio should now be at ${next}. Update its host entry to keep managing it.`
        )
      } else if (res.ok) {
        notify('ok', 'Applied', 'Network committed and restarted')
        setTimeout(() => void load(), 3000)
      } else {
        notify('err', 'Apply incomplete', 'See the step log')
      }
    }
  }

  if (!radio) return <div className="empty">Select a radio first.</div>
  if (status?.state !== 'online') {
    return <div className="callout err">Radio is not reachable.</div>
  }
  if (loading) {
    return (
      <div className="row" style={{ padding: 24, color: 'var(--text-dim)' }}>
        <Spinner /> Reading network configuration…
      </div>
    )
  }

  return (
    <>
      <div className="callout info">
        The Mesh Rider network behaves like one large Ethernet switch. Hosts on the same IP subnet
        can talk to each other regardless of the radios' own addresses — but to reach a radio's
        management interface, your machine must share its subnet.
      </div>

      <Panel title="Addressing" note="network.wan2 / wan3">
        <div className="grid c2">
          {FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <input
                className="input mono"
                value={draft[f.key] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            </Field>
          ))}
        </div>
      </Panel>

      {changingOwnAddress && (
        <div className="callout warn">
          <div>
            <b>You are changing the address you are connected on.</b> After applying, this radio
            will stop answering at {radio.host}. Add it again at its new address (or edit the host
            field) to keep managing it.
          </div>
        </div>
      )}

      <ServicesPanel radioId={radio.id} />

      <div className="row end" style={{ gap: 8, marginTop: 6 }}>
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

const SERVICES: { name: ServiceName; label: string; note: string }[] = [
  { name: 'network', label: 'Network', note: 'Also restarts wireless' },
  { name: 'wireless', label: 'Wireless', note: 'Runs `wifi`' },
  { name: 'diffserv', label: 'DiffServ', note: 'QoS / traffic prioritisation' },
  { name: 'acs_multiband', label: 'ACS multiband', note: 'Automatic channel selection' },
  { name: 'socat', label: 'socat', note: 'Serial bridging' },
  { name: 'firewall', label: 'Firewall', note: '' }
]

function ServicesPanel({ radioId }: { radioId: string }): React.JSX.Element {
  const { notify, guard } = useApp()
  const [busy, setBusy] = useState<string | null>(null)

  const restart = async (svc: ServiceName): Promise<void> => {
    setBusy(svc)
    const step = await guard(`Restart ${svc} failed`, async () =>
      window.api.service.restart(radioId, svc)
    )
    setBusy(null)
    if (step) {
      notify(
        step.ok ? 'ok' : 'err',
        step.ok ? `${svc} restarted` : `${svc} restart failed`,
        step.tolerated ? 'Session dropped during the restart — expected.' : step.stderr
      )
    }
  }

  return (
    <Panel title="Services" note="restart after a change that did not take effect">
      <div className="row wrap">
        {SERVICES.map((s) => (
          <button
            key={s.name}
            className="btn"
            title={s.note}
            disabled={busy !== null}
            onClick={() => void restart(s.name)}
          >
            {busy === s.name && <Spinner />}
            {s.label}
          </button>
        ))}
      </div>
    </Panel>
  )
}
