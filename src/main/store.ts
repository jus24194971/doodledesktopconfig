/** Persistence for the radio inventory, saved scripts and app settings. */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, PersistedState, RadioRecord, ScriptRecord } from '../shared/types.js'

const DEFAULT_SETTINGS: AppSettings = {
  defaultCredentials: { username: 'user', password: 'DoodleSmartRadio' },
  pollIntervalMs: 3000,
  requestTimeoutMs: 10_000,
  bulkConcurrency: 8,
  preferHttp: false,
  theme: 'dark'
}

export class Store {
  private file: string
  private state: PersistedState

  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json')
    this.state = this.load()
  }

  private load(): PersistedState {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      return {
        radios: parsed.radios ?? [],
        scripts: parsed.scripts ?? [],
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) }
      }
    } catch {
      return { radios: [], scripts: [], settings: { ...DEFAULT_SETTINGS } }
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8')
  }

  get all(): PersistedState {
    return this.state
  }

  // ---------------------------------------------------------------- radios

  get radios(): RadioRecord[] {
    return this.state.radios
  }

  getRadio(id: string): RadioRecord | undefined {
    return this.state.radios.find((r) => r.id === id)
  }

  addRadio(input: Omit<RadioRecord, 'id' | 'addedAt'> & { id?: string }): RadioRecord {
    const existing = this.state.radios.find((r) => r.host === input.host)
    if (existing) return existing
    const rec: RadioRecord = {
      ...input,
      id: input.id ?? `radio_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      addedAt: Date.now()
    }
    this.state.radios.push(rec)
    this.persist()
    return rec
  }

  updateRadio(id: string, patch: Partial<RadioRecord>): RadioRecord | undefined {
    const rec = this.getRadio(id)
    if (!rec) return undefined
    Object.assign(rec, patch, { id: rec.id })
    this.persist()
    return rec
  }

  removeRadio(id: string): void {
    this.state.radios = this.state.radios.filter((r) => r.id !== id)
    this.persist()
  }

  // --------------------------------------------------------------- scripts

  get scripts(): ScriptRecord[] {
    return this.state.scripts
  }

  saveScript(input: Omit<ScriptRecord, 'updatedAt'> & { id?: string }): ScriptRecord {
    const id = input.id ?? `script_${Date.now().toString(36)}`
    const existing = this.state.scripts.find((s) => s.id === id)
    if (existing) {
      Object.assign(existing, input, { id, updatedAt: Date.now() })
      this.persist()
      return existing
    }
    const rec: ScriptRecord = { ...input, id, updatedAt: Date.now() }
    this.state.scripts.push(rec)
    this.persist()
    return rec
  }

  removeScript(id: string): void {
    this.state.scripts = this.state.scripts.filter((s) => s.id !== id)
    this.persist()
  }

  // -------------------------------------------------------------- settings

  get settings(): AppSettings {
    return this.state.settings
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.state.settings = { ...this.state.settings, ...patch }
    this.persist()
    return this.state.settings
  }
}
