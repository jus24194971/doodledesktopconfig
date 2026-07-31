/** Types shared between the Electron main process and the renderer. */

export interface Credentials {
  username: string
  password: string
  /** Optional separate SSH password. Falls back to `password`. */
  sshUsername?: string
  sshPassword?: string
}

export interface RadioRecord {
  id: string
  /** User-facing label. Defaults to the hostname once known. */
  name: string
  host: string
  /** Override the global credentials for this one radio. */
  credentials?: Credentials
  group?: string
  notes?: string
  addedAt: number
}

export type ConnState = 'unknown' | 'connecting' | 'online' | 'offline' | 'auth-error'

export interface RadioStatus {
  id: string
  state: ConnState
  error?: string
  lastSeen?: number
  /** Round-trip time of the last ubus call, in ms. */
  latencyMs?: number
  board?: BoardInfo
  link?: LinkState
}

export interface BoardInfo {
  hostname?: string
  model?: string
  board_name?: string
  system?: string
  kernel?: string
  parent_model?: string
  sub_model?: string
  release?: {
    distribution?: string
    version?: string
    revision?: string
    target?: string
    description?: string
  }
}

/** Shape of /tmp/linkstate_current.json. Fields vary by firmware, so all optional. */
export interface LinkState {
  localtime?: string | number
  cpu_load?: number | string
  memory?: Record<string, unknown>
  operating_channel?: number | string
  operating_freq?: number | string
  channel_width?: number | string
  noise?: number
  activity?: number | string
  lna_status?: string | number
  stations?: StationInfo[]
  mesh?: MeshEntry[]
  [k: string]: unknown
}

export interface StationInfo {
  mac?: string
  rssi?: number | number[]
  signal?: number
  inactive?: number
  noise?: number
  tx_mcs?: number | string
  rx_mcs?: number | string
  tx_rate?: number | string
  rx_rate?: number | string
  tx_failed?: number
  tx_retries?: number
  [k: string]: unknown
}

export interface MeshEntry {
  orig_address?: string
  tq?: number
  last_seen_msecs?: number
  next_hop?: string
  [k: string]: unknown
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** One `uci set` to stage. */
export interface UciChange {
  /** e.g. "wireless.radio0.channel" */
  path: string
  value: string
}

/** Services that can be restarted after a commit. */
export type ServiceName =
  | 'network'
  | 'wireless'
  | 'diffserv'
  | 'acs_multiband'
  | 'socat'
  | 'firewall'

export interface ApplyPlan {
  changes: UciChange[]
  /** UCI packages to commit. Derived from `changes` when omitted. */
  commit?: string[]
  restart?: ServiceName[]
}

export interface ApplyStep {
  label: string
  command: string
  ok: boolean
  stdout?: string
  stderr?: string
  code?: number
  /** True when the step's failure is expected/benign (e.g. session dropped by a network restart). */
  tolerated?: boolean
}

export interface ApplyResult {
  ok: boolean
  steps: ApplyStep[]
}

export interface WirelessConfig {
  phy: string
  channel?: string
  chanbw?: string
  txpower?: string
  distance?: string
  ssid?: string
  encryption?: string
  key?: string
  mode?: string
  meshId?: string
}

export interface SystemSnapshot {
  board?: BoardInfo
  parentModel?: string
  subModel?: string
  validSubModels?: string[]
  phy?: string
  uptime?: number
  loadavg?: number[]
  memTotal?: number
  memFree?: number
  temperature?: number
  voltage?: number
  gps?: { lat?: number; lon?: number }
  ipaddr?: string
  netmask?: string
}

export interface FreqEntry {
  channel: number
  mhz: number
  restricted?: boolean
}

export interface LogFileEntry {
  path: string
  size?: number
  mtime?: number
}

export interface ScriptRecord {
  id: string
  name: string
  body: string
  description?: string
  updatedAt: number
}

export interface BulkOutcome<T = unknown> {
  radioId: string
  host: string
  ok: boolean
  error?: string
  value?: T
  durationMs: number
}

export interface AppSettings {
  defaultCredentials: Credentials
  /** Milliseconds between dashboard polls. */
  pollIntervalMs: number
  /** Per-request timeout for ubus calls. */
  requestTimeoutMs: number
  /** Max radios contacted at once during bulk operations. */
  bulkConcurrency: number
  /** Where downloaded logs are written. */
  downloadDir?: string
  /** Prefer http:// instead of https:// for ubus. */
  preferHttp: boolean
  theme: 'dark' | 'light'
}

export interface PersistedState {
  radios: RadioRecord[]
  scripts: ScriptRecord[]
  settings: AppSettings
}
