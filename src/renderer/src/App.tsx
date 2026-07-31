import React, { useEffect, useState } from 'react'
import { AppProvider, useActiveRadio, useActiveStatus, useApp } from './state'
import { Sidebar } from './components/Sidebar'
import { Dashboard } from './views/Dashboard'
import { Wireless } from './views/Wireless'
import { Network } from './views/Network'
import { Qos } from './views/Qos'
import { Logs } from './views/Logs'
import { Console } from './views/Console'
import { Fleet } from './views/Fleet'
import { Maintenance } from './views/Maintenance'
import { Settings } from './views/Settings'
import { timeAgo } from './lib/format'

type TabId =
  | 'dashboard'
  | 'wireless'
  | 'network'
  | 'qos'
  | 'logs'
  | 'console'
  | 'fleet'
  | 'maintenance'
  | 'settings'

const TABS: { id: TabId; label: string; subtitle: string; scope: 'radio' | 'app' }[] = [
  { id: 'dashboard', label: 'Dashboard', subtitle: 'Live link and system status', scope: 'radio' },
  { id: 'wireless', label: 'Wireless', subtitle: 'Channel, bandwidth, power and mesh identity', scope: 'radio' },
  { id: 'network', label: 'Network', subtitle: 'Addressing, multicast and service control', scope: 'radio' },
  { id: 'qos', label: 'Traffic', subtitle: 'DiffServ prioritisation for control and video', scope: 'radio' },
  { id: 'logs', label: 'Logs', subtitle: 'Read, enable and download radio logs', scope: 'radio' },
  { id: 'console', label: 'Console', subtitle: 'Run commands and saved scripts on the fly', scope: 'app' },
  { id: 'fleet', label: 'Fleet', subtitle: 'Apply settings across many radios at once', scope: 'app' },
  { id: 'maintenance', label: 'Maintenance', subtitle: 'Details, scans, reboot and reset', scope: 'radio' },
  { id: 'settings', label: 'Settings', subtitle: 'Credentials, polling and downloads', scope: 'app' }
]

function Toasts(): React.JSX.Element {
  const { toasts, dismissToast } = useApp()
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismissToast(t.id)}>
          <div className="toast-title">{t.title}</div>
          {t.message && <div className="toast-msg">{t.message}</div>}
        </div>
      ))}
    </div>
  )
}

function Shell(): React.JSX.Element {
  const [tab, setTab] = useState<TabId>('dashboard')
  const radio = useActiveRadio()
  const status = useActiveStatus()
  const { settings } = useApp()

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings?.theme ?? 'dark')
  }, [settings?.theme])

  const meta = TABS.find((t) => t.id === tab)!

  const title =
    meta.scope === 'radio' && radio ? `${radio.name || radio.host} · ${meta.label}` : meta.label

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <nav className="tabbar">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={t.id === tab ? 'tab active' : 'tab'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="content">
          <div className="page-head">
            <div>
              <h1 className="page-title">{title}</h1>
              <div className="page-sub">{meta.subtitle}</div>
            </div>
            {meta.scope === 'radio' && radio && (
              <div className="row" style={{ flexShrink: 0 }}>
                <span className={`badge ${status?.state === 'online' ? 'ok' : status?.state === 'auth-error' ? 'err' : ''}`}>
                  <span className={`dot ${status?.state ?? 'unknown'}`} />
                  {status?.state ?? 'unknown'}
                </span>
                {status?.lastSeen && (
                  <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                    {timeAgo(status.lastSeen)}
                  </span>
                )}
              </div>
            )}
          </div>

          {tab === 'dashboard' && <Dashboard />}
          {tab === 'wireless' && <Wireless />}
          {tab === 'network' && <Network />}
          {tab === 'qos' && <Qos />}
          {tab === 'logs' && <Logs />}
          {tab === 'console' && <Console />}
          {tab === 'fleet' && <Fleet />}
          {tab === 'maintenance' && <Maintenance />}
          {tab === 'settings' && <Settings />}
        </div>
      </main>
      <Toasts />
    </div>
  )
}

export default function App(): React.JSX.Element {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}
