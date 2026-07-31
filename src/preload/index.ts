import { contextBridge, ipcRenderer } from 'electron'
import type {
  ApplyPlan,
  ApplyResult,
  ApplyStep,
  AppSettings,
  BulkOutcome,
  Credentials,
  ExecResult,
  FreqEntry,
  LinkState,
  LogFileEntry,
  RadioRecord,
  RadioStatus,
  ScriptRecord,
  ServiceName,
  StationInfo,
  SystemSnapshot
} from '../shared/types.js'

const invoke = <R>(channel: string, ...args: unknown[]): Promise<R> =>
  ipcRenderer.invoke(channel, ...args) as Promise<R>

const on = <T,>(channel: string, cb: (payload: T) => void): (() => void) => {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const api = {
  radios: {
    list: () => invoke<RadioRecord[]>('radios:list'),
    statuses: () => invoke<RadioStatus[]>('radios:statuses'),
    add: (input: Omit<RadioRecord, 'id' | 'addedAt'>) => invoke<RadioRecord>('radios:add', input),
    addMany: (inputs: Omit<RadioRecord, 'id' | 'addedAt'>[]) =>
      invoke<RadioRecord[]>('radios:addMany', inputs),
    update: (id: string, patch: Partial<RadioRecord>) =>
      invoke<RadioRecord | undefined>('radios:update', id, patch),
    remove: (id: string) => invoke<RadioRecord[]>('radios:remove', id),
    refresh: (id: string) => invoke<RadioStatus>('radios:refresh', id),
    watch: (ids: string[]) => invoke<boolean>('radios:watch', ids)
  },

  discovery: {
    subnets: () => invoke<{ iface: string; address: string; cidr: string }[]>('discovery:subnets'),
    identify: (host: string, creds?: Credentials) => invoke<unknown>('discovery:identify', host, creds),
    scan: (cidr: string, creds?: Credentials) => invoke<unknown[]>('discovery:scan', cidr, creds),
    cancel: () => invoke<boolean>('discovery:cancel')
  },

  radio: {
    snapshot: (id: string) => invoke<SystemSnapshot>('radio:snapshot', id),
    linkState: (id: string) => invoke<LinkState | null>('radio:linkState', id),
    associations: (id: string) => invoke<StationInfo[]>('radio:associations', id),
    freqList: (id: string) => invoke<FreqEntry[]>('radio:freqList', id),
    iwInfo: (id: string) =>
      invoke<{ channel?: number; freq?: number; txpower?: number; raw: string }>('radio:iwInfo', id),
    chanbw: (id: string) => invoke<string | undefined>('radio:chanbw', id),
    validSubModels: (id: string) => invoke<string[]>('radio:validSubModels', id),
    pending: (id: string) => invoke<string>('radio:pending', id)
  },

  uci: {
    get: (id: string, path: string) => invoke<string | undefined>('uci:get', id, path),
    getMany: (id: string, paths: string[]) =>
      invoke<Record<string, string | undefined>>('uci:getMany', id, paths),
    apply: (id: string, plan: ApplyPlan) => invoke<ApplyResult>('uci:apply', id, plan),
    revert: (id: string, packages: string[]) => invoke<ApplyResult>('uci:revert', id, packages)
  },

  wireless: {
    bandSwitch: (
      id: string,
      opts: { subModel: string; channel: string; bandwidth: string; ht?: string }
    ) => invoke<ApplyStep>('wireless:bandSwitch', id, opts),
    txPower: (id: string, value: 'auto' | number) => invoke<ApplyStep>('wireless:txPower', id, value),
    distance: (id: string, metres: number) => invoke<ApplyStep>('wireless:distance', id, metres),
    networkWideChannel: (
      id: string,
      opts: { model: string; frequency: number; bandwidth: string; count?: number; modeChange?: boolean }
    ) => invoke<unknown>('wireless:networkWideChannel', id, opts)
  },

  service: {
    restart: (id: string, svc: ServiceName) => invoke<ApplyStep>('service:restart', id, svc),
    reboot: (id: string) => invoke<void>('system:reboot', id),
    factoryReset: (id: string) => invoke<void>('system:factoryReset', id)
  },

  exec: {
    run: (id: string, command: string) => invoke<ExecResult>('exec:run', id, command),
    bulk: (ids: string[], command: string) =>
      invoke<BulkOutcome<ExecResult>[]>('exec:bulk', ids, command),
    bulkApply: (ids: string[], plan: ApplyPlan) =>
      invoke<BulkOutcome<ApplyResult>[]>('exec:bulkApply', ids, plan)
  },

  logs: {
    enabled: (id: string) => invoke<boolean>('logs:enabled', id),
    setEnabled: (id: string, on: boolean) => invoke<ApplyResult>('logs:setEnabled', id, on),
    location: (id: string) => invoke<string>('logs:location', id),
    read: (id: string, path: string) => invoke<string>('logs:read', id, path),
    save: (id: string, path: string) => invoke<string>('logs:save', id, path),
    list: (id: string, globPath: string) => invoke<LogFileEntry[]>('logs:list', id, globPath),
    download: (id: string, path: string) => invoke<string>('logs:download', id, path),
    bundle: (id: string) => invoke<string>('logs:bundle', id),
    openFolder: () => invoke<string>('logs:openFolder')
  },

  ssh: {
    probe: (id: string) => invoke<boolean>('ssh:probe', id),
    exec: (id: string, command: string) => invoke<ExecResult>('ssh:exec', id, command)
  },

  scripts: {
    list: () => invoke<ScriptRecord[]>('scripts:list'),
    save: (input: Omit<ScriptRecord, 'updatedAt'>) => invoke<ScriptRecord>('scripts:save', input),
    remove: (id: string) => invoke<ScriptRecord[]>('scripts:remove', id)
  },

  settings: {
    get: () => invoke<AppSettings>('settings:get'),
    update: (patch: Partial<AppSettings>) => invoke<AppSettings>('settings:update', patch),
    pickDownloadDir: () => invoke<string | undefined>('settings:pickDownloadDir')
  },

  inventory: {
    export: () => invoke<string | null>('inventory:export'),
    import: () =>
      invoke<{ radios: RadioRecord[]; scripts: ScriptRecord[] } | null>('inventory:import')
  },

  events: {
    onStatus: (cb: (s: RadioStatus) => void) => on('radio:status', cb),
    onRadioList: (cb: (r: RadioRecord[]) => void) => on('radio:list', cb),
    onDiscoveryProgress: (cb: (p: { done: number; total: number; found: unknown }) => void) =>
      on('discovery:progress', cb),
    onBulkProgress: (cb: (o: BulkOutcome) => void) => on('exec:bulkProgress', cb)
  }
}

export type MeshRiderApi = typeof api

contextBridge.exposeInMainWorld('api', api)
