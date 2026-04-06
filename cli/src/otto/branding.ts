/**
 * Otto branding overrides
 *
 * These values can be used throughout the distribution
 * to customize the CLI appearance and messaging.
 */
export const OTTO_BRANDING = {
  /** Display name shown in UI */
  name: "Otto",
  /** Short description */
  tagline: "AI agent distribution",
  /** Organization URL */
  homepage: "https://github.com/otto-assistant/otto",
  /** Version of the otto distribution (updated by CI) */
  ottoVersion: "0.1.0",
} as const

/**
 * Check if running as Otto distribution
 */
export function isOttoDistribution(): boolean {
  return true // This file only exists in the Otto fork
}
