/**
 * Betfair Exchange API Client
 *
 * Authentication via certificate-based SSO endpoint for bot/automated access.
 * Session token expires, needs keepalive every 15-20 minutes.
 *
 * Cert SSO URL: https://identitysso-cert.betfair.com/api/certlogin
 * Exchange URL: https://api.betfair.com/exchange/betting/rest/v1.0
 */

import type { UnifiedMarket, MarketClient, SearchOptions, BetfairConfig } from './types.js';
import { betfairOddsToPercent, gbpToUsd, nowISO } from './utils.js';
import { readFileSync } from 'fs';
import https from 'https';

// =============================================================================
// Betfair API Response Types
// =============================================================================

interface BetfairLoginResponse {
  sessionToken: string;
  loginStatus: string;
}

interface BetfairMarketCatalogue {
  marketId: string;
  marketName: string;
  marketStartTime?: string;
  totalMatched?: number;
  runners?: BetfairRunner[];
  event?: {
    id: string;
    name: string;
  };
  eventType?: {
    id: string;
    name: string;
  };
  competition?: {
    id: string;
    name: string;
  };
}

interface BetfairRunner {
  selectionId: number;
  runnerName: string;
  handicap?: number;
  sortPriority?: number;
}

interface BetfairMarketBook {
  marketId: string;
  status: string;
  totalMatched: number;
  totalAvailable: number;
  runners: BetfairRunnerBook[];
}

interface BetfairRunnerBook {
  selectionId: number;
  status: string;
  lastPriceTraded?: number;
  totalMatched?: number;
  ex?: {
    availableToBack?: BetfairPriceSize[];
    availableToLay?: BetfairPriceSize[];
    tradedVolume?: BetfairPriceSize[];
  };
}

interface BetfairPriceSize {
  price: number;
  size: number;
}

interface BetfairEventType {
  eventType: {
    id: string;
    name: string;
  };
  marketCount: number;
}

// =============================================================================
// Betfair Client
// =============================================================================

export class BetfairClient implements MarketClient {
  private ssoUrl: string;
  private certSsoUrl: string;
  private baseUrl: string;
  private appKey: string;
  private username: string;
  private password: string;
  private certPath: string | undefined;
  private keyPath: string | undefined;
  private enabled: boolean;
  private sessionToken: string | null = null;
  private tokenExpiry: Date | null = null;
  private gbpToUsdRate: number;
  private httpsAgent: https.Agent | null = null;
  private lastError: string | null = null;

  constructor(config: BetfairConfig, gbpToUsdRate: number = 1.27) {
    this.ssoUrl = config.ssoUrl || 'https://identitysso.betfair.com/api';
    this.certSsoUrl = config.certSsoUrl || 'https://identitysso-cert.betfair.com/api';
    this.baseUrl = config.baseUrl || 'https://api.betfair.com/exchange/betting/rest/v1.0';
    this.appKey = config.appKey || '';
    this.username = config.username || '';
    this.password = config.password || '';
    this.certPath = config.certPath;
    this.keyPath = config.keyPath;
    this.enabled = config.enabled !== false && !!config.appKey && !!config.username && !!config.password;
    this.gbpToUsdRate = gbpToUsdRate;

    // Initialize HTTPS agent with certificate if paths provided
    if (this.certPath && this.keyPath) {
      try {
        this.httpsAgent = new https.Agent({
          cert: readFileSync(this.certPath),
          key: readFileSync(this.keyPath),
          rejectUnauthorized: true,
        });
      } catch (error) {
        console.error('Failed to load Betfair certificates:', error);
      }
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  /**
   * Login via certificate-based SSO endpoint (preferred for bots)
   * Falls back to interactive SSO if certs not available
   */
  async login(): Promise<boolean> {
    if (!this.appKey || !this.username || !this.password) {
      return false;
    }

    // Use certificate-based login if agent is available
    if (this.httpsAgent) {
      return this.loginWithCert();
    }

    // Fallback to interactive login (may be blocked for bots)
    return this.loginInteractive();
  }

  /**
   * Certificate-based non-interactive login
   */
  private async loginWithCert(): Promise<boolean> {
    return new Promise((resolve) => {
      const postData = new URLSearchParams({
        username: this.username,
        password: this.password,
      }).toString();

      const url = new URL(`${this.certSsoUrl}/certlogin`);

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        agent: this.httpsAgent!,
        headers: {
          'X-Application': this.appKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed: BetfairLoginResponse = JSON.parse(data);
            if (parsed.loginStatus === 'SUCCESS') {
              this.sessionToken = parsed.sessionToken;
              this.tokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
              resolve(true);
            } else {
              console.error(`Betfair cert login status: ${parsed.loginStatus}`);
              resolve(false);
            }
          } catch (error) {
            console.error('Betfair cert login parse error:', error, 'Response:', data.substring(0, 200));
            resolve(false);
          }
        });
      });

      req.on('error', (error) => {
        console.error('Betfair cert login error:', error);
        resolve(false);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Interactive login (may be blocked for automated requests)
   */
  private async loginInteractive(): Promise<boolean> {
    try {
      const response = await fetch(`${this.ssoUrl}/login`, {
        method: 'POST',
        headers: {
          'X-Application': this.appKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          username: this.username,
          password: this.password,
        }),
      });

      if (!response.ok) {
        console.error(`Betfair login failed: ${response.status} ${response.statusText}`);
        return false;
      }

      const data: BetfairLoginResponse = await response.json();

      if (data.loginStatus !== 'SUCCESS') {
        console.error(`Betfair login status: ${data.loginStatus}`);
        return false;
      }

      this.sessionToken = data.sessionToken;
      this.tokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
      return true;
    } catch (error) {
      console.error('Betfair login error:', error);
      return false;
    }
  }

  /**
   * Keepalive to extend session
   */
  async keepAlive(): Promise<boolean> {
    if (!this.sessionToken) return false;

    try {
      const response = await fetch(`${this.ssoUrl}/keepAlive`, {
        headers: {
          'X-Application': this.appKey,
          'X-Authentication': this.sessionToken,
        },
      });

      if (response.ok) {
        this.tokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Ensure we have a valid session
   */
  private async ensureAuth(): Promise<boolean> {
    if (this.sessionToken && this.tokenExpiry && this.tokenExpiry > new Date()) {
      return true;
    }
    return await this.login();
  }

  /**
   * Get headers for exchange API calls
   */
  private getHeaders(): Record<string, string> {
    return {
      'X-Application': this.appKey,
      'X-Authentication': this.sessionToken || '',
      'Content-Type': 'application/json',
    };
  }

  /**
   * Test authentication by listing event types
   * Returns { success, loginOk, apiOk, error } for detailed diagnostics
   */
  async testAuth(): Promise<boolean> {
    if (!this.enabled) {
      this.lastError = 'Betfair client is disabled (missing credentials)';
      return false;
    }

    this.lastError = null;

    try {
      // Step 1: Test login
      const authed = await this.ensureAuth();
      if (!authed) {
        this.lastError = 'Certificate login failed - check username/password and cert files';
        return false;
      }

      // Step 2: Test Exchange API access
      const response = await fetch(`${this.baseUrl}/listEventTypes/`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ filter: {} }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        try {
          const errorJson = JSON.parse(errorText);
          const errorCode = errorJson?.detail?.APINGException?.errorCode;
          if (errorCode === 'INVALID_APP_KEY') {
            this.lastError = 'App key rejected by Exchange API. The key may need activation (can take 48h) or upgrade at developer.betfair.com';
          } else {
            this.lastError = `Exchange API error: ${errorCode || response.statusText} - ${errorText.substring(0, 200)}`;
          }
        } catch {
          this.lastError = `Exchange API error: ${response.status} ${response.statusText}`;
        }
        return false;
      }

      return true;
    } catch (error) {
      this.lastError = `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  /**
   * Test just the login (without Exchange API)
   * Useful for diagnosing whether the issue is auth vs API permissions
   */
  async testLoginOnly(): Promise<boolean> {
    if (!this.enabled) return false;
    return await this.login();
  }

  /**
   * Search markets by text (limited - Betfair uses filter-based search)
   * We search by text filter on market name
   */
  async search(query: string, options: SearchOptions = {}): Promise<UnifiedMarket[]> {
    if (!this.enabled) return [];

    const authed = await this.ensureAuth();
    if (!authed) {
      this.lastError = 'Betfair authentication failed';
      throw new Error(this.lastError);
    }

    const maxResults = options.maxResults || 50;
    const queryLower = query.toLowerCase();

    try {
      // Search market catalogue with text query
      const catalogueResponse = await fetch(`${this.baseUrl}/listMarketCatalogue/`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          filter: {
            textQuery: query,
          },
          maxResults: maxResults,
          marketProjection: ['EVENT', 'EVENT_TYPE', 'COMPETITION', 'RUNNER_DESCRIPTION'],
        }),
      });

      if (!catalogueResponse.ok) {
        const errorText = await catalogueResponse.text();
        try {
          const errorJson = JSON.parse(errorText);
          const errorCode = errorJson?.detail?.APINGException?.errorCode;
          if (errorCode === 'INVALID_APP_KEY') {
            this.lastError = 'App key rejected by Exchange API - needs activation at developer.betfair.com';
            throw new Error(this.lastError);
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('App key rejected')) throw e;
        }
        this.lastError = `Betfair API error: ${catalogueResponse.status} ${catalogueResponse.statusText}`;
        throw new Error(this.lastError);
      }

      const catalogues: BetfairMarketCatalogue[] = await catalogueResponse.json();

      if (catalogues.length === 0) {
        return [];
      }

      // Get market books for prices and volumes
      const marketIds = catalogues.map(c => c.marketId);
      const booksResponse = await fetch(`${this.baseUrl}/listMarketBook/`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          marketIds,
          priceProjection: {
            priceData: ['EX_BEST_OFFERS', 'EX_TRADED'],
          },
        }),
      });

      let books: BetfairMarketBook[] = [];
      if (booksResponse.ok) {
        books = await booksResponse.json();
      }

      // Create lookup map for books
      const bookMap = new Map(books.map(b => [b.marketId, b]));

      // Normalize markets
      return catalogues.map(c => this.normalizeMarket(c, bookMap.get(c.marketId)));
    } catch (error) {
      console.error('Betfair search error:', error);
      throw error;
    }
  }

  /**
   * Get a single market by ID
   */
  async getMarket(marketId: string): Promise<UnifiedMarket | null> {
    if (!this.enabled) return null;

    const authed = await this.ensureAuth();
    if (!authed) {
      throw new Error('Betfair authentication failed');
    }

    try {
      // Get catalogue
      const catalogueResponse = await fetch(`${this.baseUrl}/listMarketCatalogue/`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          filter: { marketIds: [marketId] },
          maxResults: 1,
          marketProjection: ['EVENT', 'EVENT_TYPE', 'RUNNER_DESCRIPTION'],
        }),
      });

      if (!catalogueResponse.ok) {
        throw new Error(`Betfair API error: ${catalogueResponse.status} ${catalogueResponse.statusText}`);
      }

      const catalogues: BetfairMarketCatalogue[] = await catalogueResponse.json();
      if (catalogues.length === 0) return null;

      // Get book
      const bookResponse = await fetch(`${this.baseUrl}/listMarketBook/`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          marketIds: [marketId],
          priceProjection: { priceData: ['EX_BEST_OFFERS', 'EX_TRADED'] },
        }),
      });

      let book: BetfairMarketBook | undefined;
      if (bookResponse.ok) {
        const books: BetfairMarketBook[] = await bookResponse.json();
        book = books[0];
      }

      return this.normalizeMarket(catalogues[0], book);
    } catch (error) {
      console.error('Betfair getMarket error:', error);
      throw error;
    }
  }

  /**
   * List available event types (sports/categories)
   */
  async listEventTypes(): Promise<BetfairEventType[]> {
    if (!this.enabled) return [];

    const authed = await this.ensureAuth();
    if (!authed) {
      throw new Error('Betfair authentication failed');
    }

    try {
      const response = await fetch(`${this.baseUrl}/listEventTypes/`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ filter: {} }),
      });

      if (!response.ok) {
        throw new Error(`Betfair API error: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Betfair listEventTypes error:', error);
      throw error;
    }
  }

  /**
   * Normalize Betfair market to unified schema
   */
  private normalizeMarket(catalogue: BetfairMarketCatalogue, book?: BetfairMarketBook): UnifiedMarket {
    // Build question from event and market names
    const eventName = catalogue.event?.name || '';
    const marketName = catalogue.marketName || '';
    const question = eventName ? `${eventName} - ${marketName}` : marketName;

    // Get primary odds from first runner's back price
    let primaryOdds = 0;
    let outcomes: { name: string; odds: number }[] | undefined;

    if (book?.runners && book.runners.length > 0) {
      outcomes = [];
      for (const runner of book.runners) {
        const backPrice = runner.ex?.availableToBack?.[0]?.price;
        // No back price available means no liquidity — use 0% (not 50%)
        // Also try lastPriceTraded as fallback for runners with historical but no current offers
        const fallbackPrice = runner.lastPriceTraded;
        let odds: number;
        if (backPrice) {
          odds = betfairOddsToPercent(backPrice);
        } else if (fallbackPrice && fallbackPrice > 1) {
          odds = betfairOddsToPercent(fallbackPrice);
        } else {
          odds = 0;
        }
        const runnerInfo = catalogue.runners?.find(r => r.selectionId === runner.selectionId);
        outcomes.push({
          name: runnerInfo?.runnerName || `Selection ${runner.selectionId}`,
          odds,
        });
      }
      // Primary odds = first outcome (favorite)
      primaryOdds = outcomes[0]?.odds || 0;
    }

    // Volume is in GBP, convert to USD
    const volumeGBP = book?.totalMatched || catalogue.totalMatched || 0;
    const volumeUSD = gbpToUsd(volumeGBP, this.gbpToUsdRate);

    const liquidityGBP = book?.totalAvailable || 0;
    const liquidityUSD = gbpToUsd(liquidityGBP, this.gbpToUsdRate);

    // Determine status
    let status: UnifiedMarket['status'] = 'unknown';
    if (book?.status === 'OPEN') status = 'open';
    else if (book?.status === 'CLOSED') status = 'closed';
    else if (book?.status === 'SUSPENDED') status = 'closed';

    return {
      platform: 'betfair',
      id: catalogue.marketId,
      eventId: catalogue.event?.id,
      url: `https://www.betfair.com/exchange/plus/market/${catalogue.marketId}`,
      question,
      outcomes,
      odds: primaryOdds,
      volume: volumeUSD,
      liquidity: liquidityUSD,
      status,
      endDate: catalogue.marketStartTime,
      lastUpdated: nowISO(),
    };
  }
}
