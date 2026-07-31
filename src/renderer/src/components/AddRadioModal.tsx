import React, { useState } from 'react'
import { useApp } from '../state'
import { Field, Modal, Spinner, Toggle } from './ui'

/** Accepts one host, a comma/newline separated list, or a dashed range like 10.223.0.10-20. */
function expandHosts(input: string): string[] {
  const out: string[] = []
  for (const chunk of input.split(/[\s,]+/).filter(Boolean)) {
    const range = chunk.match(/^(\d+\.\d+\.\d+)\.(\d+)-(\d+)$/)
    if (range) {
      const [, prefix, a, b] = range
      const from = Math.min(Number(a), Number(b))
      const to = Math.max(Number(a), Number(b))
      for (let i = from; i <= to; i++) out.push(`${prefix}.${i}`)
    } else {
      out.push(chunk)
    }
  }
  return Array.from(new Set(out))
}

export function AddRadioModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { reloadRadios, notify, guard, settings } = useApp()
  const [hosts, setHosts] = useState('')
  const [name, setName] = useState('')
  const [group, setGroup] = useState('')
  const [useCustomCreds, setUseCustomCreds] = useState(false)
  const [username, setUsername] = useState(settings?.defaultCredentials.username ?? 'user')
  const [password, setPassword] = useState(settings?.defaultCredentials.password ?? 'DoodleSmartRadio')
  const [busy, setBusy] = useState(false)

  const list = expandHosts(hosts)

  const submit = async (): Promise<void> => {
    if (!list.length) return
    setBusy(true)
    const res = await guard('Could not add radios', async () =>
      window.api.radios.addMany(
        list.map((host, i) => ({
          host,
          name: list.length === 1 ? name || host : name ? `${name} ${i + 1}` : host,
          group: group || undefined,
          credentials: useCustomCreds ? { username, password } : undefined
        }))
      )
    )
    setBusy(false)
    if (res) {
      await reloadRadios()
      notify('ok', `Added ${res.length} radio${res.length === 1 ? '' : 's'}`, 'Connecting…')
      onClose()
    }
  }

  return (
    <Modal
      title="Add radios"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!list.length || busy}>
            {busy && <Spinner />}
            Add {list.length > 1 ? `${list.length} radios` : 'radio'}
          </button>
        </>
      }
    >
      <Field
        label="IP address or hostname"
        hint={
          <>
            One per line, or comma separated. A range works too:{' '}
            <code>10.223.0.10-20</code>.
            {list.length > 1 && (
              <>
                {' '}
                <b style={{ color: 'var(--accent)' }}>{list.length} hosts</b> will be added.
              </>
            )}
          </>
        }
      >
        <textarea
          className="textarea mono"
          value={hosts}
          autoFocus
          placeholder={'10.223.30.201\n10.223.30.202'}
          onChange={(e) => setHosts(e.target.value)}
        />
      </Field>

      <div className="grid c2">
        <Field label="Name" hint="Optional. Defaults to the radio's own hostname.">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Group" hint="Optional label, e.g. “GCS” or “Vehicle 3”.">
          <input className="input" value={group} onChange={(e) => setGroup(e.target.value)} />
        </Field>
      </div>

      <div style={{ marginTop: 6, marginBottom: 10 }}>
        <Toggle
          checked={useCustomCreds}
          onChange={setUseCustomCreds}
          label="Use different credentials for these radios"
        />
      </div>

      {useCustomCreds && (
        <div className="grid c2">
          <Field label="Username">
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label="Password">
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>
      )}
    </Modal>
  )
}
