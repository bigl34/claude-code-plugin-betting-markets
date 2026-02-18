/**
 * Betting Markets Manager - Type Definitions
 */

// =============================================================================
// Platform Types
// =============================================================================

export type Platform = 'polymarket' | 'betfair' | 'theodds' | 'kalshi' | 'manifold' | 'myriad';

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
  source?: string;         // bookmaker or exchange name (e.g. "William Hill", "polymarket")
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
  sportKey?: string;        // The Odds API explicit sport key (bypasses alias matching)
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

export interface CreditStatus {
  used: number;
  remaining: number;
  budget: number;
  lastUpdated: string;
  percentUsed: number;
}

export interface AggregatedResult {
  markets: UnifiedMarket[];
  meta: {
    query: string;
    timestamp: string;
    platforms: Partial<Record<Platform, PlatformStatus>>;
    totalResults: number;
    warnings: string[];
    creditStatus?: CreditStatus;
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
  theodds: {
    hasLiquidity: false,
    hasOutcomes: true,
    hasEventGrouping: true,
    searchType: 'filter',
    maxResults: 100,
    pagination: 'none',
  },
  kalshi: {
    hasLiquidity: true,
    hasOutcomes: true,
    hasEventGrouping: true,
    searchType: 'text',
    maxResults: 100,
    pagination: 'cursor',
  },
  manifold: {
    hasLiquidity: true,
    hasOutcomes: true,
    hasEventGrouping: false,
    searchType: 'text',
    maxResults: 100,
    pagination: 'cursor',
  },
  myriad: {
    hasLiquidity: false,
    hasOutcomes: true,
    hasEventGrouping: false,
    searchType: 'text',
    maxResults: 50,
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
  accountBaseUrl?: string;  // Account API base URL (derived from baseUrl if not set)
  appKey: string;
  username: string;
  password: string;
  certPath?: string;   // Path to .crt file
  keyPath?: string;    // Path to .key file
  enabled: boolean;
}

export interface TheOddsConfig {
  apiKey: string;
  enabled: boolean;
  baseUrl?: string;
  region?: string;
  defaultMarket?: string;
  sportKeys?: string[];
  monthlyBudget?: number;
}

export interface FinFeedConfig {
  apiKey: string;
  enabled: boolean;
  baseUrl?: string;
  exchanges?: string[];
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
  theodds?: TheOddsConfig;
  finfeed?: FinFeedConfig;
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

// =============================================================================
// Betfair Account Types
// =============================================================================

export interface BetfairTimeRange {
  from?: string;
  to?: string;
}

export type OrderProjection = 'ALL' | 'EXECUTABLE' | 'EXECUTION_COMPLETE';
export type OrderBy = 'BY_BET' | 'BY_MARKET' | 'BY_MATCH_TIME' | 'BY_PLACE_TIME' | 'BY_SETTLED_TIME' | 'BY_VOID_TIME';
export type SortDir = 'EARLIEST_TO_LATEST' | 'LATEST_TO_EARLIEST';
export type Side = 'BACK' | 'LAY';
export type OrderStatus = 'EXECUTABLE' | 'EXECUTION_COMPLETE';
export type BetStatus = 'SETTLED' | 'VOIDED' | 'LAPSED' | 'CANCELLED';
export type GroupBy = 'EVENT_TYPE' | 'EVENT' | 'MARKET' | 'SIDE' | 'BET';
export type PersistenceType = 'LAPSE' | 'PERSIST' | 'MARKET_ON_CLOSE';
export type BetfairOrderType = 'LIMIT' | 'LIMIT_ON_CLOSE' | 'MARKET_ON_CLOSE';

// Betting API — Current Orders

export interface CurrentOrderSummary {
  betId: string;
  marketId: string;
  selectionId: number;
  handicap: number;
  priceSize: { price: number; size: number };
  bspLiability: number;
  side: Side;
  status: OrderStatus;
  persistenceType: PersistenceType;
  orderType: BetfairOrderType;
  placedDate: string;
  matchedDate?: string;
  averagePriceMatched: number;
  sizeMatched: number;
  sizeRemaining: number;
  sizeLapsed: number;
  sizeCancelled: number;
  sizeVoided: number;
}

export interface CurrentOrderSummaryReport {
  currentOrders: CurrentOrderSummary[];
  moreAvailable: boolean;
}

// Betting API — Cleared (Settled) Orders

export interface ItemDescription {
  eventTypeDesc?: string;
  eventDesc?: string;
  marketDesc?: string;
  marketType?: string;
  marketStartTime?: string;
  runnerDesc?: string;
  numberOfWinners?: number;
  eachWayDivisor?: number;
}

export interface ClearedOrderSummary {
  eventTypeId?: string;
  eventId?: string;
  marketId?: string;
  selectionId?: number;
  handicap?: number;
  betId?: string;
  placedDate?: string;
  persistenceType?: PersistenceType;
  orderType?: BetfairOrderType;
  side?: Side;
  itemDescription?: ItemDescription;
  betOutcome?: string;
  priceRequested?: number;
  settledDate?: string;
  lastMatchedDate?: string;
  betCount?: number;
  commission?: number;
  priceMatched?: number;
  priceReduced?: boolean;
  sizeSettled?: number;
  profit?: number;
  sizeCancelled?: number;
}

export interface ClearedOrderSummaryReport {
  clearedOrders: ClearedOrderSummary[];
  moreAvailable: boolean;
}

// Account API — Funds

export interface AccountFundsResponse {
  availableToBetBalance: number;
  exposure: number;
  retainedCommission: number;
  exposureLimit: number;
  discountRate: number;
  pointsBalance: number;
}

// Account API — Statement

export interface StatementLegacyData {
  avgPrice?: number;
  betSize?: number;
  betType?: string;
  commissionRate?: string;
  eventId?: number;
  eventTypeId?: number;
  fullMarketName?: string;
  grossBetAmount?: number;
  marketName?: string;
  selectionId?: number;
  selectionName?: string;
  transactionType?: string;
  transactionId?: number;
  winLose?: string;
}

export interface StatementItem {
  refId?: string;
  itemDate?: string;
  amount?: number;
  balance?: number;
  itemClass?: string;
  itemClassData?: Record<string, string>;
  legacyData?: StatementLegacyData;
}

export interface AccountStatementReport {
  accountStatement: StatementItem[];
  moreAvailable: boolean;
}
