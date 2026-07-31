import React, { useCallback, useEffect, useState } from 'react'
import { useActiveRadio, useActiveStatus, useApp } from '../state'
import { Empty, Panel, Spinner, Toggle } from '../components/ui'

/** Log sources reachable through ubus `file exec`, no SSH required. */
const SOURCES: { id: string; label: string; command: string; note: string }[] = [
  { id: 'logread', label: 'System log', command: 'logread', note: 'syslog ring buffer' },
  { id: 'dmesg', label: 'Kernel log', command: 'dmesg', note: 'driver and hardware messages' },
  {
    id: 'linkstate',
    label: 'Link state',
    command: 'cat /tmp/linkstate_current.json',
    note: 'current RSSI, MCS, peers'
  },
  {
    id: 'wireless',
    label: 'Wireless config',
    command: 'uci show wireless',
    note: 'committed wireless settings'
  },
  {
    id: 'network',
    label: 'Network config',
    command: 'uci show network',
    note: 'committed network settings'
  },
  { id: 'changes', label: 'Pending UCI', command: 'uci changes', note: 'staged but not committed' },
  { id: 'processes', label: 'Processes', command: 'top -n1', note: 'CPU and memory by process' },
  { id: 'interfaces', label: 'Interfaces', command: 'ifconfig; ip route', note: 'addressing and routes' }
]

export function Logs(): React.JSX.Element {
  const radio = useActiveRadio()
  const status = useActiveStatus()
  const { notify, guard } = useApp()

  const [logEnabled, setLogEnabled] = useState<boolean | null>(null)
  const [logLocation, setLogLocation] = useState('')
  const [source, setSource] = useState(SOURCES[0])
  const [output, setOutput] = useState('')
  const [busy, setBusy] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [bundling, setBundling] = useState(false)
  const [filter, setFilter] = useState('')

  const loadState = useCallback(async () => {
    if (!radio) return
    const on = await window.api.logs.enabled(radio.id).catch(() => null)
    setLogEnabled(on)
    const loc = await window.api.logs.location(radio.id).catch(() => '')
    setLogLocation(loc)
  }, [radio?.id])

  useEffect(() => {
    setOutput('')
    void loadState()
  }, [loadState])

  const fetchSource = async (src: (typeof SOURCES)[number]): Promise<void> => {
    if (!radio) return
    setSource(src)
    setBusy(true)
    setOutput('')
    const res = await guard('Could not read log', async () => window.api.exec.run(radio.id, src.command))
    setBusy(false)
    if (res) setOutput(res.stdout || res.stderr || '(no output)')
  }

  const toggleLinkLog = async (on: boolean): Promise<void> => {
    if (!radio) return
    setToggling(true)
    const res = await guard('Could not change link logging', async () =>
      window.api.logs.setEnabled(radio.id, on)
    )
    setToggling(false)
    if (res) {
      setLogEnabled(on)
      notify(
        res.ok ? 'ok' : 'warn',
        on ? 'Link status logging enabled' : 'Link status logging disabled',
        res.ok ? 'Committed to link_status_log' : 'Commit reported a problem — check the radio'
      )
      void loadState()
    }
  }

  const saveCurrent = async (): Promise<void> => {
    if (!radio || !output) return
    // Reuse the diagnostic writer path by saving the buffer we already have.
    const blob = new Blob([output], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${radio.name || radio.host}_${source.id}_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    a.click()
    URL.revokeObjectURL(url)
    notify('ok', 'Saved', a.download)
  }

  const downloadBundle = async (): Promise<void> => {
    if (!radio) return
    setBundling(true)
    const path = await guard('Bundle failed', async () => window.api.logs.bundle(radio.id))
    setBundling(false)
    if (path) notify('ok', 'Diagnostic bundle saved', path)
  }

  if (!radio) return <div className="empty">Select a radio first.</div>
  if (status?.state !== 'online') return <div className="callout err">Radio is not reachable.</div>

  const lines = output ? output.split('\n') : []
  const shown = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines

  return (
    <>
      <Panel
        title="Link status logging"
        note="periodic RSSI / MCS / peer snapshots written to flash"
        actions={
          <>
            <button className="btn sm" onClick={() => void window.api.logs.openFolder()}>
              Open download folder
            </button>
            <button className="btn sm primary" onClick={downloadBundle} disabled={bundling}>
              {bundling && <Spinner />}
              Download diagnostic bundle
            </button>
          </>
        }
      >
        <div className="row" style={{ marginBottom: 10 }}>
          {logEnabled === null ? (
            <span style={{ color: 'var(--text-faint)' }}>Reading state…</span>
          ) : (
            <Toggle
              checked={logEnabled}
              disabled={toggling}
              onChange={(v) => void toggleLinkLog(v)}
              label={logEnabled ? 'Enabled' : 'Disabled'}
            />
          )}
          {toggling && <Spinner />}
        </div>
        <div className="hint">
          When enabled, the link-status daemon records a rolling history you can pull after a
          flight or test. Turning it on writes <code>link_status_log.@general[0].enabled</code> and
          commits it.
        </div>
        {logLocation && (
          <div className="callout" style={{ marginTop: 10, marginBottom: 0 }}>
            <div>
              <b>Log location on the radio</b>
              <div className="mono" style={{ fontSize: 11.5, marginTop: 3, whiteSpace: 'pre-wrap' }}>
                {logLocation}
              </div>
            </div>
          </div>
        )}
      </Panel>

      <Panel
        title="Live logs and configuration dumps"
        actions={
          <>
            <input
              className="input"
              style={{ width: 190 }}
              placeholder="Filter lines…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button className="btn sm" onClick={() => void fetchSource(source)} disabled={busy}>
              Refresh
            </button>
            <button className="btn sm" onClick={saveCurrent} disabled={!output}>
              Save
            </button>
          </>
        }
      >
        <div className="row wrap" style={{ marginBottom: 12 }}>
          {SOURCES.map((s) => (
            <button
              key={s.id}
              className={s.id === source.id && output ? 'btn primary sm' : 'btn sm'}
              title={s.note}
              onClick={() => void fetchSource(s)}
              disabled={busy}
            >
              {s.label}
            </button>
          ))}
        </div>

        {busy ? (
          <div className="row" style={{ padding: 20, color: 'var(--text-dim)' }}>
            <Spinner /> Running <code>{source.command}</code>…
          </div>
        ) : output ? (
          <>
            <div
              className="row"
              style={{ marginBottom: 6, fontSize: 11.5, color: 'var(--text-faint)' }}
            >
              <code>$ {source.command}</code>
              <div className="spacer" />
              <span>
                {shown.length}
                {filter ? ` of ${lines.length}` : ''} lines
              </span>
            </div>
            <div className="term" style={{ maxHeight: '52vh' }}>
              {shown.join('\n')}
            </div>
          </>
        ) : (
          <Empty title="Pick a source above">
            Output is fetched over JSON-RPC — no SSH session needed.
          </Empty>
        )}
      </Panel>

      <FileFetch radioId={radio.id} />
    </>
  )
}

/** Pull an arbitrary file off the radio, by ubus for text or SFTP for anything large. */
function FileFetch({ radioId }: { radioId: string }): React.JSX.Element {
  const { notify, guard } = useApp()
  const [path, setPath] = useState('/tmp/linkstate_current.json')
  const [busy, setBusy] = useState<'save' | 'sftp' | null>(null)

  const viaUbus = async (): Promise<void> => {
    setBusy('save')
    const local = await guard('Download failed', async () => window.api.logs.save(radioId, path))
    setBusy(null)
    if (local) notify('ok', 'Saved', local)
  }

  const viaSftp = async (): Promise<void> => {
    setBusy('sftp')
    const local = await guard('SFTP download failed', async () =>
      window.api.logs.download(radioId, path)
    )
    setBusy(null)
    if (local) notify('ok', 'Downloaded over SFTP', local)
  }

  return (
    <Panel title="Fetch a file from the radio">
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <label className="label">Remote path</label>
          <input
            className="input mono"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/tmp/linkstate_current.json"
          />
        </div>
        <button className="btn" onClick={viaUbus} disabled={busy !== null || !path}>
          {busy === 'save' && <Spinner />}
          Save (JSON-RPC)
        </button>
        <button className="btn" onClick={viaSftp} disabled={busy !== null || !path}>
          {busy === 'sftp' && <Spinner />}
          Save (SFTP)
        </button>
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        JSON-RPC is fine for text files and needs no SSH. Use SFTP for archives, captures or
        anything large — it authenticates as the SSH user set in Settings (root by default).
      </div>
    </Panel>
  )
}
