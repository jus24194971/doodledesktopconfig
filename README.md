# Mesh Rider Configurator

A cross-platform desktop app (Windows, macOS, Linux) for configuring and monitoring
[Doodle Labs](https://doodlelabs.com) Mesh Rider radios — one radio or a whole fleet.

Built because the stock web GUI is awkward and, more importantly, **loses settings**.

## Why settings don't stick in the stock GUI

Mesh Rider OS is OpenWrt. Configuration goes through UCI, and UCI has a specific contract that is
easy to get wrong:

1. `uci set` writes only to a **temporary staging area**. Nothing persists until `uci commit`.
2. A commit alone doesn't apply anything — the relevant **service must be restarted**, or the
   change waits until the next reboot.
3. The CLI `uci` and the JSON-RPC `uci` service keep **separate staging areas**. Mixing them
   silently drops changes.
4. The JSON-RPC `uci commit` performs its own automatic service reload, which Doodle Labs
   themselves describe as less reliable than an explicit restart.

This app follows Doodle Labs' documented recommendation for all writes: run UCI through
`ubus file exec` (the CLI path), then commit, then restart the service explicitly — and show you
each step's result. See [`src/main/radio.ts`](src/main/radio.ts) → `applyUci`.

Every configuration page also surfaces staged-but-uncommitted changes already sitting on the radio,
with a one-click discard.

## Features

**Inventory**
- Add radios by IP, by comma/newline list, or by range (`10.223.0.10-20`)
- Subnet discovery — TCP sweep, then a `system.board` ubus probe to confirm each host is a radio
- Per-radio credential overrides; import/export the inventory

**Dashboard** — live link state polled from `/tmp/linkstate_current.json`
- Per-peer RSSI with rolling sparkline history, MCS/rate, retries, inactivity
- batman-adv mesh originator table with transmit quality
- CPU, memory, uptime, temperature, input voltage, GPS

**Wireless** — channel, bandwidth, TX power, distance, mesh ID, SSID, encryption
- Channel list read live from the radio's own `iwinfo freqlist`
- Band switching via `band_switching.sh` (handles per-band calibration reload)

**Network** — management and secondary addressing, group-aware multicast, service restarts

**Traffic** — DiffServ QoS: command & control, video, latency-vs-throughput, robustness,
video bad-link threshold and drop ratio

**Logs**
- Toggle link-status logging (committed properly)
- Read `logread`, `dmesg`, live link state, UCI dumps, processes, interfaces
- One-click **diagnostic bundle** — 12 sources collected into a single timestamped text file
- Fetch any file by JSON-RPC (text) or SFTP (archives, captures)

**Console** — run arbitrary commands on one radio or every selected radio at once
- Transport switch: JSON-RPC `file exec` (no SSH needed) or a real SSH session as root
- Command history recall, built-in snippets, saved reusable scripts

**Fleet** — push a setting to many radios, each with its own commit and restart
- Plus the coordinated **network-wide channel switch** (`ubus message-system chswitch`), which
  moves every mesh node together instead of stranding them one at a time

**Maintenance** — noise scan, SSH reachability test, reboot, factory reset
(destructive actions are gated behind a typed confirmation phrase)

## Getting started

```bash
npm install
```

Run the full desktop app:

```bash
npm run dev
```

Work on the interface with no radios attached — serves a demo dataset in a browser:

```bash
npm run dev:ui
```

## Installing on Windows

Two artifacts are produced, both x64:

| File | What it is |
| --- | --- |
| `Mesh Rider Configurator-<version>-Setup.exe` | Installer. Wizard lets you choose the install location, creates Start Menu and desktop shortcuts, and registers an uninstaller. Installs per-user, so **no admin rights needed**. |
| `Mesh Rider Configurator-<version>-Portable.exe` | Single self-contained executable. Nothing is installed — run it from a USB stick if you like. |

The build is **not code-signed**, so on first launch Windows SmartScreen shows
"Windows protected your PC". Click **More info → Run anyway**. Removing that prompt requires an
Authenticode code-signing certificate (a paid, identity-verified purchase from a CA); drop the
`.pfx` path in `CSC_LINK` and its password in `CSC_KEY_PASSWORD` and electron-builder will sign
automatically.

Settings and the radio inventory live in `%APPDATA%\doodledesktopconfig\config.json` and are
deliberately preserved across uninstall/reinstall.

## Building installers

```bash
npm run pack:win
```

`pack:mac` and `pack:linux` are also available; `pack:dir` produces an unpacked folder without
building an installer, which is much faster when you just want to test the packaged app. Output
lands in `release/`.

Pushing a `v*` tag builds all three platforms in GitHub Actions and attaches the installers to a
Release — see [`.github/workflows/build.yml`](.github/workflows/build.yml). CI is the easier path
for macOS and Linux artifacts.

The app icon is generated from a script rather than checked in as opaque binary art:

```bash
npm run icon
```

### If a Windows build fails on symlinks

electron-builder downloads a `winCodeSign` bundle that contains macOS symlinks. Extracting those
on Windows needs privileges a normal account lacks, and the build dies with:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the client.
```

The tidiest fix is to turn on **Settings → System → For developers → Developer Mode**, which lets
non-admin accounts create symlinks. Otherwise, pre-extract the bundle without the macOS directory —
it is never needed for a Windows build:

```bash
cd "$LOCALAPPDATA/electron-builder/Cache/winCodeSign"
7za x <downloaded>.7z -owinCodeSign-2.6.0 '-x!darwin' -y
```

GitHub Actions runners have the necessary privileges, so CI builds are unaffected.

## Connecting to a radio

Radios answer JSON-RPC at `https://<radio-ip>/ubus` with a self-signed certificate, which this app
accepts deliberately (as do Doodle Labs' own `curl -k` examples).

| Firmware | JSON-RPC username | Password |
| --- | --- | --- |
| June 2024 and later | `user` | `DoodleSmartRadio` |
| Earlier | `root` | `DoodleSmartRadio` |

SSH authenticates separately as a real shell account — `root` by default. Set both under
**Settings**, or override per radio under **Maintenance**.

If JSON-RPC is disabled, enable it at `https://<radio-ip>/cgi-bin/luci/admin/services/rpcjson`
(older firmware: `.../rpcd`). Some operations need the **Full Access** ACL rather than
**Restricted Access** — notably reading arbitrary files and running scripts outside the restricted
allowlist.

## Architecture

```
src/
  main/          Electron main process — all network I/O lives here
    ubus.ts      JSON-RPC client: session handling, auto re-login, self-signed TLS
    radio.ts     High-level radio operations, incl. the set → commit → restart pipeline
    ssh.ts       SSH exec and SFTP transfer (legacy KEX/cipher support for OpenWrt)
    discovery.ts Subnet sweep and radio identification
    manager.ts   Connection pool, status polling, bounded fan-out across radios
    store.ts     Persisted inventory, scripts and settings
    ipc.ts       The renderer-callable surface
  preload/       contextBridge API — the renderer has no direct network access
  renderer/      React + TypeScript interface
  shared/        Types shared across the process boundary
```

The renderer never touches the network. Everything goes through IPC to the main process, which
keeps credentials and TLS handling out of the web context.

### Session drops are expected

Restarting `network`, `wireless` or `firewall` tears down the caller's own RPC session — often
before the request returns. Those steps are marked *tolerated*: a dropped reply is treated as
success and the session is transparently re-established. Genuine failures still surface in the
apply log.

## Reference

Sourced from the [Doodle Labs Knowledge Base](https://kb.doodlelabs.com):

- [JSON-RPC API Guide](https://kb.doodlelabs.com/json-rpc-api-guide) — ubus/UCI semantics, ACLs, error codes
- [API Reference](https://kb.doodlelabs.com/doodle-labs-api-reference) — the full endpoint list
- [Supported Networking Modes](https://kb.doodlelabs.com/supported-networking-modes) — Mesh, WDS AP/Client, Dynamic Mesh, Gateway

## Safety notes

- Changing channel, bandwidth, mesh ID or encryption key on **one** node splits it from the mesh.
  Use the Fleet page, or the network-wide channel switch, to move nodes together.
- Changing a radio's management IP drops your connection to it — update its host entry afterwards.
- Factory reset (`firstboot -y && reboot`) is irreversible and usually brings the radio back on a
  different address. Have physical or serial access before using it.

## License

MIT
