import React, { useEffect, useState } from 'react'
import { useActiveRadio, useActiveStatus, useApp } from '../state'
import { ConfirmPhrase, Field, Panel, Spinner, Toggle } from '../components/ui'

export function Maintenance(): React.JSX.Element {
  const radio = useActiveRadio()
  const status = useActiveStatus()
  const { reloadRadios, notify, guard } = useApp()

  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [group, setGroup] = useState('')
  const [useOverride, setUseOverride] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmKind, setConfirmKind] = useState<'reboot' | 'reset' | 'remove' | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanOut, setScanOut] = useState('')
  const [sshState, setSshState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [sshErr, setSshErr] = useState('')

  useEffect(() => {
    if (!radio) return
    setName(radio.name)
    setHost(radio.host)
    setGroup(radio.group ?? '')
    setUseOverride(Boolean(radio.credentials))
    setUsername(radio.credentials?.username ?? '')
    setPassword(radio.credentials?.password ?? '')
    setScanOut('')
    setSshState('idle')
  }, [radio?.id])

  if (!radio) return <div className="empty">Select a radio first.</div>

  const saveDetails = async (): Promise<void> => {
    const res = await guard('Could not update radio', async () =>
      window.api.radios.update(radio.id, {
        name,
        host,
        group: group || undefined,
        credentials: useOverride ? { username, password } : undefined
      })
    )
    if (res) {
      await reloadRadios()
      notify('ok', 'Radio updated')
    }
  }

  const testSsh = async (): Promise<void> => {
    setSshState('testing')
    setSshErr('')
    try {
      await window.api.ssh.probe(radio.id)
      setSshState('ok')
    } catch (err) {
      setSshState('fail')
      setSshErr(err instanceof Error ? err.message : String(err))
    }
  }

  const runScan = async (): Promise<void> => {
    setScanning(true)
    setScanOut('')
    const res = await guard('Noise scan failed', async () =>
      window.api.exec.run(radio.id, 'switch-scan-new.sh >/dev/null 2>&1; cat /tmp/scan_results')
    )
    setScanning(false)
    if (res) setScanOut(res.stdout || res.stderr || '(no results)')
  }

  const doReboot = async (): Promise<void> => {
    setConfirmKind(null)
    await guard('Reboot failed', async () => window.api.service.reboot(radio.id))
    notify('warn', 'Reboot issued', `${radio.name || radio.host} is restarting — expect ~60s downtime.`)
  }

  const doReset = async (): Promise<void> => {
    setConfirmKind(null)
    await guard('Factory reset failed', async () => window.api.service.factoryReset(radio.id))
    notify(
      'warn',
      'Factory reset issued',
      'The radio will reboot to defaults. It will very likely come back on a different IP address.'
    )
  }

  const doRemove = async (): Promise<void> => {
    setConfirmKind(null)
    await guard('Could not remove radio', async () => window.api.radios.remove(radio.id))
    await reloadRadios()
    notify('ok', 'Radio removed from the list', 'The radio itself was not changed.')
  }

  return (
    <>
      <Panel title="Radio details" note="stored locally — does not change the radio">
        <div className="grid c3">
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Address" hint="Update this if the radio's management IP changed.">
            <input className="input mono" value={host} onChange={(e) => setHost(e.target.value)} />
          </Field>
          <Field label="Group">
            <input className="input" value={group} onChange={(e) => setGroup(e.target.value)} />
          </Field>
        </div>

        <div style={{ marginBottom: 10 }}>
          <Toggle
            checked={useOverride}
            onChange={setUseOverride}
            label="Override the default credentials for this radio"
          />
        </div>
        {useOverride && (
          <div className="grid c2">
            <Field label="Username">
              <input className="input mono" value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label="Password">
              <input
                className="input mono"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          </div>
        )}

        <div className="row end">
          <button className="btn primary" onClick={saveDetails}>
            Save details
          </button>
        </div>
      </Panel>

      <Panel title="Connectivity">
        <dl className="kv" style={{ marginBottom: 12 }}>
          <dt>JSON-RPC</dt>
          <dd>
            <span className={`badge ${status?.state === 'online' ? 'ok' : 'err'}`}>
              {status?.state ?? 'unknown'}
            </span>
            {status?.latencyMs != null && ` · ${status.latencyMs} ms`}
            {status?.error && ` · ${status.error}`}
          </dd>
          <dt>SSH</dt>
          <dd>
            {sshState === 'idle' && <span className="badge">not tested</span>}
            {sshState === 'testing' && <Spinner />}
            {sshState === 'ok' && <span className="badge ok">reachable</span>}
            {sshState === 'fail' && (
              <span className="badge err" title={sshErr}>
                failed
              </span>
            )}
          </dd>
        </dl>
        {sshErr && <div className="callout err">{sshErr}</div>}
        <div className="row">
          <button className="btn" onClick={() => void window.api.radios.refresh(radio.id)}>
            Re-test JSON-RPC
          </button>
          <button className="btn" onClick={testSsh} disabled={sshState === 'testing'}>
            Test SSH
          </button>
        </div>
      </Panel>

      <Panel
        title="Noise scan"
        note="surveys the band so you can pick a quiet channel"
        actions={
          <button className="btn sm primary" onClick={runScan} disabled={scanning}>
            {scanning && <Spinner />}
            Run scan
          </button>
        }
      >
        <div className="callout warn">
          Scanning takes the radio off its operating channel for several seconds. The link will drop
          while it runs.
        </div>
        {scanOut ? (
          <div className="term" style={{ maxHeight: 320 }}>
            {scanOut}
          </div>
        ) : (
          <div className="hint">Results from <code>/tmp/scan_results</code> appear here.</div>
        )}
      </Panel>

      <Panel title="Danger zone">
        <div className="grid c3">
          <div>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>Reboot</div>
            <div className="hint" style={{ marginBottom: 8 }}>
              Restarts the radio. Configuration is kept. Roughly a minute of downtime.
            </div>
            <button className="btn danger block" onClick={() => setConfirmKind('reboot')}>
              Reboot radio
            </button>
          </div>
          <div>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>Factory reset</div>
            <div className="hint" style={{ marginBottom: 8 }}>
              Runs <code>firstboot -y && reboot</code>. Wipes all configuration permanently.
            </div>
            <button className="btn danger block" onClick={() => setConfirmKind('reset')}>
              Factory reset
            </button>
          </div>
          <div>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>Remove from list</div>
            <div className="hint" style={{ marginBottom: 8 }}>
              Forgets the radio in this app only. The radio itself is untouched.
            </div>
            <button className="btn block" onClick={() => setConfirmKind('remove')}>
              Remove
            </button>
          </div>
        </div>
      </Panel>

      {confirmKind === 'reboot' && (
        <ConfirmPhrase
          title="Reboot this radio?"
          phrase="REBOOT"
          onCancel={() => setConfirmKind(null)}
          onConfirm={doReboot}
          body={
            <p style={{ marginTop: 0 }}>
              <b>{radio.name || radio.host}</b> will restart. Any traffic routed through it drops
              for around a minute.
            </p>
          }
        />
      )}

      {confirmKind === 'reset' && (
        <ConfirmPhrase
          title="Factory reset this radio?"
          phrase="RESET"
          onCancel={() => setConfirmKind(null)}
          onConfirm={doReset}
          body={
            <>
              <p style={{ marginTop: 0 }}>
                This permanently erases all configuration on <b>{radio.name || radio.host}</b> —
                channel, mesh ID, encryption keys, IP addressing, everything.
              </p>
              <div className="callout err">
                It will almost certainly come back on a different IP address, and may be on a
                different band. Make sure you have physical or serial access before continuing.
              </div>
            </>
          }
        />
      )}

      {confirmKind === 'remove' && (
        <ConfirmPhrase
          title="Remove this radio from the list?"
          phrase="REMOVE"
          onCancel={() => setConfirmKind(null)}
          onConfirm={doRemove}
          body={
            <p style={{ marginTop: 0 }}>
              Removes <b>{radio.name || radio.host}</b> from this app. The radio is not modified and
              can be added again at any time.
            </p>
          }
        />
      )}
    </>
  )
}
