import * as path from "path";

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Keep the raw path normalization operation at one audited boundary.
 *
 * Cache roots are intentionally configurable filesystem locations. Derived
 * paths must go through resolveCachePath(), which performs the containment
 * check after normalization.
 */
function resolvePath(...segments: string[]): string {
  return path.resolve(...segments);
}

export function resolveCacheRoot(root: string): string {
  return resolvePath(root);
}

export function validateCacheNamespace(namespace: string): string {
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new Error("Cache namespace must be a non-empty string");
  }
  if (
    namespace === "." ||
    namespace === ".." ||
    namespace.includes("..") ||
    namespace.includes("/") ||
    namespace.includes("\\") ||
    path.isAbsolute(namespace) ||
    /^[a-zA-Z]:/.test(namespace) ||
    !NAMESPACE_PATTERN.test(namespace)
  ) {
    throw new Error(
      `Invalid cache namespace "${namespace}". Use letters, numbers, dot, underscore, or hyphen; path segments are not allowed.`,
    );
  }
  return namespace;
}

export function resolveCachePath(root: string, ...segments: string[]): string {
  const resolvedRoot = resolveCacheRoot(root);
  const resolvedPath = resolvePath(resolvedRoot, ...segments);
  if (!isPathInsideRoot(resolvedRoot, resolvedPath)) {
    throw new Error(`Resolved cache path escapes cache root: ${resolvedPath}`);
  }
  return resolvedPath;
}

export function isPathInsideRoot(root: string, targetPath: string): boolean {
  const resolvedRoot = resolveCacheRoot(root);
  const resolvedTarget = resolvePath(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
