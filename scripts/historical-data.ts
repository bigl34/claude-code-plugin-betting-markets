/**
 * Historical Price Data Fetcher
 *
 * Fetches historical probability data from Polymarket and Kalshi
 * for chart generation. Self-contained types (no types.ts dependency).
 */

import { fetchWithRetry } from './retry.js';

const REQUEST_TIMEOUT_MS = 30_000;

// =============================================================================
// Types
// =============================================================================

export interface PricePoint {
  timestamp: number;   // ms unix
  probability: number; // 0-100%
}

export interface HistoricalSeries {
  label: string;
  platform: 'polymarket' | 'kalshi';
  points: PricePoint[];
  color?: string;
  markerStyle?: 'line' | 'scatter';
}

export interface HistoricalFetchResult {
  series: HistoricalSeries[];
  title: string;
  sourceUrl: string;
  warnings: string[];
}

interface ParsedIdentifier {
  platform: 'polymarket' | 'kalshi';
  id: string;
}

// =============================================================================
// Identifier Parsing
// =============================================================================

export function parseIdentifier(input: string): ParsedIdentifier {
  // Polymarket URL: https://polymarket.com/event/some-slug or /event/some-slug/sub
  const polyUrlMatch = input.match(/polymarket\.com\/event\/([a-z0-9-]+)/i);
  if (polyUrlMatch) {
    return { platform: 'polymarket', id: polyUrlMatch[1] };
  }

  // Kalshi URL: https://kalshi.com/markets/SERIES/TICKER or https://kalshi.com/markets/TICKER
  const kalshiUrlMatch = input.match(/kalshi\.com\/markets?\/(?:[A-Z0-9-]+\/)?([A-Z0-9-]+)/i);
  if (kalshiUrlMatch) {
    return { platform: 'kalshi', id: kalshiUrlMatch[1].toUpperCase() };
  }

  // Prefix-based: polymarket:slug or kalshi:TICKER
  if (input.startsWith('polymarket:')) {
    return { platform: 'polymarket', id: input.slice('polymarket:'.length) };
  }
  if (input.startsWith('kalshi:')) {
    return { platform: 'kalshi', id: input.slice('kalshi:'.length).toUpperCase() };
  }

  // All-uppercase = likely Kalshi ticker
  if (/^[A-Z0-9-]+$/.test(input) && input.length <= 30) {
    return { platform: 'kalshi', id: input };
  }

  // Default to Polymarket slug
  return { platform: 'polymarket', id: input };
}

export function resolveHistoricalIdentifier(
  input: string,
  forcePlatform?: 'polymarket' | 'kalshi',
): ParsedIdentifier {
  const parsed = parseIdentifier(input);

  if (!forcePlatform) return parsed;

  const urlPlatform = /polymarket\.com\/event\/[a-z0-9-]+/i.test(input)
    ? 'polymarket'
    : /kalshi\.com\/markets?\/(?:[A-Z0-9-]+\/)?[A-Z0-9-]+/i.test(input)
      ? 'kalshi'
      : undefined;

  if (urlPlatform && urlPlatform !== forcePlatform) {
    const urlPlatformName = urlPlatform === 'polymarket' ? 'Polymarket' : 'Kalshi';
    throw new Error(`Cannot force platform "${forcePlatform}" for a ${urlPlatformName} URL`);
  }

  return { ...parsed, platform: forcePlatform };
}

// =============================================================================
// Downsampling
// =============================================================================

function downsample(points: PricePoint[], maxPoints: number): PricePoint[] {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const result: PricePoint[] = [];
  for (let i = 0; i < maxPoints; i++) {
    result.push(points[Math.floor(i * step)]);
  }
  // Always include the last point
  if (result[result.length - 1] !== points[points.length - 1]) {
    result.push(points[points.length - 1]);
  }
  return result;
}

// =============================================================================
// Historical Data Fetcher
// =============================================================================

const MAX_POINTS = 2000;

export class HistoricalDataFetcher {

  /**
   * Fetch historical data for a market identifier.
   * Auto-detects platform from the identifier format.
   */
  async fetch(identifier: string, forcePlatform?: 'polymarket' | 'kalshi'): Promise<HistoricalFetchResult> {
    const parsed = resolveHistoricalIdentifier(identifier, forcePlatform);

    switch (parsed.platform) {
      case 'polymarket':
        return this.fetchPolymarket(parsed.id);
      case 'kalshi':
        return this.fetchKalshi(parsed.id);
      default:
        throw new Error(`Unsupported platform: ${parsed.platform}`);
    }
  }

  // ── Polymarket ─────────────────────────────────────────────────

  private async fetchPolymarket(slug: string): Promise<HistoricalFetchResult> {
    const warnings: string[] = [];

    // Step 1: Get event data from Gamma API
    const gammaUrl = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
    const gammaResp = await fetchWithRetry(
      gammaUrl,
      {},
      { maxRetries: 3, timeoutMs: REQUEST_TIMEOUT_MS },
      "Polymarket.gammaEvents.history"
    );
    if (!gammaResp.ok) {
      throw new Error(`Gamma API returned ${gammaResp.status}: ${await gammaResp.text().catch(() => 'unknown')}`);
    }

    const events = await gammaResp.json() as Array<{
      title: string;
      slug: string;
      markets: Array<{
        clobTokenIds: string;
        outcomes: string;
        question: string;
        groupItemTitle?: string;
      }>;
    }>;

    if (!events || events.length === 0) {
      throw new Error(`No Polymarket event found for slug "${slug}"`);
    }

    const event = events[0];
    const title = event.title;
    const sourceUrl = `https://polymarket.com/event/${slug}`;

    // Step 2: Fetch price history for each market's YES token
    const series: HistoricalSeries[] = [];

    for (const market of event.markets) {
      let tokenIds: string[];
      try {
        tokenIds = JSON.parse(market.clobTokenIds);
      } catch {
        warnings.push(`Skipping market "${market.question}": invalid clobTokenIds`);
        continue;
      }

      let outcomes: string[];
      try {
        outcomes = JSON.parse(market.outcomes);
      } catch {
        outcomes = ['Yes', 'No'];
      }

      // Use the YES token (first token) for price history
      const yesTokenId = tokenIds[0];
      if (!yesTokenId) {
        warnings.push(`Skipping market "${market.question}": no token ID`);
        continue;
      }

      try {
        const historyUrl = `https://clob.polymarket.com/prices-history?market=${yesTokenId}&interval=max&fidelity=60`;
        const histResp = await fetchWithRetry(
          historyUrl,
          {},
          { maxRetries: 3, timeoutMs: REQUEST_TIMEOUT_MS },
          "Polymarket.pricesHistory"
        );
        if (!histResp.ok) {
          warnings.push(`Price history failed for "${market.question}": HTTP ${histResp.status}`);
          continue;
        }

        const histData = await histResp.json() as {
          history: Array<{ t: number; p: number }>;
        };

        if (!histData.history || histData.history.length === 0) {
          warnings.push(`No price history data for "${market.question}"`);
          continue;
        }

        let points: PricePoint[] = histData.history.map(h => ({
          timestamp: h.t * 1000,
          probability: h.p * 100,
        }));

        points = downsample(points, MAX_POINTS);

        // Label: use groupItemTitle for multi-outcome events, or first outcome name
        const label = market.groupItemTitle || outcomes[0] || market.question;

        series.push({
          label,
          platform: 'polymarket',
          points,
        });
      } catch (err) {
        warnings.push(`Error fetching history for "${market.question}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (series.length === 0) {
      throw new Error(`No historical data available for "${slug}". ${warnings.join('; ')}`);
    }

    return { series, title, sourceUrl, warnings };
  }

  // ── Kalshi ─────────────────────────────────────────────────────

  private async fetchKalshi(ticker: string): Promise<HistoricalFetchResult> {
    type KalshiCandle = { end_period_ts: number; price: { open: number; close: number; high: number; low: number } };
    const warnings: string[] = [];
    const baseUrl = 'https://api.elections.kalshi.com/trade-api/v2';

    let candleData: KalshiCandle[] = [];
    let marketTitle = ticker;

    // Try to get market info for the title
    try {
      const marketResp = await fetchWithRetry(
        `${baseUrl}/markets/${ticker}`,
        {},
        { maxRetries: 3, timeoutMs: REQUEST_TIMEOUT_MS },
        "Kalshi.marketInfo"
      );
      if (marketResp.ok) {
        const marketInfo = await marketResp.json() as { market: { title?: string; subtitle?: string; series_ticker?: string } };
        marketTitle = marketInfo.market.title || marketInfo.market.subtitle || ticker;
      }
    } catch {
      // Non-critical — we'll just use the ticker as title
    }

    // Try active candlesticks
    try {
      const candleUrl = `${baseUrl}/markets/${ticker}/candlesticks?period_interval=60`;
      const resp = await fetchWithRetry(
        candleUrl,
        {},
        { maxRetries: 3, timeoutMs: REQUEST_TIMEOUT_MS },
        "Kalshi.candlesticks"
      );
      if (resp.ok) {
        const data = await resp.json() as { candlesticks: KalshiCandle[] };
        candleData = data.candlesticks || [];
      }
    } catch {
      // Will try historical endpoint
    }

    // Fall back to historical endpoint
    if (candleData.length === 0) {
      try {
        const histUrl = `${baseUrl}/markets/${ticker}/candlesticks?period_interval=60`;
        const resp = await fetchWithRetry(
          histUrl,
          {},
          { maxRetries: 3, timeoutMs: REQUEST_TIMEOUT_MS },
          "Kalshi.candlesticks.fallback"
        );
        if (resp.ok) {
          const data = await resp.json() as { candlesticks: KalshiCandle[] };
          candleData = data.candlesticks || [];
        }
      } catch (err) {
        warnings.push(`Historical candlesticks failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (candleData.length === 0) {
      throw new Error(`No candlestick data available for Kalshi ticker "${ticker}"`);
    }

    let points: PricePoint[] = candleData.map((c: KalshiCandle) => ({
      timestamp: c.end_period_ts * 1000,
      probability: c.price.close, // Already in cents = percentage
    }));

    points = downsample(points, MAX_POINTS);

    const series: HistoricalSeries[] = [{
      label: marketTitle,
      platform: 'kalshi',
      points,
    }];

    return {
      series,
      title: marketTitle,
      sourceUrl: `https://kalshi.com/markets/${ticker}`,
      warnings,
    };
  }
}
