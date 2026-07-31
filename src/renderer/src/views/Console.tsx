import React, { useEffect, useRef, useState } from 'react'
import { useActiveRadio, useApp } from '../state'
import { Empty, Field, Modal, Panel, Spinner } from '../components/ui'
import type { BulkOutcome, ExecResult, ScriptRecord } from '@shared/types'

interface RunEntry {
  id: number
  command: string
  transport: 'ubus' | 'ssh'
  targets: { radioId: string; host: string; name: string }[]
  results: Record<string, { ok: boolean; out: string; ms?: number }>
  running: boolean
}

/** Handy one-liners so the console is useful before anyone writes their own scripts. */
const SNIPPETS: { label: string; command: string }[] = [
  { label: 'Link state', command: 'cat /tmp/linkstate_current.json' },
  { label: 'Radio info', command: 'iw dev wlan0 info' },
  { label: 'Peers', command: 'iwinfo wlan0 assoclist' },
  { label: 'Mesh table', command: 'batctl o' },
  { label: 'Channel list', command: 'iwinfo wlan0 freqlist' },
  { label: 'Model / band', command: 'fes_model.sh get parent; fes_model.sh get' },
  { label: 'Pending UCI', command: 'uci changes' },
  { label: 'Wireless UCI', command: 'uci show wireless' },
  { label: 'Uptime & load', command: 'uptime; cat /proc/loadavg' },
  { label: 'Noise scan', command: 'switch-scan-new.sh && cat /tmp/scan_results' }
]

export function Console(): React.JSX.Element {
  const radio = useActiveRadio()
  const { radios, selectedIds, statuses, notify, guard } = useApp()

  const [command, setCommand] = useState('')
  const [transport, setTransport] = useState<'ubus' | 'ssh'>('ubus')
  const [scope, setScope] = useState<'active' | 'selected'>('active')
  const [history, setHistory] = useState<RunEntry[]>([])
  const [scripts, setScripts] = useState<ScriptRecord[]>([])
  const [showSave, setShowSave] = useState(false)
  const [running, setRunning] = useState(false)
  const [recall, setRecall] = useState(-1)
  const runId = useRef(1)
  const outRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.api.scripts.list().then(setScripts)
  }, [])

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight, behavior: 'smooth' })
  }, [history])

  const targetIds =
    scope === 'selected' ? selectedIds : radio ? [radio.id] : []

  const targets = targetIds
    .map((id) => radios.find((r) => r.id === id))
    .filter((r): r is NonNullable<typeof r> => r != null)
    .map((r) => ({ radioId: r.id, host: r.host, name: r.name || r.host }))

  const run = async (): Promise<void> => {
    const cmd = command.trim()
    if (!cmd || !targets.length || running) return

    const entry: RunEntry = {
      id: runId.current++,
      command: cmd,
      transport,
      targets,
      results: {},
      running: true
    }
    setHistory((h) => [...h, entry])
    setRunning(true)
    setRecall(-1)

    const finish = (results: RunEntry['results']): void => {
      setHistory((h) => h.map((e) => (e.id === entry.id ? { ...e, results, running: false } : e)))
    }

    if (transport === 'ssh') {
      const results: RunEntry['results'] = {}
      await Promise.all(
        targets.map(async (t) => {
          const started = Date.now()
          try {
            const r: ExecResult = await window.api.ssh.exec(t.radioId, cmd)
            results[t.radioId] = {
              ok: r.code === 0,
              out: r.stdout || r.stderr || '(no output)',
              ms: Date.now() - started
            }
          } catch (err) {
            results[t.radioId] = {
              ok: false,
              out: err instanceof Error ? err.message : String(err),
              ms: Date.now() - started
            }
          }
        })
      )
      finish(results)
    } else {
      const outcomes = await guard('Command failed', async () =>
        window.api.exec.bulk(
          targets.map((t) => t.radioId),
          cmd
        )
      )
      const results: RunEntry['results'] = {}
      for (const o of (outcomes ?? []) as BulkOutcome<ExecResult>[]) {
        results[o.radioId] = {
          ok: o.ok && (o.value?.code ?? 1) === 0,
          out: o.ok
            ? o.value?.stdout || o.value?.stderr || '(no output)'
            : (o.error ?? 'failed'),
          ms: o.durationMs
        }
      }
      finish(results)
    }

    setRunning(false)
    setCommand('')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter runs; Shift+Enter inserts a newline for multi-line scripts.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void run()
      return
    }
    if (e.key === 'ArrowUp' && !command.includes('\n')) {
      const prev = history.filter((h) => h.command)
      if (!prev.length) return
      const next = recall < 0 ? prev.length - 1 : Math.max(0, recall - 1)
      e.preventDefault()
      setRecall(next)
      setCommand(prev[next].command)
    }
    if (e.key === 'ArrowDown' && recall >= 0) {
      const prev = history.filter((h) => h.command)
      const next = recall + 1
      e.preventDefault()
      if (next >= prev.length) {
        setRecall(-1)
        setCommand('')
      } else {
        setRecall(next)
        setCommand(prev[next].command)
      }
    }
  }

  const saveScript = async (name: string, description: string): Promise<void> => {
    const rec = await guard('Could not save script', async () =>
      window.api.scripts.save({ id: `script_${Date.now().toString(36)}`, name, body: command, description })
    )
    if (rec) {
      setScripts(await window.api.scripts.list())
      notify('ok', 'Script saved', name)
      setShowSave(false)
    }
  }

  const removeScript = async (id: string): Promise<void> => {
    const list = await guard('Could not delete script', async () => window.api.scripts.remove(id))
    if (list) setScripts(list)
  }

  const offline = targets.filter((t) => statuses[t.radioId]?.state !== 'online')

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: '1fr 250px', gap: 14, alignItems: 'start' }}>
        <div>
          <Panel
            title="Output"
            note={`${history.length} run${history.length === 1 ? '' : 's'}`}
            actions={
              <button className="btn sm ghost" onClick={() => setHistory([])} disabled={!history.length}>
                Clear
              </button>
            }
          >
            <div className="term" style={{ height: '46vh' }} ref={outRef}>
              {history.length === 0 && (
                <span className="t-dim">
                  Commands run through ubus <code>file exec</code> by default — no SSH needed.{'\n'}
                  Enter runs, Shift+Enter adds a line, Up recalls history.
                </span>
              )}
              {history.map((h) => (
                <div key={h.id} style={{ marginBottom: 12 }}>
                  <div>
                    <span className="t-cmd">$ </span>
                    <span>{h.command}</span>
                    <span className="t-dim">
                      {'  '}
                      [{h.transport}
                      {h.targets.length > 1 ? ` · ${h.targets.length} radios` : ''}]
                    </span>
                  </div>
                  {h.running && (
                    <div className="t-dim">
                      <Spinner /> running…
                    </div>
                  )}
                  {h.targets.map((t) => {
                    const r = h.results[t.radioId]
                    if (!r) return null
                    return (
                      <div key={t.radioId} style={{ marginTop: 4 }}>
                        {h.targets.length > 1 && (
                          <div>
                            <span className="t-host">┌─ {t.name}</span>
                            <span className="t-dim"> ({t.host})</span>
                            <span className={r.ok ? 't-ok' : 't-err'}> {r.ok ? '✓' : '✗'}</span>
                            {r.ms != null && <span className="t-dim"> {r.ms}ms</span>}
                          </div>
                        )}
                        <div className={r.ok ? '' : 't-err'}>{r.out}</div>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>

            <div style={{ marginTop: 12 }}>
              <div className="row" style={{ marginBottom: 7 }}>
                <select
                  className="select"
                  style={{ width: 'auto' }}
                  value={scope}
                  onChange={(e) => setScope(e.target.value as 'active' | 'selected')}
                >
                  <option value="active">Active radio{radio ? ` — ${radio.name || radio.host}` : ''}</option>
                  <option value="selected">Selected ({selectedIds.length})</option>
                </select>
                <select
                  className="select"
                  style={{ width: 'auto' }}
                  value={transport}
                  onChange={(e) => setTransport(e.target.value as 'ubus' | 'ssh')}
                >
                  <option value="ubus">JSON-RPC (ubus)</option>
                  <option value="ssh">SSH (root)</option>
                </select>
                <div className="spacer" />
                <button className="btn sm" onClick={() => setShowSave(true)} disabled={!command.trim()}>
                  Save as script
                </button>
              </div>

              <textarea
                className="textarea mono"
                style={{ minHeight: 62 }}
                value={command}
                placeholder={targets.length ? 'Enter a shell command…' : 'Select a radio first'}
                disabled={!targets.length}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={onKeyDown}
              />

              <div className="row" style={{ marginTop: 7 }}>
                {offline.length > 0 && (
                  <span className="badge warn">
                    {offline.length} target{offline.length === 1 ? '' : 's'} offline
                  </span>
                )}
                <div className="spacer" />
                <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                  {targets.length} target{targets.length === 1 ? '' : 's'}
                </span>
                <button
                  className="btn primary"
                  onClick={run}
                  disabled={!command.trim() || !targets.length || running}
                >
                  {running && <Spinner />}
                  Run
                </button>
              </div>
            </div>
          </Panel>
        </div>

        <div>
          <Panel title="Snippets" tight>
            <div style={{ padding: 8 }}>
              {SNIPPETS.map((s) => (
                <button
                  key={s.label}
                  className="btn sm block"
                  style={{ justifyContent: 'flex-start', marginBottom: 4 }}
                  title={s.command}
                  onClick={() => setCommand(s.command)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="Saved scripts" tight>
            <div style={{ padding: 8 }}>
              {scripts.length === 0 ? (
                <div style={{ padding: 12, fontSize: 12, color: 'var(--text-faint)', textAlign: 'center' }}>
                  Write a command, then “Save as script”.
                </div>
              ) : (
                scripts.map((s) => (
                  <div key={s.id} className="row" style={{ marginBottom: 4 }}>
                    <button
                      className="btn sm"
                      style={{ flex: 1, justifyContent: 'flex-start' }}
                      title={s.description || s.body}
                      onClick={() => setCommand(s.body)}
                    >
                      {s.name}
                    </button>
                    <button
                      className="btn sm ghost"
                      title="Delete"
                      onClick={() => void removeScript(s.id)}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </Panel>
        </div>
      </div>

      {showSave && (
        <SaveScriptModal body={command} onClose={() => setShowSave(false)} onSave={saveScript} />
      )}
    </>
  )
}

function SaveScriptModal({
  body,
  onClose,
  onSave
}: {
  body: string
  onClose: () => void
  onSave: (name: string, description: string) => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  return (
    <Modal
      title="Save script"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => void onSave(name, description)}>
            Save
          </button>
        </>
      }
    >
      <Field label="Name">
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description" hint="Optional — shown as a tooltip in the script list.">
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Body">
        <div className="term" style={{ maxHeight: 160 }}>
          {body}
        </div>
      </Field>
    </Modal>
  )
}

export function ConsoleEmpty(): React.JSX.Element {
  return <Empty title="Nothing to run">Select a radio first.</Empty>
}
