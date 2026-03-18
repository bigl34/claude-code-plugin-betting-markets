/**
 * Polymarket API Client
 *
 * Uses web scraping of polymarket.com search page for reliable text search.
 * The gamma-api.polymarket.com doesn't support proper text search filters.
 */

import type { UnifiedMarket, MarketClient, SearchOptions, PolymarketConfig, Outcome } from './types.js';
import { polymarketOddsToPercent, usdcToUsd, nowISO } from './utils.js';

// =============================================================================
// Polymarket Search Result Types (from __NEXT_DATA__)
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

interface NextDataSearchResponse {
  pageProps: {
    dehydratedState: {
      queries: Array<{
        state: {
          data: {
            pages: Array<{
              results: PolymarketSearchEvent[];
            }>;
          };
        };
      }>;
    };
  };
}

// =============================================================================
// Polymarket Client
// =============================================================================

export class PolymarketClient implements MarketClient {
  private baseUrl: string;
  private enabled: boolean;

  constructor(config: PolymarketConfig) {
    this.baseUrl = config.baseUrl || 'https://polymarket.com';
    this.enabled = config.enabled !== false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Search markets by scraping polymarket.com search results
   * This is more reliable than the gamma-api which lacks proper text search
   */
  async search(query: string, options: SearchOptions = {}): Promise<UnifiedMarket[]> {
    if (!this.enabled) return [];

    const limit = options.maxResults || 50;

    try {
      // Fetch the search page HTML
      const searchUrl = `https://polymarket.com/search?_q=${encodeURIComponent(query)}`;
      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; BettingMarketsBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });

      if (!response.ok) {
        throw new Error(`Polymarket search failed: ${response.status}`);
      }

      const html = await response.text();

      // Extract __NEXT_DATA__ script content
      // The tag may have additional attributes like crossorigin="anonymous"
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>(.+?)<\/script>/s);
      if (!nextDataMatch) {
        throw new Error('Could not find __NEXT_DATA__ in Polymarket response');
      }

      const nextData = JSON.parse(nextDataMatch[1]);

      // Extract search results from dehydrated state
      // Structure: data.props.pageProps.dehydratedState.queries
      const pageProps = nextData.props?.pageProps || nextData.pageProps;
      const queries = pageProps?.dehydratedState?.queries || [];
      const searchQuery = queries.find((q: { state?: { data?: { pages?: unknown[] } } }) => q.state?.data?.pages);
      const pages = searchQuery?.state?.data?.pages || [];
      const events: PolymarketSearchEvent[] = [];

      for (const page of pages) {
        if (page.results) {
          events.push(...page.results);
        }
      }

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
      // Fetch the event page
      const eventUrl = `https://polymarket.com/event/${slugOrId}`;
      const response = await fetch(eventUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; BettingMarketsBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });

      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`Polymarket getMarket failed: ${response.status}`);
      }

      const html = await response.text();

      // Extract __NEXT_DATA__ script content
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>(.+?)<\/script>/s);
      if (!nextDataMatch) {
        return null;
      }

      const nextData = JSON.parse(nextDataMatch[1]);
      const pageProps = nextData.props?.pageProps || nextData.pageProps;
      const event = pageProps?.dehydratedState?.queries?.[0]?.state?.data;

      if (!event) return null;

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
    const outcomes: Outcome[] = [];

    for (const market of event.markets) {
      try {
        const outcomeNames: string[] = Array.isArray(market.outcomes)
          ? market.outcomes
          : JSON.parse(market.outcomes || '[]');
        const outcomePrices: (string | number)[] = Array.isArray(market.outcomePrices)
          ? market.outcomePrices
          : JSON.parse(market.outcomePrices || '[]');

        // Find the "Yes" price — this is the probability of this candidate/outcome
        const yesIndex = outcomeNames.findIndex(n => n.toLowerCase() === 'yes');
        const yesPrice = yesIndex >= 0
          ? parseFloat(String(outcomePrices[yesIndex])) || 0
          : parseFloat(String(outcomePrices[0])) || 0;

        // Extract CLOB token IDs if available (for spread enrichment later)
        let clobTokenIds: string[] | undefined;
        try {
          clobTokenIds = Array.isArray(market.clobTokenIds)
            ? market.clobTokenIds
            : market.clobTokenIds ? JSON.parse(market.clobTokenIds) : undefined;
        } catch { /* ignore */ }

        // Use "Yes" token ID for spread lookup (first token = Yes outcome)
        const yesTokenId = clobTokenIds?.[yesIndex >= 0 ? yesIndex : 0];

        outcomes.push({
          name: market.question,
          odds: polymarketOddsToPercent(yesPrice),
          // Only store actual CLOB token IDs (long hex strings), not conditionIds
          source: yesTokenId || undefined,
        });
      } catch {
        // Skip unparseable markets
      }
    }

    // Sort by odds descending (favourite first)
    outcomes.sort((a, b) => b.odds - a.odds);

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
        fetch(`https://clob.polymarket.com/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(5000),
        }),
        fetch(`https://clob.polymarket.com/price?token_id=${encodeURIComponent(tokenId)}&side=SELL`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(5000),
        }),
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
      const response = await fetch(
        `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
        {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(5000),
        }
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
