import React, { useMemo, useState } from 'react'
import { useApp } from '../state'
import { AddRadioModal } from './AddRadioModal'
import { DiscoverModal } from './DiscoverModal'

export function Sidebar(): React.JSX.Element {
  const { radios, statuses, activeId, selectedIds, setActive, toggleSelected, setSelected } = useApp()
  const [showAdd, setShowAdd] = useState(false)
  const [showDiscover, setShowDiscover] = useState(false)
  const [filter, setFilter] = useState('')

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return radios
    return radios.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.host.toLowerCase().includes(q) ||
        (r.group ?? '').toLowerCase().includes(q)
    )
  }, [radios, filter])

  const onlineCount = radios.filter((r) => statuses[r.id]?.state === 'online').length
  const allShownSelected = shown.length > 0 && shown.every((r) => selectedIds.includes(r.id))

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <div className="brand-mark">MR</div>
          <div>
            <div className="brand-text">Mesh Rider</div>
            <div className="brand-sub">Configurator</div>
          </div>
        </div>
      </div>

      <div className="sidebar-actions">
        <button className="btn sm" onClick={() => setShowAdd(true)}>
          + Radio
        </button>
        <button className="btn sm" onClick={() => setShowDiscover(true)}>
          Scan
        </button>
        <div className="spacer" />
        <button
          className="btn sm ghost"
          title={allShownSelected ? 'Clear selection' : 'Select all'}
          onClick={() => setSelected(allShownSelected ? [] : shown.map((r) => r.id))}
        >
          {allShownSelected ? 'None' : 'All'}
        </button>
      </div>

      {radios.length > 6 && (
        <div style={{ padding: '8px 12px 0' }}>
          <input
            className="input"
            placeholder="Filter radios…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}

      <div className="radio-list">
        {radios.length === 0 && (
          <div style={{ padding: '28px 14px', textAlign: 'center', color: 'var(--text-faint)', fontSize: 12.5 }}>
            No radios yet.
            <br />
            <br />
            Add one by IP, or scan your subnet to find them automatically.
          </div>
        )}

        {shown.map((r) => {
          const st = statuses[r.id]
          const checked = selectedIds.includes(r.id)
          return (
            <div
              key={r.id}
              className={`radio-item${activeId === r.id ? ' active' : ''}${checked ? ' checked' : ''}`}
              onClick={() => setActive(r.id)}
            >
              <span
                className={`radio-check${checked ? ' on' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleSelected(r.id)
                }}
                title="Include in fleet actions"
              >
                {checked && (
                  <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6.5L4.5 9L10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className={`dot ${st?.state ?? 'unknown'}`} title={st?.error ?? st?.state ?? 'unknown'} />
              <div className="radio-meta">
                <div className="radio-name">{r.name || r.host}</div>
                <div className="radio-host">{r.host}</div>
              </div>
              {st?.latencyMs != null && st.state === 'online' && (
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>
                  {st.latencyMs}ms
                </span>
              )}
            </div>
          )
        })}
      </div>

      <div className="sidebar-foot">
        <span>
          {onlineCount}/{radios.length} online
        </span>
        {selectedIds.length > 0 && <span className="badge info">{selectedIds.length} selected</span>}
      </div>

      {showAdd && <AddRadioModal onClose={() => setShowAdd(false)} />}
      {showDiscover && <DiscoverModal onClose={() => setShowDiscover(false)} />}
    </aside>
  )
}
