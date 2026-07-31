/**
 * Ad-hoc code-sign the macOS bundle after packing.
 *
 * Apple Silicon will not execute *any* arm64 Mach-O binary that lacks a valid signature — the
 * kernel refuses it outright. An entirely unsigned .app therefore fails to launch with the
 * misleading message "the application is damaged and can't be opened", and clearing the quarantine
 * attribute does not help, because quarantine is not the problem.
 *
 * electron-builder has no ad-hoc signing path of its own: with no certificate configured it logs
 * "skipped macOS application code signing" and ships the bundle unsigned. So we sign here with the
 * ad-hoc identity ("-"), which costs nothing, needs no Apple account, and makes the app runnable.
 * It does NOT satisfy Gatekeeper for downloaded copies — that still needs a real Developer ID plus
 * notarisation — but it is the difference between "won't start at all" and "start it once via
 * right-click → Open".
 *
 * This runs before electron-builder's own signing step and before the DMG is assembled, and the
 * only thing between the two is a read-only sanity check, so the signature survives into the
 * finished disk image. If a real certificate is configured we do nothing and let electron-builder
 * sign properly instead.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/** Signature order matters: nested code must be signed before whatever encloses it. */
function collectNested(appPath) {
  const targets = []
  const frameworks = path.join(appPath, 'Contents', 'Frameworks')

  if (fs.existsSync(frameworks)) {
    for (const entry of fs.readdirSync(frameworks)) {
      const full = path.join(frameworks, entry)
      // Helper .app bundles and .framework bundles are signed as units; loose .dylib files
      // are signed directly.
      if (/\.(app|framework|dylib)$/.test(entry)) targets.push(full)
    }
  }

  // Native addons shipped outside the asar (none today, but ssh2 would land here if its
  // optional cpu-features binding were ever installed).
  const unpacked = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked')
  if (fs.existsSync(unpacked)) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.node')) targets.push(full)
      }
    }
    walk(unpacked)
  }

  // Deepest first.
  return targets.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)
}

function codesign(target) {
  execFileSync(
    'codesign',
    ['--force', '--sign', '-', '--timestamp=none', target],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  // A real certificate takes precedence — electron-builder will sign and notarise properly, and
  // an ad-hoc signature here would only be thrown away.
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('  • afterPack: real signing identity configured, skipping ad-hoc signature')
    return
  }

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  if (!fs.existsSync(appPath)) {
    throw new Error(`afterPack: expected bundle not found at ${appPath}`)
  }

  const nested = collectNested(appPath)
  for (const target of nested) codesign(target)
  codesign(appPath)

  // Fail the build rather than emit a bundle that cannot launch.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: ['ignore', 'ignore', 'pipe']
  })

  console.log(
    `  • afterPack: ad-hoc signed ${appName} (${nested.length} nested item(s)) for ${context.arch === 1 ? 'x64' : 'arm64'}`
  )
}
