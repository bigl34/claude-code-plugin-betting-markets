/**
 * Betting Markets Aggregator
 *
 * Combines results from Polymarket and Betfair into unified output.
 * Searches prediction markets in parallel with graceful degradation.
 *
 * Key features:
 * - Parallel search: Query multiple platforms simultaneously
 * - Unified format: Normalizes odds/prices to percentages and USD volume
 * - Graceful degradation: Returns partial results if some platforms fail
 * - Markdown output: Formatted tables for easy reading
 *
 * Supported platforms:
 * - Polymarket: Crypto prediction market (public API, no auth)
 * - Betfair: Traditional betting exchange (requires API credentials)
 *
 * Currencies: Betfair GBP converted to USD using configurable rate.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  UnifiedMarket,
  SearchOptions,
  AggregatedResult,
  PlatformStatus,
  Config,
  Platform,
} from './types.js';
import { PolymarketClient } from './polymarket-client.js';
import { BetfairClient } from './betfair-client.js';
import { sortMarkets, filterByMinVolume, formatMarkdownTable, nowISO } from './utils.js';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================
// AGGREGATOR
// ============================================

export class BettingMarketsAggregator {
  private polymarket: PolymarketClient;
  private betfair: BetfairClient;

  constructor() {
    // When compiled, __dirname is dist/, so look in parent for config.json
    const configPath = join(__dirname, '..', 'config.json');
    const config: Config = JSON.parse(readFileSync(configPath, 'utf-8'));
    this.polymarket = new PolymarketClient(config.polymarket);
    this.betfair = new BetfairClient(config.betfair, config.settings?.gbpToUsd || 1.27);
  }

  // ============================================
  // SEARCH OPERATIONS
  // ============================================

  /**
   * Searches all enabled platforms in parallel.
   *
   * Returns partial results if some platforms fail, with warnings
   * indicating which platforms encountered errors.
   *
   * @param query - Search query for market names/descriptions
   * @param options - Search options
   * @param options.platform - Filter to specific platform (polymarket|betfair)
   * @param options.minVolume - Minimum volume filter (USD)
   * @param options.maxResults - Limit number of results
   * @param options.sortBy - Sort order (volume|probability)
   * @returns Aggregated results with platform status metadata
   */
  async searchAll(query: string, options: SearchOptions = {}): Promise<AggregatedResult> {
    const platforms: Record<Platform, PlatformStatus> = {
      polymarket: { status: 'disabled' },
      betfair: { status: 'disabled' },
    };
    const warnings: string[] = [];
    let allMarkets: UnifiedMarket[] = [];

    // Filter to specific platform if requested
    const targetPlatform = options.platform;

    // Build search promises for enabled platforms
    const searchPromises: Promise<{
      platform: Platform;
      markets?: UnifiedMarket[];
      error?: string;
    }>[] = [];

    if (this.polymarket.isEnabled() && (!targetPlatform || targetPlatform === 'polymarket')) {
      searchPromises.push(
        this.polymarket
          .search(query, options)
          .then(markets => ({ platform: 'polymarket' as const, markets }))
          .catch(error => ({
            platform: 'polymarket' as const,
            error: error instanceof Error ? error.message : String(error),
          }))
      );
    }

    if (this.betfair.isEnabled() && (!targetPlatform || targetPlatform === 'betfair')) {
      searchPromises.push(
        this.betfair
          .search(query, options)
          .then(markets => ({ platform: 'betfair' as const, markets }))
          .catch(error => ({
            platform: 'betfair' as const,
            error: error instanceof Error ? error.message : String(error),
          }))
      );
    }

    // Execute all searches in parallel
    const results = await Promise.all(searchPromises);

    // Process results
    for (const result of results) {
      if (result.error) {
        platforms[result.platform] = {
          status: 'error',
          error: result.error,
        };
        warnings.push(`${result.platform}: ${result.error}`);
      } else if (result.markets) {
        platforms[result.platform] = {
          status: 'success',
          count: result.markets.length,
        };
        allMarkets = allMarkets.concat(result.markets);
      }
    }

    // Apply filters
    if (options.minVolume) {
      allMarkets = filterByMinVolume(allMarkets, options.minVolume);
    }

    // Sort
    allMarkets = sortMarkets(allMarkets, options.sortBy || 'volume');

    // Limit results
    if (options.maxResults) {
      allMarkets = allMarkets.slice(0, options.maxResults);
    }

    return {
      markets: allMarkets,
      meta: {
        query,
        timestamp: nowISO(),
        platforms,
        totalResults: allMarkets.length,
        warnings,
      },
    };
  }

  // ============================================
  // OUTPUT FORMATTING
  // ============================================

  /**
   * Searches and returns results as a formatted markdown table.
   *
   * Includes platform warnings and result summary at the end.
   *
   * @param query - Search query
   * @param options - Search options (same as searchAll)
   * @returns Markdown-formatted table with results
   */
  async formatTable(query: string, options: SearchOptions = {}): Promise<string> {
    const result = await this.searchAll(query, options);

    let output = formatMarkdownTable(result.markets);

    // Add warnings if any
    if (result.meta.warnings.length > 0) {
      output += '\n\n**Warnings:**\n';
      for (const warning of result.meta.warnings) {
        output += `- ${warning}\n`;
      }
    }

    // Add summary
    output += `\n\n*${result.meta.totalResults} results found across `;
    const successPlatforms = Object.entries(result.meta.platforms)
      .filter(([_, status]) => status.status === 'success')
      .map(([name]) => name);
    output += successPlatforms.join(', ') + '*';

    return output;
  }

  // ============================================
  // MARKET OPERATIONS
  // ============================================

  /**
   * Gets a single market by ID from a specific platform.
   *
   * @param id - Market ID (platform-specific format)
   * @param platform - Target platform (polymarket|betfair)
   * @returns Market details or null if not found
   */
  async getMarket(id: string, platform: Platform): Promise<UnifiedMarket | null> {
    switch (platform) {
      case 'polymarket':
        return this.polymarket.getMarket(id);
      case 'betfair':
        return this.betfair.getMarket(id);
      default:
        return null;
    }
  }

  // ============================================
  // AUTHENTICATION
  // ============================================

  /**
   * Tests authentication for all platforms.
   *
   * Polymarket requires no auth (always authenticated).
   * Betfair requires valid API credentials.
   *
   * @returns Status per platform including any error messages
   */
  async testAuth(): Promise<Record<Platform, { enabled: boolean; authenticated: boolean; error?: string }>> {
    const results: Record<Platform, { enabled: boolean; authenticated: boolean; error?: string }> = {
      polymarket: { enabled: this.polymarket.isEnabled(), authenticated: true }, // No auth needed
      betfair: { enabled: this.betfair.isEnabled(), authenticated: false },
    };

    // Test Betfair auth
    if (this.betfair.isEnabled()) {
      try {
        results.betfair.authenticated = await this.betfair.testAuth?.() || false;
        if (!results.betfair.authenticated) {
          const err = this.betfair.getLastError?.();
          if (err) results.betfair.error = err;
        }
      } catch (e) {
        results.betfair.authenticated = false;
        results.betfair.error = e instanceof Error ? e.message : String(e);
      }
    }

    return results;
  }

  // ============================================
  // UTILITY
  // ============================================

  /** Returns list of available CLI commands with their options. */
  listTools(): { name: string; description: string; options?: string[] }[] {
    return [
      {
        name: 'search',
        description: 'Search markets across all platforms',
        options: ['--query', '--platform', '--min-volume', '--max-results'],
      },
      {
        name: 'format-table',
        description: 'Search and output markdown table',
        options: ['--query', '--min-volume', '--sort-by'],
      },
      {
        name: 'market',
        description: 'Get single market details',
        options: ['--id', '--platform'],
      },
      {
        name: 'auth-test',
        description: 'Test authentication for all platforms',
      },
      {
        name: 'list-tools',
        description: 'List available commands',
      },
    ];
  }
}
