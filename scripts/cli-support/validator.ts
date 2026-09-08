/**
 * @local/cli-utils Validator
 *
 * Zod-based validation and CLI runner utilities.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- Zod v3/v4 runtime introspection has no stable public internal type. */

import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { z, ZodError } from "zod";
import {
  CommandDef,
  CommandHandler,
  CommandMap,
  RunCliOptions,
  SchemaField,
} from "./types.js";
import {
  parseArgs,
  extractCommand,
  extractGlobalFlags,
  camelToKebab,
} from "./parser.js";

/**
 * Create a command definition with schema and handler.
 *
 * @param schema - Zod schema for command arguments
 * @param handler - Async function to execute the command
 * @param description - Optional command description for help text
 * @param options - Optional command behaviour. `{ strictFlags: false }` opts
 *   the command out of runCli's unrecognised-flag rejection.
 * @returns Command definition object
 *
 * @example
 * const getOrder = createCommand(
 *   z.object({ orderId: z.string() }),
 *   async (args, client) => client.getOrder(args.orderId),
 *   "Retrieve an order by ID"
 * );
 */
export function createCommand<TSchema extends z.ZodType, TClient>(
  schema: TSchema,
  handler: CommandHandler<z.infer<TSchema>, TClient>,
  description?: string,
  options?: {
    strictFlags?: boolean;
    clientless?: boolean;
    /** Side-effect classification — see CommandDef.sideEffect (internal-ref). */
    sideEffect?: import("./types.js").SideEffect;
    /** Override the side-effect default for confirmation requirements. */
    requiresConfirmation?: boolean;
    dryRunSupported?: boolean;
    idempotent?: boolean;
    requiresSafeOutput?: boolean;
    operationResultExit?: boolean;
  }
): CommandDef<TClient, z.infer<TSchema>> {
  return {
    schema: schema as unknown as z.ZodType<z.infer<TSchema>>,
    handler,
    description,
    strictFlags: options?.strictFlags,
    clientless: options?.clientless,
    sideEffect: options?.sideEffect,
    requiresConfirmation: options?.requiresConfirmation,
    dryRunSupported: options?.dryRunSupported,
    idempotent: options?.idempotent,
    requiresSafeOutput: options?.requiresSafeOutput,
    operationResultExit: options?.operationResultExit,
  };
}

/**
 * Pre-built cache commands that work with any client implementing cache methods.
 *
 * @returns Command map for cache-stats, cache-clear, cache-invalidate
 */
export function cacheCommands<
  TClient extends {
    getCacheStats: () => unknown;
    clearCache: () => number;
    invalidateCacheKey: (key: string) => boolean;
  }
>(): CommandMap<TClient> {
  return {
    "cache-stats": createCommand(
      z.object({}),
      async (_args, client) => client.getCacheStats(),
      "Show cache statistics",
      { sideEffect: "read" },
    ),
    "cache-clear": createCommand(
      z.object({}),
      async (_args, client) => ({ cleared: client.clearCache() }),
      "Clear all cached data",
      { sideEffect: "destructive" },
    ),
    "cache-invalidate": createCommand(
      z.object({
        key: z.string().min(1).describe("Cache key to invalidate"),
      }),
      async (args, client) => ({ invalidated: client.invalidateCacheKey((args as { key: string }).key) }),
      "Invalidate a specific cache key",
      { sideEffect: "destructive" },
    ),
  };
}

/**
 * Format a Zod error into a user-friendly message.
 *
 * @param error - ZodError from validation
 * @returns Formatted error message
 */
export function formatZodError(error: ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `--${camelToKebab(issue.path.join("."))}` : "input";
    const rawIssue = issue as Record<string, any>;
    const received =
      rawIssue.received ??
      /received ([A-Za-z0-9_-]+)/.exec(issue.message)?.[1];

    switch (String(issue.code)) {
      case "invalid_type":
        if (received === "undefined") {
          return `Missing required argument: ${path}`;
        }
        return `${path}: Expected ${rawIssue.expected}, got ${received ?? "unknown"}`;
      case "too_small":
        return `${path}: Value too small (minimum: ${rawIssue.minimum})`;
      case "too_big":
        return `${path}: Value too large (maximum: ${rawIssue.maximum})`;
      case "invalid_enum_value":
      case "invalid_value": {
        const values = rawIssue.options ?? rawIssue.values ?? [];
        return `${path}: Invalid value. Expected one of: ${values.join(", ")}`;
      }
      default:
        return `${path}: ${issue.message}`;
    }
  });

  return issues.join("\n");
}

type ZodRuntimeCtor = new (...args: any[]) => z.ZodType;

function getZodCtor(name: string): ZodRuntimeCtor | undefined {
  return (z as unknown as Record<string, ZodRuntimeCtor | undefined>)[name];
}

function isZodInstance(schema: z.ZodType, ctorName: string): boolean {
  const ctor = getZodCtor(ctorName);
  return typeof ctor === "function" && schema instanceof ctor;
}

function getZodDef(schema: z.ZodType): Record<string, any> {
  return ((schema as any)._def ?? (schema as any).def ?? {}) as Record<string, any>;
}

function getZodKind(schema: z.ZodType): string | undefined {
  const def = getZodDef(schema);
  return def.typeName ?? def.type;
}

function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (let guard = 0; guard < 10; guard += 1) {
    const def = getZodDef(current);
    const kind = getZodKind(current);

    if ((isZodInstance(current, "ZodEffects") || kind === "effects") && def.schema) {
      current = def.schema as z.ZodType;
      continue;
    }

    if (kind === "pipe" && def.out) {
      current = def.out as z.ZodType;
      continue;
    }

    return current;
  }
  return current;
}

function unwrapFieldSchema(schema: z.ZodType, field: SchemaField): z.ZodType {
  let current = schema;
  for (let guard = 0; guard < 10; guard += 1) {
    const def = getZodDef(current);
    const kind = getZodKind(current);

    if (isZodInstance(current, "ZodOptional") || kind === "optional") {
      field.required = false;
      current = def.innerType as z.ZodType;
      continue;
    }

    if (isZodInstance(current, "ZodDefault") || kind === "default") {
      field.required = false;
      const defaultValue = def.defaultValue;
      field.default = typeof defaultValue === "function" ? defaultValue() : defaultValue;
      current = def.innerType as z.ZodType;
      continue;
    }

    if ((isZodInstance(current, "ZodEffects") || kind === "effects") && def.schema) {
      current = def.schema as z.ZodType;
      continue;
    }

    if (kind === "pipe" && def.out) {
      current = def.out as z.ZodType;
      continue;
    }

    return current;
  }
  return current;
}

function getEnumValues(schema: z.ZodType): string[] {
  const def = getZodDef(schema);
  const options = (schema as any).options;
  if (Array.isArray(options)) return options.map(String);
  if (Array.isArray(def.values)) return def.values.map(String);
  if (def.entries && typeof def.entries === "object") return Object.values(def.entries).map(String);
  return [];
}

/**
 * Extract schema metadata for help generation.
 * Handles Zod wrappers from both Zod v3 (`ZodEffects`) and v4 (`pipe`).
 *
 * @param schema - Zod schema (ZodObject or wrappers around ZodObject)
 * @returns Array of field metadata
 */
export function extractSchemaFields(schema: z.ZodType): SchemaField[] {
  const fields: SchemaField[] = [];
  const innerSchema = unwrapSchema(schema);

  // If not a ZodObject, return empty fields
  if (!(isZodInstance(innerSchema, "ZodObject") || getZodKind(innerSchema) === "object")) {
    return fields;
  }

  const rawShape = getZodDef(innerSchema).shape ?? (innerSchema as any).shape;
  const shape = typeof rawShape === "function" ? rawShape() : rawShape;

  for (const [name, rawFieldSchema] of Object.entries(shape ?? {})) {
    const fieldSchema = rawFieldSchema as z.ZodType & { description?: string };
    const field: SchemaField = {
      name,
      type: "string",
      required: true,
      description: fieldSchema.description,
    };

    const fieldInner = unwrapFieldSchema(fieldSchema, field);
    const fieldKind = getZodKind(fieldInner);

    // Determine type
    if (isZodInstance(fieldInner, "ZodString") || fieldKind === "string") {
      field.type = "string";
    } else if (isZodInstance(fieldInner, "ZodNumber") || fieldKind === "number") {
      field.type = "number";
    } else if (isZodInstance(fieldInner, "ZodBoolean") || fieldKind === "boolean") {
      field.type = "boolean";
    } else if (isZodInstance(fieldInner, "ZodEnum") || fieldKind === "enum") {
      field.type = "enum";
      field.enumValues = getEnumValues(fieldInner);
    } else if (isZodInstance(fieldInner, "ZodEffects") || fieldKind === "effects" || fieldKind === "pipe") {
      // Preprocessed value - try to get inner type
      field.type = "string";
    }

    fields.push(field);
  }

  return fields;
}

/**
 * Generate help text for a command.
 *
 * @param commandName - Name of the command
 * @param commandDef - Command definition
 * @returns Formatted help string
 */
export function generateCommandHelp(
  commandName: string,
  commandDef: CommandDef<unknown>
): string {
  const lines: string[] = [];
  const fields = extractSchemaFields(commandDef.schema);

  lines.push(`  ${commandName}`);
  if (commandDef.description) {
    lines.push(`    ${commandDef.description}`);
  }
  // internal-ref: surface side-effect metadata in help so operators (and
  // cross-service consumers grepping `--help` output) see the class.
  if (commandDef.sideEffect) {
    const flags: string[] = [`sideEffect=${commandDef.sideEffect}`];
    if (commandDef.idempotent === true) flags.push("idempotent");
    if (commandDef.dryRunSupported === true) flags.push("dry-run-supported");
    lines.push(`    [${flags.join(", ")}]`);
  }

  if (fields.length > 0) {
    lines.push("    Options:");
    for (const field of fields) {
      const flagName = `--${camelToKebab(field.name)}`;
      const typeStr = field.enumValues ? field.enumValues.join("|") : `<${field.type}>`;
      const reqStr = field.required ? "(required)" : field.default !== undefined ? `(default: ${field.default})` : "(optional)";
      const desc = field.description ? ` - ${field.description}` : "";
      lines.push(`      ${flagName} ${typeStr} ${reqStr}${desc}`);
    }
  }

  return lines.join("\n");
}

/**
 * Generate full help text for all commands.
 *
 * @param commands - Command map
 * @param options - CLI options
 * @returns Formatted help string
 */
export function generateHelp<TClient>(
  commands: CommandMap<TClient>,
  options?: RunCliOptions<TClient>
): string {
  const lines: string[] = [];
  const programName = options?.programName || "cli";

  lines.push(`${programName}`);
  if (options?.description) {
    lines.push(`  ${options.description}`);
  }
  lines.push("");
  lines.push("Usage:");
  lines.push(`  npx tsx ${programName}.ts <command> [options]`);
  lines.push("");
  lines.push("Global Options:");
  lines.push("  --help, -h      Show this help message");
  lines.push("  --no-cache      Disable caching for this request");
  lines.push("  --verbose       Enable verbose output");
  lines.push("");
  lines.push("Commands:");

  for (const [name, def] of Object.entries(commands)) {
    lines.push(generateCommandHelp(name, def as CommandDef<unknown>));
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Keys parseArgs emits for the global flags. `--no-cache` lands as `cache`
 * (parseArgs strips the `no-` prefix) and `--noCache` as `noCache`, so both
 * appear here. runCli's unrecognised-flag check treats these as always-known.
 */
const GLOBAL_FLAG_KEYS: readonly string[] = [
  "help",
  "verbose",
  "cache",
  "noCache",
  // internal-ref: explicit safety flags for side-effecting commands. Always
  // known so the strict-flag check never rejects them, even on commands
  // that don't declare a sideEffect.
  "confirm",
  "dryRun",
];

/**
 * Default confirmation policy for a sideEffect (internal-ref). Used when the
 * command doesn't override `requiresConfirmation`.
 */
function defaultRequiresConfirmation(
  sideEffect: import("./types.js").SideEffect | undefined,
): boolean {
  return sideEffect === "destructive" || sideEffect === "external_send";
}

type ConfirmMode = "warn" | "deny";

type CliNumberSchema = z.ZodType<number>;
type CliBooleanSchema = z.ZodType<boolean>;

interface ConfirmTelemetryInput {
  command: string;
  service: string;
  sideEffect: import("./types.js").SideEffect | undefined;
  mode: ConfirmMode;
  bypass: boolean;
  dryRun: boolean;
}

function resolveConfirmMode(): ConfirmMode {
  return process.env.CLI_CONFIRM_MODE?.toLowerCase() === "warn" ? "warn" : "deny";
}

function emitConfirmTelemetry(record: ConfirmTelemetryInput): void {
  const telemetryRecord = {
    event: "unconfirmed_side_effect",
    ts: new Date().toISOString(),
    command: record.command,
    service: record.service,
    sideEffect: record.sideEffect,
    mode: record.mode,
    bypass: record.bypass,
    dryRun: record.dryRun,
    hints: {
      tty: Boolean(process.stdout.isTTY),
      ci: Boolean(process.env.CI || process.env.GITHUB_ACTIONS),
      ppid: process.ppid,
      argv0: process.argv0,
    },
  };
  const line = JSON.stringify(telemetryRecord);
  console.error(`[cli-confirm] ${line}`);

  const logPath = process.env.CLI_CONFIRM_TELEMETRY_LOG;
  if (logPath) {
    try {
      appendFileSync(logPath, `${line}\n`);
    } catch {
      // Best-effort telemetry must never change CLI behavior.
    }
  }
}

function isSafeOutputEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const metadata = record._contentSafety;
  if (typeof metadata !== "object" || metadata === null) {
    return false;
  }
  return (metadata as Record<string, unknown>).version === 1;
}

function operationResultRequiresFailure(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (result.ok === false) {
    return true;
  }
  if (result.success === false) {
    return true;
  }
  if (result.error === true) {
    return true;
  }
  if (result.partialFailure === true) {
    return true;
  }
  if (typeof result.errorCount === "number" && result.errorCount > 0) {
    return true;
  }
  if (result.emptyIsError === true) {
    if (result.count === 0 || result.total === 0) {
      return true;
    }
    for (const key of ["items", "results", "records", "rows"]) {
      const collection = result[key];
      if (Array.isArray(collection) && collection.length === 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Run the CLI with the given commands and client class.
 *
 * @param commands - Map of command names to definitions
 * @param ClientClass - Client class constructor (instantiated for each run)
 * @param options - CLI options
 */
export async function runCli<TClient>(
  commands: CommandMap<TClient>,
  ClientClass: new () => TClient,
  options?: RunCliOptions<TClient>
): Promise<void> {
  const argv = process.argv.slice(2);
  const commandName = extractCommand(argv);
  const rawArgs = parseArgs(argv);
  const globals = extractGlobalFlags(rawArgs);

  // Handle help flag
  if (globals.help || !commandName || commandName === "help") {
    console.log(generateHelp(commands, options));
    process.exit(0);
  }

  // Find command
  const commandDef = commands[commandName];
  if (!commandDef) {
    console.error(JSON.stringify({
      error: true,
      message: `Unknown command: ${commandName}. Run with --help for available commands.`,
    }, null, 2));
    process.exit(1);
  }

  // Reject unrecognised --flags BEFORE validation. Zod's default strip mode
  // silently DROPS an unknown key — a misspelled --tennant-id, or a typo'd
  // safety flag on a write command, would simply vanish and the command run
  // with defaults. A key-diff is the only way to surface it: parseArgs emits
  // ONLY --flag-derived camelCase keys (no positionals, no short flags), so the
  // known set is exactly this command's schema fields plus the global flags.
  if (commandDef.strictFlags !== false) {
    const schemaFieldNames = extractSchemaFields(commandDef.schema).map((field) => field.name);
    // RunCliOptions.globals lets a CLI declare extra global flags; honour those
    // field names too so the check never rejects a documented custom global.
    const customGlobalNames = options?.globals
      ? extractSchemaFields(options.globals).map((field) => field.name)
      : [];
    const knownKeys = new Set<string>([...schemaFieldNames, ...customGlobalNames, ...GLOBAL_FLAG_KEYS]);
    const unknownKeys = Object.keys(rawArgs).filter((key) => !knownKeys.has(key));
    if (unknownKeys.length > 0) {
      const flagList = unknownKeys.map((key) => `--${camelToKebab(key)}`).join(", ");
      console.error(JSON.stringify({
        error: true,
        message: `Unrecognized option(s): ${flagList}. Run with --help for available options.`,
      }, null, 2));
      process.exit(1);
    }
  }

  // internal-ref/internal-ref: warn by default when a side-effecting command runs
  // without `--confirm` / supported `--dry-run`; opt in to hard refusal via
  // CLI_CONFIRM_MODE=deny.
  const sideEffect = commandDef.sideEffect;
  const service =
    options?.programName ??
    (process.argv[1] ? basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, "") : "unknown");
  const needsConfirmation =
    commandDef.requiresConfirmation ?? defaultRequiresConfirmation(sideEffect);
  if (needsConfirmation) {
    const confirmed = rawArgs.confirm === true || rawArgs.confirm === "true";
    const dryRun = rawArgs.dryRun === true || rawArgs.dryRun === "true";
    // internal-ref: --dry-run only satisfies the gate when the command ACTUALLY
    // supports a no-op preview. Otherwise --dry-run must not silence the
    // warning (a non-dry-run-capable command would still perform its side
    // effect) — only --confirm acknowledges it. Fail-closed.
    const dryRunSatisfies = dryRun && commandDef.dryRunSupported === true;
    if (!confirmed && !dryRunSatisfies) {
      const mode = resolveConfirmMode();
      const bypass = process.env.ALLOW_UNCONFIRMED_DESTRUCTIVE === "1";
      emitConfirmTelemetry({
        command: commandName,
        service,
        sideEffect,
        mode,
        bypass,
        dryRun,
      });
      if (mode === "deny" && !bypass) {
        console.error(JSON.stringify({
          error: true,
          message:
            `command "${commandName}" is sideEffect="${sideEffect}" and was invoked without --confirm` +
            `${commandDef.dryRunSupported ? " or --dry-run" : ""}. Refused (CLI_CONFIRM_MODE=deny). ` +
            `Pass --confirm to proceed${commandDef.dryRunSupported ? ", or --dry-run to preview" : ""}.`,
        }, null, 2));
        process.exit(1);
      }
      const hint = dryRun
        ? `--dry-run is not supported by this command (it would still act) — pass --confirm to acknowledge.`
        : `pass --confirm to acknowledge, or --dry-run to preview.`;
      console.error(
        `[cli-utils] WARN: command "${commandName}" is declared sideEffect="${sideEffect}" ` +
        `but was invoked without --confirm${commandDef.dryRunSupported === true ? " or --dry-run" : ""}. ` +
        `Future versions will refuse this — ${hint}` +
        (bypass && mode === "deny" ? " (ALLOW_UNCONFIRMED_DESTRUCTIVE override)" : ""),
      );
    }
  }

  // Validate arguments with Zod BEFORE instantiating client
  // (so users get validation errors without needing valid config)
  const parseResult = commandDef.schema.safeParse(rawArgs);
  if (!parseResult.success) {
    console.error(JSON.stringify({
      error: true,
      message: formatZodError(parseResult.error),
    }, null, 2));
    process.exit(1);
  }

  let client: TClient | undefined;
  let exitCode = 0;

  try {
    // Static metadata commands (for example list-tools) must remain usable on
    // a fresh installation before credentials have been rendered.
    if (!commandDef.clientless) {
      client = new ClientClass();
    }

    // Apply global flags
    if (
      client &&
      globals.noCache &&
      typeof (client as Record<string, unknown>).disableCache === "function"
    ) {
      (client as Record<string, () => void>).disableCache();
    }

    // Execute command
    const result = await commandDef.handler(parseResult.data, client as TClient, globals);
    if (commandDef.requiresSafeOutput && !isSafeOutputEnvelope(result)) {
      throw new Error(
        `command "${commandName}" is declared requiresSafeOutput=true but returned a plain result`,
      );
    }
    if (commandDef.operationResultExit && operationResultRequiresFailure(result)) {
      exitCode = 1;
    }

    // Output result as JSON
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      error: true,
      message: error instanceof Error ? error.message : String(error),
    }, null, 2));
    exitCode = 1;
  } finally {
    // Await cleanup so MCP transports / child processes are released. The old
    // code called process.exit() inside the try/catch, which terminated the
    // process before this finally ran — orphaning transports across every
    // service CLI. Bound it with a watchdog: a stalled disconnect() must not
    // hang the CLI. A cleanup failure is logged but never fatal — a successful
    // command stays exit 0.
    const cleanupTimeoutMs = options?.cleanupTimeoutMs ?? 5000;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const watchdogExpired = new Promise<void>((resolve) => {
      watchdog = setTimeout(resolve, cleanupTimeoutMs);
    });
    // The .catch() is attached to the cleanup promise itself, so a rejection —
    // whether before or after the watchdog wins the race — is always handled
    // (never an UnhandledPromiseRejection) and never reaches Promise.race as a
    // throw. cleanupDone therefore only ever resolves.
    const cleanupDone = (async (): Promise<void> => {
      if (client && options?.cleanup) {
        await options.cleanup(client);
      } else if (client && typeof (client as Record<string, unknown>).disconnect === "function") {
        await (client as Record<string, () => Promise<void>>).disconnect();
      }
    })().catch((cleanupError: unknown) => {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.error(`[cli-utils] cleanup failed (ignored): ${message}`);
    });
    await Promise.race([cleanupDone, watchdogExpired]);
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
    }
  }

  // A single exit AFTER cleanup has run (or timed out) — never inside the
  // try/catch, where process.exit() would pre-empt the finally block.
  process.exit(exitCode);
}

/**
 * Zod helpers for common CLI patterns.
 */
export const cliTypes = {
  /**
   * Strict integer parsing (avoids JS coercion edge cases).
   * Rejects empty strings, scientific notation, etc.
   */
  int: (min?: number, max?: number): CliNumberSchema => {
    // Build inner schema with optional min/max
    let inner = z.number().int();
    if (min !== undefined) inner = inner.min(min);
    if (max !== undefined) inner = inner.max(max);

    return z.preprocess(
      (val) => {
        if (val === "" || val === undefined || val === null) return undefined;
        if (typeof val === "boolean") return NaN;
        const num = Number(val);
        if (!Number.isInteger(num)) return NaN;
        return num;
      },
      inner
    ) as CliNumberSchema;
  },

  /**
   * Float parsing with optional min/max.
   */
  float: (min?: number, max?: number): CliNumberSchema => {
    // Build inner schema with optional min/max
    let inner = z.number();
    if (min !== undefined) inner = inner.min(min);
    if (max !== undefined) inner = inner.max(max);

    return z.preprocess(
      (val) => {
        if (val === "" || val === undefined || val === null) return undefined;
        if (typeof val === "boolean") return NaN;
        return Number(val);
      },
      inner
    ) as CliNumberSchema;
  },

  /**
   * Boolean that handles "true"/"false" strings.
   */
  bool: (): CliBooleanSchema =>
    z.preprocess(
      (val) => {
        if (val === true || val === "true") return true;
        if (val === false || val === "false") return false;
        return undefined;
      },
      z.boolean()
    ) as CliBooleanSchema,

  /**
   * Date string (ISO 8601 format).
   */
  date: () => z.string().datetime({ offset: true }).or(z.string().date()),

  /**
   * Pagination limit with sensible defaults.
   */
  limit: (defaultVal = 50, max = 250): CliNumberSchema =>
    z.preprocess(
      (val) => {
        if (val === "" || val === undefined || val === null) return undefined;
        if (typeof val === "boolean") return NaN;
        return Number(val);
      },
      z.number().int().min(1).max(max).default(defaultVal)
    ) as CliNumberSchema,
};
