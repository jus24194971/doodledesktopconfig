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

/** Run codesign, surfacing its stderr on failure — the message is the whole diagnosis. */
function codesign(args) {
  try {
    return execFileSync('codesign', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim()
    const stdout = (err.stdout || '').toString().trim()
    throw new Error(
      `codesign ${args.join(' ')}\n${stderr || stdout || err.message}`
    )
  }
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

  // Let codesign walk the bundle itself. Its --deep traversal signs nested frameworks and
  // helper apps inside-out in the correct order; hand-rolling that ordering is fragile, and
  // Apple's objection to --deep concerns per-binary entitlements during *distribution*
  // signing, which does not apply to an ad-hoc signature.
  codesign(['--force', '--deep', '--sign', '-', '--timestamp=none', appPath])

  // Fail the build rather than emit a bundle that cannot launch.
  codesign(['--verify', '--deep', '--strict', appPath])

  const archName = { 0: 'ia32', 1: 'x64', 3: 'arm64', 4: 'universal' }[context.arch] ?? String(context.arch)
  console.log(`  • afterPack: ad-hoc signed ${appName} (${archName})`)
}
