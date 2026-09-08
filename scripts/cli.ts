#!/usr/bin/env npx tsx
/**
 * Betting Markets Manager CLI
 *
 * Zod-validated CLI for searching and aggregating prediction markets.
 */

import { writeFileSync } from 'fs';
import { z } from "zod";
import { createCommand, runCli, cliTypes } from "./cli-support/validator.js";
import type { Platform, SearchOptions, BetStatus, OrderProjection, OrderBy, SortDir, Side, GroupBy } from "./types.js";
import { BettingMarketsAggregator } from "./aggregator.js";
import { HistoricalDataFetcher } from './historical-data.js';
import { ChartRenderer } from './chart-renderer.js';

const PLATFORM_VALUES = ["polymarket", "betfair", "theodds", "kalshi", "manifold", "myriad"] as const;

// Define commands with Zod schemas
const commands = {
  "list-tools": createCommand(
    z.object({}),
    async () => BettingMarketsAggregator.listTools(),
    "List all available commands",
    { sideEffect: "read", clientless: true }
  ),

  "search": createCommand(
    z.object({
      query: z.string().min(1).describe("Search query"),
      platform: z.enum(PLATFORM_VALUES).optional().describe("Filter to platform"),
      minVolume: cliTypes.int(0).optional().describe("Minimum volume in USD"),
      maxResults: cliTypes.int(1, 1000).optional().describe("Maximum results"),
      sortBy: z.enum(["volume", "odds", "platform"]).optional().describe("Sort by field"),
      sport: z.string().optional().describe("The Odds API sport key (e.g. soccer_epl)"),
    }),
    async (args, client: BettingMarketsAggregator) => {
      const { query, platform, minVolume, maxResults, sortBy, sport } = args as {
        query: string;
        platform?: Platform;
        minVolume?: number;
        maxResults?: number;
        sortBy?: SearchOptions["sortBy"];
        sport?: string;
      };
      return client.searchAll(query, { platform, minVolume, maxResults, sortBy, sportKey: sport });
    },
    "Search markets across platforms",
    { sideEffect: "read" }
  ),

  "format-table": createCommand(
    z.object({
      query: z.string().min(1).describe("Search query"),
      platform: z.enum(PLATFORM_VALUES).optional().describe("Filter to platform"),
      minVolume: cliTypes.int(0).optional().describe("Minimum volume in USD"),
      maxResults: cliTypes.int(1, 1000).optional().describe("Maximum results"),
      sortBy: z.enum(["volume", "odds", "platform"]).optional().describe("Sort by field"),
    }),
    async (args, client: BettingMarketsAggregator) => {
      const { query, platform, minVolume, maxResults, sortBy } = args as {
        query: string;
        platform?: Platform;
        minVolume?: number;
        maxResults?: number;
        sortBy?: SearchOptions["sortBy"];
      };
      const table = await client.formatTable(query, { platform, minVolume, maxResults, sortBy });
      // Return as raw text (not JSON) for direct use
      console.log(table);
      process.exit(0);
    },
    "Search and output markdown table",
    { sideEffect: "read" }
  ),

  "market": createCommand(
    z.object({
      id: z.string().min(1).describe("Market ID"),
      platform: z.enum(PLATFORM_VALUES).describe("Platform name"),
    }),
    async (args, client: BettingMarketsAggregator) => {
      const { id, platform } = args as { id: string; platform: Platform };
      const market = await client.getMarket(id, platform);
      return market || { found: false, message: "Market not found" };
    },
    "Get single market details",
    { sideEffect: "read" }
  ),

  "auth-test": createCommand(
    z.object({}),
    async (_args, client: BettingMarketsAggregator) => {
      const authResults = await client.testAuth();
      // Also output formatted text
      console.log("\nAuthentication Test Results:");
      console.log("\u2500".repeat(40));
      for (const [platform, status] of Object.entries(authResults)) {
        if (!status) continue;
        const enabledStr = status.enabled ? "\u2713 enabled" : "\u2717 disabled";
        const authStr = status.authenticated ? "\u2713 authenticated" : "\u2717 not authenticated";
        console.log(`${platform.padEnd(12)} ${enabledStr.padEnd(14)} ${authStr}`);
        if (status.error) {
          console.log(`             \u2514\u2500 ${status.error}`);
        }
      }
      console.log("\u2500".repeat(40));
      console.log("\nJSON:");
      return authResults;
    },
    "Test authentication for all platforms",
    { sideEffect: "read" }
  ),

  "credit-status": createCommand(
    z.object({
      refresh: z.boolean().optional().describe("Refresh account-wide usage through the free sports endpoint"),
    }),
    async (args, client: BettingMarketsAggregator) => {
      if ((args as { refresh?: boolean }).refresh) {
        await client.refreshCreditStatus();
      }
      const formatted = client.getFormattedCreditStatus();
      console.log(formatted);
      const status = client.getCreditStatus();
      if (status) {
        console.log("\nJSON:");
        return status;
      }
      return { message: "The Odds API is not enabled" };
    },
    "Show The Odds API credit usage",
    { sideEffect: "read" }
  ),

  "list-sports": createCommand(
    z.object({}),
    async (_args, client: BettingMarketsAggregator) => {
      const sports = await client.listSports();
      // Output formatted table
      console.log(`\n${sports.length} sports available:\n`);
      console.log("Key".padEnd(45) + "Title".padEnd(35) + "Group".padEnd(20) + "Active");
      console.log("\u2500".repeat(105));
      for (const sport of sports) {
        console.log(
          sport.key.padEnd(45) +
          sport.title.padEnd(35) +
          sport.group.padEnd(20) +
          (sport.active ? "\u2713" : "\u2717")
        );
      }
      console.log("\nJSON:");
      return sports;
    },
    "List available The Odds API sports (0 credits)",
    { sideEffect: "read" }
  ),

  // ── Betfair Account Commands ──────────────────────────────────

  "account-funds": createCommand(
    z.object({}),
    async (_args, client: BettingMarketsAggregator) => {
      const funds = await client.getAccountFunds();
      console.log("\nBetfair Account Funds:");
      console.log("\u2500".repeat(50));
      console.log(`  Balance:     ${funds.formatted.availableToBetBalance}`);
      console.log(`  Exposure:    ${funds.formatted.exposure}`);
      console.log(`  Commission:  ${funds.formatted.retainedCommission}`);
      console.log(`  Exp. Limit:  ${funds.formatted.exposureLimit}`);
      console.log(`  Discount:    ${funds.discountRate}%`);
      console.log(`  Points:      ${funds.pointsBalance}`);
      console.log("\u2500".repeat(50));
      console.log("\nJSON:");
      return funds;
    },
    "Show Betfair account balance and exposure",
    { sideEffect: "read" }
  ),

  "account-statement": createCommand(
    z.object({
      dateFrom: cliTypes.date().optional().describe("Start date (ISO 8601)"),
      dateTo: cliTypes.date().optional().describe("End date (ISO 8601)"),
      includeItem: z.enum(["ALL", "EXCHANGE", "DEPOSITS_WITHDRAWALS"]).optional().describe("Item type filter"),
      limit: cliTypes.int(1, 100).optional().describe("Records per page (default 100)"),
      maxPages: cliTypes.int(1, 10).optional().describe("Max pages to fetch (default 1)"),
    }),
    async (args, client: BettingMarketsAggregator) => {
      const { dateFrom, dateTo, includeItem, limit, maxPages } = args as {
        dateFrom?: string; dateTo?: string; includeItem?: string;
        limit?: number; maxPages?: number;
      };
      const itemDateRange = (dateFrom || dateTo) ? { from: dateFrom, to: dateTo } : undefined;
      const result = await client.getAccountStatement({
        itemDateRange,
        includeItem,
        recordCount: limit,
        maxPages,
      });

      console.log(`\nBetfair Account Statement (${result.totalFetched} items):`);
      console.log("\u2500".repeat(90));
      for (const item of result.items) {
        const date = item.itemDate ? new Date(item.itemDate).toLocaleString('en-GB') : 'N/A';
        const amount = item.amount !== undefined ? (item.amount >= 0 ? `+\u00a3${item.amount.toFixed(2)}` : `-\u00a3${Math.abs(item.amount).toFixed(2)}`) : '';
        const balance = item.balance !== undefined ? `bal: \u00a3${item.balance.toFixed(2)}` : '';
        const desc = item.legacyData?.fullMarketName || item.itemClass || '';
        console.log(`  ${date}  ${amount.padStart(12)}  ${balance.padStart(16)}  ${desc}`);
      }
      if (result.moreAvailable) {
        console.log(`\n  ... more available (use --max-pages to fetch more)`);
      }
      console.log("\u2500".repeat(90));
      console.log("\nJSON:");
      return result;
    },
    "Show Betfair account transaction history",
    { sideEffect: "read" }
  ),

  "current-orders": createCommand(
    z.object({
      orderProjection: z.enum(["ALL", "EXECUTABLE", "EXECUTION_COMPLETE"]).optional().describe("Order filter"),
      marketIds: z.preprocess(
        (v) => typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : v,
        z.array(z.string()).optional()
      ).describe("Comma-separated market IDs"),
      dateFrom: cliTypes.date().optional().describe("Start date (ISO 8601)"),
      dateTo: cliTypes.date().optional().describe("End date (ISO 8601)"),
      orderBy: z.enum(["BY_BET", "BY_MARKET", "BY_MATCH_TIME", "BY_PLACE_TIME", "BY_SETTLED_TIME", "BY_VOID_TIME"]).optional().describe("Sort field"),
      sortDir: z.enum(["EARLIEST_TO_LATEST", "LATEST_TO_EARLIEST"]).optional().describe("Sort direction"),
      limit: cliTypes.int(1, 1000).optional().describe("Records per page (default 100)"),
      maxPages: cliTypes.int(1, 10).optional().describe("Max pages to fetch (default 1)"),
    }),
    async (args, client: BettingMarketsAggregator) => {
      const { orderProjection, marketIds, dateFrom, dateTo, orderBy, sortDir, limit, maxPages } = args as {
        orderProjection?: OrderProjection; marketIds?: string[];
        dateFrom?: string; dateTo?: string; orderBy?: OrderBy; sortDir?: SortDir;
        limit?: number; maxPages?: number;
      };
      const dateRange = (dateFrom || dateTo) ? { from: dateFrom, to: dateTo } : undefined;
      const result = await client.getCurrentOrders({
        orderProjection, marketIds, dateRange, orderBy, sortDir,
        recordCount: limit, maxPages,
      });

      console.log(`\nBetfair Current Orders (${result.totalFetched} orders):`);
      console.log("\u2500".repeat(100));
      if (result.orders.length === 0) {
        console.log("  No open orders.");
      } else {
        for (const order of result.orders) {
          const placed = new Date(order.placedDate).toLocaleString('en-GB');
          const price = order.priceSize?.price?.toFixed(2) || 'N/A';
          const stake = order.priceSize?.size?.toFixed(2) || 'N/A';
          console.log(`  ${order.side.padEnd(5)} ${order.marketId}  sel:${order.selectionId}  @${price}  \u00a3${stake}  matched:\u00a3${order.sizeMatched.toFixed(2)}  remaining:\u00a3${order.sizeRemaining.toFixed(2)}  ${placed}`);
        }
      }
      if (result.moreAvailable) {
        console.log(`\n  ... more available (use --max-pages to fetch more)`);
      }
      console.log("\u2500".repeat(100));
      console.log("\nJSON:");
      return result;
    },
    "List open Betfair orders",
    { sideEffect: "read" }
  ),

  "cleared-orders": createCommand(
    z.object({
      betStatus: z.enum(["SETTLED", "VOIDED", "LAPSED", "CANCELLED"]).describe("Bet status (required)"),
      eventTypeIds: z.preprocess(
        (v) => typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : v,
        z.array(z.string()).optional()
      ).describe("Comma-separated event type IDs"),
      marketIds: z.preprocess(
        (v) => typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : v,
        z.array(z.string()).optional()
      ).describe("Comma-separated market IDs"),
      side: z.enum(["BACK", "LAY"]).optional().describe("Filter by side"),
      dateFrom: cliTypes.date().optional().describe("Settled date start (ISO 8601)"),
      dateTo: cliTypes.date().optional().describe("Settled date end (ISO 8601)"),
      groupBy: z.enum(["EVENT_TYPE", "EVENT", "MARKET", "SIDE", "BET"]).optional().describe("Group results by"),
      limit: cliTypes.int(1, 1000).optional().describe("Records per page (default 100)"),
      maxPages: cliTypes.int(1, 10).optional().describe("Max pages to fetch (default 5)"),
    }),
    async (args, client: BettingMarketsAggregator) => {
      const { betStatus, eventTypeIds, marketIds, side, dateFrom, dateTo, groupBy, limit, maxPages } = args as {
        betStatus: BetStatus; eventTypeIds?: string[]; marketIds?: string[];
        side?: Side; dateFrom?: string; dateTo?: string; groupBy?: GroupBy;
        limit?: number; maxPages?: number;
      };
      const settledDateRange = (dateFrom || dateTo) ? { from: dateFrom, to: dateTo } : undefined;
      const result = await client.getClearedOrders({
        betStatus, eventTypeIds, marketIds, side, settledDateRange, groupBy,
        recordCount: limit, maxPages,
      });

      console.log(`\nBetfair Cleared Orders — ${betStatus} (${result.totalFetched} orders):`);
      console.log("\u2500".repeat(110));
      if (result.orders.length === 0) {
        console.log("  No orders found.");
      } else {
        let totalProfit = 0;
        let totalCommission = 0;
        for (const order of result.orders) {
          const date = order.settledDate ? new Date(order.settledDate).toLocaleString('en-GB') : 'N/A';
          const desc = order.itemDescription?.eventDesc || order.marketId || '';
          const runner = order.itemDescription?.runnerDesc || '';
          const profit = order.profit || 0;
          const commission = order.commission || 0;
          totalProfit += profit;
          totalCommission += commission;
          const profitStr = profit >= 0 ? `+\u00a3${profit.toFixed(2)}` : `-\u00a3${Math.abs(profit).toFixed(2)}`;
          const sideStr = order.side?.padEnd(5) || '     ';
          console.log(`  ${sideStr} ${desc.substring(0, 35).padEnd(36)} ${runner.substring(0, 20).padEnd(21)} ${profitStr.padStart(12)}  comm:\u00a3${commission.toFixed(2)}  ${order.betOutcome?.padEnd(5) || ''}  ${date}`);
        }
        console.log("\u2500".repeat(110));
        console.log(`  Total P&L: ${client.formatGbp(totalProfit)}  |  Total Commission: ${client.formatGbp(totalCommission)}`);
      }
      if (result.moreAvailable) {
        console.log(`\n  ... more available (use --max-pages to fetch more)`);
      }
      console.log("\u2500".repeat(110));
      console.log("\nJSON:");
      return result;
    },
    "List settled/voided Betfair orders",
    { sideEffect: "read" }
  ),

  "chart": createCommand(
    z.object({
      market: z.string().min(1).describe("Market identifier (Polymarket slug/URL or Kalshi ticker)"),
      platform: z.enum(["polymarket", "kalshi"]).optional().describe("Force platform"),
      output: z.string().optional().describe("Output PNG path (default: /tmp/betting-chart-{ts}.png)"),
      width: cliTypes.int(400, 3000).optional().describe("Width px (default 1400)"),
      height: cliTypes.int(300, 2000).optional().describe("Height px (default 800)"),
      title: z.string().optional().describe("Custom chart title"),
    }),
    async (args) => {
      const { market, platform, output, width, height, title } = args as {
        market: string;
        platform?: 'polymarket' | 'kalshi';
        output?: string;
        width?: number;
        height?: number;
        title?: string;
      };

      const fetcher = new HistoricalDataFetcher();
      const result = await fetcher.fetch(market, platform);

      const renderer = new ChartRenderer();
      const pngBuffer = renderer.render(result.series, {
        width,
        height,
        title: title || result.title,
      });

      const outPath = output || `/tmp/betting-chart-${Date.now()}.png`;
      writeFileSync(outPath, pngBuffer);

      console.log(`Chart saved to: ${outPath}`);
      if (result.warnings.length > 0) {
        console.log(`Warnings: ${result.warnings.join('; ')}`);
      }

      return {
        path: outPath,
        title: result.title,
        sourceUrl: result.sourceUrl,
        seriesCount: result.series.length,
        series: result.series.map(s => ({
          label: s.label,
          platform: s.platform,
          pointCount: s.points.length,
          timeRange: s.points.length > 0 ? {
            from: new Date(s.points[0].timestamp).toISOString(),
            to: new Date(s.points[s.points.length - 1].timestamp).toISOString(),
          } : null,
        })),
        warnings: result.warnings,
      };
    },
    "Generate historical probability chart (PNG)",
    { sideEffect: "write" }
  ),

  "account-summary": createCommand(
    z.object({}),
    async (_args, client: BettingMarketsAggregator) => {
      const summary = await client.getAccountSummary();

      console.log("\n" + "\u2550".repeat(60));
      console.log("  BETFAIR ACCOUNT DASHBOARD");
      console.log("\u2550".repeat(60));

      // Funds
      if (summary.funds) {
        console.log("\n  \u250C Balance");
        console.log(`  \u2502 Available:  ${summary.funds.formatted.availableToBetBalance}`);
        console.log(`  \u2502 Exposure:   ${summary.funds.formatted.exposure}`);
        console.log(`  \u2502 Commission: ${summary.funds.formatted.retainedCommission}`);
        console.log(`  \u2514 Discount:   ${summary.funds.discountRate}%`);
      } else {
        console.log(`\n  \u2718 Funds: ${summary.fundsError}`);
      }

      // Open orders
      if (summary.openOrders) {
        console.log(`\n  \u250C Open Orders`);
        console.log(`  \u2514 ${summary.openOrders.formatted}`);
      } else {
        console.log(`\n  \u2718 Open Orders: ${summary.openOrdersError}`);
      }

      // Recent settled
      if (summary.recentSettled) {
        console.log(`\n  \u250C Recent Settled`);
        console.log(`  \u2514 ${summary.recentSettled.formatted}`);
      } else {
        console.log(`\n  \u2718 Recent Settled: ${summary.recentSettledError}`);
      }

      console.log("\n" + "\u2550".repeat(60));
      console.log("\nJSON:");
      return summary;
    },
    "Betfair account dashboard (balance + orders + P&L)",
    { sideEffect: "read" }
  ),
};

// Run CLI
runCli(commands, BettingMarketsAggregator, {
  programName: "betting-cli",
  description: "Search and aggregate prediction markets",
});
