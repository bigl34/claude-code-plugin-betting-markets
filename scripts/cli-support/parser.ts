/**
 * @local/cli-utils Argument Parser
 *
 * Parses command-line arguments into a raw key-value object.
 * Does NOT validate - that's handled by Zod schemas.
 */

import type { RawArgs, GlobalFlags } from "./types.js";

/**
 * Parse command-line arguments into a raw object.
 *
 * Supports:
 * - --key value (string value)
 * - --key=value (equals syntax)
 * - --flag (boolean true)
 * - --no-flag (boolean false)
 *
 * @param argv - Command-line arguments (typically process.argv.slice(2))
 * @returns Parsed arguments as key-value pairs
 *
 * @example
 * parseArgs(["--limit", "50", "--verbose"])
 * // { limit: "50", verbose: true }
 *
 * parseArgs(["--no-cache", "--status=open"])
 * // { noCache: true, status: "open" }
 */
export function parseArgs(argv: string[]): RawArgs {
  const args: RawArgs = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // `-h` is the only supported short flag. Keep other single-dash tokens
    // untouched so this does not accidentally introduce general short-flag
    // parsing.
    if (arg === "-h") {
      args.help = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      continue;
    }

    // Handle --key=value syntax
    if (arg.includes("=")) {
      const [key, ...valueParts] = arg.slice(2).split("=");
      const value = valueParts.join("="); // Handle values with = in them
      args[kebabToCamel(key)] = value;
      continue;
    }

    const key = arg.slice(2);

    // Handle --no-* negation flags
    if (key.startsWith("no-")) {
      const positiveKey = key.slice(3);
      args[kebabToCamel(positiveKey)] = false;
      continue;
    }

    // Check if next arg is a value or another flag
    const nextArg = argv[i + 1];
    if (nextArg && nextArg !== "-h" && !nextArg.startsWith("--")) {
      args[kebabToCamel(key)] = nextArg;
      i++; // Skip the value in next iteration
    } else {
      // Boolean flag
      args[kebabToCamel(key)] = true;
    }
  }

  return args;
}

/**
 * Extract the command name from argv.
 *
 * @param argv - Command-line arguments
 * @returns The first non-flag argument, or undefined
 */
export function extractCommand(argv: string[]): string | undefined {
  return argv.find((arg) => arg !== "-h" && !arg.startsWith("--"));
}

/**
 * Extract global flags from parsed args.
 *
 * @param args - Parsed arguments
 * @returns Global flags object
 */
export function extractGlobalFlags(args: RawArgs): GlobalFlags {
  return {
    noCache:
      args.noCache === true ||
      args.noCache === "true" ||
      args.cache === false ||
      args.cache === "false",
    help: args.help === true || args.help === "true",
    verbose: args.verbose === true || args.verbose === "true",
    // Surface dry-run/confirm to handlers (kebab `--dry-run`
    // parses to `dryRun`).
    dryRun: args.dryRun === true || args.dryRun === "true",
    confirm: args.confirm === true || args.confirm === "true",
  };
}

/**
 * Convert kebab-case to camelCase.
 *
 * @param str - Kebab-case string
 * @returns camelCase string
 *
 * @example
 * kebabToCamel("order-id") // "orderId"
 * kebabToCamel("include-line-items") // "includeLineItems"
 */
export function kebabToCamel(str: string): string {
  return str.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Convert camelCase to kebab-case.
 *
 * @param str - camelCase string
 * @returns kebab-case string
 *
 * @example
 * camelToKebab("orderId") // "order-id"
 * camelToKebab("includeLineItems") // "include-line-items"
 */
export function camelToKebab(str: string): string {
  return str.replace(/([A-Z])/g, "-$1").toLowerCase();
}
