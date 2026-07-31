import React, { useEffect, useState } from 'react'
import { useApp } from '../state'
import { Field, Modal, Spinner } from './ui'

interface Discovered {
  host: string
  identified: boolean
  authOk: boolean
  hostname?: string
  error?: string
  board?: { sub_model?: string; parent_model?: string; release?: { version?: string } }
}

export function DiscoverModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { reloadRadios, notify, guard, radios } = useApp()
  const [subnets, setSubnets] = useState<{ iface: string; address: string; cidr: string }[]>([])
  const [cidr, setCidr] = useState('')
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [found, setFound] = useState<Discovered[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())

  useEffect(() => {
    void window.api.discovery.subnets().then((s) => {
      setSubnets(s)
      // Mesh Rider radios ship on 10.223.x.x, so prefer an interface already on that network.
      const doodle = s.find((x) => x.address.startsWith('10.223.'))
      setCidr(doodle?.cidr ?? s[0]?.cidr ?? '10.223.0.0/24')
    })
    const off = window.api.events.onDiscoveryProgress((p) => {
      setProgress({ done: p.done, total: p.total })
      if (p.found) setFound((f) => [...f, p.found as Discovered])
    })
    return off
  }, [])

  const known = new Set(radios.map((r) => r.host))

  const scan = async (): Promise<void> => {
    setFound([])
    setPicked(new Set())
    setProgress({ done: 0, total: 0 })
    setScanning(true)
    const res = await guard('Scan failed', async () => window.api.discovery.scan(cidr))
    setScanning(false)
    if (res) {
      const list = res as Discovered[]
      setFound(list)
      // Pre-tick everything not already in the inventory.
      setPicked(new Set(list.filter((d) => !known.has(d.host)).map((d) => d.host)))
      notify(list.length ? 'ok' : 'warn', `Scan complete`, `${list.length} radio(s) found on ${cidr}`)
    }
  }

  const cancel = async (): Promise<void> => {
    await window.api.discovery.cancel()
    setScanning(false)
  }

  const addPicked = async (): Promise<void> => {
    const toAdd = found.filter((d) => picked.has(d.host) && !known.has(d.host))
    if (!toAdd.length) return
    const res = await guard('Could not add radios', async () =>
      window.api.radios.addMany(toAdd.map((d) => ({ host: d.host, name: d.hostname || d.host })))
    )
    if (res) {
      await reloadRadios()
      notify('ok', `Added ${res.length} radio(s)`)
      onClose()
    }
  }

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0
  const newCount = found.filter((d) => picked.has(d.host) && !known.has(d.host)).length

  return (
    <Modal
      title="Discover radios"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={addPicked} disabled={newCount === 0}>
            Add {newCount} radio{newCount === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <div className="callout info">
        Scans the subnet for hosts answering on the web port, then confirms each is a Mesh Rider
        radio by calling <code>system.board</code> over ubus.
      </div>

      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <Field label="Subnet to scan">
            <input
              className="input mono"
              value={cidr}
              onChange={(e) => setCidr(e.target.value)}
              placeholder="10.223.0.0/24"
              disabled={scanning}
            />
          </Field>
        </div>
        {scanning ? (
          <button className="btn danger" onClick={cancel} style={{ marginBottom: 12 }}>
            Stop
          </button>
        ) : (
          <button className="btn primary" onClick={scan} style={{ marginBottom: 12 }}>
            Scan
          </button>
        )}
      </div>

      {subnets.length > 0 && !scanning && (
        <div className="row wrap" style={{ marginBottom: 12, gap: 6 }}>
          {subnets.map((s) => (
            <button key={s.cidr + s.iface} className="btn sm ghost" onClick={() => setCidr(s.cidr)}>
              {s.iface} · {s.cidr}
            </button>
          ))}
        </div>
      )}

      {scanning && (
        <div style={{ marginBottom: 12 }}>
          <div className="row" style={{ marginBottom: 5, fontSize: 12, color: 'var(--text-dim)' }}>
            <Spinner />
            <span>
              Probing {progress.done} of {progress.total} addresses…
            </span>
            <div className="spacer" />
            <span>{found.length} found</span>
          </div>
          <div style={{ height: 4, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', transition: 'width .2s' }} />
          </div>
        </div>
      )}

      {found.length > 0 && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 34 }} />
                <th>Address</th>
                <th>Hostname</th>
                <th>Model</th>
                <th>Firmware</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {found.map((d) => {
                const already = known.has(d.host)
                return (
                  <tr key={d.host}>
                    <td>
                      <input
                        type="checkbox"
                        checked={picked.has(d.host)}
                        disabled={already}
                        onChange={(e) => {
                          const next = new Set(picked)
                          e.target.checked ? next.add(d.host) : next.delete(d.host)
                          setPicked(next)
                        }}
                      />
                    </td>
                    <td className="mono">{d.host}</td>
                    <td>{d.hostname ?? '—'}</td>
                    <td>{d.board?.sub_model ?? d.board?.parent_model ?? '—'}</td>
                    <td className="mono">{d.board?.release?.version ?? '—'}</td>
                    <td>
                      {already ? (
                        <span className="badge">already added</span>
                      ) : d.authOk ? (
                        <span className="badge ok">reachable</span>
                      ) : (
                        <span className="badge warn" title={d.error}>
                          auth failed
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!scanning && found.length === 0 && progress.total > 0 && (
        <div className="empty">No radios answered on {cidr}.</div>
      )}
    </Modal>
  )
}
