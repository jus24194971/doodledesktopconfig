/**
 * JSON-RPC / ubus client for Mesh Rider OS radios.
 *
 * Everything the radio exposes is reached over `POST https://<ip>/ubus`. The radio ships a
 * self-signed certificate, so TLS verification is disabled deliberately (this is exactly what
 * Doodle Labs' own `curl -k` / `verify=False` examples do).
 */
import https from 'node:https'
import http from 'node:http'
import { Buffer } from 'node:buffer'
import type { ExecResult } from '../shared/types.js'

/** The 32-zero null session, which may only call `session.login`. */
const NULL_SESSION = '00000000000000000000000000000000'

/** ubus status codes, as returned in `result[0]`. */
export const UBUS_ERRORS: Record<number, string> = {
  0: 'OK',
  1: 'Invalid command',
  2: 'Invalid argument',
  3: 'Method not found',
  4: 'Not found',
  5: 'No data',
  6: 'Permission denied',
  7: 'Timeout',
  8: 'Not supported',
  9: 'Unknown error',
  10: 'Connection failed',
  11: 'No memory',
  12: 'Parse error',
  13: 'System error'
}

export class UbusError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly kind: 'ubus' | 'rpc' | 'transport' | 'auth' = 'ubus'
  ) {
    super(message)
    this.name = 'UbusError'
  }
}

export interface UbusOptions {
  host: string
  username: string
  password: string
  timeoutMs?: number
  preferHttp?: boolean
}

interface RpcResponse {
  jsonrpc: string
  id: number | string
  result?: [number, unknown?]
  error?: { code: number; message: string }
}

/** A session token is valid for 300s and is refreshed on use; we re-login well before that. */
const SESSION_TTL_MS = 240_000

export class UbusClient {
  private token: string | null = null
  private tokenAt = 0
  private loginInFlight: Promise<string> | null = null
  private rpcId = 1

  host: string
  username: string
  password: string
  timeoutMs: number
  preferHttp: boolean

  constructor(opts: UbusOptions) {
    this.host = opts.host
    this.username = opts.username
    this.password = opts.password
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.preferHttp = opts.preferHttp ?? false
  }

  private get url(): string {
    const scheme = this.preferHttp ? 'http' : 'https'
    // Bare IPv6 literals need bracketing in a URL.
    const host = this.host.includes(':') && !this.host.startsWith('[') ? `[${this.host}]` : this.host
    return `${scheme}://${host}/ubus`
  }

  /** Drop the cached session, forcing a fresh login on the next call. */
  invalidate(): void {
    this.token = null
    this.tokenAt = 0
  }

  updateCredentials(username: string, password: string): void {
    if (username !== this.username || password !== this.password) {
      this.username = username
      this.password = password
      this.invalidate()
    }
  }

  private post(body: unknown, timeoutMs: number): Promise<RpcResponse> {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const isHttps = !this.preferHttp
    const mod = isHttps ? https : http

    return new Promise<RpcResponse>((resolve, reject) => {
      const req = mod.request(
        this.url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(payload.length)
          },
          // The radio uses a self-signed cert with no third-party CA.
          ...(isHttps ? { rejectUnauthorized: false } : {})
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (res.statusCode && res.statusCode >= 400) {
              reject(
                new UbusError(
                  `HTTP ${res.statusCode} from ${this.host}${text ? `: ${text.slice(0, 200)}` : ''}`,
                  res.statusCode,
                  'transport'
                )
              )
              return
            }
            try {
              resolve(JSON.parse(text) as RpcResponse)
            } catch {
              reject(
                new UbusError(
                  `Malformed JSON from ${this.host}: ${text.slice(0, 200)}`,
                  -1,
                  'transport'
                )
              )
            }
          })
        }
      )

      req.setTimeout(timeoutMs, () => {
        req.destroy(new UbusError(`Timed out after ${timeoutMs}ms contacting ${this.host}`, 7, 'transport'))
      })
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err instanceof UbusError) return reject(err)
        reject(new UbusError(`${err.code ?? 'ERR'}: ${err.message}`, -1, 'transport'))
      })
      req.end(payload)
    })
  }

  /** Log in and cache the session token. Concurrent callers share one in-flight login. */
  async login(force = false): Promise<string> {
    if (!force && this.token && Date.now() - this.tokenAt < SESSION_TTL_MS) return this.token
    if (this.loginInFlight) return this.loginInFlight

    this.loginInFlight = (async () => {
      const res = await this.post(
        {
          jsonrpc: '2.0',
          id: this.rpcId++,
          method: 'call',
          params: [
            NULL_SESSION,
            'session',
            'login',
            { username: this.username, password: this.password }
          ]
        },
        this.timeoutMs
      )

      if (res.error) {
        throw new UbusError(`Login rejected: ${res.error.message}`, res.error.code, 'auth')
      }
      const [status, data] = res.result ?? [9]
      if (status !== 0) {
        throw new UbusError(
          `Login failed (${UBUS_ERRORS[status] ?? status}). Check the username and password.`,
          status,
          'auth'
        )
      }
      const token = (data as { ubus_rpc_session?: string } | undefined)?.ubus_rpc_session
      if (!token) throw new UbusError('Login returned no session token', 9, 'auth')

      this.token = token
      this.tokenAt = Date.now()
      return token
    })()

    try {
      return await this.loginInFlight
    } finally {
      this.loginInFlight = null
    }
  }

  /**
   * Invoke `object.method` with `params`. Retries once with a fresh login when the radio reports
   * that the session went away — which happens routinely, since restarting `network` or `wireless`
   * tears down the caller's own RPC session.
   */
  async call<T = unknown>(
    object: string,
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number; retryOnAuth?: boolean } = {}
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs
    const retryOnAuth = opts.retryOnAuth ?? true
    const token = await this.login()

    const send = async (tok: string): Promise<RpcResponse> =>
      this.post(
        { jsonrpc: '2.0', id: this.rpcId++, method: 'call', params: [tok, object, method, params] },
        timeoutMs
      )

    let res = await send(token)

    // -32002 is rpcd's "access denied", which is also what an expired session looks like.
    const sessionGone =
      (res.error && (res.error.code === -32002 || res.error.code === -32000)) ||
      (res.result && res.result[0] === 6)

    if (sessionGone && retryOnAuth) {
      const fresh = await this.login(true)
      res = await send(fresh)
    }

    if (res.error) {
      throw new UbusError(
        `${object}.${method}: ${res.error.message}`,
        res.error.code,
        res.error.code === -32002 ? 'auth' : 'rpc'
      )
    }
    const [status, data] = res.result ?? [9]
    if (status !== 0) {
      throw new UbusError(
        `${object}.${method} failed: ${UBUS_ERRORS[status] ?? `status ${status}`}`,
        status,
        'ubus'
      )
    }
    return data as T
  }

  /**
   * Run a command on the radio via `file.exec`. This is the general-purpose escape hatch and is
   * how Doodle Labs recommends driving `uci` — see `applyUci` in radio.ts for why that matters.
   */
  async exec(command: string, params: string[] = [], timeoutMs?: number): Promise<ExecResult> {
    const out = await this.call<{ code?: number; stdout?: string; stderr?: string }>(
      'file',
      'exec',
      params.length ? { command, params } : { command },
      { timeoutMs }
    )
    return {
      code: out.code ?? 0,
      stdout: out.stdout ?? '',
      stderr: out.stderr ?? ''
    }
  }

  /** Run a full shell line (pipes, redirects, `&&`) by handing it to `sh -c`. */
  async shell(line: string, timeoutMs?: number): Promise<ExecResult> {
    return this.exec('sh', ['-c', line], timeoutMs)
  }

  /** Read a file from the radio. Set `base64` for binary payloads such as log archives. */
  async readFile(path: string, base64 = false): Promise<string> {
    const out = await this.call<{ data?: string }>('file', 'read', {
      path,
      base64: base64 ? 1 : 0
    })
    return out.data ?? ''
  }

  async stat(path: string): Promise<{ path: string; type: string; size: number; mtime: number }> {
    return this.call('file', 'stat', { path })
  }

  async writeFile(path: string, data: string, opts: { mode?: number; append?: boolean } = {}): Promise<void> {
    await this.call('file', 'write', {
      path,
      data,
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
      ...(opts.append ? { append: true } : {})
    })
  }
}
