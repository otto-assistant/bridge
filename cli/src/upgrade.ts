// Kimaki self-upgrade utilities.
// Detects the package manager used to install kimaki, checks npm for newer versions,
// and runs the global upgrade command. Used by both CLI `kimaki upgrade` and
// the Discord `/upgrade-and-restart` command, plus background auto-upgrade on startup.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import { createLogger, LogPrefix } from './logger.js'
import { execAsync } from './worktrees.js'

const logger = createLogger(LogPrefix.CLI)

type Pm = 'bun' | 'pnpm' | 'npm'
type CliPackageJson = { version: string; name: string }

// Detects which package manager globally installed kimaki, used to run the
// correct `<pm> i -g kimaki@latest` upgrade command.
//
// Detection order:
// 1. npm_config_user_agent — set by npx/bunx/pnpm dlx, reliable for those cases
// 2. Realpath of the running script — resolve symlinks and check if the path
//    lives under a known PM global directory (e.g. ~/.bun, ~/Library/pnpm,
//    /usr/local/lib/node_modules). Inspired by sindresorhus/global-directory.
// 3. process.versions.bun — if the runtime itself is Bun, likely bun ecosystem
// 4. Default to npm — safest fallback since npm is the most common global installer
export function detectPm(): Pm {
  const ua = process.env.npm_config_user_agent
  if (ua?.startsWith('bun/')) {
    return 'bun'
  }
  if (ua?.startsWith('pnpm/')) {
    return 'pnpm'
  }
  if (ua?.startsWith('npm/')) {
    return 'npm'
  }

  const scriptPath = resolveScriptRealpath()
  if (scriptPath) {
    const p = scriptPath.toLowerCase()
    // bun global installs live under ~/.bun or $BUN_INSTALL
    if (p.includes('.bun/') || p.includes('/bun/install/')) {
      return 'bun'
    }
    // pnpm global installs live under ~/Library/pnpm, ~/.local/share/pnpm, or $PNPM_HOME
    if (p.includes('/pnpm/')) {
      return 'pnpm'
    }
    // npm global installs typically live under lib/node_modules/kimaki without
    // any pnpm or bun path segments, so if we reach here it's likely npm
  }

  if (process.versions.bun) {
    return 'bun'
  }

  return 'npm'
}

function resolveScriptRealpath(): string | null {
  try {
    const script = process.argv[1]
    if (!script) {
      return null
    }
    return fs.realpathSync(script)
  } catch {
    return null
  }
}

function getCliPackageJson(): CliPackageJson {
  const require = createRequire(import.meta.url)
  return require('../package.json') as CliPackageJson
}

export function getCurrentVersion(): string {
  return getCliPackageJson().version
}

function getPackageName(): string {
  return getCliPackageJson().name
}

export async function getLatestNpmVersion(): Promise<string | null> {
  try {
    const packageName = encodeURIComponent(getPackageName())
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      return null
    }
    const data = (await res.json()) as { version: string }
    return data.version
  } catch {
    return null
  }
}

// Returns the new version string if upgraded, null if already up to date.
export async function upgrade(): Promise<string | null> {
  const current = getCurrentVersion()
  const latest = await getLatestNpmVersion()
  if (!latest) {
    throw new Error('Failed to check latest version from npm')
  }
  if (current === latest) {
    return null
  }

  const pm = detectPm()
  const packageName = getPackageName()
  logger.log(`Upgrading ${packageName} from v${current} to v${latest} using ${pm}...`)
  await execAsync(`${pm} i -g ${packageName}@latest`, { timeout: 120_000 })

  return latest
}

// Fire-and-forget background upgrade check on bot startup.
// Only upgrades if a newer version is available. Errors are silently ignored.
export async function backgroundUpgradeKimaki(): Promise<void> {
  try {
    const current = getCurrentVersion()
    const latest = await getLatestNpmVersion()
    if (!latest || current === latest) {
      return
    }

    const pm = detectPm()
    const packageName = getPackageName()
    logger.debug(
      `Background ${packageName} upgrade started: v${current} -> v${latest}`,
    )
    await execAsync(`${pm} i -g ${packageName}@latest`, { timeout: 120_000 })
    logger.debug(`Background ${packageName} upgrade completed: v${latest}`)
  } catch {
    // silently ignored, non-critical
  }
}
