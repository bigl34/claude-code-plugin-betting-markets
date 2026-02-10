/**
 * Polymarket API Client
 *
 * Uses web scraping of polymarket.com search page for reliable text search.
 * The gamma-api.polymarket.com doesn't support proper text search filters.
 */

import type { UnifiedMarket, MarketClient, SearchOptions, PolymarketConfig } from './types.js';
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
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
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
        // Use event-level data if no individual markets
        if (!event.markets || event.markets.length === 0) {
          markets.push(this.normalizeEventToMarket(event));
        } else {
          // Use the first market's prices with event-level volume
          const primaryMarket = event.markets[0];
          markets.push(this.normalizeMarketWithEvent(primaryMarket, event));
        }
      }

      // Sort by volume and limit
      return markets
        .sort((a, b) => b.volume - a.volume)
        .slice(0, limit);
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

      if (event.markets && event.markets.length > 0) {
        return this.normalizeMarketWithEvent(event.markets[0], event);
      }

      return this.normalizeEventToMarket(event);
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
      outcomes,
      odds: primaryOdds,
      volume: usdcToUsd(volume),
      liquidity: usdcToUsd(liquidity),
      status: market.closed ? 'closed' : market.active && market.acceptingOrders ? 'open' : 'unknown',
      endDate: market.endDate || event.endDate,
      lastUpdated: nowISO(),
    };
  }
}
