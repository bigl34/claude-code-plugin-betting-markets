#!/usr/bin/env npx tsx
/**
 * Betting Markets Manager CLI
 *
 * Zod-validated CLI for searching and aggregating prediction markets.
 */

import { z, createCommand, runCli, cliTypes } from "@local/cli-utils";
import type { Platform, SearchOptions } from "./types.js";
import { BettingMarketsAggregator } from "./aggregator.js";

// Define commands with Zod schemas
const commands = {
  "list-tools": createCommand(
    z.object({}),
    async (_args, client: BettingMarketsAggregator) => client.listTools(),
    "List all available commands"
  ),

  "search": createCommand(
    z.object({
      query: z.string().min(1).describe("Search query"),
      platform: z.enum(["polymarket", "betfair"]).optional().describe("Filter to platform"),
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
      return client.searchAll(query, { platform, minVolume, maxResults, sortBy });
    },
    "Search markets across platforms"
  ),

  "format-table": createCommand(
    z.object({
      query: z.string().min(1).describe("Search query"),
      platform: z.enum(["polymarket", "betfair"]).optional().describe("Filter to platform"),
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
    "Search and output markdown table"
  ),

  "market": createCommand(
    z.object({
      id: z.string().min(1).describe("Market ID"),
      platform: z.enum(["polymarket", "betfair"]).describe("Platform name"),
    }),
    async (args, client: BettingMarketsAggregator) => {
      const { id, platform } = args as { id: string; platform: Platform };
      const market = await client.getMarket(id, platform);
      return market || { found: false, message: "Market not found" };
    },
    "Get single market details"
  ),

  "auth-test": createCommand(
    z.object({}),
    async (_args, client: BettingMarketsAggregator) => {
      const authResults = await client.testAuth();
      // Also output formatted text
      console.log("\nAuthentication Test Results:");
      console.log("─".repeat(40));
      for (const [platform, status] of Object.entries(authResults)) {
        const enabledStr = status.enabled ? "✓ enabled" : "✗ disabled";
        const authStr = status.authenticated ? "✓ authenticated" : "✗ not authenticated";
        console.log(`${platform.padEnd(12)} ${enabledStr.padEnd(14)} ${authStr}`);
        if (status.error) {
          console.log(`             └─ ${status.error}`);
        }
      }
      console.log("─".repeat(40));
      console.log("\nJSON:");
      return authResults;
    },
    "Test authentication for all platforms"
  ),
};

// Run CLI
runCli(commands, BettingMarketsAggregator, {
  programName: "betting-cli",
  description: "Search and aggregate prediction markets",
});
