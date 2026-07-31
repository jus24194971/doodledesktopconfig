import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { AppSettings, RadioRecord, RadioStatus } from '@shared/types'

export interface Toast {
  id: number
  kind: 'ok' | 'err' | 'warn' | 'info'
  title: string
  message?: string
}

interface AppState {
  radios: RadioRecord[]
  statuses: Record<string, RadioStatus>
  settings: AppSettings | null
  /** The radio whose detail pages are on screen. */
  activeId: string | null
  /** Radios ticked for fleet-wide operations. */
  selectedIds: string[]
  toasts: Toast[]

  setActive: (id: string | null) => void
  toggleSelected: (id: string) => void
  setSelected: (ids: string[]) => void
  reloadRadios: () => Promise<void>
  reloadSettings: () => Promise<void>
  notify: (kind: Toast['kind'], title: string, message?: string) => void
  dismissToast: (id: number) => void
  /** Run an async action, turning any throw into an error toast. */
  guard: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>
}

const Ctx = createContext<AppState | null>(null)

export function useApp(): AppState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>')
  return ctx
}

/** The currently active radio record, or null. */
export function useActiveRadio(): RadioRecord | null {
  const { radios, activeId } = useApp()
  return useMemo(() => radios.find((r) => r.id === activeId) ?? null, [radios, activeId])
}

export function useActiveStatus(): RadioStatus | null {
  const { statuses, activeId } = useApp()
  return activeId ? (statuses[activeId] ?? null) : null
}

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [radios, setRadios] = useState<RadioRecord[]>([])
  const [statuses, setStatuses] = useState<Record<string, RadioStatus>>({})
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(1)

  const notify = useCallback((kind: Toast['kind'], title: string, message?: string) => {
    const id = toastId.current++
    setToasts((t) => [...t, { id, kind, title, message }])
    // Errors linger; everything else clears itself.
    const ttl = kind === 'err' ? 9000 : 4000
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])

  const guard = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn()
      } catch (err) {
        notify('err', label, err instanceof Error ? err.message : String(err))
        return undefined
      }
    },
    [notify]
  )

  const reloadRadios = useCallback(async () => {
    const [list, sts] = await Promise.all([window.api.radios.list(), window.api.radios.statuses()])
    setRadios(list)
    setStatuses(Object.fromEntries(sts.map((s) => [s.id, s])))
    setActiveId((cur) => (cur && list.some((r) => r.id === cur) ? cur : (list[0]?.id ?? null)))
    setSelectedIds((cur) => cur.filter((id) => list.some((r) => r.id === id)))
  }, [])

  const reloadSettings = useCallback(async () => {
    setSettings(await window.api.settings.get())
  }, [])

  useEffect(() => {
    void reloadRadios()
    void reloadSettings()

    const offStatus = window.api.events.onStatus((s) => {
      setStatuses((prev) => ({ ...prev, [s.id]: s }))
    })
    const offList = window.api.events.onRadioList((list) => setRadios(list))
    return () => {
      offStatus()
      offList()
    }
  }, [reloadRadios, reloadSettings])

  // Only poll what the user can actually see, plus anything ticked for fleet actions.
  useEffect(() => {
    const ids = Array.from(new Set([activeId, ...selectedIds].filter(Boolean) as string[]))
    void window.api.radios.watch(ids)
  }, [activeId, selectedIds])

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }, [])

  const value = useMemo<AppState>(
    () => ({
      radios,
      statuses,
      settings,
      activeId,
      selectedIds,
      toasts,
      setActive: setActiveId,
      toggleSelected,
      setSelected: setSelectedIds,
      reloadRadios,
      reloadSettings,
      notify,
      dismissToast,
      guard
    }),
    [
      radios,
      statuses,
      settings,
      activeId,
      selectedIds,
      toasts,
      toggleSelected,
      reloadRadios,
      reloadSettings,
      notify,
      dismissToast,
      guard
    ]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
