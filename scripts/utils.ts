/**
 * Betting Markets Manager - Utility Functions
 *
 * Handles odds conversion, currency normalization, and formatting.
 */

import type { UnifiedMarket } from './types.js';

// =============================================================================
// Odds Conversion
// =============================================================================

/**
 * Convert Polymarket price (0-1 decimal) to percentage
 * Example: 0.22 → 22%
 */
export function polymarketOddsToPercent(price: number): number {
  return Math.round(price * 100 * 100) / 100; // Round to 2 decimal places
}

/**
 * Convert Kalshi price (cents, 0-100) to percentage
 * Example: 22 (cents) → 22%
 */
export function kalshiOddsToPercent(cents: number): number {
  return Math.round(cents * 100) / 100; // Already in %, round to 2 decimal places
}

/**
 * Convert Betfair decimal odds to percentage (implied probability)
 * Example: 4.55 → 22% (1/4.55 * 100)
 */
export function betfairOddsToPercent(decimalOdds: number): number {
  if (decimalOdds <= 1) return 100; // Edge case: odds of 1 means 100% certainty
  return Math.round((1 / decimalOdds) * 100 * 100) / 100;
}

// =============================================================================
// Currency Conversion
// =============================================================================

/**
 * Convert GBP to USD
 */
export function gbpToUsd(gbp: number, rate: number = 1.27): number {
  return Math.round(gbp * rate * 100) / 100;
}

/**
 * USDC is pegged to USD, so 1:1 conversion
 */
export function usdcToUsd(usdc: number): number {
  return usdc;
}

// =============================================================================
// Volume Formatting
// =============================================================================

/**
 * Format volume for display (e.g., 13000000 → "$13m")
 */
export function formatVolume(usd: number): string {
  if (usd >= 1_000_000_000) {
    return `$${(usd / 1_000_000_000).toFixed(1)}b`;
  }
  if (usd >= 1_000_000) {
    return `$${(usd / 1_000_000).toFixed(1)}m`;
  }
  if (usd >= 1_000) {
    return `$${(usd / 1_000).toFixed(1)}k`;
  }
  return `$${usd.toFixed(0)}`;
}

/**
 * Format odds for display (e.g., 22 → "22%")
 */
export function formatOdds(percent: number): string {
  return `${Math.round(percent)}%`;
}

// =============================================================================
// Table Formatting
// =============================================================================

/**
 * Format markets as a markdown table
 */
export function formatMarkdownTable(
  markets: UnifiedMarket[],
  options: { includeUrl?: boolean } = {}
): string {
  if (markets.length === 0) {
    return 'No markets found.';
  }

  const headers = ['Platform', 'Question', 'Odds', 'Volume'];
  const rows = markets.map(m => [
    `**${capitalize(m.platform)}**`,
    m.question,
    `**${formatOdds(m.odds)}**`,
    formatVolume(m.volume),
  ]);

  // Calculate column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  );

  // Build table
  const headerRow = '| ' + headers.map((h, i) => h.padEnd(widths[i])).join(' | ') + ' |';
  const separatorRow = '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|';
  const dataRows = rows.map(r =>
    '| ' + r.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |'
  );

  return [headerRow, separatorRow, ...dataRows].join('\n');
}

// =============================================================================
// Helpers
// =============================================================================

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Parse volume string to number (e.g., "$13m" → 13000000)
 */
export function parseVolumeString(str: string): number {
  const cleaned = str.replace(/[$,]/g, '').toLowerCase();
  const match = cleaned.match(/^([\d.]+)([kmb])?$/);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const suffix = match[2];

  switch (suffix) {
    case 'k': return value * 1_000;
    case 'm': return value * 1_000_000;
    case 'b': return value * 1_000_000_000;
    default: return value;
  }
}

/**
 * Sort markets by specified criteria
 */
export function sortMarkets(
  markets: UnifiedMarket[],
  sortBy: 'volume' | 'odds' | 'platform' = 'volume'
): UnifiedMarket[] {
  return [...markets].sort((a, b) => {
    switch (sortBy) {
      case 'volume':
        return b.volume - a.volume; // Descending
      case 'odds':
        return b.odds - a.odds; // Descending
      case 'platform':
        return a.platform.localeCompare(b.platform);
      default:
        return 0;
    }
  });
}

/**
 * Filter markets by minimum volume
 */
export function filterByMinVolume(markets: UnifiedMarket[], minVolume: number): UnifiedMarket[] {
  return markets.filter(m => m.volume >= minVolume);
}

/**
 * Get current ISO timestamp
 */
export function nowISO(): string {
  return new Date().toISOString();
}
