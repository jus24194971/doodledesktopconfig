/**
 * High-level Mesh Rider operations built on top of the ubus client.
 *
 * The single most important thing in this file is `applyUci`. Doodle Labs' own JSON-RPC guide
 * spells out why the stock web GUI loses settings:
 *
 *   - `uci set` only writes to a temporary staging area; nothing persists until `uci commit`.
 *   - The CLI `uci` and the RPC `uci` service keep *separate* staging areas, so mixing them
 *     silently drops changes.
 *   - The RPC `uci commit` also triggers its own service reload, which Doodle Labs describe as
 *     unreliable compared to an explicit restart.
 *
 * So every write goes through `file.exec` with `command: "uci"` (the CLI path), and we always
 * follow set -> commit -> explicit service restart.
 */
import { UbusClient, UbusError } from './ubus.js'
import type {
  ApplyPlan,
  ApplyResult,
  ApplyStep,
  BoardInfo,
  FreqEntry,
  LinkState,
  ServiceName,
  StationInfo,
  SystemSnapshot,
  UciChange
} from '../shared/types.js'

/** Restarting these tears down our own RPC session, so a failed reply is expected. */
const SESSION_KILLING: ServiceName[] = ['network', 'wireless', 'firewall']

/** Service restarts are slow; give them plenty of room before declaring failure. */
const RESTART_TIMEOUT_MS = 45_000

export class Radio {
  constructor(readonly ubus: UbusClient) {}

  get host(): string {
    return this.ubus.host
  }

  // ---------------------------------------------------------------- system

  async board(): Promise<BoardInfo> {
    return this.ubus.call<BoardInfo>('system', 'board')
  }

  async systemInfo(): Promise<{
    uptime?: number
    load?: number[]
    memory?: { total?: number; free?: number; shared?: number; buffered?: number }
  }> {
    return this.ubus.call('system', 'info')
  }

  /**
   * Which PHY carries the Mesh Rider radio. Dual-radio units have a separate WiFi PHY, so this
   * must never be assumed to be 0.
   */
  async meshRiderPhy(): Promise<string> {
    try {
      const res = await this.ubus.exec('/usr/share/simpleconfig/get_fes_phy.sh')
      const m = res.stdout.match(/(\d+)/)
      if (m) return m[1]
    } catch {
      /* older firmware may not ship the script */
    }
    return '0'
  }

  async parentModel(): Promise<string> {
    const res = await this.ubus.exec('fes_model.sh', ['get', 'parent'])
    return res.stdout.trim()
  }

  async subModel(): Promise<string> {
    const res = await this.ubus.exec('fes_model.sh', ['get'])
    return res.stdout.trim()
  }

  /** The bands this hardware can legally be switched to. */
  async validSubModels(): Promise<string[]> {
    const parent = await this.parentModel()
    if (!parent) return []
    const res = await this.ubus.exec('cat', [`/usr/share/.doodlelabs/fes/${parent}`])
    return res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
  }

  async temperatureAndVoltage(): Promise<{ temperature?: number; voltage?: number }> {
    try {
      const res = await this.ubus.exec('cat', ['/tmp/run/pancake.txt'])
      const temp = res.stdout.match(/Temperature['"\s:]+([-\d.]+)/i)
      const vin = res.stdout.match(/VIN\s*VOLTAGE['"\s:]+([-\d.]+)/i)
      return {
        temperature: temp ? Number(temp[1]) : undefined,
        // The KB documents VIN VOLTAGE as a raw ADC reading scaled by 20.2.
        voltage: vin ? Number(vin[1]) / 20.2 : undefined
      }
    } catch {
      return {}
    }
  }

  async gps(): Promise<{ lat?: number; lon?: number }> {
    try {
      const [lat, lon] = await Promise.all([
        this.ubus.exec('/usr/bin/gpspipe', ['-O']),
        this.ubus.exec('/usr/bin/gpspipe', ['-L'])
      ])
      const parse = (s: string): number | undefined => {
        const m = s.match(/-?\d+\.\d+/)
        return m ? Number(m[0]) : undefined
      }
      return { lat: parse(lat.stdout), lon: parse(lon.stdout) }
    } catch {
      return {}
    }
  }

  async snapshot(): Promise<SystemSnapshot> {
    const [board, info, phy, temps] = await Promise.all([
      this.board().catch(() => undefined),
      this.systemInfo().catch(() => undefined),
      this.meshRiderPhy().catch(() => '0'),
      this.temperatureAndVoltage()
    ])

    const [ipaddr, netmask] = await Promise.all([
      this.uciGet('network.wan2.ipaddr').catch(() => undefined),
      this.uciGet('network.wan2.netmask').catch(() => undefined)
    ])

    return {
      board,
      parentModel: board?.parent_model,
      subModel: board?.sub_model,
      phy,
      uptime: info?.uptime,
      loadavg: info?.load,
      memTotal: info?.memory?.total,
      memFree: info?.memory?.free,
      temperature: temps.temperature,
      voltage: temps.voltage,
      ipaddr,
      netmask
    }
  }

  // ------------------------------------------------------------ link state

  /** The link-state daemon's rolling snapshot: RSSI, MCS, noise, stations and mesh neighbours. */
  async linkState(): Promise<LinkState | null> {
    for (const path of ['/tmp/linkstate_current.json', '/tmp/status.json']) {
      try {
        const raw = await this.ubus.readFile(path)
        if (raw.trim()) return JSON.parse(raw) as LinkState
      } catch {
        /* try the next path */
      }
    }
    return null
  }

  async associations(device?: string): Promise<StationInfo[]> {
    const dev = device ?? `wlan${await this.meshRiderPhy()}`
    const out = await this.ubus.call<{ results?: StationInfo[] }>('iwinfo', 'assoclist', {
      device: dev
    })
    return out.results ?? []
  }

  /** Channels available in the *current* band. */
  async freqList(device?: string): Promise<FreqEntry[]> {
    const dev = device ?? `wlan${await this.meshRiderPhy()}`
    const out = await this.ubus.call<{
      results?: { channel: number; mhz: number; restricted?: boolean }[]
    }>('iwinfo', 'freqlist', { device: dev })
    return out.results ?? []
  }

  /** TX power and current channel, straight from `iw`. */
  async iwInfo(device?: string): Promise<{ channel?: number; freq?: number; txpower?: number; raw: string }> {
    const dev = device ?? `wlan${await this.meshRiderPhy()}`
    const res = await this.ubus.exec('iw', [dev, 'info'])
    const raw = res.stdout
    const ch = raw.match(/channel\s+(\d+)/)
    const freq = raw.match(/\((\d+)\s*MHz\)/)
    const pow = raw.match(/txpower\s+([-\d.]+)/)
    return {
      channel: ch ? Number(ch[1]) : undefined,
      freq: freq ? Number(freq[1]) : undefined,
      txpower: pow ? Number(pow[1]) : undefined,
      raw
    }
  }

  async chanbw(): Promise<string | undefined> {
    const phy = await this.meshRiderPhy()
    try {
      const res = await this.ubus.exec('cat', [
        `/sys/kernel/debug/ieee80211/phy${phy}/ath9k/chanbw`
      ])
      return res.stdout.trim() || undefined
    } catch {
      return this.uciGet(`wireless.radio${phy}.chanbw`).catch(() => undefined)
    }
  }

  // ------------------------------------------------------------------ UCI

  /** Read one UCI value. Returns undefined when the option is unset. */
  async uciGet(path: string): Promise<string | undefined> {
    const res = await this.ubus.exec('uci', ['get', path])
    if (res.code !== 0) return undefined
    const v = res.stdout.trim()
    return v.length ? v : undefined
  }

  /** Read several UCI values at once, in a single round trip. */
  async uciGetMany(paths: string[]): Promise<Record<string, string | undefined>> {
    if (!paths.length) return {}
    // One `sh -c` beats N round trips; a sentinel keeps unset options aligned with their key.
    const script = paths
      .map((p) => `echo "${p}=$(uci -q get ${p} || echo '\\0UNSET\\0')"`)
      .join('; ')
    const res = await this.ubus.shell(script)
    const out: Record<string, string | undefined> = {}
    for (const line of res.stdout.split('\n')) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const val = line.slice(eq + 1).trim()
      out[key] = val.includes('UNSET') || val === '' ? undefined : val
    }
    return out
  }

  /** UCI package name for a dotted path: `wireless.radio0.channel` -> `wireless`. */
  private static packageOf(path: string): string {
    return path.split('.')[0]
  }

  /**
   * Stage, commit and activate a set of UCI changes.
   *
   * This is the whole reason the app exists: `uci set` alone is a no-op after reboot, and an
   * RPC-side commit reloads services unreliably. Doing set -> commit -> restart explicitly is what
   * makes a setting actually stick.
   */
  async applyUci(plan: ApplyPlan): Promise<ApplyResult> {
    const steps: ApplyStep[] = []
    const record = (
      label: string,
      command: string,
      res: { code: number; stdout: string; stderr: string },
      tolerated = false
    ): boolean => {
      const ok = res.code === 0
      steps.push({
        label,
        command,
        ok: ok || tolerated,
        tolerated: tolerated && !ok,
        code: res.code,
        stdout: res.stdout?.trim() || undefined,
        stderr: res.stderr?.trim() || undefined
      })
      return ok
    }

    // 1. Stage every change through the CLI uci, in one shell call so a mid-way session
    //    expiry cannot leave the staging area half-written.
    if (plan.changes.length) {
      const setLine = plan.changes
        .map((c: UciChange) => `uci set ${shellQuote(`${c.path}=${c.value}`)}`)
        .join(' && ')
      const res = await this.ubus.shell(setLine)
      if (!record(`Stage ${plan.changes.length} change(s)`, setLine, res)) {
        return { ok: false, steps }
      }
    }

    // 2. Commit each affected package.
    const packages =
      plan.commit ?? Array.from(new Set(plan.changes.map((c) => Radio.packageOf(c.path))))
    for (const pkg of packages) {
      const res = await this.ubus.exec('uci', ['commit', pkg])
      if (!record(`Commit ${pkg}`, `uci commit ${pkg}`, res)) {
        return { ok: false, steps }
      }
    }

    // 3. Restart services so the change takes effect now rather than at next boot.
    for (const svc of plan.restart ?? []) {
      const tolerated = SESSION_KILLING.includes(svc)
      const cmd = svc === 'wireless' ? 'wifi' : `/etc/init.d/${svc} restart`
      try {
        const res =
          svc === 'wireless'
            ? await this.ubus.exec('wifi', [], RESTART_TIMEOUT_MS)
            : await this.ubus.exec(`/etc/init.d/${svc}`, ['restart'], RESTART_TIMEOUT_MS)
        record(`Restart ${svc}`, cmd, res, tolerated)
      } catch (err) {
        // A network/wireless restart drops our RPC session mid-request. That is success, not failure.
        const msg = err instanceof Error ? err.message : String(err)
        steps.push({
          label: `Restart ${svc}`,
          command: cmd,
          ok: tolerated,
          tolerated,
          stderr: msg
        })
        this.ubus.invalidate()
        if (!tolerated) return { ok: false, steps }
      }
      if (tolerated) this.ubus.invalidate()
    }

    return { ok: steps.every((s) => s.ok), steps }
  }

  /** Throw away staged-but-uncommitted changes. */
  async uciRevert(packages: string[]): Promise<ApplyResult> {
    const steps: ApplyStep[] = []
    for (const pkg of packages) {
      const res = await this.ubus.exec('uci', ['revert', pkg])
      steps.push({
        label: `Revert ${pkg}`,
        command: `uci revert ${pkg}`,
        ok: res.code === 0,
        code: res.code,
        stderr: res.stderr?.trim() || undefined
      })
    }
    return { ok: steps.every((s) => s.ok), steps }
  }

  /** Staged-but-uncommitted changes, so the UI can warn about a dirty config. */
  async uciPending(): Promise<string> {
    const res = await this.ubus.shell('uci changes')
    return res.stdout.trim()
  }

  // ------------------------------------------------------- wireless config

  /**
   * Band / channel / bandwidth switch. This goes through Doodle Labs' own `band_switching.sh`
   * rather than raw UCI, because changing band also has to reload calibration for the new band.
   */
  async bandSwitch(opts: {
    subModel: string
    channel: string | number
    bandwidth: string | number
    ht?: string
  }): Promise<ApplyStep> {
    const params = [String(opts.subModel), String(opts.channel), String(opts.bandwidth)]
    if (opts.ht) params.push(opts.ht)
    const cmd = `/usr/share/simpleconfig/band_switching.sh ${params.join(' ')}`
    try {
      const res = await this.ubus.exec(
        '/usr/share/simpleconfig/band_switching.sh',
        params,
        RESTART_TIMEOUT_MS
      )
      return {
        label: 'Band switch',
        command: cmd,
        ok: res.code === 0,
        code: res.code,
        stdout: res.stdout?.trim() || undefined,
        stderr: res.stderr?.trim() || undefined
      }
    } catch (err) {
      // band_switching.sh restarts the radio, which can drop the session before it replies.
      this.ubus.invalidate()
      return {
        label: 'Band switch',
        command: cmd,
        ok: true,
        tolerated: true,
        stderr: err instanceof Error ? err.message : String(err)
      }
    }
  }

  /** Live TX power change (does not survive a reboot — pair with the UCI setting to persist). */
  async setTxPower(value: 'auto' | number, device?: string): Promise<ApplyStep> {
    const dev = device ?? `wlan${await this.meshRiderPhy()}`
    const params =
      value === 'auto'
        ? [dev, 'set', 'txpower', 'auto']
        : // `iw` takes mBm, i.e. dBm * 100.
          [dev, 'set', 'txpower', 'fixed', String(Math.round(value * 100))]
    const res = await this.ubus.exec('iw', params)
    return {
      label: `Set TX power ${value === 'auto' ? 'auto' : `${value} dBm`}`,
      command: `iw ${params.join(' ')}`,
      ok: res.code === 0,
      code: res.code,
      stderr: res.stderr?.trim() || undefined
    }
  }

  async setDistance(metres: number): Promise<ApplyStep> {
    const phy = await this.meshRiderPhy()
    const res = await this.ubus.exec('iw', [`phy${phy}`, 'set', 'distance', String(metres)])
    return {
      label: `Set distance ${metres} m`,
      command: `iw phy${phy} set distance ${metres}`,
      ok: res.code === 0,
      code: res.code,
      stderr: res.stderr?.trim() || undefined
    }
  }

  /** Coordinated mesh-wide channel switch — every node moves together. */
  async networkWideChannelSwitch(opts: {
    model: string
    frequency: number
    bandwidth: string
    count?: number
    modeChange?: boolean
  }): Promise<unknown> {
    return this.ubus.call(
      'message-system',
      'chswitch',
      {
        count: opts.count ?? 3,
        model: opts.model,
        frequency: opts.frequency,
        bandwidth: opts.bandwidth,
        mode_change: opts.modeChange ? 1 : 0
      },
      { timeoutMs: RESTART_TIMEOUT_MS }
    )
  }

  // -------------------------------------------------------------- services

  async restartService(svc: ServiceName): Promise<ApplyStep> {
    const tolerated = SESSION_KILLING.includes(svc)
    const cmd = svc === 'wireless' ? 'wifi' : `/etc/init.d/${svc} restart`
    try {
      const res =
        svc === 'wireless'
          ? await this.ubus.exec('wifi', [], RESTART_TIMEOUT_MS)
          : await this.ubus.exec(`/etc/init.d/${svc}`, ['restart'], RESTART_TIMEOUT_MS)
      if (tolerated) this.ubus.invalidate()
      return {
        label: `Restart ${svc}`,
        command: cmd,
        ok: res.code === 0 || tolerated,
        tolerated: tolerated && res.code !== 0,
        code: res.code,
        stderr: res.stderr?.trim() || undefined
      }
    } catch (err) {
      this.ubus.invalidate()
      return {
        label: `Restart ${svc}`,
        command: cmd,
        ok: tolerated,
        tolerated,
        stderr: err instanceof Error ? err.message : String(err)
      }
    }
  }

  async reboot(): Promise<void> {
    try {
      await this.ubus.call('system', 'reboot', {}, { timeoutMs: 5000, retryOnAuth: false })
    } catch (err) {
      // The radio goes down mid-reply; only a genuine auth failure is worth surfacing.
      if (err instanceof UbusError && err.kind === 'auth') throw err
    }
    this.ubus.invalidate()
  }

  /** Wipe to factory defaults and reboot. Destructive and irreversible. */
  async factoryReset(): Promise<void> {
    try {
      await this.ubus.exec('sh', ['-c', 'firstboot -y && reboot'], 5000)
    } catch {
      /* connection drops as the radio resets */
    }
    this.ubus.invalidate()
  }

  // ------------------------------------------------------------------ logs

  async linkLogEnabled(): Promise<boolean> {
    const v = await this.uciGet('link_status_log.@general[0].enabled')
    return v === '1'
  }

  async setLinkLogEnabled(enabled: boolean): Promise<ApplyResult> {
    return this.applyUci({
      changes: [{ path: 'link_status_log.@general[0].enabled', value: enabled ? '1' : '0' }],
      commit: ['link_status_log']
    })
  }

  /** Where the link-status daemon has been writing its logs. */
  async linkLogLocation(): Promise<string> {
    const res = await this.ubus.exec('/usr/bin/link-status.sh', ['LOGS'])
    return res.stdout.trim()
  }

  async noiseScan(): Promise<string> {
    await this.ubus.exec('switch-scan-new.sh', [], RESTART_TIMEOUT_MS)
    return this.ubus.readFile('/tmp/scan_results')
  }

  async scanList(): Promise<unknown> {
    const raw = await this.ubus.readFile('/etc/scanlist.json')
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
}

/** Single-quote a string for POSIX sh. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
