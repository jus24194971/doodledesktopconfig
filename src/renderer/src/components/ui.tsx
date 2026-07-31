import React, { useEffect, useState } from 'react'
import type { ApplyResult, ApplyStep } from '@shared/types'

export function Panel({
  title,
  note,
  actions,
  children,
  tight
}: {
  title?: string
  note?: string
  actions?: React.ReactNode
  children: React.ReactNode
  tight?: boolean
}): React.JSX.Element {
  return (
    <section className="panel">
      {(title || actions) && (
        <header className="panel-head">
          <div>
            <span className="panel-title">{title}</span>
            {note && <span className="panel-note"> — {note}</span>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      <div className={tight ? 'panel-body tight' : 'panel-body'}>{children}</div>
    </section>
  )
}

export function Stat({
  label,
  value,
  unit,
  sub,
  tone
}: {
  label: string
  value: React.ReactNode
  unit?: string
  sub?: React.ReactNode
  tone?: 'ok' | 'warn' | 'err'
}): React.JSX.Element {
  const color = tone ? `var(--${tone})` : undefined
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color }}>
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {sub !== undefined && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="field">
      <label className="label">{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: React.ReactNode
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div
      className="switch"
      role="switch"
      aria-checked={checked}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onChange(!checked)}
      onKeyDown={(e) => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onChange(!checked)
        }
      }}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
    >
      <span className={checked ? 'switch-track on' : 'switch-track'}>
        <span className="switch-knob" />
      </span>
      {label && <span>{label}</span>}
    </div>
  )
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  wide?: boolean
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={wide ? 'modal wide' : 'modal'} role="dialog" aria-modal="true">
        <div className="modal-head">{title}</div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Empty({
  title,
  children
}: {
  title: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children}
    </div>
  )
}

export function Spinner(): React.JSX.Element {
  return <span className="spin" aria-label="loading" />
}

/** Five-bar signal meter. RSSI is in dBm; anything at or below -95 reads as no signal. */
export function SignalBars({ rssi }: { rssi?: number | null }): React.JSX.Element {
  const level =
    rssi == null || rssi <= -95
      ? 0
      : rssi >= -50
        ? 5
        : rssi >= -60
          ? 4
          : rssi >= -70
            ? 3
            : rssi >= -80
              ? 2
              : 1
  const tone = level >= 4 ? '' : level === 3 ? ' mid' : ' low'
  return (
    <span className="bars" title={rssi != null ? `${rssi} dBm` : 'no signal'}>
      {[0, 1, 2, 3, 4].map((i) => (
        <i
          key={i}
          className={i < level ? `on${tone}` : ''}
          style={{ height: `${4 + i * 2.2}px` }}
        />
      ))}
    </span>
  )
}

/** Renders the step-by-step outcome of an applyUci run, so failures are never silent. */
export function ApplyLog({ result }: { result: ApplyResult | null }): React.JSX.Element | null {
  if (!result) return null
  return (
    <div className="term" style={{ maxHeight: 260 }}>
      {result.steps.map((s: ApplyStep, i) => (
        <div key={i}>
          <span className={s.ok ? 't-ok' : 't-err'}>{s.ok ? '✓' : '✗'}</span>{' '}
          <span>{s.label}</span>
          {s.tolerated && <span className="t-dim"> (session dropped — expected)</span>}
          <div className="t-dim" style={{ paddingLeft: 16 }}>
            $ {s.command}
          </div>
          {s.stdout && <div style={{ paddingLeft: 16 }}>{s.stdout}</div>}
          {s.stderr && (
            <div className="t-err" style={{ paddingLeft: 16 }}>
              {s.stderr}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** A save button that shows in-flight and recently-saved states. */
export function SaveButton({
  onClick,
  busy,
  dirty,
  children
}: {
  onClick: () => void
  busy?: boolean
  dirty?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <button className="btn primary" onClick={onClick} disabled={busy || !dirty}>
      {busy && <Spinner />}
      {children ?? (busy ? 'Applying…' : 'Apply & commit')}
    </button>
  )
}

/** Confirmation gate for destructive actions; requires typing the exact phrase. */
export function ConfirmPhrase({
  phrase,
  onConfirm,
  onCancel,
  title,
  body
}: {
  phrase: string
  onConfirm: () => void
  onCancel: () => void
  title: string
  body: React.ReactNode
}): React.JSX.Element {
  const [typed, setTyped] = useState('')
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" disabled={typed !== phrase} onClick={onConfirm}>
            Confirm
          </button>
        </>
      }
    >
      {body}
      <Field label={`Type “${phrase}” to continue`}>
        <input
          className="input mono"
          value={typed}
          autoFocus
          onChange={(e) => setTyped(e.target.value)}
          placeholder={phrase}
        />
      </Field>
    </Modal>
  )
}
