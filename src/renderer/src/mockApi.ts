/**
 * Demo-mode stand-in for the preload bridge.
 *
 * Installed only when `window.api` is missing — i.e. when the renderer is opened in a plain
 * browser via `npm run dev:ui` rather than inside Electron. It serves plausible fake radios so
 * the interface can be worked on without hardware. Never loaded in the packaged app.
 */
import type {
  ApplyResult,
  AppSettings,
  BulkOutcome,
  ExecResult,
  LinkState,
  RadioRecord,
  RadioStatus,
  ScriptRecord
} from '@shared/types'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const RADIOS: RadioRecord[] = [
  { id: 'r1', name: 'GCS-Base', host: '10.223.30.201', group: 'GCS', addedAt: Date.now() },
  { id: 'r2', name: 'Vehicle-01', host: '10.223.30.202', group: 'Air', addedAt: Date.now() },
  { id: 'r3', name: 'Vehicle-02', host: '10.223.30.203', group: 'Air', addedAt: Date.now() },
  { id: 'r4', name: 'Relay-Tower', host: '10.223.30.210', group: 'Relay', addedAt: Date.now() }
]

const board = (host: string): RadioStatus['board'] => ({
  hostname: `smartradio-${host.split('.').pop()}a3ac`,
  model: 'DoodleLabs SmartRadio',
  board_name: 'smartradio',
  system: 'Qualcomm Atheros QCA9533 ver 2 rev 0',
  kernel: '4.14.221',
  parent_model: 'MB-2025-2KM-XW',
  sub_model: 'RM-915v3-2L-X',
  release: {
    distribution: 'Doodle Labs',
    version: 'firmware-2024-06.2',
    revision: 'r11306-c4a6851c72',
    target: 'ar71xx/generic'
  }
})

let tick = 0

function linkState(seed: number): LinkState {
  tick++
  const jitter = (n: number): number => Math.round(n + Math.sin(tick / 4 + seed) * 4)
  return {
    localtime: new Date().toISOString(),
    operating_channel: 8,
    operating_freq: 915,
    channel_width: 20,
    noise: -101,
    activity: 12 + (seed % 7),
    lna_status: 'on',
    stations: Array.from({ length: seed === 0 ? 3 : 1 }, (_, i) => ({
      mac: `00:30:1A:4F:${(seed * 16 + i).toString(16).padStart(2, '0')}:${(i * 7 + 3).toString(16).padStart(2, '0')}`.toUpperCase(),
      rssi: jitter(-58 - i * 11 - seed * 3),
      inactive: 20 + i * 40,
      tx: { mcs: 11 - i, rate: 65000 - i * 12000 },
      rx: { mcs: 12 - i, rate: 72000 - i * 9000 },
      tx_retries: 3 + i * 5
    })),
    mesh: Array.from({ length: 3 }, (_, i) => ({
      orig_address: `00:30:1A:4F:${(i * 9).toString(16).padStart(2, '0')}:11`.toUpperCase(),
      tq: 255 - i * 48,
      next_hop: `00:30:1A:4F:${(i * 3).toString(16).padStart(2, '0')}:22`.toUpperCase(),
      last_seen_msecs: 200 + i * 400
    }))
  }
}

const STATUSES: Record<string, RadioStatus> = Object.fromEntries(
  RADIOS.map((r, i) => [
    r.id,
    {
      id: r.id,
      state: i === 3 ? 'offline' : 'online',
      error: i === 3 ? 'ETIMEDOUT: connect timed out' : undefined,
      lastSeen: Date.now(),
      latencyMs: 12 + i * 6,
      board: board(r.host),
      link: linkState(i)
    } as RadioStatus
  ])
)

const UCI: Record<string, string> = {
  'wireless.radio0.channel': '8',
  'wireless.radio0.chanbw': '20',
  'wireless.radio0.txpower': 'auto',
  'wireless.radio0.distance': '5000',
  'wireless.wifi0.mode': 'mesh',
  'wireless.wifi0.mesh_id': 'DoodleMesh',
  'wireless.wifi0.ssid': 'MeshRider',
  'wireless.wifi0.encryption': 'psk2',
  'wireless.wifi0.key': 'meshpassword',
  'network.wan2.ipaddr': '10.223.30.201',
  'network.wan2.netmask': '255.255.0.0',
  'network.bat0.multicast_mode': '1',
  'diffserv.@general[0].enabled': '1',
  'diffserv.@general[0].optimized_cc': '1',
  'diffserv.@general[0].optimized_vi': '0',
  'diffserv.@general[0].low_latency': '1',
  'diffserv.@general[0].diversity_rates': '0',
  'diffserv.@general[0].vi_drop_signal_threshold': '-95',
  'diffserv.@general[0].vi_drop_signal_ratio': '90',
  'link_status_log.@general[0].enabled': '1'
}

const settings: AppSettings = {
  defaultCredentials: { username: 'user', password: 'DoodleSmartRadio' },
  pollIntervalMs: 3000,
  requestTimeoutMs: 10000,
  bulkConcurrency: 8,
  preferHttp: false,
  theme: 'dark'
}

let scripts: ScriptRecord[] = [
  {
    id: 's1',
    name: 'Link summary',
    body: 'iw dev wlan0 info; iwinfo wlan0 assoclist',
    description: 'Channel, power and associated peers',
    updatedAt: Date.now()
  }
]

const statusListeners: ((s: RadioStatus) => void)[] = []

// Keep the fake dashboards moving so charts and trends are visible.
setInterval(() => {
  for (const [i, r] of RADIOS.entries()) {
    if (STATUSES[r.id].state !== 'online') continue
    STATUSES[r.id] = { ...STATUSES[r.id], link: linkState(i), lastSeen: Date.now() }
    for (const cb of statusListeners) cb(STATUSES[r.id])
  }
}, 2000)

const applyOk = (n: number): ApplyResult => ({
  ok: true,
  steps: [
    { label: `Stage ${n} change(s)`, command: 'uci set …', ok: true },
    { label: 'Commit wireless', command: 'uci commit wireless', ok: true },
    { label: 'Restart wireless', command: 'wifi', ok: true, tolerated: true }
  ]
})

export function installMockApi(): void {
  const api = {
    radios: {
      list: async () => RADIOS,
      statuses: async () => Object.values(STATUSES),
      add: async (input: Omit<RadioRecord, 'id' | 'addedAt'>) => {
        const rec = { ...input, id: `r${RADIOS.length + 1}`, addedAt: Date.now() }
        RADIOS.push(rec)
        STATUSES[rec.id] = { id: rec.id, state: 'online', board: board(rec.host), lastSeen: Date.now() }
        return rec
      },
      addMany: async (inputs: Omit<RadioRecord, 'id' | 'addedAt'>[]) =>
        Promise.all(inputs.map((i) => api.radios.add(i))),
      update: async (id: string, patch: Partial<RadioRecord>) => {
        const r = RADIOS.find((x) => x.id === id)
        if (r) Object.assign(r, patch)
        return r
      },
      remove: async (id: string) => {
        const i = RADIOS.findIndex((r) => r.id === id)
        if (i >= 0) RADIOS.splice(i, 1)
        return RADIOS
      },
      refresh: async (id: string) => STATUSES[id],
      watch: async () => true
    },
    discovery: {
      subnets: async () => [{ iface: 'Ethernet', address: '10.223.30.5', cidr: '10.223.0.0/16' }],
      identify: async () => ({}),
      scan: async () => {
        await wait(900)
        return [{ host: '10.223.30.222', identified: true, authOk: true, hostname: 'smartradio-de01', board: board('222') }]
      },
      cancel: async () => true
    },
    radio: {
      snapshot: async (id: string) => ({
        board: STATUSES[id]?.board,
        phy: '0',
        uptime: 86400 * 2 + 3600 * 5,
        loadavg: [39000, 32000, 28000],
        memTotal: 128 * 1024 * 1024,
        memFree: 61 * 1024 * 1024,
        temperature: 47.5,
        voltage: 12.3,
        ipaddr: RADIOS.find((r) => r.id === id)?.host,
        netmask: '255.255.0.0'
      }),
      linkState: async (id: string) => STATUSES[id]?.link ?? null,
      associations: async () => [],
      freqList: async () =>
        Array.from({ length: 12 }, (_, i) => ({ channel: i + 1, mhz: 902 + i * 2 })),
      iwInfo: async () => ({ channel: 8, freq: 915, txpower: 27, raw: '' }),
      chanbw: async () => '20',
      validSubModels: async () => ['RM-915v3-2L-X', 'RM-2450-2L-X', 'RM-1675-2KM-XW'],
      pending: async () => ''
    },
    uci: {
      get: async (_id: string, path: string) => UCI[path],
      getMany: async (_id: string, paths: string[]) =>
        Object.fromEntries(paths.map((p) => [p, UCI[p]])),
      apply: async (_id: string, plan: { changes: { path: string; value: string }[] }) => {
        await wait(700)
        for (const c of plan.changes) UCI[c.path] = c.value
        return applyOk(plan.changes.length)
      },
      revert: async () => applyOk(0)
    },
    wireless: {
      bandSwitch: async () => ({ label: 'Band switch', command: 'band_switching.sh', ok: true }),
      txPower: async () => ({ label: 'Set TX power', command: 'iw', ok: true }),
      distance: async () => ({ label: 'Set distance', command: 'iw', ok: true }),
      networkWideChannel: async () => {
        await wait(600)
        return {}
      }
    },
    service: {
      restart: async (_id: string, svc: string) => ({ label: `Restart ${svc}`, command: '', ok: true }),
      reboot: async () => undefined,
      factoryReset: async () => undefined
    },
    exec: {
      run: async (_id: string, command: string): Promise<ExecResult> => {
        await wait(400)
        return { code: 0, stdout: `(demo mode)\n$ ${command}\nno radio attached — output simulated`, stderr: '' }
      },
      bulk: async (ids: string[], command: string): Promise<BulkOutcome<ExecResult>[]> => {
        await wait(500)
        return ids.map((id) => ({
          radioId: id,
          host: RADIOS.find((r) => r.id === id)?.host ?? '?',
          ok: true,
          value: { code: 0, stdout: `(demo) ${command}`, stderr: '' },
          durationMs: 120
        }))
      },
      bulkApply: async () => []
    },
    logs: {
      enabled: async () => true,
      setEnabled: async () => applyOk(1),
      location: async () => '/tmp/longtermlog/',
      read: async () => 'demo log content',
      save: async () => 'C:/Downloads/demo.txt',
      list: async () => [],
      download: async () => 'C:/Downloads/demo.tar.gz',
      bundle: async () => {
        await wait(1200)
        return 'C:/Downloads/diag_demo.txt'
      },
      openFolder: async () => 'C:/Downloads'
    },
    ssh: {
      probe: async () => true,
      exec: async (_id: string, command: string) => ({ code: 0, stdout: `(demo ssh) ${command}`, stderr: '' })
    },
    scripts: {
      list: async () => scripts,
      save: async (input: Omit<ScriptRecord, 'updatedAt'>) => {
        const rec = { ...input, updatedAt: Date.now() }
        scripts = [...scripts.filter((s) => s.id !== rec.id), rec]
        return rec
      },
      remove: async (id: string) => {
        scripts = scripts.filter((s) => s.id !== id)
        return scripts
      }
    },
    settings: {
      get: async () => settings,
      update: async (patch: Partial<AppSettings>) => Object.assign(settings, patch),
      pickDownloadDir: async () => settings.downloadDir
    },
    inventory: {
      export: async () => null,
      import: async () => null
    },
    events: {
      onStatus: (cb: (s: RadioStatus) => void) => {
        statusListeners.push(cb)
        return () => {
          const i = statusListeners.indexOf(cb)
          if (i >= 0) statusListeners.splice(i, 1)
        }
      },
      onRadioList: () => () => undefined,
      onDiscoveryProgress: () => () => undefined,
      onBulkProgress: () => () => undefined
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = api
}
