/**
 * Betting Markets Aggregator
 *
 * Combines results from multiple platforms into unified output.
 * Searches prediction markets in parallel with graceful degradation.
 *
 * Key features:
 * - Parallel search: Query multiple platforms simultaneously
 * - Unified format: Normalizes odds/prices to percentages and USD volume
 * - Graceful degradation: Returns partial results if some platforms fail
 * - Markdown output: Formatted tables for easy reading
 * - Polymarket dedup: FinFeedAPI primary, native scraper as fallback
 * - Credit tracking: The Odds API budget management
 *
 * Supported platforms:
 * - Polymarket: Crypto prediction market (native scraper or via FinFeedAPI)
 * - Betfair: Traditional betting exchange (requires API credentials)
 * - The Odds API: Aggregated bookmaker odds (API key + credit budget)
 * - Kalshi, Manifold, Myriad: Via FinFeedAPI
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
  CreditStatus,
  AccountFundsResponse,
  BetfairTimeRange,
  OrderProjection,
  OrderBy,
  SortDir,
  BetStatus,
  Side,
  GroupBy,
} from './types.js';
import { PolymarketClient } from './polymarket-client.js';
import { BetfairClient } from './betfair-client.js';
import { TheOddsClient } from './theodds-client.js';
import { FinFeedClient } from './finfeed-client.js';
import { sortMarkets, filterByMinVolume, formatMarkdownTable, nowISO, formatGbpWithUsd, gbpToUsd } from './utils.js';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================
// AGGREGATOR
// ============================================

export class BettingMarketsAggregator {
  private polymarket: PolymarketClient;
  private betfair: BetfairClient;
  private theodds: TheOddsClient | null;
  private finfeed: FinFeedClient | null;
  private gbpToUsdRate: number;

  constructor() {
    // When compiled, __dirname is dist/, so look in parent for config.json
    const configPath = join(__dirname, '..', 'config.json');
    const config: Config = JSON.parse(readFileSync(configPath, 'utf-8'));
    this.gbpToUsdRate = config.settings?.gbpToUsd || 1.27;
    this.polymarket = new PolymarketClient(config.polymarket);
    this.betfair = new BetfairClient(config.betfair, this.gbpToUsdRate);
    this.theodds = config.theodds ? new TheOddsClient(config.theodds) : null;
    this.finfeed = config.finfeed ? new FinFeedClient(config.finfeed) : null;
  }

  // ============================================
  // SEARCH OPERATIONS
  // ============================================

  /**
   * Searches all enabled platforms in parallel.
   *
   * Polymarket deduplication:
   * - If FinFeedAPI handles Polymarket, skip the native scraper
   * - If FinFeedAPI fails for Polymarket specifically, retry with native scraper
   *
   * @param query - Search query for market names/descriptions
   * @param options - Search options
   * @returns Aggregated results with platform status metadata
   */
  async searchAll(query: string, options: SearchOptions = {}): Promise<AggregatedResult> {
    const platforms: Partial<Record<Platform, PlatformStatus>> = {};
    const warnings: string[] = [];
    let allMarkets: UnifiedMarket[] = [];

    const targetPlatform = options.platform;

    // Native scraper is always preferred for Polymarket (has real server-side
    // search via polymarket.com). FinFeedAPI's client-side filtering of 200
    // rows misses most markets — especially political/niche ones.
    const finfeedHandlesPolymarket = false;

    // Build search promises
    type SearchResult = {
      platform: Platform;
      markets?: UnifiedMarket[];
      error?: string;
    };

    const searchPromises: Promise<SearchResult>[] = [];

    // ── Polymarket (native scraper) ─────────────────────────────
    // Skip if FinFeedAPI handles it AND we're not specifically targeting polymarket
    const useNativePolymarket = this.polymarket.isEnabled() &&
      (!targetPlatform || targetPlatform === 'polymarket') &&
      !finfeedHandlesPolymarket;

    if (useNativePolymarket) {
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

    // ── Betfair ─────────────────────────────────────────────────
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

    // ── The Odds API ────────────────────────────────────────────
    if (this.theodds?.isEnabled() && (!targetPlatform || targetPlatform === 'theodds')) {
      searchPromises.push(
        this.theodds
          .search(query, options)
          .then(markets => ({ platform: 'theodds' as const, markets }))
          .catch(error => ({
            platform: 'theodds' as const,
            error: error instanceof Error ? error.message : String(error),
          }))
      );
    }

    // ── FinFeedAPI (multiple exchanges) ─────────────────────────
    if (this.finfeed?.isEnabled()) {
      // FinFeedAPI returns results tagged with their actual platform
      // (polymarket, kalshi, manifold, myriad) so we need to handle
      // them as a batch but track per-platform status
      const finfeedExchanges = this.getFinfeedTargetExchanges(targetPlatform);

      if (finfeedExchanges.length > 0) {
        searchPromises.push(
          this.finfeed
            .search(query, options)
            .then(markets => {
              // Group results by platform for status tracking
              const grouped = new Map<Platform, UnifiedMarket[]>();
              for (const market of markets) {
                const existing = grouped.get(market.platform) || [];
                existing.push(market);
                grouped.set(market.platform, existing);
              }

              // Record per-platform status
              for (const exchange of finfeedExchanges) {
                const platform = exchange as Platform;
                const exchangeMarkets = grouped.get(platform);
                if (exchangeMarkets) {
                  platforms[platform] = { status: 'success', count: exchangeMarkets.length };
                } else {
                  platforms[platform] = { status: 'success', count: 0 };
                }
              }

              return { platform: 'polymarket' as const, markets }; // Platform here is irrelevant — we set per-platform above
            })
            .catch(error => {
              const errorMsg = error instanceof Error ? error.message : String(error);
              for (const exchange of finfeedExchanges) {
                platforms[exchange as Platform] = { status: 'error', error: errorMsg };
              }
              warnings.push(`finfeed: ${errorMsg}`);
              return { platform: 'polymarket' as const, error: errorMsg };
            })
        );
      }
    }

    // Execute all searches in parallel
    const results = await Promise.all(searchPromises);

    // Process results
    for (const result of results) {
      if (result.error) {
        // Only set platform status if not already set by FinFeedAPI batch handler
        if (!platforms[result.platform]) {
          platforms[result.platform] = {
            status: 'error',
            error: result.error,
          };
          warnings.push(`${result.platform}: ${result.error}`);
        }
      } else if (result.markets) {
        allMarkets = allMarkets.concat(result.markets);
        // Only set platform status if not already set by FinFeedAPI batch handler
        if (!platforms[result.platform]) {
          platforms[result.platform] = {
            status: 'success',
            count: result.markets.length,
          };
        }
      }
    }

    // ── Polymarket fallback ─────────────────────────────────────
    // If FinFeedAPI was supposed to handle Polymarket but failed,
    // retry with the native scraper
    if (finfeedHandlesPolymarket &&
        platforms.polymarket?.status === 'error' &&
        this.polymarket.isEnabled() &&
        (!targetPlatform || targetPlatform === 'polymarket')) {
      try {
        const fallbackMarkets = await this.polymarket.search(query, options);
        platforms.polymarket = { status: 'success', count: fallbackMarkets.length };
        allMarkets = allMarkets.concat(fallbackMarkets);
        warnings.push('polymarket: fell back to native scraper (FinFeedAPI failed)');
      } catch (error) {
        // Both failed — keep the original error
        warnings.push(`polymarket fallback: ${error instanceof Error ? error.message : String(error)}`);
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

    // Include credit status if TheOdds was queried
    let creditStatus: CreditStatus | undefined;
    if (this.theodds?.isEnabled() && (!targetPlatform || targetPlatform === 'theodds')) {
      creditStatus = this.theodds.getCreditStatus();
    }

    return {
      markets: allMarkets,
      meta: {
        query,
        timestamp: nowISO(),
        platforms,
        totalResults: allMarkets.length,
        warnings,
        ...(creditStatus && { creditStatus }),
      },
    };
  }

  /**
   * Determine which FinFeedAPI exchanges to query based on target platform.
   */
  private getFinfeedTargetExchanges(targetPlatform?: Platform): string[] {
    if (!this.finfeed?.isEnabled()) return [];

    // Polymarket excluded — native scraper has real server-side search
    const allExchanges = ['kalshi', 'manifold', 'myriad'];

    if (targetPlatform) {
      if (targetPlatform === 'polymarket') return []; // Native scraper handles this
      if (this.finfeed.handlesExchange(targetPlatform)) {
        return [targetPlatform];
      }
      return [];
    }

    return allExchanges.filter(e => this.finfeed!.handlesExchange(e));
  }

  // ============================================
  // OUTPUT FORMATTING
  // ============================================

  /**
   * Searches and returns results as a formatted markdown table.
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
      .filter(([_, status]) => status?.status === 'success')
      .map(([name]) => name);
    output += successPlatforms.join(', ') + '*';

    // Add credit status if available
    if (result.meta.creditStatus) {
      const cs = result.meta.creditStatus;
      output += `\n*The Odds API credits: ${cs.used}/${cs.budget} used (${cs.percentUsed}%)*`;
    }

    return output;
  }

  // ============================================
  // MARKET OPERATIONS
  // ============================================

  /**
   * Gets a single market by ID from a specific platform.
   */
  async getMarket(id: string, platform: Platform): Promise<UnifiedMarket | null> {
    switch (platform) {
      case 'polymarket':
        return this.polymarket.getMarket(id);
      case 'betfair':
        return this.betfair.getMarket(id);
      case 'theodds':
        return this.theodds?.getMarket(id) || null;
      case 'kalshi':
      case 'manifold':
      case 'myriad':
        return this.finfeed?.getMarket(id) || null;
      default:
        return null;
    }
  }

  // ============================================
  // AUTHENTICATION
  // ============================================

  /**
   * Tests authentication for all platforms.
   */
  async testAuth(): Promise<Partial<Record<Platform, { enabled: boolean; authenticated: boolean; error?: string }>>> {
    const results: Partial<Record<Platform, { enabled: boolean; authenticated: boolean; error?: string }>> = {
      polymarket: { enabled: this.polymarket.isEnabled(), authenticated: true }, // No auth needed
      betfair: { enabled: this.betfair.isEnabled(), authenticated: false },
    };

    // Test Betfair auth
    if (this.betfair.isEnabled()) {
      try {
        results.betfair!.authenticated = await this.betfair.testAuth?.() || false;
        if (!results.betfair!.authenticated) {
          const err = this.betfair.getLastError?.();
          if (err) results.betfair!.error = err;
        }
      } catch (e) {
        results.betfair!.authenticated = false;
        results.betfair!.error = e instanceof Error ? e.message : String(e);
      }
    }

    // Test The Odds API (0 credits — uses /v4/sports)
    if (this.theodds) {
      results.theodds = { enabled: this.theodds.isEnabled(), authenticated: false };
      if (this.theodds.isEnabled()) {
        try {
          results.theodds.authenticated = await this.theodds.testAuth?.() || false;
          if (!results.theodds.authenticated) {
            const err = this.theodds.getLastError?.();
            if (err) results.theodds.error = err;
          }
        } catch (e) {
          results.theodds.authenticated = false;
          results.theodds.error = e instanceof Error ? e.message : String(e);
        }
      }
    }

    // Test FinFeedAPI
    if (this.finfeed) {
      // FinFeedAPI covers multiple platforms — show as a single entry
      const finfeedResult = { enabled: this.finfeed.isEnabled(), authenticated: false, error: undefined as string | undefined };
      if (this.finfeed.isEnabled()) {
        try {
          finfeedResult.authenticated = await this.finfeed.testAuth?.() || false;
          if (!finfeedResult.authenticated) {
            const err = this.finfeed.getLastError?.();
            if (err) finfeedResult.error = err;
          }
        } catch (e) {
          finfeedResult.authenticated = false;
          finfeedResult.error = e instanceof Error ? e.message : String(e);
        }
      }

      // Report FinFeedAPI status for each exchange it handles
      for (const exchange of ['kalshi', 'manifold', 'myriad'] as Platform[]) {
        if (this.finfeed.handlesExchange(exchange)) {
          results[exchange] = { ...finfeedResult };
        }
      }
    }

    return results;
  }

  // ============================================
  // CREDIT STATUS (The Odds API)
  // ============================================

  getCreditStatus(): CreditStatus | null {
    if (!this.theodds?.isEnabled()) return null;
    return this.theodds.getCreditStatus();
  }

  getFormattedCreditStatus(): string {
    if (!this.theodds?.isEnabled()) return 'The Odds API is not enabled.';
    return this.theodds.getFormattedCreditStatus();
  }

  // ============================================
  // SPORTS LIST (The Odds API)
  // ============================================

  async listSports(): Promise<{ key: string; title: string; group: string; active: boolean }[]> {
    if (!this.theodds?.isEnabled()) {
      throw new Error('The Odds API is not enabled. Add API key to config.json.');
    }
    const sports = await this.theodds.listSports();
    return sports.map(s => ({
      key: s.key,
      title: s.title,
      group: s.group,
      active: s.active,
    }));
  }

  // ============================================
  // BETFAIR ACCOUNT OPERATIONS
  // ============================================

  /**
   * Get Betfair account balance and exposure.
   * Enriches response with formatted GBP/USD strings.
   */
  async getAccountFunds(): Promise<AccountFundsResponse & { formatted: Record<string, string>; gbpToUsdRate: number }> {
    const funds = await this.betfair.getAccountFunds();
    return {
      ...funds,
      gbpToUsdRate: this.gbpToUsdRate,
      formatted: {
        availableToBetBalance: formatGbpWithUsd(funds.availableToBetBalance, this.gbpToUsdRate),
        exposure: formatGbpWithUsd(funds.exposure, this.gbpToUsdRate),
        retainedCommission: formatGbpWithUsd(funds.retainedCommission, this.gbpToUsdRate),
        exposureLimit: formatGbpWithUsd(funds.exposureLimit, this.gbpToUsdRate),
      },
    };
  }

  /**
   * Get Betfair account statement (transaction history).
   */
  async getAccountStatement(options: {
    itemDateRange?: BetfairTimeRange;
    includeItem?: string;
    recordCount?: number;
    maxPages?: number;
  } = {}) {
    return this.betfair.getAccountStatement(options);
  }

  /**
   * List current (open) Betfair orders.
   */
  async getCurrentOrders(options: {
    orderProjection?: OrderProjection;
    marketIds?: string[];
    dateRange?: BetfairTimeRange;
    orderBy?: OrderBy;
    sortDir?: SortDir;
    recordCount?: number;
    maxPages?: number;
  } = {}) {
    return this.betfair.getCurrentOrders(options);
  }

  /**
   * List cleared (settled) Betfair orders.
   */
  async getClearedOrders(options: {
    betStatus: BetStatus;
    eventTypeIds?: string[];
    marketIds?: string[];
    side?: Side;
    settledDateRange?: BetfairTimeRange;
    groupBy?: GroupBy;
    recordCount?: number;
    maxPages?: number;
  }) {
    return this.betfair.getClearedOrders(options);
  }

  /**
   * Combined account dashboard: balance + open orders + recent P&L.
   * Uses pre-auth + Promise.allSettled for resilience.
   */
  async getAccountSummary(): Promise<{
    funds?: AccountFundsResponse & { formatted: Record<string, string>; gbpToUsdRate: number };
    fundsError?: string;
    openOrders?: { count: number; totalStake: number; formatted: string };
    openOrdersError?: string;
    recentSettled?: { count: number; totalProfit: number; totalCommission: number; formatted: string };
    recentSettledError?: string;
  }> {
    // Pre-auth to avoid 3 concurrent login attempts
    await this.betfair.ensureAuthenticated();

    const [fundsResult, ordersResult, settledResult] = await Promise.allSettled([
      this.getAccountFunds(),
      this.getCurrentOrders({ orderProjection: 'EXECUTABLE' }),
      this.getClearedOrders({ betStatus: 'SETTLED', maxPages: 1 }),
    ]);

    const result: Awaited<ReturnType<typeof this.getAccountSummary>> = {};

    // Funds
    if (fundsResult.status === 'fulfilled') {
      result.funds = fundsResult.value;
    } else {
      result.fundsError = fundsResult.reason instanceof Error ? fundsResult.reason.message : String(fundsResult.reason);
    }

    // Open orders
    if (ordersResult.status === 'fulfilled') {
      const orders = ordersResult.value.orders;
      const totalStake = orders.reduce((sum, o) => sum + o.sizeRemaining, 0);
      result.openOrders = {
        count: orders.length,
        totalStake,
        formatted: `${orders.length} open order(s), ${formatGbpWithUsd(totalStake, this.gbpToUsdRate)} at stake`,
      };
    } else {
      result.openOrdersError = ordersResult.reason instanceof Error ? ordersResult.reason.message : String(ordersResult.reason);
    }

    // Recent settled
    if (settledResult.status === 'fulfilled') {
      const settled = settledResult.value.orders;
      const totalProfit = settled.reduce((sum, o) => sum + (o.profit || 0), 0);
      const totalCommission = settled.reduce((sum, o) => sum + (o.commission || 0), 0);
      result.recentSettled = {
        count: settled.length,
        totalProfit,
        totalCommission,
        formatted: `${settled.length} settled bet(s), P&L: ${formatGbpWithUsd(totalProfit, this.gbpToUsdRate)}, commission: ${formatGbpWithUsd(totalCommission, this.gbpToUsdRate)}`,
      };
    } else {
      result.recentSettledError = settledResult.reason instanceof Error ? settledResult.reason.message : String(settledResult.reason);
    }

    return result;
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
        options: ['--query', '--platform', '--min-volume', '--max-results', '--sport'],
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
        name: 'credit-status',
        description: 'Show The Odds API credit usage',
      },
      {
        name: 'list-sports',
        description: 'List available The Odds API sports (0 credits)',
      },
      {
        name: 'account-funds',
        description: 'Show Betfair account balance and exposure',
      },
      {
        name: 'account-statement',
        description: 'Show Betfair account transaction history',
        options: ['--date-from', '--date-to', '--include-item', '--limit', '--max-pages'],
      },
      {
        name: 'current-orders',
        description: 'List open Betfair orders',
        options: ['--order-projection', '--market-ids', '--date-from', '--date-to', '--order-by', '--sort-dir', '--limit', '--max-pages'],
      },
      {
        name: 'cleared-orders',
        description: 'List settled/voided Betfair orders',
        options: ['--bet-status', '--event-type-ids', '--market-ids', '--side', '--date-from', '--date-to', '--group-by', '--limit', '--max-pages'],
      },
      {
        name: 'account-summary',
        description: 'Betfair account dashboard (balance + orders + P&L)',
      },
      {
        name: 'chart',
        description: 'Generate historical probability chart (Polymarket, Kalshi)',
        options: ['--market', '--platform', '--output', '--width', '--height', '--title'],
      },
      {
        name: 'list-tools',
        description: 'List available commands',
      },
    ];
  }
}
