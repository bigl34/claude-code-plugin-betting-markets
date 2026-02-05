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
  odds: number; // 0-100 (percentage)
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
}

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
