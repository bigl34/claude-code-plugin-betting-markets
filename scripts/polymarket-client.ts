/**
 * Polymarket API Client
 *
 * Uses Gamma's public search endpoint, then hydrates each event by slug so
 * multi-outcome markets are never limited to a search preview.
 */

import type { UnifiedMarket, MarketClient, SearchOptions, PolymarketConfig, Outcome } from './types.js';
import { polymarketOddsToPercent, usdcToUsd, nowISO } from './utils.js';
import { fetchWithRetry } from './retry.js';

const REQUEST_TIMEOUT_MS = 30_000;
const CLOB_PRICE_TIMEOUT_MS = 5_000;

// Max concurrent Gamma hydration fetches — bounds fan-out against the
// rate-limited Gamma endpoint when a search returns many multi-candidate events.
const HYDRATION_CONCURRENCY = 8;

// =============================================================================
// Polymarket search result types
// =============================================================================

interface PolymarketSearchEvent {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  description?: string;
  startDate?: string;
  endDate: string;
  image?: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  liquidity: number;
  volume: number;
  volume24hr?: number;
  enableOrderBook?: boolean;
  markets: PolymarketSearchMarket[];
}

interface PolymarketSearchMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  liquidity: string;
  volume: string;
  outcomePrices: string | string[]; // JSON string or array like ["0.22","0.78"]
  outcomes: string | string[]; // JSON string or array like ["Yes","No"]
  clobTokenIds?: string | string[]; // JSON string or array — CLOB token IDs for order book
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
}

// =============================================================================
// Gamma API Types (for CLOB token ID lookup)
// =============================================================================

interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  clobTokenIds?: string | string[]; // JSON string or array of token ID strings
  outcomePrices?: string;
  outcomes?: string;
}

/**
 * A sub-market as returned by the Gamma API `/events` endpoint. It is a superset
 * of the fields we read; numeric fields (volume/liquidity) arrive as numbers here
 * whereas the search page serves them as strings.
 */
interface GammaEventMarket {
  id?: string;
  question?: string;
  conditionId?: string;
  slug?: string;
  endDate?: string;
  liquidity?: string | number;
  volume?: string | number;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[];
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
}

interface GammaEvent {
  id?: string | number;
  ticker?: string;
  slug?: string;
  title?: string;
  question?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  image?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  liquidity?: string | number;
  volume?: string | number;
  volume24hr?: string | number;
  enableOrderBook?: boolean;
  markets?: GammaEventMarket[];
}

interface GammaPublicSearchResponse {
  events?: GammaEvent[];
}

// =============================================================================
// Pure helpers (exported for unit testing)
// =============================================================================

/**
 * Parse a field that Polymarket serves as either a JSON-encoded string or an
 * already-decoded array (the two shapes appear interchangeably across endpoints).
 * Gamma can deliver prices as numbers, so every element is coerced to a string —
 * callers do `.toLowerCase()` on names and `parseFloat(String(...))` on prices,
 * both safe on strings.
 */
function parseStringOrArray(value: string | Array<string | number> | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map(element => String(element));
  }
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(element => String(element)) : [];
  } catch {
    return [];
  }
}

/**
 * Build the sorted outcome list for a multi-candidate event, one outcome per
 * sub-market. Each sub-market is a Yes/No question ("Will Spain win…?") whose
 * "Yes" price is that candidate's win probability.
 *
 * Pure and independent of result-set size: 60 sub-markets in → 60 outcomes out
 * (this is the consumer of the truncation fix — no implicit 5-cap).
 */
export function buildOutcomesFromMarkets(markets: PolymarketSearchMarket[]): Outcome[] {
  const outcomes: Outcome[] = [];

  for (const market of markets) {
    const outcomeNames = parseStringOrArray(market.outcomes);
    const outcomePrices = parseStringOrArray(market.outcomePrices);
    if (outcomeNames.length === 0) {
      continue;
    }

    // The "Yes" price is this candidate's probability; fall back to the first price.
    const yesIndex = outcomeNames.findIndex(name => name.toLowerCase() === 'yes');
    const priceIndex = yesIndex >= 0 ? yesIndex : 0;
    const yesPrice = parseFloat(String(outcomePrices[priceIndex])) || 0;

    // Carry the "Yes" CLOB token ID so spread enrichment can skip a Gamma round-trip.
    const tokenIds = parseStringOrArray(market.clobTokenIds);
    const yesTokenId = tokenIds[priceIndex];

    outcomes.push({
      name: market.question,
      odds: polymarketOddsToPercent(yesPrice),
      source: yesTokenId || undefined,
    });
  }

  // Favourite first.
  outcomes.sort((a, b) => b.odds - a.odds);
  return outcomes;
}

/**
 * Coerce a Gamma API market object into the search-page market shape so the
 * existing normalizers can consume it unchanged. Gamma serves numeric
 * volume/liquidity, which we stringify to match `PolymarketSearchMarket`.
 */
export function gammaMarketToSearchMarket(market: GammaEventMarket): PolymarketSearchMarket {
  const toStringField = (value: string | number | undefined): string =>
    value === undefined || value === null ? '' : String(value);

  return {
    id: market.id ?? '',
    question: market.question ?? '',
    conditionId: market.conditionId ?? '',
    slug: market.slug ?? '',
    endDate: market.endDate ?? '',
    liquidity: toStringField(market.liquidity),
    volume: toStringField(market.volume),
    outcomePrices: market.outcomePrices ?? '[]',
    outcomes: market.outcomes ?? '[]',
    clobTokenIds: market.clobTokenIds,
    active: market.active ?? false,
    closed: market.closed ?? false,
    acceptingOrders: market.acceptingOrders ?? false,
  };
}

export function gammaEventToSearchEvent(event: GammaEvent): PolymarketSearchEvent {
  const numberField = (value: string | number | undefined): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return {
    id: String(event.id ?? event.slug ?? ''),
    ticker: event.ticker ?? '',
    slug: event.slug ?? '',
    title: event.title ?? event.question ?? '',
    description: event.description,
    startDate: event.startDate,
    endDate: event.endDate ?? '',
    image: event.image,
    active: event.active ?? false,
    closed: event.closed ?? false,
    archived: event.archived ?? false,
    liquidity: numberField(event.liquidity),
    volume: numberField(event.volume),
    volume24hr: numberField(event.volume24hr),
    enableOrderBook: event.enableOrderBook,
    markets: (event.markets ?? []).map(gammaMarketToSearchMarket),
  };
}

// =============================================================================
// Polymarket Client
// =============================================================================

export class PolymarketClient implements MarketClient {
  private baseUrl: string;
  private enabled: boolean;

  constructor(config: PolymarketConfig) {
    this.baseUrl = (config.baseUrl || 'https://gamma-api.polymarket.com').replace(/\/$/, '');
    this.enabled = config.enabled !== false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Search active events through Gamma public search, then hydrate by slug.
   */
  async search(query: string, options: SearchOptions = {}): Promise<UnifiedMarket[]> {
    if (!this.enabled) return [];

    const limit = options.maxResults || 50;

    try {
      const searchUrl = new URL(`${this.baseUrl}/public-search`);
      searchUrl.searchParams.set('q', query);
      searchUrl.searchParams.set('limit_per_type', String(Math.min(Math.max(limit, 1), 100)));
      searchUrl.searchParams.set('events_status', 'active');
      const response = await fetchWithRetry(
        searchUrl.toString(),
        {
          headers: {
            'Accept': 'application/json',
          },
        },
        { maxRetries: 3, timeoutMs: REQUEST_TIMEOUT_MS },
        "Polymarket.search"
      );

      if (!response.ok) {
        throw new Error(`Polymarket search failed: ${response.status}`);
      }

      const payload = await response.json() as GammaPublicSearchResponse;
      const events = (payload.events ?? [])
        .map(gammaEventToSearchEvent)
        .filter(event => event.id && event.slug && event.title);

      await this.hydrateEvents(events);

      // Convert events to unified markets
      const markets: UnifiedMarket[] = [];
      for (const event of events) {
        if (!event.markets || event.markets.length === 0) {
          // No sub-markets — use event-level data only
          markets.push(this.normalizeEventToMarket(event));
        } else if (event.markets.length === 1) {
          // Single sub-market — binary Yes/No
          markets.push(this.normalizeMarketWithEvent(event.markets[0], event));
        } else {
          // Multi-outcome event: each sub-market = one candidate/outcome
          // e.g., "Next UK PM" has separate Yes/No markets per candidate
          markets.push(this.normalizeMultiMarketEvent(event));
        }
      }

      // Sort by volume and limit
      const sorted = markets
        .sort((a, b) => b.volume - a.volume)
        .slice(0, limit);

      // Enrich with CLOB spread data (best-effort, non-blocking)
      await this.enrichWithClobSpread(sorted);

      return sorted;
    } catch (error) {
      console.error('Polymarket search error:', error);
      throw error;
    }
  }

  /**
   * Get a single market by slug
   */
  async getMarket(slugOrId: string): Promise<UnifiedMarket | null> {
    if (!this.enabled) return null;

    try {
      const slug = this.extractEventSlug(slugOrId);
      const eventUrl = `${this.baseUrl}/events?slug=${encodeURIComponent(slug)}`;
      const response = await fetchWithRetry(
        eventUrl,
        {
          headers: {
            'Accept': 'application/json',
          },
        },
        { maxRetries: 3, timeoutMs: REQUEST_TIMEOUT_MS },
        "Polymarket.getMarket"
      );

      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`Polymarket getMarket failed: ${response.status}`);
      }

      const payload = await response.json() as GammaEvent[];
      const gammaEvent = payload[0];
      if (!gammaEvent) return null;
      const event = gammaEventToSearchEvent(gammaEvent);

      let market: UnifiedMarket;
      if (!event.markets || event.markets.length === 0) {
        market = this.normalizeEventToMarket(event);
      } else if (event.markets.length === 1) {
        market = this.normalizeMarketWithEvent(event.markets[0], event);
      } else {
        market = this.normalizeMultiMarketEvent(event);
      }

      // Enrich single market with spread data
      await this.enrichWithClobSpread([market]);

      return market;
    } catch (error) {
      console.error('Polymarket getMarket error:', error);
      throw error;
    }
  }

  private extractEventSlug(value: string): string {
    const match = value.match(/\/event\/([^/?#]+)/);
    return decodeURIComponent(match?.[1] ?? value).trim();
  }

  /**
   * Normalize a search event (without market details) to unified schema
   */
  private normalizeEventToMarket(event: PolymarketSearchEvent): UnifiedMarket {
    return {
      platform: 'polymarket',
      id: event.id,
      eventId: event.id,
      url: `https://polymarket.com/event/${event.slug}`,
      question: event.title,
      description: event.description || undefined,
      odds: 50, // Unknown without market data
      volume: event.volume || 0,
      liquidity: event.liquidity || 0,
      status: event.closed ? 'closed' : event.active ? 'open' : 'unknown',
      endDate: event.endDate,
      lastUpdated: nowISO(),
    };
  }

  /**
   * Normalize a market with its parent event data
   */
  private normalizeMarketWithEvent(market: PolymarketSearchMarket, event: PolymarketSearchEvent): UnifiedMarket {
    // Parse outcomes and prices
    let outcomes: { name: string; odds: number }[] | undefined;
    let primaryOdds = 50;

    try {
      // Outcomes may be arrays or JSON strings depending on the API response
      const outcomeNames: string[] = Array.isArray(market.outcomes)
        ? market.outcomes
        : JSON.parse(market.outcomes || '[]');
      const outcomePrices: (string | number)[] = Array.isArray(market.outcomePrices)
        ? market.outcomePrices
        : JSON.parse(market.outcomePrices || '[]');

      if (outcomeNames.length > 0 && outcomePrices.length > 0) {
        outcomes = outcomeNames.map((name, i) => ({
          name,
          odds: polymarketOddsToPercent(parseFloat(String(outcomePrices[i])) || 0),
        }));
        primaryOdds = outcomes[0]?.odds || 50;
      }
    } catch {
      // Parsing failed, use defaults
    }

    // Use event-level volume (more accurate for display)
    const volume = event.volume || parseFloat(market.volume) || 0;
    const liquidity = event.liquidity || parseFloat(market.liquidity) || 0;

    return {
      platform: 'polymarket',
      id: market.id,
      eventId: event.id,
      url: `https://polymarket.com/event/${event.slug}`,
      question: event.title || market.question,
      description: event.description || undefined,
      outcomes,
      odds: primaryOdds,
      volume: usdcToUsd(volume),
      liquidity: usdcToUsd(liquidity),
      status: market.closed ? 'closed' : market.active && market.acceptingOrders ? 'open' : 'unknown',
      endDate: market.endDate || event.endDate,
      lastUpdated: nowISO(),
    };
  }

  /**
   * Normalize a multi-outcome event where each sub-market = one candidate/outcome.
   * e.g., "Next UK PM" has markets: "Angela Rayner?", "Ed Miliband?", etc.
   * Each sub-market has Yes/No outcomes — we extract the "Yes" price as the candidate's probability.
   */
  private normalizeMultiMarketEvent(event: PolymarketSearchEvent): UnifiedMarket {
    // One outcome per sub-market, favourite first. Scales to the full (hydrated)
    // market list — no implicit cap on the number of candidates.
    const outcomes = buildOutcomesFromMarkets(event.markets);

    const volume = event.volume || 0;
    const liquidity = event.liquidity || 0;

    return {
      platform: 'polymarket',
      id: event.id,
      eventId: event.id,
      url: `https://polymarket.com/event/${event.slug}`,
      question: event.title,
      description: event.description || undefined,
      outcomes,
      odds: outcomes[0]?.odds || 50,
      volume: usdcToUsd(volume),
      liquidity: usdcToUsd(liquidity),
      status: event.closed ? 'closed' : event.active ? 'open' : 'unknown',
      endDate: event.endDate,
      lastUpdated: nowISO(),
    };
  }

  // =============================================================================
  // CLOB Spread Enrichment
  // =============================================================================

  /**
   * Enrich market outcomes with buy/sell spread from Polymarket's CLOB /price endpoint.
   *
   * The /price endpoint returns real execution prices that factor in BOTH the AMM
   * and CLOB order book — unlike /book which only shows the thin CLOB.
   * This gives meaningful spreads (typically 0.2-2pp) even for AMM-backed markets.
   *
   * Token IDs come from search data (clobTokenIds) or Gamma API fallback.
   */
  private async enrichWithClobSpread(markets: UnifiedMarket[]): Promise<void> {
    for (const market of markets) {
      if (!market.outcomes || market.outcomes.length === 0) continue;

      try {
        // Check if outcomes already have CLOB token IDs stored in the source field
        const hasTokenIds = market.outcomes.some(o =>
          o.source && o.source !== 'polymarket' && o.source.length > 60
        );

        let tokenMap: Map<string, string> | undefined;

        if (!hasTokenIds && market.url) {
          // Fetch token IDs from Gamma API
          tokenMap = await this.fetchGammaTokenIds(market.url);
        }

        // Fetch buy/sell prices in parallel (max 20 outcomes)
        const outcomesToEnrich = market.outcomes.slice(0, 20);
        const pricePromises = outcomesToEnrich.map(async (outcome) => {
          let tokenId = outcome.source && outcome.source.length > 60
            ? outcome.source
            : undefined;

          if (!tokenId && tokenMap) {
            tokenId = tokenMap.get(outcome.name);
          }

          if (!tokenId) return;

          try {
            const [buyPrice, sellPrice] = await this.fetchClobPrices(tokenId);
            if (buyPrice !== null && sellPrice !== null) {
              const spreadPP = Math.round(Math.abs(buyPrice - sellPrice) * 100 * 100) / 100;

              outcome.layOdds = polymarketOddsToPercent(buyPrice);   // cost to buy (ask)
              outcome.backOdds = polymarketOddsToPercent(sellPrice);  // proceeds from sell (bid)
              outcome.spread = spreadPP;
              // Use midpoint of execution prices as odds
              outcome.odds = Math.round(((buyPrice + sellPrice) / 2) * 100 * 100) / 100;
            }
          } catch {
            // Price fetch failed for this outcome — skip silently
          }
        });

        await Promise.all(pricePromises);

        // Clean up: set source to platform name (token IDs were only used for lookup)
        for (const outcome of market.outcomes) {
          outcome.source = 'polymarket';
        }
      } catch {
        // Non-critical: spread enrichment failed, continue without it
      }
    }
  }

  /**
   * Fetch execution prices (buy + sell) for a token from the CLOB /price endpoint.
   * This factors in both AMM and CLOB liquidity for realistic execution prices.
   * Returns [buyPrice, sellPrice] as 0-1 decimals, or [null, null] on failure.
   */
  private async fetchClobPrices(tokenId: string): Promise<[number | null, number | null]> {
    try {
      const [buyResp, sellResp] = await Promise.all([
        fetchWithRetry(
          `https://clob.polymarket.com/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`,
          { headers: { 'Accept': 'application/json' } },
          { maxRetries: 3, timeoutMs: CLOB_PRICE_TIMEOUT_MS },
          "Polymarket.clobPriceBuy"
        ),
        fetchWithRetry(
          `https://clob.polymarket.com/price?token_id=${encodeURIComponent(tokenId)}&side=SELL`,
          { headers: { 'Accept': 'application/json' } },
          { maxRetries: 3, timeoutMs: CLOB_PRICE_TIMEOUT_MS },
          "Polymarket.clobPriceSell"
        ),
      ]);

      if (!buyResp.ok || !sellResp.ok) return [null, null];

      const buyData = await buyResp.json() as { price?: string };
      const sellData = await sellResp.json() as { price?: string };

      const buyPrice = buyData.price ? parseFloat(buyData.price) : null;
      const sellPrice = sellData.price ? parseFloat(sellData.price) : null;

      return [buyPrice, sellPrice];
    } catch {
      return [null, null];
    }
  }

  /**
   * Replace public-search previews with complete event payloads. Events are
   * mutated in place. Hydration is best-effort and bounded.
   */
  private async hydrateEvents(events: PolymarketSearchEvent[]): Promise<void> {
    for (let start = 0; start < events.length; start += HYDRATION_CONCURRENCY) {
      const batch = events.slice(start, start + HYDRATION_CONCURRENCY);
      await Promise.all(batch.map(event => this.hydrateEventFromGamma(event)));
    }
  }

  /** Replace one event's truncated preview with its full Gamma market list (best-effort). */
  private async hydrateEventFromGamma(event: PolymarketSearchEvent): Promise<void> {
    try {
      const fullMarkets = await this.fetchGammaEventMarkets(event.slug);
      if (fullMarkets.length > 0) {
        event.markets = fullMarkets;
      }
    } catch {
      // Keep the truncated preview on failure.
    }
  }

  /**
   * Fetch the complete sub-market list for an event from the Gamma API by slug.
   * Gamma returns every market (not the truncated search preview). Returns an
   * empty array on any failure so the caller can fall back to the preview.
   */
  private async fetchGammaEventMarkets(slug: string): Promise<PolymarketSearchMarket[]> {
    if (!slug) {
      return [];
    }

    const response = await fetchWithRetry(
      `${this.baseUrl}/events?slug=${encodeURIComponent(slug)}`,
      { headers: { 'Accept': 'application/json' } },
      { maxRetries: 3, timeoutMs: REQUEST_TIMEOUT_MS },
      "Polymarket.gammaEventMarkets"
    );

    if (!response.ok) {
      return [];
    }

    const events = await response.json() as Array<{ markets?: GammaEventMarket[] }>;
    const gammaMarkets = events[0]?.markets ?? [];
    return gammaMarkets.map(gammaMarketToSearchMarket);
  }

  /**
   * Fetch CLOB token IDs from Gamma API for all markets in an event.
   * Returns a map of question → Yes token ID.
   */
  private async fetchGammaTokenIds(eventUrl: string): Promise<Map<string, string>> {
    const tokenMap = new Map<string, string>();

    try {
      // Extract slug from event URL
      const slugMatch = eventUrl.match(/\/event\/([^/?#]+)/);
      if (!slugMatch) return tokenMap;

      const slug = slugMatch[1];
      const response = await fetchWithRetry(
        `${this.baseUrl}/events?slug=${encodeURIComponent(slug)}`,
        { headers: { 'Accept': 'application/json' } },
        { maxRetries: 3, timeoutMs: CLOB_PRICE_TIMEOUT_MS },
        "Polymarket.gammaEvents"
      );

      if (!response.ok) return tokenMap;

      const events = await response.json() as Array<{ markets?: GammaMarket[] }>;
      const event = events[0];
      if (!event?.markets) return tokenMap;

      for (const market of event.markets) {
        if (market.clobTokenIds) {
          try {
            // clobTokenIds may be a JSON string or array
            const tokenIds: string[] = Array.isArray(market.clobTokenIds)
              ? market.clobTokenIds
              : JSON.parse(market.clobTokenIds);
            if (tokenIds.length > 0) {
              // First token ID = Yes outcome
              tokenMap.set(market.question, tokenIds[0]);
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch {
      // Gamma API failed — return empty map
    }

    return tokenMap;
  }
}
