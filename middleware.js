// Vercel Edge Middleware — runs BEFORE the filesystem, so it can map a
// subdomain to a specific page (plain vercel.json rewrites run AFTER the
// filesystem, so `/` always resolved to index.html).
//
//   app.orlixai.xyz/*  → /app.html      (path-based views: /overview, /playground, …)
//   docs.orlixai.xyz/  → /docs.html
//   b20.orlixai.xyz/   → /b20-studio.html
//
// The matcher excludes /api, /assets, and any path with a file extension so
// real assets and functions are served untouched.
import { rewrite, next } from '@vercel/edge';

export const config = { matcher: '/((?!api|assets|.*\\.).*)' };

const ROOT = {
  'docs.orlixai.xyz': '/docs.html',
  'b20.orlixai.xyz':  '/b20-studio.html',
};

export default function middleware(request) {
  const host = (request.headers.get('host') || '').toLowerCase();
  const path = new URL(request.url).pathname;

  // App: every (non-asset) path serves the SPA, which routes client-side.
  if (host === 'app.orlixai.xyz') return rewrite(new URL('/app.html', request.url));

  // Docs / B20: single page, only the root.
  const dest = ROOT[host];
  if (dest && path === '/') return rewrite(new URL(dest, request.url));

  return next();
}
