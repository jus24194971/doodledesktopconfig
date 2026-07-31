/** Owns the pool of live radio connections, status polling and fan-out across many radios. */
import { EventEmitter } from 'node:events'
import { Radio } from './radio.js'
import { UbusClient } from './ubus.js'
import type { Store } from './store.js'
import type { BulkOutcome, Credentials, RadioRecord, RadioStatus } from '../shared/types.js'

export class RadioManager extends EventEmitter {
  private clients = new Map<string, Radio>()
  private statuses = new Map<string, RadioStatus>()
  private pollTimer: NodeJS.Timeout | null = null
  /** Radio ids the UI currently has open, so we only poll what is on screen. */
  private watching = new Set<string>()

  constructor(private store: Store) {
    super()
  }

  private credentialsFor(rec: RadioRecord): Credentials {
    return rec.credentials ?? this.store.settings.defaultCredentials
  }

  /** Get (or build) the connection for a radio, keeping credentials and settings in sync. */
  get(id: string): Radio {
    const rec = this.store.getRadio(id)
    if (!rec) throw new Error(`No radio with id ${id}`)

    let radio = this.clients.get(id)
    if (!radio || radio.host !== rec.host) {
      const creds = this.credentialsFor(rec)
      radio = new Radio(
        new UbusClient({
          host: rec.host,
          username: creds.username,
          password: creds.password,
          timeoutMs: this.store.settings.requestTimeoutMs,
          preferHttp: this.store.settings.preferHttp
        })
      )
      this.clients.set(id, radio)
    } else {
      const creds = this.credentialsFor(rec)
      radio.ubus.updateCredentials(creds.username, creds.password)
      radio.ubus.timeoutMs = this.store.settings.requestTimeoutMs
      radio.ubus.preferHttp = this.store.settings.preferHttp
    }
    return radio
  }

  drop(id: string): void {
    this.clients.delete(id)
    this.statuses.delete(id)
    this.watching.delete(id)
  }

  /** Forget every cached session, e.g. after the default credentials change. */
  resetAll(): void {
    for (const r of this.clients.values()) r.ubus.invalidate()
    this.clients.clear()
  }

  getStatus(id: string): RadioStatus {
    return this.statuses.get(id) ?? { id, state: 'unknown' }
  }

  allStatuses(): RadioStatus[] {
    return this.store.radios.map((r) => this.getStatus(r.id))
  }

  private setStatus(id: string, patch: Partial<RadioStatus>): void {
    const next: RadioStatus = { ...this.getStatus(id), ...patch, id }
    this.statuses.set(id, next)
    this.emit('status', next)
  }

  /** Contact one radio and refresh its cached status. */
  async refresh(id: string, opts: { withLink?: boolean } = {}): Promise<RadioStatus> {
    const rec = this.store.getRadio(id)
    if (!rec) throw new Error(`No radio with id ${id}`)

    if (this.getStatus(id).state === 'unknown') this.setStatus(id, { state: 'connecting' })
    const started = Date.now()

    try {
      const radio = this.get(id)
      const board = await radio.board()
      const latencyMs = Date.now() - started

      let link = this.getStatus(id).link
      if (opts.withLink !== false) {
        link = (await radio.linkState().catch(() => null)) ?? undefined
      }

      // Adopt the radio's own hostname the first time we see it, if the user never named it.
      if (board.hostname && (!rec.name || rec.name === rec.host)) {
        this.store.updateRadio(id, { name: board.hostname })
        this.emit('radios', this.store.radios)
      }

      this.setStatus(id, {
        state: 'online',
        error: undefined,
        lastSeen: Date.now(),
        latencyMs,
        board,
        link
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isAuth = /login|denied|password|auth/i.test(message)
      this.setStatus(id, { state: isAuth ? 'auth-error' : 'offline', error: message })
    }
    return this.getStatus(id)
  }

  // ------------------------------------------------------------------ poll

  /** Restrict polling to the radios currently visible in the UI. */
  setWatching(ids: string[]): void {
    this.watching = new Set(ids)
  }

  startPolling(): void {
    this.stopPolling()
    const tick = async (): Promise<void> => {
      const ids = this.watching.size ? [...this.watching] : this.store.radios.map((r) => r.id)
      await this.mapConcurrent(ids, (id) => this.refresh(id).catch(() => undefined), 6)
      if (this.pollTimer !== null) {
        this.pollTimer = setTimeout(() => void tick(), this.store.settings.pollIntervalMs)
      }
    }
    // Marker so the loop knows it is still live.
    this.pollTimer = setTimeout(() => void tick(), 0)
  }

  stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  // ------------------------------------------------------------------ bulk

  private async mapConcurrent<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    limit: number
  ): Promise<R[]> {
    const results = new Array<R>(items.length)
    let i = 0
    const worker = async (): Promise<void> => {
      while (i < items.length) {
        const idx = i++
        results[idx] = await fn(items[idx])
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
    return results
  }

  /**
   * Run the same operation against many radios, capped by `bulkConcurrency`. Each radio's outcome
   * is reported independently so one unreachable node never sinks the whole batch.
   */
  async bulk<T>(
    ids: string[],
    fn: (radio: Radio, rec: RadioRecord) => Promise<T>,
    onEach?: (outcome: BulkOutcome<T>) => void
  ): Promise<BulkOutcome<T>[]> {
    return this.mapConcurrent(
      ids,
      async (id): Promise<BulkOutcome<T>> => {
        const rec = this.store.getRadio(id)
        const started = Date.now()
        if (!rec) {
          const out: BulkOutcome<T> = {
            radioId: id,
            host: '?',
            ok: false,
            error: 'Radio not found',
            durationMs: 0
          }
          onEach?.(out)
          return out
        }
        try {
          const value = await fn(this.get(id), rec)
          const out: BulkOutcome<T> = {
            radioId: id,
            host: rec.host,
            ok: true,
            value,
            durationMs: Date.now() - started
          }
          onEach?.(out)
          return out
        } catch (err) {
          const out: BulkOutcome<T> = {
            radioId: id,
            host: rec.host,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - started
          }
          onEach?.(out)
          return out
        }
      },
      this.store.settings.bulkConcurrency
    )
  }
}
