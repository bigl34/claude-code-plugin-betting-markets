/**
 * Retry Utilities - Shared retry logic with exponential backoff and jitter
 *
 * Provides consistent retry behavior across all indexer components:
 * - Qdrant client (vector storage)
 * - OpenAI embedder (embedding generation)
 * - Slack/Notion connectors (API calls)
 *
 * Pattern derived from gorgias-connector.ts which has battle-tested retry logic.
 */

/**
 * Configuration for retry behavior
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Initial delay in milliseconds (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds (default: 60000) */
  maxDelayMs: number;
  /** Jitter percentage ±X to avoid thundering herd (default: 0.2 = ±20%) */
  jitterPercent: number;
  /** Error patterns that should trigger a retry */
  retryableErrors: string[];
  /** Timeout for the operation in milliseconds (default: 60000) */
  timeoutMs: number;
  /** Optional per-call retry predicate */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Optional per-call delay override */
  nextDelayMs?: (ctx: { attempt: number; error: unknown; baseDelayMs: number; maxDelayMs: number }) => number;
  /** Operation kind for write-safety retry gating */
  operationKind?: 'read' | 'write';
  /** Optional predicate that identifies write errors before bytes were sent */
  isPreSendError?: (error: unknown) => boolean;
  /** Optional sleep implementation for tests or custom schedulers */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Optional retry-attempt logger */
  logger?: (message: string) => void;
}

/**
 * Result of a retry operation
 */
export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
  totalDelayMs: number;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  jitterPercent: 0.2,
  timeoutMs: 60000,
  retryableErrors: [
    // HTTP status codes
    '429',              // Rate limit
    '500',              // Internal server error
    '502',              // Bad gateway
    '503',              // Service unavailable
    '504',              // Gateway timeout
    // Network errors
    'ECONNRESET',       // Connection reset
    'ECONNREFUSED',     // Connection refused
    'ETIMEDOUT',        // Timeout
    'ENOTFOUND',        // DNS lookup failed
    'EAI_AGAIN',        // DNS lookup timeout
    // Fetch/Node errors
    'fetch failed',     // Generic fetch error
    'AbortError',       // Request aborted
    'socket hang up',   // Socket error
    'network error',    // Generic network error
    'UND_ERR_CONNECT_TIMEOUT',  // Undici timeout
    'UND_ERR_SOCKET',   // Undici socket error
  ],
};

/**
 * Pre-configured retry configs for specific use cases
 */
export const RETRY_CONFIGS = {
  /** For Qdrant vector database operations */
  qdrant: {
    ...DEFAULT_RETRY_CONFIG,
    maxRetries: 3,
    baseDelayMs: 2000,
    maxDelayMs: 30000,
  } as RetryConfig,

  /** For OpenAI API calls (higher delays for rate limits) */
  openai: {
    ...DEFAULT_RETRY_CONFIG,
    maxRetries: 3,
    baseDelayMs: 5000,
    maxDelayMs: 120000,
    retryableErrors: [
      ...DEFAULT_RETRY_CONFIG.retryableErrors,
      'rate_limit',
      'Rate limit',
    ],
  } as RetryConfig,

  /** For Slack API calls */
  slack: {
    ...DEFAULT_RETRY_CONFIG,
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 60000,
    retryableErrors: [
      ...DEFAULT_RETRY_CONFIG.retryableErrors,
      'rate_limited',
      'ratelimited',
    ],
  } as RetryConfig,

  /** For Notion API calls */
  notion: {
    ...DEFAULT_RETRY_CONFIG,
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 60000,
    retryableErrors: [
      ...DEFAULT_RETRY_CONFIG.retryableErrors,
      'conflict_error',  // Database modified during query
    ],
  } as RetryConfig,
};

/**
 * Calculate exponential backoff delay with jitter
 *
 * Formula: min(baseDelayMs * 2^attempt, maxDelayMs) ± jitter
 * Jitter helps prevent thundering herd when multiple processes retry simultaneously
 */
export function calculateBackoff(
  attempt: number,
  config: Pick<RetryConfig, 'baseDelayMs' | 'maxDelayMs' | 'jitterPercent'>
): number {
  // Exponential backoff: base * 2^attempt
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt);

  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);

  // Add jitter (±jitterPercent)
  const jitterRange = cappedDelay * config.jitterPercent;
  const jitter = jitterRange * (Math.random() * 2 - 1);

  return Math.round(cappedDelay + jitter);
}

/**
 * Check if an error should trigger a retry
 */
export function isRetryableError(
  // Error-like values arrive from fetch, SDKs, and user-supplied retry hooks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: Error | any,
  retryablePatterns: string[]
): boolean {
  const errorString = String(error?.message || error?.code || error || '').toLowerCase();
  const errorName = String(error?.name || '').toLowerCase();
  const statusCode = String(error?.status || error?.statusCode || '');

  return retryablePatterns.some(pattern => {
    // Numeric patterns (HTTP status codes) must match the status property exactly,
    // not via substring of the error message (UUIDs can contain digit sequences like '429')
    if (/^\d+$/.test(pattern)) {
      return statusCode === pattern;
    }
    const p = pattern.toLowerCase();
    return (
      errorString.includes(p) ||
      errorName.includes(p)
    );
  });
}

export function isPreSendNetworkError(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null | undefined;
  const code = e?.cause?.code ?? e?.code;
  const ALLOW = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'EAI_NONAME', 'EAI_NODATA']);
  return typeof code === 'string' && ALLOW.has(code);
}

function isWriteRetryable(
  error: unknown,
  operationKind: RetryConfig['operationKind'],
  isPreSendError: RetryConfig['isPreSendError']
): boolean {
  if (operationKind !== 'write') return true;
  // A non-idempotent write may only retry when the request was provably NOT
  // applied server-side:
  //   - a pre-send network error (the request never left the client), or
  //   - HTTP 429 (rate-limited: the server rejected it BEFORE processing, so a
  //     retry cannot duplicate the side effect — and dropping it would break
  //     rate-limited senders like Slack postMessage).
  // A 5xx / timeout MAY have been applied, so retrying risks a DUPLICATE send;
  // those are not retried for writes (internal-ref / F11).
  //
  // CAVEAT: the 429 carve-out assumes 429 == "rejected before processing", which
  // holds for the standard rate-limit case and for every current fetchWithRetry
  // caller (Slack/Klaviyo/etc — none are payment processors; EasyPost/Xero use
  // their own SDKs). A genuinely-irreversible write behind a proxy that could 429
  // AFTER accepting the request must use an idempotency key rather than rely on
  // this.
  if ((isPreSendError ?? isPreSendNetworkError)(error)) return true;
  // Coerce so a string-shaped status ('429') still matches — isRetryableError
  // compares strings, so a write must too or the carve-out silently misses it.
  const rawStatus = (error as { status?: number | string; statusCode?: number | string })?.status
    ?? (error as { statusCode?: number | string })?.statusCode;
  return Number(rawStatus) === 429;
}

/** Upper bound on how long a server's 429 `Retry-After` will be honoured (5 min). */
const RETRY_AFTER_MAX_MS = 300_000;

/** Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) to ms. */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function clampNextDelayMs(delayMs: number | undefined, maxDelayMs: number): number {
  const rawDelayMs = delayMs ?? 0;
  if (!Number.isFinite(rawDelayMs)) return 0;
  return Math.max(0, Math.min(maxDelayMs, rawDelayMs));
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute an operation with retry logic
 *
 * @param operation - Async function to execute
 * @param config - Retry configuration (merged with defaults)
 * @param context - Optional context string for logging
 * @returns Promise with result including success status and attempt count
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => qdrantClient.upsertPoints(points),
 *   RETRY_CONFIGS.qdrant,
 *   'Qdrant.upsertPoints'
 * );
 *
 * if (result.success) {
 *   console.log(`Success after ${result.attempts} attempts`);
 * } else {
 *   console.error(`Failed: ${result.error?.message}`);
 * }
 * ```
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  context?: string
): Promise<RetryResult<T>> {
  const cfg: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };

  let lastError: Error | undefined;
  let attempts = 0;
  let totalDelayMs = 0;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    attempts = attempt + 1;

    try {
      const data = await operation();
      return {
        success: true,
        data,
        attempts,
        totalDelayMs,
      };
    } catch (error: unknown) {
      const err = error as Error & Record<string, unknown>;
      lastError = err;

      // Check if this is a retryable error
      let isRetryable = cfg.shouldRetry ? cfg.shouldRetry(error, attempt) : isRetryableError(error, cfg.retryableErrors);
      isRetryable = isRetryable && isWriteRetryable(error, cfg.operationKind, cfg.isPreSendError);
      const hasRetriesLeft = attempt < cfg.maxRetries;

      if (isRetryable && hasRetriesLeft) {
        const delayMs = cfg.nextDelayMs
          ? clampNextDelayMs(cfg.nextDelayMs({ attempt, error, baseDelayMs: cfg.baseDelayMs, maxDelayMs: cfg.maxDelayMs }), cfg.maxDelayMs)
          : calculateBackoff(attempt, cfg);
        totalDelayMs += delayMs;

        const contextStr = context ? `[${context}] ` : '';
        const formattedMessage =
          `${contextStr}Retryable error (attempt ${attempt + 1}/${cfg.maxRetries + 1}): ` +
          `${err.message || error}. Waiting ${(delayMs / 1000).toFixed(1)}s...`;
        (cfg.logger ?? console.error)(formattedMessage);

        await (cfg.sleepImpl ?? sleep)(delayMs);
      } else {
        // Non-retryable error or out of retries
        break;
      }
    }
  }

  return {
    success: false,
    error: lastError,
    attempts,
    totalDelayMs,
  };
}

/**
 * Execute an operation with retry, throwing on failure
 *
 * Use this when you want simple try/catch semantics but with retries.
 *
 * @example
 * ```typescript
 * try {
 *   const data = await withRetryThrow(
 *     () => api.call(),
 *     { maxRetries: 3 }
 *   );
 * } catch (error) {
 *   console.error('All retries exhausted:', error);
 * }
 * ```
 */
export async function withRetryThrow<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  context?: string
): Promise<T> {
  const result = await withRetry(operation, config, context);

  if (result.success) {
    return result.data as T;
  }

  const contextStr = context ? `[${context}] ` : '';
  const error = new Error(
    `${contextStr}Operation failed after ${result.attempts} attempts: ${result.error?.message}`
  );
  const err = error as Error & Record<string, unknown>;
  err.cause = result.error;
  err.attempts = result.attempts;
  err.totalDelayMs = result.totalDelayMs;

  throw error;
}

/**
 * Create an AbortController with a timeout
 *
 * @example
 * ```typescript
 * const { controller, timeoutId, cleanup } = createTimeoutController(60000);
 * try {
 *   await fetch(url, { signal: controller.signal });
 * } finally {
 *   cleanup();
 * }
 * ```
 */
export function createTimeoutController(timeoutMs: number): {
  controller: AbortController;
  timeoutId: ReturnType<typeof setTimeout>;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return {
    controller,
    timeoutId,
    cleanup: () => clearTimeout(timeoutId),
  };
}

/**
 * Fetch with timeout and automatic retry
 *
 * Combines AbortController timeout with retry logic.
 *
 * @example
 * ```typescript
 * const response = await fetchWithRetry(url, {
 *   method: 'POST',
 *   body: JSON.stringify(data),
 * }, {
 *   timeoutMs: 30000,
 *   maxRetries: 3,
 * });
 * ```
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  config: Partial<RetryConfig> = {},
  context?: string
): Promise<Response> {
  // F11 (internal-ref): derive the operation kind from the HTTP method. A
  // non-idempotent write (POST/PUT/PATCH/DELETE) is NOT retried on a 5xx /
  // timeout — those may have been applied server-side, so a retry could
  // DUPLICATE the send (duplicate orders / payments / messages). GET/HEAD are
  // reads and retry fully. A 429 (rate-limit) still retries for writes (see
  // isWriteRetryable), honouring `Retry-After`.
  //
  // Callers whose POST is an IDEMPOTENT READ — a GraphQL query, an
  // ElasticSearch/Qdrant `_search`, a Notion `/search` or `/databases/{id}/query`
  // — MUST pass `operationKind: 'read'` to opt back into full 5xx retry.
  const method = (options.method ?? 'GET').toUpperCase();
  const isSafeMethod = method === 'GET' || method === 'HEAD';
  const cfg: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
    operationKind: config.operationKind ?? (isSafeMethod ? 'read' : 'write'),
  };
  // Honour a 429 `Retry-After` over the computed backoff (unless the caller
  // already supplied its own nextDelayMs hook). A server's explicit Retry-After
  // must be able to EXCEED the normal backoff ceiling (`maxDelayMs`, default 60s)
  // — otherwise a `Retry-After: 120` is truncated to 60s and the client retries
  // while still rate-limited (consensus). So raise the OUTER clamp ceiling to
  // RETRY_AFTER_MAX_MS, but keep normal exponential backoff bounded by the
  // caller's ORIGINAL maxDelayMs.
  if (!config.nextDelayMs) {
    const backoffMaxDelayMs = cfg.maxDelayMs;
    cfg.maxDelayMs = Math.max(cfg.maxDelayMs, RETRY_AFTER_MAX_MS);
    cfg.nextDelayMs = ({ attempt, error }) => {
      const retryAfterMs = (error as { retryAfterMs?: number } | null | undefined)?.retryAfterMs;
      if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) {
        return Math.min(retryAfterMs, RETRY_AFTER_MAX_MS);
      }
      return calculateBackoff(attempt, { ...cfg, maxDelayMs: backoffMaxDelayMs });
    };
  }

  return withRetryThrow(
    async () => {
      const { controller, cleanup } = createTimeoutController(cfg.timeoutMs);

      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        // Treat certain HTTP statuses as errors for retry
        if (!response.ok) {
          const statusStr = String(response.status);
          if (cfg.retryableErrors.includes(statusStr)) {
            const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
            const err = error as Error & Record<string, unknown>;
            err.status = response.status;
            if (response.status === 429) {
              const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
              if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
            }
            throw error;
          }
        }

        return response;
      } finally {
        cleanup();
      }
    },
    cfg,
    context
  );
}
