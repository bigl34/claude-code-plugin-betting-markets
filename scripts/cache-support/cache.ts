/**
 * PluginCache - Core cache implementation
 * File-based persistent cache for Claude Code plugins
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";
import {
  CacheConfig,
  CacheEntry,
  CacheManifest,
  CacheResult,
  CacheStats,
  CacheValidator,
  GetOptions,
  GetOrFetchOptions,
  SetOptions,
} from "./types.js";
import { cleanupIfNeeded } from "./cleanup.js";
import {
  isPathInsideRoot,
  resolveCachePath,
  resolveCacheRoot,
  validateCacheNamespace,
} from "./namespace.js";

const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "plugin-cache");
const DEFAULT_MAX_SIZE = 500 * 1024 * 1024; // 500MB
const DEFAULT_MAX_ENTRY_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_TTL = 300_000; // 5 minutes
const DEFAULT_STALE_WHILE_REVALIDATE = 86_400_000; // 24 hours
const MANIFEST_VERSION = 2;

export class PluginCache {
  private namespace: string;
  private cacheDir: string;
  private namespaceDir: string;
  private manifestPath: string;
  private defaultTTL: number;
  private defaultSWR: number;
  private maxEntrySize: number;
  private disabled: boolean;

  constructor(config: CacheConfig) {
    this.namespace = validateCacheNamespace(config.namespace);
    this.cacheDir = resolveCacheRoot(config.cacheDir || DEFAULT_CACHE_DIR);
    this.namespaceDir = resolveCachePath(this.cacheDir, this.namespace);
    this.manifestPath = resolveCachePath(this.cacheDir, "manifest.json");
    this.defaultTTL = config.defaultTTL ?? DEFAULT_TTL;
    this.defaultSWR = config.defaultStaleWhileRevalidate ?? DEFAULT_STALE_WHILE_REVALIDATE;
    this.maxEntrySize = config.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE;
    this.disabled = config.disabled ?? false;

    // Ensure directories exist
    if (!this.disabled) {
      this.ensureDirectories();
      this.migrateManifestIfNeeded();
    }
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
    if (!fs.existsSync(this.namespaceDir)) {
      fs.mkdirSync(this.namespaceDir, { recursive: true });
    }
  }

  private emptyManifest(maxSize = DEFAULT_MAX_SIZE): CacheManifest {
    return {
      version: MANIFEST_VERSION,
      totalSize: 0,
      maxSize,
      entries: {},
    };
  }

  private isInsideCacheDir(filePath: string): boolean {
    const resolvedFilePath = resolveCacheRoot(filePath);
    return resolvedFilePath !== this.cacheDir
      && isPathInsideRoot(this.cacheDir, resolvedFilePath);
  }

  private migrateManifestIfNeeded(): void {
    if (!fs.existsSync(this.manifestPath)) return;

    let manifest: CacheManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(this.manifestPath, "utf-8")) as CacheManifest;
    } catch {
      this.saveManifest(this.emptyManifest());
      return;
    }

    if (manifest.version === MANIFEST_VERSION) return;

    for (const entry of Object.values(manifest.entries ?? {})) {
      if (entry.filePath && this.isInsideCacheDir(entry.filePath) && fs.existsSync(entry.filePath)) {
        try {
          fs.unlinkSync(entry.filePath);
        } catch {
          // Best-effort cache flush; manifest reset below detaches any leftovers.
        }
      }
    }

    this.saveManifest(this.emptyManifest(manifest.maxSize || DEFAULT_MAX_SIZE));
  }

  private getManifest(): CacheManifest {
    if (!fs.existsSync(this.manifestPath)) {
      return this.emptyManifest();
    }
    try {
      const content = fs.readFileSync(this.manifestPath, "utf-8");
      const manifest = JSON.parse(content) as CacheManifest;
      if (manifest.version !== MANIFEST_VERSION) {
        return this.emptyManifest(manifest.maxSize || DEFAULT_MAX_SIZE);
      }
      return manifest;
    } catch {
      return this.emptyManifest();
    }
  }

  private saveManifest(manifest: CacheManifest): void {
    // Atomic write: write to temp file, then rename
    // This prevents manifest corruption if process crashes mid-write
    const tempPath = `${this.manifestPath}.tmp.${process.pid}`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2));
      fs.renameSync(tempPath, this.manifestPath);
    } catch (error) {
      // Clean up temp file on error
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  private getFilePath(key: string): string {
    const digest = createHash("sha256")
      .update(`${this.namespace}\0${key}`)
      .digest("base64url");
    return resolveCachePath(this.namespaceDir, `${digest}.json`);
  }

  /**
   * Disable cache (all operations become no-ops)
   */
  disable(): void {
    this.disabled = true;
  }

  /**
   * Enable cache
   */
  enable(): void {
    this.disabled = false;
    this.ensureDirectories();
    this.migrateManifestIfNeeded();
  }

  /**
   * Check if cache is disabled
   */
  isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * Get an entry from the cache
   */
  get<T>(key: string, options?: GetOptions): CacheResult<T> {
    if (this.disabled) {
      return { data: null, hit: false, stale: false, needsRevalidation: true };
    }

    const filePath = this.getFilePath(key);
    if (!fs.existsSync(filePath)) {
      return { data: null, hit: false, stale: false, needsRevalidation: true };
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const entry = JSON.parse(content) as CacheEntry<T>;
      const now = new Date();
      const ttl = options?.ttl ?? this.defaultTTL;
      const expiresAt = options?.ttl === undefined
        ? new Date(entry.expiresAt)
        : new Date(new Date(entry.createdAt).getTime() + ttl);
      const swr = options?.staleWhileRevalidate ?? this.defaultSWR;

      // Update last accessed time
      entry.lastAccessedAt = now.toISOString();
      fs.writeFileSync(filePath, JSON.stringify(entry));

      // Update manifest
      const manifest = this.getManifest();
      const manifestKey = filePath;
      if (manifest.entries[manifestKey]) {
        manifest.entries[manifestKey].lastAccessedAt = entry.lastAccessedAt;
        this.saveManifest(manifest);
      }

      // Check expiration
      const isExpired = now > expiresAt;
      const swrExpiresAt = new Date(expiresAt.getTime() + swr);
      const isWithinSWR = now <= swrExpiresAt;

      if (isExpired && !isWithinSWR) {
        // Completely expired, remove entry
        this.invalidate(key);
        return { data: null, hit: false, stale: false, needsRevalidation: true };
      }

      return {
        data: entry.data,
        hit: true,
        stale: isExpired,
        needsRevalidation: isExpired,
        entry,
      };
    } catch {
      return { data: null, hit: false, stale: false, needsRevalidation: true };
    }
  }

  /**
   * Set an entry in the cache
   */
  async set<T>(key: string, data: T, options?: SetOptions): Promise<void> {
    if (this.disabled) return;

    const serialized = JSON.stringify(data);
    const size = Buffer.byteLength(serialized, "utf-8");

    if (size > this.maxEntrySize) {
      console.warn(
        `[cache] Entry "${key}" exceeds max size (${size} > ${this.maxEntrySize}), skipping`
      );
      return;
    }

    const ttl = options?.ttl ?? this.defaultTTL;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl);

    const entry: CacheEntry<T> = {
      data,
      createdAt: now.toISOString(),
      lastAccessedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      size,
      ...(options?.etag && { etag: options.etag }),
      ...(options?.lastModified && { lastModified: options.lastModified }),
      ...(options?.version && { version: options.version }),
    };

    const filePath = this.getFilePath(key);

    // Update manifest first
    const manifest = this.getManifest();
    const oldEntry = manifest.entries[filePath];
    const oldSize = oldEntry?.size ?? 0;

    manifest.entries[filePath] = {
      filePath,
      namespace: this.namespace,
      key,
      size,
      lastAccessedAt: entry.lastAccessedAt,
      expiresAt: entry.expiresAt,
    };
    manifest.totalSize = manifest.totalSize - oldSize + size;
    this.saveManifest(manifest);

    // Write cache file
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));

    // Run cleanup if needed
    await cleanupIfNeeded(this.cacheDir);
  }

  /**
   * Get from cache or fetch fresh data
   */
  async getOrFetch<T>(
    key: string,
    fetcher: () => Promise<T>,
    options?: GetOrFetchOptions
  ): Promise<T> {
    if (this.disabled || options?.bypassCache) {
      const data = await fetcher();
      if (!this.disabled) {
        await this.set(key, data, options);
      }
      return data;
    }

    const cached = this.get<T>(key, {
      ttl: options?.ttl,
      staleWhileRevalidate: options?.staleWhileRevalidate,
    });

    if (cached.hit && !cached.stale) {
      return cached.data!;
    }

    if (cached.hit && cached.stale) {
      // Return stale data but trigger background refresh
      // In synchronous context, we just fetch and update
      const freshData = await fetcher();
      await this.set(key, freshData, options);
      return freshData;
    }

    // Cache miss - fetch fresh
    const data = await fetcher();
    await this.set(key, data, options);
    return data;
  }

  /**
   * Invalidate (delete) a specific cache entry
   */
  invalidate(key: string): boolean {
    if (this.disabled) return false;

    const filePath = this.getFilePath(key);
    if (!fs.existsSync(filePath)) return false;

    try {
      // Get size before deleting
      const content = fs.readFileSync(filePath, "utf-8");
      const entry = JSON.parse(content) as CacheEntry;

      // Delete file
      fs.unlinkSync(filePath);

      // Update manifest
      const manifest = this.getManifest();
      if (manifest.entries[filePath]) {
        manifest.totalSize -= entry.size;
        delete manifest.entries[filePath];
        this.saveManifest(manifest);
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Invalidate multiple entries matching a pattern.
   *
   * String patterns are literal key fragments. Pass a RegExp when regular
   * expression semantics are explicitly required.
   */
  invalidatePattern(pattern: string | RegExp): number {
    if (this.disabled) return 0;

    const manifest = this.getManifest();
    const matches = typeof pattern === "string"
      ? (key: string) => key.includes(pattern)
      : (key: string) => {
          pattern.lastIndex = 0;
          return pattern.test(key);
        };
    let count = 0;

    for (const entry of Object.values(manifest.entries)) {
      if (entry.namespace === this.namespace && matches(entry.key)) {
        if (this.invalidate(entry.key)) {
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Clear all entries in this namespace
   */
  clear(): number {
    if (this.disabled) return 0;

    const manifest = this.getManifest();
    let count = 0;
    let freedSize = 0;

    for (const [filePath, entry] of Object.entries(manifest.entries)) {
      if (entry.namespace === this.namespace) {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          freedSize += entry.size;
          delete manifest.entries[filePath];
          count++;
        } catch {
          // Ignore errors
        }
      }
    }

    manifest.totalSize -= freedSize;
    this.saveManifest(manifest);

    return count;
  }

  /**
   * Get validator info for conditional requests
   */
  getValidator(key: string): CacheValidator | null {
    if (this.disabled) return null;

    const filePath = this.getFilePath(key);
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const entry = JSON.parse(content) as CacheEntry;
      if (!entry.etag && !entry.lastModified) return null;
      return {
        ...(entry.etag && { etag: entry.etag }),
        ...(entry.lastModified && { lastModified: entry.lastModified }),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get cache statistics for this namespace
   */
  getStats(): CacheStats {
    if (this.disabled) {
      return {
        namespace: this.namespace,
        entryCount: 0,
        totalSize: 0,
        expiredCount: 0,
        staleCount: 0,
      };
    }

    const manifest = this.getManifest();
    const now = new Date();
    let entryCount = 0;
    let totalSize = 0;
    let expiredCount = 0;
    let staleCount = 0;
    let oldestEntry: string | undefined;
    let newestEntry: string | undefined;

    for (const entry of Object.values(manifest.entries)) {
      if (entry.namespace !== this.namespace) continue;

      entryCount++;
      totalSize += entry.size;

      const expiresAt = new Date(entry.expiresAt);
      const swrExpiresAt = new Date(expiresAt.getTime() + this.defaultSWR);

      if (now > swrExpiresAt) {
        expiredCount++;
      } else if (now > expiresAt) {
        staleCount++;
      }

      if (!oldestEntry || entry.lastAccessedAt < oldestEntry) {
        oldestEntry = entry.lastAccessedAt;
      }
      if (!newestEntry || entry.lastAccessedAt > newestEntry) {
        newestEntry = entry.lastAccessedAt;
      }
    }

    return {
      namespace: this.namespace,
      entryCount,
      totalSize,
      expiredCount,
      staleCount,
      oldestEntry,
      newestEntry,
    };
  }

  /**
   * List all keys in this namespace
   */
  keys(): string[] {
    if (this.disabled) return [];

    const manifest = this.getManifest();
    return Object.values(manifest.entries)
      .filter((e) => e.namespace === this.namespace)
      .map((e) => e.key);
  }

  /**
   * Check if a key exists in cache (regardless of expiration)
   */
  has(key: string): boolean {
    if (this.disabled) return false;
    return fs.existsSync(this.getFilePath(key));
  }
}
