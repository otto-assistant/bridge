// Runtime configuration for Otto bot (formerly Kimaki).
// Thin re-export layer over the centralized zustand store (store.ts).
// Getter/setter functions are kept for backwards compatibility so existing
// import sites don't need to change. They delegate to store.getState() and
// store.setState() under the hood.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from './store.js'

// Default data directory: ~/.otto for new installs, falls back to ~/.kimaki
// for existing users to preserve their database and configuration.
const DEFAULT_DATA_DIR = (() => {
  const home = os.homedir()
  const ottoDirr = path.join(home, '.otto')
  const kimakiDir = path.join(home, '.kimaki')
  // If ~/.otto already exists, use it. If ~/.kimaki exists (legacy), use it.
  // Otherwise default to ~/.otto for fresh installs.
  if (fs.existsSync(ottoDirr)) {
    return ottoDirr
  }
  if (fs.existsSync(kimakiDir)) {
    return kimakiDir
  }
  return ottoDirr
})()

/**
 * Get the data directory path.
 * Falls back to ~/.otto (or ~/.kimaki for legacy installs) if not explicitly set.
 * Under vitest (OTTO_VITEST / KIMAKI_VITEST env var), auto-creates an isolated
 * temp dir so tests never touch the real data directory. Tests that need a
 * specific dir can still call setDataDir() before any DB access to override.
 */
export function getDataDir(): string {
  const current = store.getState().dataDir
  if (current) {
    return current
  }
  if (process.env.OTTO_VITEST || process.env.KIMAKI_VITEST) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-test-'))
    store.setState({ dataDir: tmpDir })
    return tmpDir
  }
  store.setState({ dataDir: DEFAULT_DATA_DIR })
  return DEFAULT_DATA_DIR
}

/**
 * Set the data directory path.
 * Creates the directory if it doesn't exist.
 * Must be called before any database or path-dependent operations.
 */
export function setDataDir(dir: string): void {
  const resolvedDir = path.resolve(dir)

  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true })
  }

  store.setState({ dataDir: resolvedDir })
}

/**
 * Get the projects directory path (for /create-new-project command).
 * Returns the custom --projects-dir if set, otherwise <dataDir>/projects.
 */
export function getProjectsDir(): string {
  const custom = store.getState().projectsDir
  if (custom) {
    return custom
  }
  return path.join(getDataDir(), 'projects')
}

/**
 * Set a custom projects directory path (from --projects-dir CLI flag).
 * Creates the directory if it doesn't exist.
 */
export function setProjectsDir(dir: string): void {
  const resolvedDir = path.resolve(dir)

  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true })
  }

  store.setState({ projectsDir: resolvedDir })
}

export type { RegisteredUserCommand } from './store.js'

const DEFAULT_LOCK_PORT = 29988

/**
 * Derive a lock port from the data directory path.
 * Reads OTTO_LOCK_PORT or KIMAKI_LOCK_PORT (in that order of preference).
 * Returns a stable port for the default data directories.
 * For custom data dirs, uses a hash to generate a port in the range 30000-39999.
 */
export function getLockPort(): number {
  const envPortRaw = process.env['OTTO_LOCK_PORT'] || process.env['KIMAKI_LOCK_PORT']
  if (envPortRaw) {
    const envPort = Number.parseInt(envPortRaw, 10)
    if (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535) {
      return envPort
    }
  }

  const dir = getDataDir()

  // Use original port for default data dir (backwards compatible)
  if (dir === DEFAULT_DATA_DIR) {
    return DEFAULT_LOCK_PORT
  }

  // Hash-based port for custom data dirs
  let hash = 0
  for (let i = 0; i < dir.length; i++) {
    const char = dir.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }
  // Map to port range 30000-39999
  return 30000 + (Math.abs(hash) % 10000)
}
