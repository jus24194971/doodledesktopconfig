/**
 * Find Mesh Rider radios on the local network.
 *
 * Two stages: a fast TCP sweep for anything listening on the web port, then a ubus probe to
 * confirm the host is actually a Doodle Labs radio rather than some other device.
 */
import net from 'node:net'
import os from 'node:os'
import { UbusClient } from './ubus.js'
import type { BoardInfo, Credentials } from '../shared/types.js'

export interface DiscoveredRadio {
  host: string
  reachable: boolean
  identified: boolean
  authOk: boolean
  board?: BoardInfo
  hostname?: string
  error?: string
}

export interface DiscoverOptions {
  /** CIDR such as "10.223.0.0/24", or a bare "10.223.0" prefix. */
  cidr: string
  credentials: Credentials
  port?: number
  connectTimeoutMs?: number
  concurrency?: number
  preferHttp?: boolean
  onProgress?: (done: number, total: number, found: DiscoveredRadio | null) => void
  signal?: AbortSignal
}

/** IPv4 addresses of this machine's own interfaces, for suggesting a subnet to scan. */
export function localSubnets(): { iface: string; address: string; cidr: string }[] {
  const out: { iface: string; address: string; cidr: string }[] = []
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const bits = maskToBits(a.netmask)
      const base = applyMask(a.address, a.netmask)
      out.push({ iface, address: a.address, cidr: `${base}/${bits}` })
    }
  }
  return out
}

function maskToBits(mask: string): number {
  return mask
    .split('.')
    .map((o) => (Number(o) >>> 0).toString(2).padStart(8, '0'))
    .join('')
    .split('')
    .filter((c) => c === '1').length
}

function applyMask(ip: string, mask: string): string {
  const a = ip.split('.').map(Number)
  const m = mask.split('.').map(Number)
  return a.map((o, i) => o & m[i]).join('.')
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

/** Expand a CIDR (or a bare three-octet prefix) into host addresses. */
export function expandCidr(cidr: string): string[] {
  let base: string
  let bits: number

  if (cidr.includes('/')) {
    const [b, p] = cidr.split('/')
    base = b.trim()
    bits = Number(p)
  } else {
    const octets = cidr.trim().split('.').filter(Boolean)
    if (octets.length === 3) {
      base = `${octets.join('.')}.0`
      bits = 24
    } else if (octets.length === 4) {
      return [octets.join('.')]
    } else {
      throw new Error(`Cannot parse "${cidr}" as a subnet`)
    }
  }

  if (!Number.isFinite(bits) || bits < 8 || bits > 32) {
    throw new Error(`Prefix /${bits} is out of range (expected /8 to /32)`)
  }
  const size = 2 ** (32 - bits)
  if (size > 65536) {
    throw new Error(`/${bits} covers ${size} addresses; narrow the range to /16 or smaller`)
  }

  const start = ipToInt(base) & (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0)
  const hosts: string[] = []
  // Skip the network and broadcast addresses for anything wider than a /31.
  const first = size > 2 ? start + 1 : start
  const last = size > 2 ? start + size - 2 : start + size - 1
  for (let n = first; n <= last; n++) hosts.push(intToIp(n))
  return hosts
}

/** Is anything accepting TCP connections on this host:port? */
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, host)
  })
}

/** Confirm a host is a Mesh Rider radio, and whether our credentials work on it. */
export async function identify(
  host: string,
  creds: Credentials,
  opts: { timeoutMs?: number; preferHttp?: boolean } = {}
): Promise<DiscoveredRadio> {
  const client = new UbusClient({
    host,
    username: creds.username,
    password: creds.password,
    timeoutMs: opts.timeoutMs ?? 6000,
    preferHttp: opts.preferHttp
  })
  try {
    const board = await client.call<BoardInfo>('system', 'board')
    const isDoodle =
      /doodle/i.test(board.model ?? '') ||
      /doodle/i.test(board.release?.distribution ?? '') ||
      /smartradio/i.test(board.board_name ?? '') ||
      /smartradio/i.test(board.hostname ?? '')
    return {
      host,
      reachable: true,
      identified: isDoodle,
      authOk: true,
      board,
      hostname: board.hostname
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // A rejected login still proves something is answering /ubus — almost certainly a radio
    // with different credentials, which is worth reporting.
    const authFailed = /login|denied|password|auth/i.test(message)
    return {
      host,
      reachable: true,
      identified: authFailed,
      authOk: false,
      error: message
    }
  }
}

export async function discover(opts: DiscoverOptions): Promise<DiscoveredRadio[]> {
  const port = opts.port ?? (opts.preferHttp ? 80 : 443)
  const connectTimeoutMs = opts.connectTimeoutMs ?? 700
  const concurrency = opts.concurrency ?? 64
  const hosts = expandCidr(opts.cidr)
  const found: DiscoveredRadio[] = []

  let index = 0
  let done = 0

  const worker = async (): Promise<void> => {
    while (index < hosts.length) {
      if (opts.signal?.aborted) return
      const host = hosts[index++]
      let hit: DiscoveredRadio | null = null
      try {
        if (await tcpProbe(host, port, connectTimeoutMs)) {
          const res = await identify(host, opts.credentials, {
            timeoutMs: 6000,
            preferHttp: opts.preferHttp
          })
          if (res.identified || res.authOk) {
            found.push(res)
            hit = res
          }
        }
      } catch {
        /* a host that fails to probe is simply not a radio */
      }
      done++
      opts.onProgress?.(done, hosts.length, hit)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker))
  return found.sort((a, b) => ipToInt(a.host) - ipToInt(b.host))
}
