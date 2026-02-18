/**
 * The Odds API Client
 *
 * Aggregates odds from 40+ traditional bookmakers (William Hill, Ladbrokes, etc.)
 * across 70+ sports. Free tier: 500 credits/month, 1 credit per request (UK region).
 *
 * Key design choices:
 * - Sport alias map for credit-efficient searching (don't guess sport keys)
 * - Trimmed mean consensus probability across bookmakers
 * - Credit tracking with circuit breaker
 * - Response caching via @local/plugin-cache (5min TTL for odds, 24h for sports list)
 *
 * API docs: https://the-odds-api.com/liveapi/guides/v4/
 */

import type {
  UnifiedMarket,
  MarketClient,
  SearchOptions,
  TheOddsConfig,
  Outcome,
  CreditStatus,
} from './types.js';
import { decimalOddsToPercent, trimmedMeanProbability, nowISO } from './utils.js';
import { findSportKeys } from './sport-aliases.js';
import { CreditTracker } from './credit-tracker.js';
import { PluginCache } from '@local/plugin-cache';

// =============================================================================
// The Odds API Response Types
// =============================================================================

interface OddsSport {
  key: string;
  group: string;
  title: string;
  description: string;
  active: boolean;
  has_outrights: boolean;
}

interface OddsOutcome {
  name: string;
  price: number;  // decimal odds (e.g. 2.50)
}

interface OddsMarket {
  key: string;     // "h2h", "spreads", "totals"
  last_update: string;
  outcomes: OddsOutcome[];
}

interface OddsBookmaker {
  key: string;     // e.g. "williamhill"
  title: string;   // e.g. "William Hill"
  last_update: string;
  markets: OddsMarket[];
}

interface OddsEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;  // ISO 8601
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
}

// =============================================================================
// The Odds API Client
// =============================================================================

const CACHE_TTL_ODDS = 5 * 60 * 1000;     // 5 minutes for odds
const CACHE_TTL_SPORTS = 24 * 60 * 60 * 1000; // 24 hours for sports list

export class TheOddsClient implements MarketClient {
  private apiKey: string;
  private baseUrl: string;
  private region: string;
  private defaultMarket: string;
  private enabled: boolean;
  private lastError: string | null = null;
  private creditTracker: CreditTracker;
  private cache: PluginCache;

  constructor(config: TheOddsConfig) {
    this.apiKey = config.apiKey || '';
    this.baseUrl = config.baseUrl || 'https://api.the-odds-api.com';
    this.region = config.region || 'uk';
    this.defaultMarket = config.defaultMarket || 'h2h';
    this.enabled = config.enabled !== false && !!config.apiKey;
    this.creditTracker = new CreditTracker(config.monthlyBudget || 400);
    this.cache = new PluginCache({
      namespace: 'betting-markets-theodds',
      defaultTTL: CACHE_TTL_ODDS,
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  // ============================================
  // API REQUESTS
  // ============================================

  /**
   * Make an authenticated GET request to The Odds API.
   * Handles credit tracking, caching, and error handling.
   */
  private async apiGet<T>(
    path: string,
    params: Record<string, string> = {},
    options: { cacheTTL?: number; cacheKey?: string; creditCost?: number } = {}
  ): Promise<T> {
    const { cacheTTL, cacheKey, creditCost = 1 } = options;

    // Check cache first
    if (cacheKey) {
      const cached = this.cache.get<T>(cacheKey, { ttl: cacheTTL });
      if (cached.hit && !cached.stale) {
        return cached.data!;
      }
    }

    // Credit check (sports list is free = 0 credits)
    if (creditCost > 0 && !this.creditTracker.canMakeRequest(creditCost)) {
      const status = this.creditTracker.getCreditStatus();
      this.lastError = `Credit budget exhausted: ${status.used}/${status.budget} used (${status.percentUsed}%)`;
      throw new Error(this.lastError);
    }

    // Build URL
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('apiKey', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    // Record request (pessimistic)
    if (creditCost > 0) {
      this.creditTracker.recordRequest(path, creditCost);
    }

    try {
      const response = await fetch(url.toString());

      // Update credit tracker from headers
      this.creditTracker.updateFromHeaders(response.headers);

      if (!response.ok) {
        const errorText = await response.text();
        this.lastError = `The Odds API error: ${response.status} - ${errorText.substring(0, 200)}`;
        throw new Error(this.lastError);
      }

      const data: T = await response.json();

      // Cache the result
      if (cacheKey) {
        await this.cache.set(cacheKey, data, { ttl: cacheTTL });
      }

      return data;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('The Odds API error:')) {
        throw error;
      }
      this.lastError = `The Odds API request failed: ${error instanceof Error ? error.message : String(error)}`;
      throw new Error(this.lastError);
    }
  }

  // ============================================
  // SEARCH
  // ============================================

  /**
   * Search for markets using sport alias matching.
   *
   * Strategy:
   * 1. If options.sportKey is set, use it directly
   * 2. Otherwise, check alias map for matching sport keys
   * 3. If no alias match, return empty (don't burn credits guessing)
   *
   * For each matching sport key, fetches odds and normalizes to UnifiedMarket[].
   */
  async search(query: string, options: SearchOptions = {}): Promise<UnifiedMarket[]> {
    if (!this.enabled) return [];
    this.lastError = null;

    // Determine sport keys to query
    let sportKeys: string[];

    if (options.sportKey) {
      // Explicit sport key from --sport flag
      sportKeys = [options.sportKey];
    } else {
      // Alias-based matching
      sportKeys = findSportKeys(query);
      if (sportKeys.length === 0) {
        // No alias match — don't waste credits guessing
        return [];
      }
    }

    const allMarkets: UnifiedMarket[] = [];
    const queryLower = query.toLowerCase();

    // Determine correct market type per sport key
    // Politics/outrights use "outrights", sports use h2h/spreads/totals
    const sportMarketTypes = await this.getSportMarketTypes(sportKeys);

    // Fetch odds for each matching sport (in parallel)
    const promises = sportKeys.map(async (sportKey) => {
      try {
        const marketType = sportMarketTypes.get(sportKey) || this.defaultMarket;
        const events = await this.apiGet<OddsEvent[]>(
          `/v4/sports/${sportKey}/odds`,
          {
            regions: this.region,
            markets: marketType,
            oddsFormat: 'decimal',
          },
          {
            cacheTTL: CACHE_TTL_ODDS,
            cacheKey: `odds_${sportKey}_${this.region}_${marketType}`,
            creditCost: 1,
          }
        );

        // Filter events by query (client-side text match on team/event names)
        for (const event of events) {
          const eventText = `${event.home_team} ${event.away_team} ${event.sport_title}`.toLowerCase();

          // If using explicit sportKey, include all events; otherwise filter by query
          const isMatch = options.sportKey || eventText.includes(queryLower) ||
            queryLower.split(/\s+/).some(term => eventText.includes(term));

          if (isMatch) {
            allMarkets.push(this.normalizeEvent(event));
          }
        }
      } catch (error) {
        // Log but don't fail the entire search for one sport
        console.error(`TheOdds search error for ${sportKey}:`, error);
      }
    });

    await Promise.all(promises);

    // Sort by volume (number of bookmakers as proxy) and limit
    const maxResults = options.maxResults || 50;
    return allMarkets.slice(0, maxResults);
  }

  // ============================================
  // MARKET DETAILS
  // ============================================

  async getMarket(id: string): Promise<UnifiedMarket | null> {
    if (!this.enabled) return null;

    // The Odds API doesn't have a direct "get by event ID" endpoint.
    // We'd need to know the sport key. For now, return null.
    // In practice, the agent would use search to find markets.
    this.lastError = 'Direct market lookup by ID not supported for The Odds API — use search with --sport instead';
    return null;
  }

  // ============================================
  // AUTH TEST
  // ============================================

  /**
   * Test authentication by calling the sports list endpoint (0 credits).
   */
  async testAuth(): Promise<boolean> {
    if (!this.enabled) {
      this.lastError = 'The Odds API client is disabled (missing API key)';
      return false;
    }

    this.lastError = null;

    try {
      const sports = await this.listSports();
      return sports.length > 0;
    } catch (error) {
      this.lastError = `Auth test failed: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  // ============================================
  // SPORTS LIST
  // ============================================

  /**
   * List all available sports (0 credits).
   * Cached for 24 hours.
   */
  async listSports(): Promise<OddsSport[]> {
    return this.apiGet<OddsSport[]>(
      '/v4/sports',
      {},
      {
        cacheTTL: CACHE_TTL_SPORTS,
        cacheKey: 'sports_list',
        creditCost: 0,
      }
    );
  }

  // ============================================
  // CREDIT STATUS
  // ============================================

  getCreditStatus(): CreditStatus {
    return this.creditTracker.getCreditStatus();
  }

  getFormattedCreditStatus(): string {
    return this.creditTracker.getFormattedStatus();
  }

  // ============================================
  // SPORT MARKET TYPE RESOLUTION
  // ============================================

  /**
   * Determine the correct market type for each sport key.
   * Politics and outright-only sports use "outrights" instead of "h2h".
   * Uses the cached sports list to check has_outrights.
   */
  private async getSportMarketTypes(sportKeys: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    try {
      const sports = await this.listSports();
      const sportsMap = new Map(sports.map(s => [s.key, s]));

      for (const key of sportKeys) {
        const sport = sportsMap.get(key);
        if (sport?.has_outrights) {
          // Outright-only sports (politics, golf winners, etc.) — use outrights
          result.set(key, 'outrights');
        } else {
          result.set(key, this.defaultMarket);
        }
      }
    } catch {
      // If sports list fails, fall back to heuristic: politics keys use outrights
      for (const key of sportKeys) {
        if (key.startsWith('politics_') || key.includes('_winner')) {
          result.set(key, 'outrights');
        } else {
          result.set(key, this.defaultMarket);
        }
      }
    }

    return result;
  }

  // ============================================
  // NORMALIZATION
  // ============================================

  /**
   * Normalize a The Odds API event to UnifiedMarket.
   *
   * Aggregates odds across all bookmakers using trimmed mean:
   * - Collects decimal odds per outcome from all bookmakers
   * - Calculates consensus probability via trimmedMeanProbability()
   * - Tracks which bookmaker offers the best price per outcome
   */
  private normalizeEvent(event: OddsEvent): UnifiedMarket {
    // Outright markets (politics, golf winners) may have no away_team
    const question = event.away_team
      ? `${event.home_team} vs ${event.away_team}`
      : event.home_team || event.sport_title;

    // Collect odds per outcome across all bookmakers
    const outcomeOdds: Record<string, { prices: number[]; bestPrice: number; bestBookmaker: string }> = {};

    for (const bookmaker of event.bookmakers) {
      for (const market of bookmaker.markets) {
        // Accept h2h, outrights, or whatever market type was requested

        for (const outcome of market.outcomes) {
          if (!outcomeOdds[outcome.name]) {
            outcomeOdds[outcome.name] = { prices: [], bestPrice: Infinity, bestBookmaker: '' };
          }

          outcomeOdds[outcome.name].prices.push(outcome.price);

          // Track best (lowest decimal odds = highest implied probability for backer)
          if (outcome.price < outcomeOdds[outcome.name].bestPrice) {
            outcomeOdds[outcome.name].bestPrice = outcome.price;
            outcomeOdds[outcome.name].bestBookmaker = bookmaker.title;
          }
        }
      }
    }

    // Build outcomes with consensus probabilities
    const outcomes: Outcome[] = Object.entries(outcomeOdds).map(([name, data]) => ({
      name,
      odds: trimmedMeanProbability(data.prices),
      source: data.bestBookmaker,
    }));

    // Sort by odds descending (favourite first)
    outcomes.sort((a, b) => b.odds - a.odds);

    const primaryOdds = outcomes[0]?.odds || 0;

    return {
      platform: 'theodds',
      id: event.id,
      url: `https://the-odds-api.com/sports/${event.sport_key}`,
      question,
      outcomes,
      odds: primaryOdds,
      volume: 0, // The Odds API doesn't provide volume data
      status: new Date(event.commence_time) > new Date() ? 'open' : 'closed',
      endDate: event.commence_time,
      lastUpdated: nowISO(),
    };
  }
}
