import type { LinkState, StationInfo } from '@shared/types'

export function bytes(n?: number): string {
  if (n == null) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function duration(seconds?: number): string {
  if (seconds == null) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

export function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const parsed = Number.parseFloat(v)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function str(v: unknown): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return undefined
}

/**
 * Pull a value from a link-state object by trying several key spellings.
 * Field names drift between firmware releases, so nothing can be assumed.
 */
export function pick(obj: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined
  for (const k of keys) {
    if (obj[k] != null) return obj[k]
    // Try a case/underscore-insensitive match as a fallback.
    const norm = k.toLowerCase().replace(/[_\s-]/g, '')
    for (const actual of Object.keys(obj)) {
      if (actual.toLowerCase().replace(/[_\s-]/g, '') === norm && obj[actual] != null) {
        return obj[actual]
      }
    }
  }
  return undefined
}

/** RSSI can arrive as a scalar or as a per-chain array; reduce to the strongest chain. */
export function rssiOf(station: StationInfo): number | undefined {
  const raw = pick(station as Record<string, unknown>, 'rssi', 'signal', 'signal_dbm')
  if (Array.isArray(raw)) {
    const nums = raw.map(num).filter((n): n is number => n != null && n !== 0)
    return nums.length ? Math.max(...nums) : undefined
  }
  return num(raw)
}

/** Stations live under different keys depending on firmware. */
export function stationsOf(link: LinkState | null | undefined): StationInfo[] {
  if (!link) return []
  const raw = pick(link as Record<string, unknown>, 'stations', 'station', 'assoclist', 'sta')
  if (Array.isArray(raw)) return raw as StationInfo[]
  // Some builds emit an object keyed by MAC.
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, StationInfo>).map(([mac, v]) => ({ mac, ...v }))
  }
  return []
}

export function meshOf(link: LinkState | null | undefined): Record<string, unknown>[] {
  if (!link) return []
  const raw = pick(link as Record<string, unknown>, 'mesh', 'mesh_stats', 'originators', 'batman')
  if (Array.isArray(raw)) return raw as Record<string, unknown>[]
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, Record<string, unknown>>).map(([k, v]) => ({
      orig_address: k,
      ...v
    }))
  }
  return []
}

export function macOf(s: StationInfo): string {
  return str(pick(s as Record<string, unknown>, 'mac', 'address', 'bssid')) ?? '—'
}

export function mcsOf(s: StationInfo, dir: 'tx' | 'rx'): string {
  const nested = (s as Record<string, unknown>)[dir]
  if (nested && typeof nested === 'object') {
    const m = pick(nested as Record<string, unknown>, 'mcs')
    const rate = pick(nested as Record<string, unknown>, 'rate')
    if (m != null) return `MCS ${m}${rate != null ? ` · ${(num(rate) ?? 0) / 1000} Mbps` : ''}`
  }
  const flat = pick(s as Record<string, unknown>, `${dir}_mcs`, `${dir}mcs`)
  if (flat != null) return `MCS ${flat}`
  return '—'
}

/** Colour tone for an RSSI reading. */
export function rssiTone(rssi?: number): 'ok' | 'warn' | 'err' | undefined {
  if (rssi == null) return undefined
  if (rssi >= -65) return 'ok'
  if (rssi >= -80) return 'warn'
  return 'err'
}

export function timeAgo(ts?: number): string {
  if (!ts) return 'never'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

/** Bandwidth options offered by Mesh Rider OS. */
export const BANDWIDTHS = ['3', '5', '10', '15', '20', '26', '40'] as const

/** DFS-free, commonly used mesh channel widths paired with a human label. */
export function bandwidthLabel(bw: string): string {
  return `${bw} MHz`
}
