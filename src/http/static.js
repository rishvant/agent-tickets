/**
 * Static file serving for the bundled UI.
 *
 * Only files inside public/ are reachable; `..` traversal is rejected before the
 * filesystem is touched. No directory listings, no caching (this is a dev tool,
 * and stale HTML after a rebuild is worse than a few extra bytes).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

export function contentTypeFor(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Serves pathname from publicDir. Returns true when a response was written.
 */
export function serveStatic(publicDir, pathname, res) {
  const root = resolve(publicDir);

  let relative;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return false;
  }
  if (relative.length === 0 || relative.includes('\0')) return false;

  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) return false;
  if (!existsSync(target)) return false;

  let stats;
  try {
    stats = statSync(target);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;

  const payload = readFileSync(target);
  res.statusCode = 200;
  res.setHeader('content-type', contentTypeFor(target));
  res.setHeader('content-length', payload.length);
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
  return true;
}
