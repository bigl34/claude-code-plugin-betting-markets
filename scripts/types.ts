/**
 * Betting Markets Manager - Type Definitions
 */

// =============================================================================
// Platform Types
// =============================================================================

export type Platform = 'polymarket' | 'betfair';

export type MarketStatus = 'open' | 'closed' | 'settled' | 'unknown';

// =============================================================================
// Unified Market Schema
// =============================================================================

export interface Outcome {
  name: string;
  odds: number;       // 0-100 (percentage) — midpoint when both sides available, back-only otherwise
  backOdds?: number;  // implied % from best back price (Betfair only)
  layOdds?: number;   // implied % from best lay price (Betfair only)
  spread?: number;    // |backOdds - layOdds| — wide spread = low confidence
  backSize?: number;  // GBP available at best back price
  laySize?: number;   // GBP available at best lay price
  thinLiquidity?: boolean; // true if back size < MIN_OFFER_SIZE threshold
  backOnly?: boolean;      // true if no lay side — odds is 0 (use backOdds for indicative price)
}

export interface UnifiedMarket {
  // Identity
  platform: Platform;
  id: string;
  eventId?: string;
  url: string;

  // Content
  question: string;
  outcomes?: Outcome[];

  // Odds (always percentage)
  odds: number; // 0-100 (percentage / implied probability)

  // Volume & Liquidity (always USD)
  volume: number; // USD
  liquidity?: number; // USD

  // Status
  status: MarketStatus;
  endDate?: string; // ISO 8601

  // Metadata
  lastUpdated: string; // ISO 8601
}

// =============================================================================
// Search & Aggregation
// =============================================================================

export interface SearchOptions {
  platform?: Platform;
  minVolume?: number;
  maxResults?: number;
  sortBy?: 'volume' | 'odds' | 'platform';
  status?: MarketStatus;
  eventTypeIds?: string[];  // Betfair event type IDs (e.g. ['2378961'] for politics)
}

/** Well-known Betfair event type IDs for use with eventTypeIds filter. */
export const BETFAIR_EVENT_TYPES = {
  SOCCER: '1',
  TENNIS: '2',
  GOLF: '3',
  CRICKET: '4',
  HORSE_RACING: '7',
  POLITICS: '2378961',
} as const;

export interface PlatformStatus {
  status: 'success' | 'error' | 'disabled';
  count?: number;
  error?: string;
}

export interface AggregatedResult {
  markets: UnifiedMarket[];
  meta: {
    query: string;
    timestamp: string;
    platforms: {
      polymarket: PlatformStatus;
      betfair: PlatformStatus;
    };
    totalResults: number;
    warnings: string[];
  };
}

// =============================================================================
// Platform Capabilities
// =============================================================================

export interface PlatformCapabilities {
  hasLiquidity: boolean;
  hasOutcomes: boolean;
  hasEventGrouping: boolean;
  searchType: 'text' | 'filter' | 'both';
  maxResults: number;
  pagination: 'offset' | 'cursor' | 'none';
}

export const PLATFORM_CAPABILITIES: Record<Platform, PlatformCapabilities> = {
  polymarket: {
    hasLiquidity: true,
    hasOutcomes: true,
    hasEventGrouping: true,
    searchType: 'text',
    maxResults: 100,
    pagination: 'offset',
  },
  betfair: {
    hasLiquidity: true,
    hasOutcomes: true,
    hasEventGrouping: true,
    searchType: 'filter',
    maxResults: 1000,
    pagination: 'none',
  },
};

// =============================================================================
// Configuration
// =============================================================================

export interface PolymarketConfig {
  baseUrl: string;
  enabled: boolean;
}

export interface BetfairConfig {
  ssoUrl: string;
  certSsoUrl: string;  // Certificate-based SSO endpoint
  baseUrl: string;
  appKey: string;
  username: string;
  password: string;
  certPath?: string;   // Path to .crt file
  keyPath?: string;    // Path to .key file
  enabled: boolean;
}

export interface SettingsConfig {
  gbpToUsd: number;
  defaultMaxResults: number;
  cacheMarketsTTL: number;
  cacheMetadataTTL: number;
}

export interface Config {
  polymarket: PolymarketConfig;
  betfair: BetfairConfig;
  settings: SettingsConfig;
}

// =============================================================================
// Client Interface
// =============================================================================

export interface MarketClient {
  search(query: string, options?: SearchOptions): Promise<UnifiedMarket[]>;
  getMarket(id: string): Promise<UnifiedMarket | null>;
  isEnabled(): boolean;
  testAuth?(): Promise<boolean>;
  getLastError?(): string | null;
}
