/** Every renderer-callable operation. The renderer has no network access of its own. */
import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { discover, identify, localSubnets } from './discovery.js'
import { sshDownload, sshExec, sshList, sshProbe, type SshOptions } from './ssh.js'
import type { RadioManager } from './manager.js'
import type { Store } from './store.js'
import type {
  ApplyPlan,
  AppSettings,
  BulkOutcome,
  Credentials,
  ExecResult,
  RadioRecord,
  ScriptRecord,
  ServiceName
} from '../shared/types.js'

let discoverAbort: AbortController | null = null

function sshOptionsFor(store: Store, id: string): SshOptions {
  const rec = store.getRadio(id)
  if (!rec) throw new Error(`No radio with id ${id}`)
  const creds: Credentials = rec.credentials ?? store.settings.defaultCredentials
  return {
    host: rec.host,
    // SSH wants the real shell account; the ubus account is often the unprivileged `user`.
    username: creds.sshUsername || 'root',
    password: creds.sshPassword || creds.password
  }
}

function downloadDir(store: Store): string {
  return store.settings.downloadDir || path.join(app.getPath('downloads'), 'MeshRider')
}

export function registerIpc(store: Store, manager: RadioManager, getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown): void => {
    getWindow()?.webContents.send(channel, payload)
  }

  manager.on('status', (s) => send('radio:status', s))
  manager.on('radios', (r) => send('radio:list', r))

  const handle = <A extends unknown[], R>(
    channel: string,
    fn: (...args: A) => Promise<R> | R
  ): void => {
    ipcMain.handle(channel, async (_evt, ...args) => fn(...(args as A)))
  }

  // ------------------------------------------------------------- inventory

  handle('radios:list', () => store.radios)
  handle('radios:statuses', () => manager.allStatuses())

  handle('radios:add', (input: Omit<RadioRecord, 'id' | 'addedAt'>) => {
    const rec = store.addRadio(input)
    void manager.refresh(rec.id)
    return rec
  })

  handle('radios:addMany', (inputs: Omit<RadioRecord, 'id' | 'addedAt'>[]) => {
    const added = inputs.map((i) => store.addRadio(i))
    for (const r of added) void manager.refresh(r.id)
    return added
  })

  handle('radios:update', (id: string, patch: Partial<RadioRecord>) => {
    const rec = store.updateRadio(id, patch)
    manager.drop(id)
    void manager.refresh(id)
    return rec
  })

  handle('radios:remove', (id: string) => {
    manager.drop(id)
    store.removeRadio(id)
    return store.radios
  })

  handle('radios:refresh', (id: string) => manager.refresh(id))
  handle('radios:watch', (ids: string[]) => {
    manager.setWatching(ids)
    return true
  })

  // ------------------------------------------------------------- discovery

  handle('discovery:subnets', () => localSubnets())

  handle('discovery:identify', (host: string, creds?: Credentials) =>
    identify(host, creds ?? store.settings.defaultCredentials, {
      preferHttp: store.settings.preferHttp
    })
  )

  handle('discovery:scan', async (cidr: string, creds?: Credentials) => {
    discoverAbort?.abort()
    discoverAbort = new AbortController()
    const results = await discover({
      cidr,
      credentials: creds ?? store.settings.defaultCredentials,
      preferHttp: store.settings.preferHttp,
      signal: discoverAbort.signal,
      onProgress: (done, total, found) => send('discovery:progress', { done, total, found })
    })
    discoverAbort = null
    return results
  })

  handle('discovery:cancel', () => {
    discoverAbort?.abort()
    discoverAbort = null
    return true
  })

  // ---------------------------------------------------------------- status

  handle('radio:snapshot', (id: string) => manager.get(id).snapshot())
  handle('radio:linkState', (id: string) => manager.get(id).linkState())
  handle('radio:associations', (id: string) => manager.get(id).associations())
  handle('radio:freqList', (id: string) => manager.get(id).freqList())
  handle('radio:iwInfo', (id: string) => manager.get(id).iwInfo())
  handle('radio:chanbw', (id: string) => manager.get(id).chanbw())
  handle('radio:validSubModels', (id: string) => manager.get(id).validSubModels())
  handle('radio:pending', (id: string) => manager.get(id).uciPending())

  // ------------------------------------------------------------------- UCI

  handle('uci:get', (id: string, uciPath: string) => manager.get(id).uciGet(uciPath))
  handle('uci:getMany', (id: string, paths: string[]) => manager.get(id).uciGetMany(paths))
  handle('uci:apply', (id: string, plan: ApplyPlan) => manager.get(id).applyUci(plan))
  handle('uci:revert', (id: string, packages: string[]) => manager.get(id).uciRevert(packages))

  // -------------------------------------------------------------- wireless

  handle(
    'wireless:bandSwitch',
    (id: string, opts: { subModel: string; channel: string; bandwidth: string; ht?: string }) =>
      manager.get(id).bandSwitch(opts)
  )
  handle('wireless:txPower', (id: string, value: 'auto' | number) =>
    manager.get(id).setTxPower(value)
  )
  handle('wireless:distance', (id: string, metres: number) => manager.get(id).setDistance(metres))
  handle(
    'wireless:networkWideChannel',
    (
      id: string,
      opts: { model: string; frequency: number; bandwidth: string; count?: number; modeChange?: boolean }
    ) => manager.get(id).networkWideChannelSwitch(opts)
  )

  // -------------------------------------------------------------- services

  handle('service:restart', (id: string, svc: ServiceName) => manager.get(id).restartService(svc))
  handle('system:reboot', (id: string) => manager.get(id).reboot())
  handle('system:factoryReset', (id: string) => manager.get(id).factoryReset())

  // ------------------------------------------------------------------ exec

  handle('exec:run', (id: string, command: string): Promise<ExecResult> =>
    manager.get(id).ubus.shell(command, 60_000)
  )

  handle('exec:bulk', async (ids: string[], command: string) =>
    manager.bulk(
      ids,
      (radio) => radio.ubus.shell(command, 60_000),
      (o) => send('exec:bulkProgress', o)
    )
  )

  handle('exec:bulkApply', async (ids: string[], plan: ApplyPlan) =>
    manager.bulk(
      ids,
      (radio) => radio.applyUci(plan),
      (o) => send('exec:bulkProgress', o as BulkOutcome)
    )
  )

  // ------------------------------------------------------------------ logs

  handle('logs:enabled', (id: string) => manager.get(id).linkLogEnabled())
  handle('logs:setEnabled', (id: string, on: boolean) => manager.get(id).setLinkLogEnabled(on))
  handle('logs:location', (id: string) => manager.get(id).linkLogLocation())

  handle('logs:read', async (id: string, remotePath: string) =>
    manager.get(id).ubus.readFile(remotePath)
  )

  /** Pull a text log through ubus and save it locally. Good for small/medium files. */
  handle('logs:save', async (id: string, remotePath: string) => {
    const rec = store.getRadio(id)
    const content = await manager.get(id).ubus.readFile(remotePath)
    const dir = downloadDir(store)
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const local = path.join(
      dir,
      `${rec?.name || rec?.host || id}_${path.posix.basename(remotePath)}_${stamp}`
    )
    fs.writeFileSync(local, content, 'utf8')
    return local
  })

  handle('logs:list', (id: string, globPath: string) =>
    sshList(sshOptionsFor(store, id), globPath)
  )

  /** SFTP download, for archives and anything too large to base64 through JSON-RPC. */
  handle('logs:download', (id: string, remotePath: string) =>
    sshDownload(sshOptionsFor(store, id), remotePath, downloadDir(store))
  )

  handle('logs:openFolder', () => {
    const dir = downloadDir(store)
    fs.mkdirSync(dir, { recursive: true })
    void shell.openPath(dir)
    return dir
  })

  /** Gather the standard diagnostics bundle in one shot. */
  handle('logs:bundle', async (id: string) => {
    const radio = manager.get(id)
    const rec = store.getRadio(id)
    const sections: { name: string; command: string }[] = [
      { name: 'board', command: 'ubus call system board' },
      { name: 'linkstate', command: 'cat /tmp/linkstate_current.json' },
      { name: 'logread', command: 'logread' },
      { name: 'dmesg', command: 'dmesg' },
      { name: 'uci-wireless', command: 'uci show wireless' },
      { name: 'uci-network', command: 'uci show network' },
      { name: 'uci-diffserv', command: 'uci show diffserv' },
      { name: 'iw-info', command: 'iw dev' },
      { name: 'ifconfig', command: 'ifconfig' },
      { name: 'routes', command: 'ip route' },
      { name: 'processes', command: 'top -n1' },
      { name: 'pending-uci', command: 'uci changes' }
    ]

    const parts: string[] = [
      `Mesh Rider diagnostic bundle`,
      `Radio: ${rec?.name ?? ''} (${rec?.host ?? ''})`,
      `Collected: ${new Date().toISOString()}`,
      ''
    ]
    for (const s of sections) {
      let body: string
      try {
        const res = await radio.ubus.shell(s.command, 30_000)
        body = res.stdout || res.stderr || '(no output)'
      } catch (err) {
        body = `ERROR: ${err instanceof Error ? err.message : String(err)}`
      }
      parts.push(`${'='.repeat(72)}\n## ${s.name}  —  ${s.command}\n${'='.repeat(72)}\n${body}\n`)
    }

    const dir = downloadDir(store)
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const local = path.join(dir, `diag_${rec?.name || rec?.host || id}_${stamp}.txt`)
    fs.writeFileSync(local, parts.join('\n'), 'utf8')
    return local
  })

  // ------------------------------------------------------------------- SSH

  handle('ssh:probe', (id: string) => sshProbe(sshOptionsFor(store, id)))
  handle('ssh:exec', (id: string, command: string) => sshExec(sshOptionsFor(store, id), command))

  // --------------------------------------------------------------- scripts

  handle('scripts:list', () => store.scripts)
  handle('scripts:save', (input: Omit<ScriptRecord, 'updatedAt'>) => store.saveScript(input))
  handle('scripts:remove', (id: string) => {
    store.removeScript(id)
    return store.scripts
  })

  // -------------------------------------------------------------- settings

  handle('settings:get', () => store.settings)
  handle('settings:update', (patch: Partial<AppSettings>) => {
    const next = store.updateSettings(patch)
    // Credentials or transport may have changed; force fresh sessions everywhere.
    manager.resetAll()
    manager.stopPolling()
    manager.startPolling()
    return next
  })

  handle('settings:pickDownloadDir', async () => {
    const win = getWindow()
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || !res.filePaths[0]) return store.settings.downloadDir
    return store.updateSettings({ downloadDir: res.filePaths[0] }).downloadDir
  })

  // ----------------------------------------------------------- import/export

  handle('inventory:export', async () => {
    const win = getWindow()
    const res = await dialog.showSaveDialog(win ?? undefined!, {
      defaultPath: 'meshrider-inventory.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return null
    fs.writeFileSync(
      res.filePath,
      JSON.stringify({ radios: store.radios, scripts: store.scripts }, null, 2),
      'utf8'
    )
    return res.filePath
  })

  handle('inventory:import', async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const parsed = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8')) as {
      radios?: RadioRecord[]
      scripts?: ScriptRecord[]
    }
    for (const r of parsed.radios ?? []) {
      store.addRadio({ name: r.name, host: r.host, credentials: r.credentials, group: r.group })
    }
    for (const s of parsed.scripts ?? []) {
      store.saveScript({ id: s.id, name: s.name, body: s.body, description: s.description })
    }
    return { radios: store.radios, scripts: store.scripts }
  })
}
