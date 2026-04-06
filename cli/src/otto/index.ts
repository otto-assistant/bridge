/**
 * Otto distribution extensions
 *
 * Custom branding, features, and integrations for the Otto AI distribution.
 * This module is imported by the upstream entry point.
 * Upstream code is NOT modified beyond a single import line at the end of cli.ts.
 */
export { OTTO_BRANDING } from "./branding.js"

/**
 * Otto-specific configuration for the distribution
 */
export const OTTO_CONFIG = {
  /** GitHub organization */
  org: "otto-assistant",
  /** Upstream repository */
  upstream: "remorses/kimaki",
  /** Distribution name */
  distributionName: "Otto",
  /** Homepage */
  homepage: "https://github.com/otto-assistant/otto",
} as const
