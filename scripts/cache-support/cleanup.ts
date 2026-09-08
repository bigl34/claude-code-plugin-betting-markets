/**
 * Cache Cleanup - LRU eviction logic
 * Automatically cleans up when cache exceeds size limits
 */

import * as fs from "fs";
import { CacheManifest, CleanupResult } from "./types.js";
import { isPathInsideRoot, resolveCachePath, validateCacheNamespace } from "./namespace.js";

const DEFAULT_MAX_SIZE = 500 * 1024 * 1024; // 500MB
const CLEANUP_THRESHOLD = 0.9; // 90% triggers cleanup
const CLEANUP_TARGET = 0.7; // Clean down to 70%

function safeUnlink(cacheDir: string, filePath: string): boolean {
  if (!isPathInsideRoot(cacheDir, filePath)) {
    return false;
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  return true;
}

/**
 * Check if cleanup is needed and perform if necessary
 */
export async function cleanupIfNeeded(cacheDir: string): Promise<CleanupResult | null> {
  const manifestPath = resolveCachePath(cacheDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as CacheManifest;
  const maxSize = manifest.maxSize || DEFAULT_MAX_SIZE;
  const threshold = maxSize * CLEANUP_THRESHOLD;

  if (manifest.totalSize < threshold) {
    return null;
  }

  return performCleanup(cacheDir, manifest);
}

/**
 * Perform LRU cleanup
 */
export function performCleanup(
  cacheDir: string,
  manifest?: CacheManifest
): CleanupResult {
  const manifestPath = resolveCachePath(cacheDir, "manifest.json");

  if (!manifest) {
    if (!fs.existsSync(manifestPath)) {
      return { entriesRemoved: 0, bytesFreed: 0, newTotalSize: 0 };
    }
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as CacheManifest;
  }

  const maxSize = manifest.maxSize || DEFAULT_MAX_SIZE;
  const targetSize = maxSize * CLEANUP_TARGET;

  // Sort entries by last accessed time (oldest first)
  const entries = Object.values(manifest.entries).sort((a, b) => {
    const aTime = new Date(a.lastAccessedAt).getTime();
    const bTime = new Date(b.lastAccessedAt).getTime();
    return aTime - bTime;
  });

  let currentSize = manifest.totalSize;
  let entriesRemoved = 0;
  let bytesFreed = 0;

  for (const entry of entries) {
    if (currentSize <= targetSize) {
      break;
    }

    try {
      if (safeUnlink(cacheDir, entry.filePath)) {
        delete manifest.entries[entry.filePath];
        currentSize -= entry.size;
        bytesFreed += entry.size;
        entriesRemoved++;
      }
    } catch {
      // Ignore individual file deletion errors
    }
  }

  // Update manifest
  manifest.totalSize = currentSize;
  manifest.lastCleanup = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    entriesRemoved,
    bytesFreed,
    newTotalSize: currentSize,
  };
}

/**
 * Remove all expired entries (past SWR window)
 */
export function purgeExpired(
  cacheDir: string,
  defaultSWR: number = 24 * 60 * 60 * 1000
): CleanupResult {
  const manifestPath = resolveCachePath(cacheDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    return { entriesRemoved: 0, bytesFreed: 0, newTotalSize: 0 };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as CacheManifest;
  const now = new Date();
  let entriesRemoved = 0;
  let bytesFreed = 0;

  for (const [filePath, entry] of Object.entries(manifest.entries)) {
    const expiresAt = new Date(entry.expiresAt);
    const swrExpiresAt = new Date(expiresAt.getTime() + defaultSWR);

    if (now > swrExpiresAt) {
      try {
        if (safeUnlink(cacheDir, filePath)) {
          bytesFreed += entry.size;
          delete manifest.entries[filePath];
          entriesRemoved++;
        }
      } catch {
        // Ignore individual errors
      }
    }
  }

  manifest.totalSize -= bytesFreed;
  manifest.lastCleanup = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    entriesRemoved,
    bytesFreed,
    newTotalSize: manifest.totalSize,
  };
}

/**
 * Clear entire cache
 */
export function clearAll(cacheDir: string): CleanupResult {
  const manifestPath = resolveCachePath(cacheDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    return { entriesRemoved: 0, bytesFreed: 0, newTotalSize: 0 };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as CacheManifest;
  let entriesRemoved = 0;
  let bytesFreed = 0;

  for (const [filePath, entry] of Object.entries(manifest.entries)) {
    try {
      if (safeUnlink(cacheDir, filePath)) {
        bytesFreed += entry.size;
        entriesRemoved++;
      }
    } catch {
      // Ignore individual errors
    }
  }

  // Reset manifest
  const newManifest: CacheManifest = {
    version: manifest.version,
    totalSize: 0,
    maxSize: manifest.maxSize,
    entries: {},
    lastCleanup: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2));

  // Try to remove namespace directories
  try {
    const dirs = fs.readdirSync(cacheDir);
    for (const dir of dirs) {
      const dirPath = resolveCachePath(cacheDir, dir);
      if (fs.statSync(dirPath).isDirectory()) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    }
  } catch {
    // Ignore directory cleanup errors
  }

  return {
    entriesRemoved,
    bytesFreed,
    newTotalSize: 0,
  };
}

/**
 * Clear cache for a specific namespace
 */
export function clearNamespace(cacheDir: string, namespace: string): CleanupResult {
  const safeNamespace = validateCacheNamespace(namespace);
  const manifestPath = resolveCachePath(cacheDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    return { entriesRemoved: 0, bytesFreed: 0, newTotalSize: 0 };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as CacheManifest;
  let entriesRemoved = 0;
  let bytesFreed = 0;

  for (const [filePath, entry] of Object.entries(manifest.entries)) {
    if (entry.namespace === safeNamespace) {
      try {
        safeUnlink(cacheDir, filePath);
        bytesFreed += entry.size;
        delete manifest.entries[filePath];
        entriesRemoved++;
      } catch {
        // Ignore individual errors
      }
    }
  }

  manifest.totalSize -= bytesFreed;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Try to remove namespace directory
  const namespaceDir = resolveCachePath(cacheDir, safeNamespace);
  try {
    if (fs.existsSync(namespaceDir)) {
      fs.rmSync(namespaceDir, { recursive: true, force: true });
    }
  } catch {
    // Ignore directory cleanup errors
  }

  return {
    entriesRemoved,
    bytesFreed,
    newTotalSize: manifest.totalSize,
  };
}
