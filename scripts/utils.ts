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

/**
 * Convert decimal odds to percentage (same formula as Betfair, named for The Odds API clarity)
 * Example: 2.50 → 40% (1/2.50 * 100)
 */
export function decimalOddsToPercent(decimalOdds: number): number {
  return betfairOddsToPercent(decimalOdds);
}

/**
 * Calculate trimmed mean implied probability from an array of decimal odds.
 * Drops the highest and lowest outliers when 3+ bookmakers report odds,
 * then averages the remaining values to produce a consensus probability.
 *
 * @param decimalOdds Array of decimal odds (e.g. [2.50, 2.60, 2.40, 2.55])
 * @returns Consensus probability as percentage (0-100)
 */
export function trimmedMeanProbability(decimalOdds: number[]): number {
  if (decimalOdds.length === 0) return 0;

  // Convert all to implied probabilities
  const probabilities = decimalOdds.map(d => decimalOddsToPercent(d));

  if (probabilities.length <= 2) {
    // With 1-2 values, just average them
    const sum = probabilities.reduce((a, b) => a + b, 0);
    return Math.round((sum / probabilities.length) * 100) / 100;
  }

  // Sort and drop highest + lowest (trimmed mean)
  const sorted = [...probabilities].sort((a, b) => a - b);
  const trimmed = sorted.slice(1, -1);
  const sum = trimmed.reduce((a, b) => a + b, 0);
  return Math.round((sum / trimmed.length) * 100) / 100;
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
 * Format a GBP amount with USD equivalent
 * Example: formatGbpWithUsd(1234.56, 1.27) → "£1,234.56 ($1,567.89)"
 */
export function formatGbpWithUsd(gbp: number, rate: number = 1.27): string {
  const usd = gbpToUsd(gbp, rate);
  const gbpStr = gbp.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usdStr = usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `\u00a3${gbpStr} ($${usdStr})`;
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
  if (options.includeUrl) headers.push('URL');
  const rows = markets.map(m => [
    `**${capitalize(m.platform)}**`,
    m.question,
    `**${formatOdds(m.odds)}**`,
    formatVolume(m.volume),
    ...(options.includeUrl ? [m.url] : []),
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
