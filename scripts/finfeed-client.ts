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
import { PluginCache } from './cache-support/cache.js';
import { fetchWithRetry, DEFAULT_RETRY_CONFIG } from './retry.js';

const CACHE_TTL_MARKETS = 30 * 60 * 1000; // 30 minutes for market listings
const REQUEST_TIMEOUT_MS = 30_000;

// 429 retry is handled manually below (we honour the Retry-After header). Strip
// '429' from the default retryable-errors list so fetchWithRetry does not also
// retry it with generic exponential backoff before the manual handler runs.
const FINFEED_RETRYABLE_ERRORS = DEFAULT_RETRY_CONFIG.retryableErrors.filter(e => e !== '429');

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
  exchange?: string;         // human-readable exchange name (added by the API in 2026-06)
  exchange_id: string;       // "POLYMARKET", "KALSHI", etc.
  outcome_type?: string;     // "Binary", "MultipleChoice", "Numeric"
  mechanism?: string;        // "CPMM", "CLOB"
  source_specific_data?: Record<string, unknown> | null;
}

/**
 * Cursor-paginated envelope returned by GET /v1/markets/{EXCHANGE}/history.
 *
 * The endpoint historically returned a bare `FinFeedMarketRow[]`. As of 2026-06
 * it wraps the rows in `{ data, next_cursor }` and paginates by opaque cursor
 * (the old `page` query param is silently ignored). We model both shapes so the
 * client survives whichever the API serves.
 */
interface FinFeedHistoryEnvelope {
  data: FinFeedMarketRow[];
  next_cursor?: string | null;
}

type FinFeedHistoryResponse = FinFeedHistoryEnvelope | FinFeedMarketRow[];

/**
 * Unwrap the outcome rows from a history response, accepting both the legacy
 * bare-array shape and the 2026-06 `{ data, next_cursor }` envelope.
 *
 * Returns an empty array for any unrecognised shape rather than letting a
 * non-iterable reach a spread operator (the root cause of the 2026-06 crash).
 */
export function extractHistoryRows(response: FinFeedHistoryResponse): FinFeedMarketRow[] {
  if (Array.isArray(response)) {
    return response;
  }
  if (response && Array.isArray(response.data)) {
    return response.data;
  }
  console.error('FinFeedAPI: unexpected history response shape (no array, no .data array) — returning 0 rows');
  return [];
}

/**
 * Extract the pagination cursor for the next page, or undefined when the API
 * signals there are no further pages (or served the cursor-less legacy shape).
 */
export function extractHistoryCursor(response: FinFeedHistoryResponse): string | undefined {
  if (Array.isArray(response)) {
    return undefined;
  }
  const cursor = response?.next_cursor;
  return cursor ? cursor : undefined;
}

// =============================================================================
// Per-exchange row normalization (2026-06 schema revamp)
//
// The /history payload's top-level `title`/`price`/`status` became placeholders
// (title = market_id, price = 0, status unreliable). The real values moved into
// `source_specific_data`, with a different shape per exchange. These helpers
// recover a human title + 0-1 outcome probability + status for each row.
// =============================================================================

/** A row normalized to display-ready fields, regardless of source exchange. */
export interface FinFeedRowView {
  title: string;        // human-readable market title
  probability: number;  // 0-1 probability for THIS row's outcome
  status: string;       // raw status string ("active", "resolved", ...)
}

/** Safe string read from an untyped source_specific_data bag. */
function ssdString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Kalshi YES probability (0-1). Prefers the last traded price; falls back to the
 * bid/ask midpoint when the market hasn't traded. Kalshi serves these as dollar
 * strings ("0.6000") in source_specific_data.
 *
 * Returns NaN when there is NO usable price signal at all (no last price, no
 * bid, no ask) so callers can leave the outcome as "unknown" rather than
 * fabricating a 100% complement for the NO outcome.
 */
export function kalshiYesProbability(ssd: Record<string, unknown>): number {
  const lastPrice = parseFloat(ssdString(ssd.LastPriceDollars));
  if (Number.isFinite(lastPrice) && lastPrice > 0) {
    return lastPrice;
  }
  const bid = parseFloat(ssdString(ssd.YesBidDollars));
  const ask = parseFloat(ssdString(ssd.YesAskDollars));
  const bidValid = Number.isFinite(bid) && bid > 0;
  const askValid = Number.isFinite(ask) && ask > 0;
  if (bidValid && askValid) {
    return (bid + ask) / 2;
  }
  if (bidValid) return bid;
  if (askValid) return ask;
  // A genuine, finite zero last price is still real data; a missing/unparseable
  // field is not — signal the latter with NaN.
  return Number.isFinite(lastPrice) ? lastPrice : NaN;
}

/**
 * Manifold YES probability (0-1) for a binary cpmm-1 market, computed from the
 * AMM pool: prob = p·poolNO / (p·poolNO + (1-p)·poolYES). Verified against
 * Manifold's live /v0/market probability. Returns NaN for non-binary markets.
 */
export function manifoldYesProbability(ssd: Record<string, unknown>): number {
  const outcomeType = ssdString(ssd.OutcomeType).toUpperCase();
  const mechanism = ssdString(ssd.Mechanism).toLowerCase();
  if (outcomeType !== 'BINARY' || mechanism !== 'cpmm-1') {
    return NaN;
  }
  const p = parseFloat(ssdString(ssd.P));
  let pool: { YES?: number; NO?: number } | null = null;
  try {
    pool = JSON.parse(ssdString(ssd.Pool));
  } catch {
    pool = null;
  }
  if (!pool || !Number.isFinite(p)) {
    return NaN;
  }
  const poolYes = Number(pool.YES);
  const poolNo = Number(pool.NO);
  if (!Number.isFinite(poolYes) || !Number.isFinite(poolNo)) {
    return NaN;
  }
  const denominator = p * poolNo + (1 - p) * poolYes;
  if (denominator <= 0) {
    return NaN;
  }
  return (p * poolNo) / denominator;
}

/**
 * Normalize one outcome row to display-ready fields, recovering the real values
 * from source_specific_data per exchange. Falls back to the (legacy) top-level
 * fields for any exchange we don't special-case or any missing data.
 */
export function extractRowView(row: FinFeedMarketRow): FinFeedRowView {
  const ssd = row.source_specific_data || {};
  const exchange = (row.exchange_id || '').toUpperCase();
  const isYesOutcome = (row.outcome_name || '').toLowerCase() === 'yes';

  // Legacy top-level defaults (used as-is if an exchange isn't special-cased).
  let title = row.title;
  let probability = row.price;
  let status = row.status;

  if (exchange === 'KALSHI') {
    title = ssdString(ssd.Title) || title;
    status = ssdString(ssd.Status) || status;
    const yesProbability = kalshiYesProbability(ssd);
    // Guard like the Manifold branch: only overwrite when there's real price
    // data, so an untraded market doesn't show a fabricated 100% NO.
    if (Number.isFinite(yesProbability)) {
      probability = isYesOutcome ? yesProbability : 1 - yesProbability;
    }
  } else if (exchange === 'MANIFOLD') {
    title = ssdString(ssd.Question) || title;
    status = ssdString(ssd.Status) || status;
    const yesProbability = manifoldYesProbability(ssd);
    if (Number.isFinite(yesProbability)) {
      probability = isYesOutcome ? yesProbability : 1 - yesProbability;
    }
  } else if (exchange === 'MYRIAD') {
    // Myriad's FinFeed payload carries a human Title but no price/probability,
    // so outcome odds remain unavailable (left at the top-level default).
    title = ssdString(ssd.Title) || title;
    status = ssdString(ssd.State) || status;
  }

  return { title, probability, status };
}

function sourceSpecificStrings(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.flatMap(item => sourceSpecificStrings(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .flatMap(item => sourceSpecificStrings(item, depth + 1));
  }
  return [];
}

export function buildFinFeedSearchText(row: FinFeedMarketRow): string {
  const view = extractRowView(row);
  return [
    view.title,
    row.description || '',
    ...sourceSpecificStrings(row.source_specific_data),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function finFeedRowMatchesQuery(row: FinFeedMarketRow, query: string): boolean {
  const queryLower = query.trim().toLowerCase();
  if (!queryLower) return true;
  const text = buildFinFeedSearchText(row);
  const terms = queryLower.split(/\s+/).filter(Boolean);
  return text.includes(queryLower) || terms.some(term => text.includes(term));
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

    const response = await fetchWithRetry(
      url.toString(),
      {
        headers: {
          'Authorization': this.apiKey,
          'Accept': 'application/json',
        },
      },
      {
        maxRetries: 3,
        timeoutMs: REQUEST_TIMEOUT_MS,
        retryableErrors: FINFEED_RETRYABLE_ERRORS,
      },
      "FinFeed.request"
    );

    // Handle rate limiting with retry — we honour the Retry-After header
    // (fetchWithRetry is configured NOT to retry 429s for this reason).
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
        const matchingRows = rows.filter(row => finFeedRowMatchesQuery(row, query));

        // Group rows by title (each outcome is a separate row)
        const grouped = this.groupByTitle(matchingRows);

        for (const market of grouped) {
          allMarkets.push(market);
        }
      } catch (error) {
        console.error("FinFeedAPI search error for", exchangeId, ":", error);
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
   * Cache TTL: 30 minutes. On cache miss, fetches up to 3 cursor pages (600 rows).
   * Multi-page fetch is slow on cold cache (~32s per exchange due to rate limits)
   * but instant on subsequent searches within the cache window.
   *
   * Pagination is cursor-based (the API ignores the legacy `page` param): each
   * response carries a `next_cursor` we pass back to fetch the following page.
   */
  private async getExchangeMarkets(exchangeId: string, needsDelay: boolean): Promise<FinFeedMarketRow[]> {
    const cacheKey = `markets_${exchangeId}`;
    const cached = this.cache.get<FinFeedMarketRow[]>(cacheKey, { ttl: CACHE_TTL_MARKETS });

    if (cached.hit && !cached.stale) {
      return cached.data!;
    }

    const allRows: FinFeedMarketRow[] = [];
    const pageSize = 200;
    const maxPages = 3;            // coverage cap: 600 rows per exchange
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      // Defensive: if the API ever echoes a cursor we've already fetched, stop
      // rather than re-fetching the same page (would duplicate rows).
      if (cursor && seenCursors.has(cursor)) {
        break;
      }

      // Rate limit delay between API requests (free tier: ~1 req/15s). The very
      // first request of a single-exchange query skips the delay; subsequent
      // pages and follow-on exchanges always wait.
      const isFirstRequestOfBatch = pageIndex === 0;
      const needsRateLimitDelay = needsDelay || !isFirstRequestOfBatch;
      if (needsRateLimitDelay) {
        await new Promise(r => setTimeout(r, 16000));
      }

      const params: Record<string, string> = { limit: String(pageSize) };
      if (cursor) {
        seenCursors.add(cursor);
        params.cursor = cursor;
      }

      const response = await this.apiGet<FinFeedHistoryResponse>(
        `/v1/markets/${exchangeId}/history`,
        params
      );

      const rows = extractHistoryRows(response);
      allRows.push(...rows);

      cursor = extractHistoryCursor(response);

      // Stop when the API signals no further pages (no cursor) or returns a
      // short page (fewer rows than requested).
      const reachedLastPage = !cursor || rows.length < pageSize;
      if (reachedLastPage) {
        break;
      }
    }

    // Dedup by market_id as a correctness backstop against overlapping pages —
    // duplicate rows would otherwise distort grouped outcomes.
    const uniqueRows = Array.from(
      new Map(allRows.map(row => [row.market_id, row])).values()
    );

    await this.cache.set(cacheKey, uniqueRows, { ttl: CACHE_TTL_MARKETS });
    return uniqueRows;
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
   * Each API row is one outcome. As of the 2026-06 schema revamp the real title
   * and price live in source_specific_data, so we normalize every row through
   * extractRowView first, then group by the recovered human title (this is also
   * what lets a market's YES and NO rows collapse into one UnifiedMarket — they
   * share a title only after normalization).
   */
  private groupByTitle(rows: FinFeedMarketRow[]): UnifiedMarket[] {
    // Normalize each row to (title, probability, status) before grouping.
    const normalizedRows = rows.map(row => ({ row, view: extractRowView(row) }));

    const groups = new Map<string, Array<{ row: FinFeedMarketRow; view: FinFeedRowView }>>();
    for (const entry of normalizedRows) {
      const key = `${entry.row.exchange_id}::${entry.view.title}`;
      const existing = groups.get(key) || [];
      existing.push(entry);
      groups.set(key, existing);
    }

    const markets: UnifiedMarket[] = [];

    for (const [_, groupEntries] of groups) {
      const first = groupEntries[0];
      const platform = EXCHANGE_TO_PLATFORM[first.row.exchange_id] || 'polymarket';

      // Build outcomes from all rows in this group, using each row's normalized
      // per-outcome probability.
      const outcomes: Outcome[] = groupEntries.map(({ row, view }) => ({
        name: row.outcome_name,
        odds: polymarketOddsToPercent(view.probability),
        source: first.row.exchange_id.toLowerCase(),
      }));

      // Sort by odds descending
      outcomes.sort((a, b) => b.odds - a.odds);

      const primaryOdds = outcomes.length > 0 ? outcomes[0].odds : 50;

      // Determine status (lowercase for our enum). Kalshi/Myriad report "active".
      let status: UnifiedMarket['status'] = 'unknown';
      const rawStatus = first.view.status?.toLowerCase();
      if (rawStatus === 'open' || rawStatus === 'active') status = 'open';
      else if (rawStatus === 'closed' || rawStatus === 'resolved') status = 'closed';

      // Use the first row's market_id (strip outcome suffix for the event-level ID)
      const baseId = first.row.market_id.replace(/_(YES|NO)$/i, '');

      markets.push({
        platform,
        id: baseId,
        url: '',
        question: first.view.title,
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
