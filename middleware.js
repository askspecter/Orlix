// Vercel Edge Middleware — runs BEFORE the filesystem, so it can map a
// subdomain to a specific page (plain vercel.json rewrites run AFTER the
// filesystem, so `/` always resolved to index.html).
//
//   app.orlixai.xyz/*  → /app.html      (path-based views: /overview, /playground, …)
//   docs.orlixai.xyz/* → /docs.html     (path-based pages: /overview, /policies, …)
//   b20.orlixai.xyz/   → /b20-studio.html
//
// The matcher excludes /api, /assets, and any path with a file extension so
// real assets and functions are served untouched.
import { rewrite, next } from '@vercel/edge';

export const config = { matcher: '/((?!api|assets|.*\\.).*)' };

// Hosts whose every (non-asset) path serves one SPA that routes client-side.
const SPA = {
  'app.orlixai.xyz':  '/app.html',
  'docs.orlixai.xyz': '/docs.html',
};
// Single-page hosts: only the root is rewritten.
const ROOT = {
  'b20.orlixai.xyz': '/b20-studio.html',
};

export default function middleware(request) {
  const host = (request.headers.get('host') || '').toLowerCase();
  const path = new URL(request.url).pathname;

  if (SPA[host]) return rewrite(new URL(SPA[host], request.url));

  const dest = ROOT[host];
  if (dest && path === '/') return rewrite(new URL(dest, request.url));

  return next();
}
