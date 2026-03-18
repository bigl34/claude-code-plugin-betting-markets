/**
 * FinFeedAPI Prediction Markets Client
 *
 * Aggregates prediction market data from Polymarket, Kalshi, Manifold, and Myriad
 * via the FinFeedAPI unified REST API (backed by CoinAPI infrastructure).
 *
 * Key design decisions informed by the OpenAPI spec:
 * - Base URL: https://api.prediction-markets.finfeedapi.com
 * - Auth: Authorization header with raw API key (no Bearer prefix)
 * - Exchange IDs are UPPERCASE: POLYMARKET, KALSHI, MANIFOLD, MYRIAD
 * - Each market row = one outcome (binary markets have _YES and _NO rows)
 * - Markets grouped by title to reconstruct multi-outcome views
 * - No server-side text search — list + client-side filter
 * - Endpoint: GET /v1/markets/{EXCHANGE_ID}/history?limit=N&page=N
 *
 * API docs: https://docs.finfeedapi.com/prediction-markets-api/
 * OpenAPI spec: github.com/api-bricks/api-bricks-sdk/finfeedapi/prediction-markets-api-rest/spec/
 */

import type {
  UnifiedMarket,
  MarketClient,
  SearchOptions,
  FinFeedConfig,
  Platform,
  Outcome,
} from './types.js';
import { polymarketOddsToPercent, nowISO } from './utils.js';
import { PluginCache } from '@local/plugin-cache';

const CACHE_TTL_MARKETS = 30 * 60 * 1000; // 30 minutes for market listings

// =============================================================================
// FinFeedAPI Response Types (from OpenAPI spec)
// =============================================================================

/** Markets.MarketModel — each row is a single outcome */
interface FinFeedMarketRow {
  market_id: string;         // e.g. "WILL-TRUMP-SELL-10K-25K-GOLD-CARDS-IN-2025_YES"
  title: string;             // e.g. "Will Trump sell 10k-25k Gold Cards in 2025?"
  description?: string | null;
  outcome_name: string;      // e.g. "Yes", "No"
  price: number;             // 0.00 - 1.00
  status: string;            // "Open", "Closed", "Resolved", "Suspended"
  exchange_id: string;       // "POLYMARKET", "KALSHI", etc.
  outcome_type?: string;     // "Binary", "MultipleChoice", "Numeric"
  mechanism?: string;        // "CPMM", "CLOB"
  source_specific_data?: Record<string, unknown> | null;
}

// =============================================================================
// Exchange → Platform Mapping
// =============================================================================

/** Maps FinFeedAPI UPPERCASE exchange_id → our Platform type */
const EXCHANGE_TO_PLATFORM: Record<string, Platform> = {
  POLYMARKET: 'polymarket',
  KALSHI: 'kalshi',
  MANIFOLD: 'manifold',
  MYRIAD: 'myriad',
};

/** Maps our Platform type → FinFeedAPI UPPERCASE exchange_id */
const PLATFORM_TO_EXCHANGE: Record<string, string> = {
  polymarket: 'POLYMARKET',
  kalshi: 'KALSHI',
  manifold: 'MANIFOLD',
  myriad: 'MYRIAD',
};

const DEFAULT_EXCHANGES = ['POLYMARKET', 'KALSHI', 'MANIFOLD', 'MYRIAD'];

// =============================================================================
// FinFeedAPI Client
// =============================================================================

export class FinFeedClient implements MarketClient {
  private apiKey: string;
  private baseUrl: string;
  private exchanges: string[];  // UPPERCASE exchange IDs
  private enabled: boolean;
  private lastError: string | null = null;
  private cache: PluginCache;

  constructor(config: FinFeedConfig) {
    this.apiKey = config.apiKey || '';
    this.baseUrl = config.baseUrl || 'https://api.prediction-markets.finfeedapi.com';
    // Config stores lowercase, API needs UPPERCASE
    this.exchanges = (config.exchanges || ['polymarket', 'kalshi', 'manifold', 'myriad'])
      .map(e => PLATFORM_TO_EXCHANGE[e] || e.toUpperCase());
    this.enabled = config.enabled !== false && !!config.apiKey;
    this.cache = new PluginCache({
      namespace: 'betting-markets-finfeed',
      defaultTTL: CACHE_TTL_MARKETS,
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  /**
   * Check if this client handles a specific exchange (lowercase platform name).
   * Used by the aggregator to skip native Polymarket scraper when FinFeedAPI covers it.
   */
  handlesExchange(exchangeName: string): boolean {
    const upperId = PLATFORM_TO_EXCHANGE[exchangeName.toLowerCase()] || exchangeName.toUpperCase();
    return this.enabled && this.exchanges.includes(upperId);
  }

  // ============================================
  // API REQUESTS
  // ============================================

  private async apiGet<T>(path: string, params: Record<string, string> = {}, retries = 1): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': this.apiKey,
        'Accept': 'application/json',
      },
    });

    // Handle rate limiting with retry
    if (response.status === 429 && retries > 0) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '16', 10);
      const waitMs = (retryAfter + 1) * 1000; // Add 1s buffer
      await new Promise(r => setTimeout(r, waitMs));
      return this.apiGet<T>(path, params, retries - 1);
    }

    if (!response.ok) {
      const errorText = await response.text();
      this.lastError = `FinFeedAPI error: ${response.status} - ${errorText.substring(0, 200)}`;
      throw new Error(this.lastError);
    }

    return response.json() as Promise<T>;
  }

  // ============================================
  // SEARCH
  // ============================================

  /**
   * Search markets across enabled exchanges.
   *
   * FinFeedAPI has no server-side text search — we list markets via
   * GET /v1/markets/{EXCHANGE_ID}/history and filter client-side.
   *
   * Each API row is a single outcome. Binary markets return two rows
   * (title_YES and title_NO). We group by title to reconstruct
   * multi-outcome UnifiedMarkets.
   */
  async search(query: string, options: SearchOptions = {}): Promise<UnifiedMarket[]> {
    if (!this.enabled) return [];
    this.lastError = null;

    const queryLower = query.toLowerCase();

    // Determine which exchanges to query
    let targetExchanges = this.exchanges;

    if (options.platform) {
      const upperId = PLATFORM_TO_EXCHANGE[options.platform];
      if (upperId && this.exchanges.includes(upperId)) {
        targetExchanges = [upperId];
      } else {
        return [];
      }
    }

    const allMarkets: UnifiedMarket[] = [];

    // Query exchanges — use cached listings when available to avoid rate limit delays
    for (let i = 0; i < targetExchanges.length; i++) {
      const exchangeId = targetExchanges[i];
      try {
        const rows = await this.getExchangeMarkets(exchangeId, i > 0);

        // Filter by query text
        const matchingRows = rows.filter(row => {
          const text = `${row.title} ${row.description || ''}`.toLowerCase();
          return text.includes(queryLower) ||
            queryLower.split(/\s+/).some(term => text.includes(term));
        });

        // Group rows by title (each outcome is a separate row)
        const grouped = this.groupByTitle(matchingRows);

        for (const market of grouped) {
          allMarkets.push(market);
        }
      } catch (error) {
        console.error(`FinFeedAPI search error for ${exchangeId}:`, error);
      }
    }

    // Sort by primary odds descending and limit
    const maxResults = options.maxResults || 50;
    return allMarkets.slice(0, maxResults);
  }

  /**
   * Search a single exchange only (by lowercase name).
   */
  async searchExchange(exchange: string, query: string, options: SearchOptions = {}): Promise<UnifiedMarket[]> {
    if (!this.enabled) return [];
    const upperId = PLATFORM_TO_EXCHANGE[exchange] || exchange.toUpperCase();
    if (!this.exchanges.includes(upperId)) return [];

    return this.search(query, { ...options, platform: exchange as Platform });
  }

  // ============================================
  // CACHED EXCHANGE LISTINGS
  // ============================================

  /**
   * Get market listings for an exchange, using cache to avoid rate limit delays.
   * Cache TTL: 30 minutes. On cache miss, fetches 3 pages (600 rows) from API.
   * Multi-page fetch is slow on cold cache (~32s per exchange due to rate limits)
   * but instant on subsequent searches within the cache window.
   */
  private async getExchangeMarkets(exchangeId: string, needsDelay: boolean): Promise<FinFeedMarketRow[]> {
    const cacheKey = `markets_${exchangeId}`;
    const cached = this.cache.get<FinFeedMarketRow[]>(cacheKey, { ttl: CACHE_TTL_MARKETS });

    if (cached.hit && !cached.stale) {
      return cached.data!;
    }

    const allRows: FinFeedMarketRow[] = [];
    const pagesToFetch = 3;

    for (let page = 1; page <= pagesToFetch; page++) {
      // Rate limit delay between API requests (free tier: ~1 req/15s)
      if (needsDelay || page > 1) {
        await new Promise(r => setTimeout(r, 16000));
      }

      const rows = await this.apiGet<FinFeedMarketRow[]>(
        `/v1/markets/${exchangeId}/history`,
        { limit: '200', page: String(page) }
      );

      allRows.push(...rows);

      // Stop early if we got fewer than 200 — no more pages
      if (rows.length < 200) break;
    }

    await this.cache.set(cacheKey, allRows, { ttl: CACHE_TTL_MARKETS });
    return allRows;
  }

  // ============================================
  // MARKET DETAILS
  // ============================================

  async getMarket(id: string): Promise<UnifiedMarket | null> {
    if (!this.enabled) return null;

    // Try activity endpoint for current price data on each exchange
    for (const exchangeId of this.exchanges) {
      try {
        const activity = await this.apiGet<{
          trade?: { market_id: string; price: number };
          quote?: { ask: number; bid: number };
        }>(`/v1/activity/${exchangeId}/${id}/current`);

        if (activity.trade || activity.quote) {
          const price = activity.trade?.price ?? activity.quote?.bid ?? 0.5;
          return {
            platform: EXCHANGE_TO_PLATFORM[exchangeId] || 'polymarket',
            id,
            url: '',
            question: id.replace(/_/g, ' ').replace(/-/g, ' '),
            odds: polymarketOddsToPercent(price),
            volume: 0,
            status: 'open',
            lastUpdated: nowISO(),
          };
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  // ============================================
  // AUTH TEST
  // ============================================

  async testAuth(): Promise<boolean> {
    if (!this.enabled) {
      this.lastError = 'FinFeedAPI client is disabled (missing API key)';
      return false;
    }

    this.lastError = null;

    try {
      // Test with the exchanges list endpoint (lightweight, no market data)
      const exchanges = await this.apiGet<Array<{ exchange_id: string }>>(
        '/v1/exchanges'
      );
      return Array.isArray(exchanges) && exchanges.length > 0;
    } catch (error) {
      this.lastError = `Auth test failed: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  // ============================================
  // NORMALIZATION
  // ============================================

  /**
   * Group flat outcome rows by title into multi-outcome UnifiedMarkets.
   *
   * The API returns one row per outcome:
   *   { title: "Will X?", outcome_name: "Yes", price: 0.65 }
   *   { title: "Will X?", outcome_name: "No",  price: 0.35 }
   *
   * We group these into a single UnifiedMarket with an outcomes array.
   */
  private groupByTitle(rows: FinFeedMarketRow[]): UnifiedMarket[] {
    const groups = new Map<string, FinFeedMarketRow[]>();

    for (const row of rows) {
      const key = `${row.exchange_id}::${row.title}`;
      const existing = groups.get(key) || [];
      existing.push(row);
      groups.set(key, existing);
    }

    const markets: UnifiedMarket[] = [];

    for (const [_, groupRows] of groups) {
      const first = groupRows[0];
      const platform = EXCHANGE_TO_PLATFORM[first.exchange_id] || 'polymarket';

      // Build outcomes from all rows in this group
      const outcomes: Outcome[] = groupRows.map(row => ({
        name: row.outcome_name,
        odds: polymarketOddsToPercent(row.price),
        source: first.exchange_id.toLowerCase(),
      }));

      // Sort by odds descending
      outcomes.sort((a, b) => b.odds - a.odds);

      const primaryOdds = outcomes[0]?.odds || 50;

      // Determine status (lowercase for our enum)
      let status: UnifiedMarket['status'] = 'unknown';
      const rawStatus = first.status?.toLowerCase();
      if (rawStatus === 'open') status = 'open';
      else if (rawStatus === 'closed' || rawStatus === 'resolved') status = 'closed';

      // Use the first row's market_id (strip outcome suffix for the event-level ID)
      const baseId = first.market_id.replace(/_(YES|NO)$/i, '');

      markets.push({
        platform,
        id: baseId,
        url: '',
        question: first.title,
        outcomes,
        odds: primaryOdds,
        volume: 0, // FinFeedAPI market listing doesn't include volume
        status,
        lastUpdated: nowISO(),
      });
    }

    return markets;
  }
}
