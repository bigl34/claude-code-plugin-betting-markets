/**
 * Plugin Cache Type Definitions
 * Shared cache library for Claude Code plugins
 */

/** Stored cache entry with metadata */
export interface CacheEntry<T = unknown> {
  /** The cached data */
  data: T;
  /** When the entry was created (ISO timestamp) */
  createdAt: string;
  /** When the entry was last accessed (ISO timestamp) */
  lastAccessedAt: string;
  /** When the entry expires (ISO timestamp) */
  expiresAt: string;
  /** ETag for conditional requests (if available) */
  etag?: string;
  /** Last-Modified header value (if available) */
  lastModified?: string;
  /** Custom version for manual cache busting */
  version?: string;
  /** Size in bytes */
  size: number;
}

/** Manifest entry for tracking across the global cache */
export interface ManifestEntry {
  /** Full path to the cache file */
  filePath: string;
  /** Plugin namespace */
  namespace: string;
  /** Cache key within namespace */
  key: string;
  /** Size in bytes */
  size: number;
  /** Last accessed timestamp (ISO) */
  lastAccessedAt: string;
  /** Expiration timestamp (ISO) */
  expiresAt: string;
}

/** Global cache manifest */
export interface CacheManifest {
  /** Schema version for future migrations */
  version: number;
  /** Total size in bytes across all plugins */
  totalSize: number;
  /** Maximum allowed size in bytes */
  maxSize: number;
  /** All cache entries indexed by file path */
  entries: Record<string, ManifestEntry>;
  /** Last cleanup timestamp */
  lastCleanup?: string;
}

/** Configuration for PluginCache instance */
export interface CacheConfig {
  /** Plugin namespace (e.g., "shopify-order-manager") */
  namespace: string;
  /** Default TTL in milliseconds (default: 5 minutes) */
  defaultTTL?: number;
  /** Default stale-while-revalidate period in ms (default: 24 hours) */
  defaultStaleWhileRevalidate?: number;
  /** Maximum size per entry in bytes (default: 10MB) */
  maxEntrySize?: number;
  /** Custom cache directory (default: ~/.cache/plugin-cache) */
  cacheDir?: string;
  /** Whether cache is disabled (all ops become no-ops) */
  disabled?: boolean;
}

/** Options for cache.get() */
export interface GetOptions {
  /** TTL override for this entry */
  ttl?: number;
  /** Stale-while-revalidate period override */
  staleWhileRevalidate?: number;
}

/** Options for cache.set() */
export interface SetOptions {
  /** TTL in milliseconds */
  ttl?: number;
  /** ETag for conditional requests */
  etag?: string;
  /** Last-Modified value */
  lastModified?: string;
  /** Custom version string */
  version?: string;
}

/** Options for cache.getOrFetch() */
export interface GetOrFetchOptions extends SetOptions {
  /** Bypass cache and fetch fresh (still updates cache) */
  bypassCache?: boolean;
  /** Stale-while-revalidate period */
  staleWhileRevalidate?: number;
}

/** Result from cache.get() */
export interface CacheResult<T> {
  /** The cached data (null if not found) */
  data: T | null;
  /** Whether the entry was found */
  hit: boolean;
  /** Whether the data is stale (past TTL but within SWR window) */
  stale: boolean;
  /** Whether revalidation is needed */
  needsRevalidation: boolean;
  /** Cache entry metadata */
  entry?: CacheEntry<T>;
}

/** Validator info for conditional requests */
export interface CacheValidator {
  etag?: string;
  lastModified?: string;
}

/** Cache statistics */
export interface CacheStats {
  /** Plugin namespace */
  namespace: string;
  /** Number of entries */
  entryCount: number;
  /** Total size in bytes */
  totalSize: number;
  /** Oldest entry timestamp */
  oldestEntry?: string;
  /** Newest entry timestamp */
  newestEntry?: string;
  /** Number of expired entries */
  expiredCount: number;
  /** Number of stale entries (past TTL but within SWR) */
  staleCount: number;
}

/** Global cache statistics */
export interface GlobalCacheStats {
  /** Total entries across all plugins */
  totalEntries: number;
  /** Total size in bytes */
  totalSize: number;
  /** Maximum size in bytes */
  maxSize: number;
  /** Percentage used */
  usagePercent: number;
  /** Per-plugin breakdown */
  byNamespace: Record<string, CacheStats>;
  /** Last cleanup timestamp */
  lastCleanup?: string;
}

/** Cleanup result */
export interface CleanupResult {
  /** Number of entries removed */
  entriesRemoved: number;
  /** Bytes freed */
  bytesFreed: number;
  /** New total size */
  newTotalSize: number;
}
