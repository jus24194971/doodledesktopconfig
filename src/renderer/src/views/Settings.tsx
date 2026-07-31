import React, { useEffect, useState } from 'react'
import { useApp } from '../state'
import { Field, Panel, Spinner, Toggle } from '../components/ui'
import type { AppSettings } from '@shared/types'

export function Settings(): React.JSX.Element {
  const { settings, reloadSettings, reloadRadios, notify, guard } = useApp()
  const [draft, setDraft] = useState<AppSettings | null>(settings)
  const [busy, setBusy] = useState(false)

  useEffect(() => setDraft(settings), [settings])

  if (!draft) {
    return (
      <div className="row" style={{ padding: 24 }}>
        <Spinner /> Loading settings…
      </div>
    )
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    const next = await guard('Could not save settings', async () =>
      window.api.settings.update(draft)
    )
    setBusy(false)
    if (next) {
      await reloadSettings()
      notify('ok', 'Settings saved', 'Sessions were reset so the new values take effect now')
    }
  }

  const patch = (p: Partial<AppSettings>): void => setDraft({ ...draft, ...p })

  return (
    <>
      <Panel title="Default credentials" note="used for any radio without its own override">
        <div className="callout info">
          Mesh Rider firmware from June 2024 onward defaults to{' '}
          <code>user / DoodleSmartRadio</code> for JSON-RPC. Older builds use{' '}
          <code>root / DoodleSmartRadio</code>. SSH always authenticates as a real shell account,
          normally <code>root</code>.
        </div>
        <div className="grid c2">
          <Field label="JSON-RPC username">
            <input
              className="input mono"
              value={draft.defaultCredentials.username}
              onChange={(e) =>
                patch({ defaultCredentials: { ...draft.defaultCredentials, username: e.target.value } })
              }
            />
          </Field>
          <Field label="JSON-RPC password">
            <input
              className="input mono"
              type="password"
              value={draft.defaultCredentials.password}
              onChange={(e) =>
                patch({ defaultCredentials: { ...draft.defaultCredentials, password: e.target.value } })
              }
            />
          </Field>
          <Field label="SSH username" hint="Defaults to root when blank.">
            <input
              className="input mono"
              value={draft.defaultCredentials.sshUsername ?? ''}
              placeholder="root"
              onChange={(e) =>
                patch({ defaultCredentials: { ...draft.defaultCredentials, sshUsername: e.target.value } })
              }
            />
          </Field>
          <Field label="SSH password" hint="Falls back to the JSON-RPC password when blank.">
            <input
              className="input mono"
              type="password"
              value={draft.defaultCredentials.sshPassword ?? ''}
              placeholder="(same as above)"
              onChange={(e) =>
                patch({ defaultCredentials: { ...draft.defaultCredentials, sshPassword: e.target.value } })
              }
            />
          </Field>
        </div>
      </Panel>

      <Panel title="Connection">
        <div className="grid c3">
          <Field label="Poll interval (ms)" hint="How often the dashboard refreshes visible radios.">
            <input
              className="input mono"
              type="number"
              min={500}
              value={draft.pollIntervalMs}
              onChange={(e) => patch({ pollIntervalMs: Number(e.target.value) || 3000 })}
            />
          </Field>
          <Field label="Request timeout (ms)" hint="Raise this on slow or long-range links.">
            <input
              className="input mono"
              type="number"
              min={1000}
              value={draft.requestTimeoutMs}
              onChange={(e) => patch({ requestTimeoutMs: Number(e.target.value) || 10000 })}
            />
          </Field>
          <Field label="Fleet concurrency" hint="How many radios are contacted at once.">
            <input
              className="input mono"
              type="number"
              min={1}
              max={64}
              value={draft.bulkConcurrency}
              onChange={(e) => patch({ bulkConcurrency: Number(e.target.value) || 8 })}
            />
          </Field>
        </div>

        <div style={{ marginTop: 4 }}>
          <Toggle
            checked={draft.preferHttp}
            onChange={(v) => patch({ preferHttp: v })}
            label="Use plain HTTP instead of HTTPS"
          />
          <div className="hint" style={{ marginLeft: 42 }}>
            Radios normally serve JSON-RPC over HTTPS with a self-signed certificate, which this app
            accepts. Only enable HTTP if a radio has TLS disabled.
          </div>
        </div>
      </Panel>

      <Panel title="Downloads">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <Field label="Download folder" hint="Where logs and diagnostic bundles are written.">
              <input
                className="input mono"
                value={draft.downloadDir ?? ''}
                placeholder="(system Downloads/MeshRider)"
                onChange={(e) => patch({ downloadDir: e.target.value })}
              />
            </Field>
          </div>
          <button
            className="btn"
            style={{ marginBottom: 12 }}
            onClick={async () => {
              const dir = await window.api.settings.pickDownloadDir()
              if (dir) {
                patch({ downloadDir: dir })
                await reloadSettings()
              }
            }}
          >
            Browse…
          </button>
          <button
            className="btn"
            style={{ marginBottom: 12 }}
            onClick={() => void window.api.logs.openFolder()}
          >
            Open
          </button>
        </div>
      </Panel>

      <Panel title="Appearance">
        <Field label="Theme">
          <select
            className="select"
            style={{ width: 200 }}
            value={draft.theme}
            onChange={(e) => patch({ theme: e.target.value as 'dark' | 'light' })}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </Field>
      </Panel>

      <Panel title="Inventory">
        <div className="row">
          <button
            className="btn"
            onClick={async () => {
              const p = await window.api.inventory.export()
              if (p) notify('ok', 'Inventory exported', p)
            }}
          >
            Export radios & scripts
          </button>
          <button
            className="btn"
            onClick={async () => {
              const res = await window.api.inventory.import()
              if (res) {
                await reloadRadios()
                notify('ok', 'Inventory imported', `${res.radios.length} radios in the list`)
              }
            }}
          >
            Import…
          </button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          Exports include per-radio credential overrides in plain text. Treat the file accordingly.
        </div>
      </Panel>

      <div className="row end" style={{ gap: 8 }}>
        <button className="btn" onClick={() => setDraft(settings)}>
          Discard
        </button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy && <Spinner />}
          Save settings
        </button>
      </div>
    </>
  )
}
