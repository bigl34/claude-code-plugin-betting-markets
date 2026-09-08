import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Config } from './types.js';

const DEFAULT_CONFIG_PATHS: Partial<Record<NodeJS.Platform, string>> = {
  linux: 'YOUR_CREDENTIALS_PATH/configs/betting-markets-manager.json',
  darwin: 'YOUR_CREDENTIALS_PATH/configs/betting-markets-manager.json',
};

const enabledSchema = z.boolean();

const configSchema = z.object({
  polymarket: z.object({
    baseUrl: z.string().url(),
    enabled: enabledSchema,
  }),
  betfair: z.object({
    ssoUrl: z.string().url(),
    certSsoUrl: z.string().url(),
    baseUrl: z.string().url(),
    accountBaseUrl: z.string().url().optional(),
    appKey: z.string(),
    username: z.string(),
    password: z.string(),
    certPath: z.string().optional(),
    keyPath: z.string().optional(),
    enabled: enabledSchema,
  }),
  theodds: z.object({
    apiKey: z.string(),
    enabled: enabledSchema,
    baseUrl: z.string().url().optional(),
    region: z.string().min(1).optional(),
    defaultMarket: z.string().min(1).optional(),
    sportKeys: z.array(z.string()).optional(),
    monthlyBudget: z.number().int().positive().max(400).optional(),
  }).optional(),
  finfeed: z.object({
    apiKey: z.string(),
    enabled: enabledSchema,
    baseUrl: z.string().url().optional(),
    exchanges: z.array(z.string()).optional(),
  }).optional(),
  settings: z.object({
    gbpToUsd: z.number().positive(),
    defaultMaxResults: z.number().int().positive(),
    cacheMarketsTTL: z.number().int().nonnegative(),
    cacheMetadataTTL: z.number().int().nonnegative(),
  }),
}).strict();

const REMEDY = 'Run cred-loader-sync or set BETTING_MARKETS_CONFIG_PATH to a rendered configuration file.';

export function resolveBettingMarketsConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicitPath = env.BETTING_MARKETS_CONFIG_PATH?.trim();
  if (explicitPath) return explicitPath;

  const defaultPath = DEFAULT_CONFIG_PATHS[platform];
  if (!defaultPath) {
    throw new Error(`Betting markets credentials have no default RAM path for ${platform}. ${REMEDY}`);
  }
  return defaultPath;
}

export function parseBettingMarketsConfig(input: unknown, source = 'configuration'): Config {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid betting markets ${source}: ${details}. ${REMEDY}`);
  }
  return parsed.data;
}

export function loadBettingMarketsConfig(): Config {
  const configPath = resolveBettingMarketsConfigPath();
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read betting markets credentials at ${configPath}: ${reason}. ${REMEDY}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in betting markets credentials at ${configPath}. ${REMEDY}`);
  }
  return parseBettingMarketsConfig(value, `configuration at ${configPath}`);
}
