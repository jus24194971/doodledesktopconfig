/**
 * SSH access to the radio.
 *
 * ubus `file.exec` covers almost everything, but a real SSH session is better for two jobs:
 * interactive shell work, and pulling large/binary files (log archives, tcpdump captures) which
 * would otherwise have to be base64'd through JSON-RPC.
 */
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import fs from 'node:fs'
import path from 'node:path'
import type { ExecResult, LogFileEntry } from '../shared/types.js'

export interface SshOptions {
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  timeoutMs?: number
}

function connectConfig(opts: SshOptions): ConnectConfig {
  return {
    host: opts.host,
    port: opts.port ?? 22,
    username: opts.username,
    ...(opts.password ? { password: opts.password } : {}),
    ...(opts.privateKey ? { privateKey: opts.privateKey, passphrase: opts.passphrase } : {}),
    readyTimeout: opts.timeoutMs ?? 15_000,
    // Mesh Rider OS is OpenWrt on an ar71xx target with a dated dropbear/openssh build, so the
    // modern-only defaults in ssh2 will not negotiate. Re-enable the older primitives.
    algorithms: {
      kex: [
        'curve25519-sha256',
        'curve25519-sha256@libssh.org',
        'ecdh-sha2-nistp256',
        'diffie-hellman-group14-sha256',
        'diffie-hellman-group14-sha1',
        'diffie-hellman-group1-sha1'
      ],
      serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-256', 'ssh-rsa'],
      cipher: [
        'aes128-ctr',
        'aes256-ctr',
        'aes128-gcm@openssh.com',
        'aes256-gcm@openssh.com',
        'aes128-cbc',
        '3des-cbc'
      ]
    }
  }
}

function withClient<T>(opts: SshOptions, fn: (c: Client) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const conn = new Client()
    let settled = false
    const finish = (err: Error | null, value?: T): void => {
      if (settled) return
      settled = true
      conn.end()
      err ? reject(err) : resolve(value as T)
    }
    conn.on('ready', () => {
      fn(conn).then(
        (v) => finish(null, v),
        (e) => finish(e instanceof Error ? e : new Error(String(e)))
      )
    })
    conn.on('error', (err) => finish(err))
    try {
      conn.connect(connectConfig(opts))
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/** Run one command over SSH and collect its output. */
export function sshExec(opts: SshOptions, command: string): Promise<ExecResult> {
  return withClient(opts, (conn) =>
    new Promise<ExecResult>((resolve, reject) => {
      conn.exec(command, (err, stream: ClientChannel) => {
        if (err) return reject(err)
        let stdout = ''
        let stderr = ''
        let code = 0
        stream.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
        stream.on('close', (c: number) => {
          code = c ?? 0
          resolve({ code, stdout, stderr })
        })
      })
    })
  )
}

/** Verify credentials without running anything. */
export async function sshProbe(opts: SshOptions): Promise<boolean> {
  await withClient(opts, async () => true)
  return true
}

/** List files matching a glob, with size and mtime, ready for the download picker. */
export function sshList(opts: SshOptions, globPath: string): Promise<LogFileEntry[]> {
  return withClient(opts, (conn) =>
    new Promise<LogFileEntry[]>((resolve, reject) => {
      // `find` is more predictable than `ls` for parsing, and busybox ships it.
      conn.exec(`ls -la ${globPath} 2>/dev/null || true`, (err, stream: ClientChannel) => {
        if (err) return reject(err)
        let out = ''
        stream.on('data', (d: Buffer) => (out += d.toString('utf8')))
        stream.on('close', () => {
          const entries: LogFileEntry[] = []
          for (const line of out.split('\n')) {
            const parts = line.trim().split(/\s+/)
            if (parts.length < 9 || line.startsWith('d') || line.startsWith('total')) continue
            entries.push({ path: parts.slice(8).join(' '), size: Number(parts[4]) || undefined })
          }
          resolve(entries)
        })
      })
    })
  )
}

/** Download a remote file over SFTP into `destDir`. Returns the local path written. */
export function sshDownload(
  opts: SshOptions,
  remotePath: string,
  destDir: string,
  fileName?: string
): Promise<string> {
  return withClient(opts, (conn) =>
    new Promise<string>((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err)
        fs.mkdirSync(destDir, { recursive: true })
        const local = path.join(destDir, fileName ?? path.posix.basename(remotePath))
        sftp.fastGet(remotePath, local, (e) => (e ? reject(e) : resolve(local)))
      })
    })
  )
}

/** Upload a local file, e.g. pushing a script onto the radio before running it. */
export function sshUpload(opts: SshOptions, localPath: string, remotePath: string): Promise<void> {
  return withClient(opts, (conn) =>
    new Promise<void>((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err)
        sftp.fastPut(localPath, remotePath, (e) => (e ? reject(e) : resolve()))
      })
    })
  )
}
