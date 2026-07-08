// Vercel Edge Middleware — runs BEFORE the filesystem, so it can map a
// subdomain's root to a specific page (plain vercel.json rewrites run AFTER
// the filesystem, so `/` always resolved to index.html).
//
//   app.orlixai.xyz  → /app.html
//   docs.orlixai.xyz → /docs.html
//   b20.orlixai.xyz  → /b20-studio.html
import { rewrite, next } from '@vercel/edge';

export const config = { matcher: '/' };

const HOSTS = {
  'app.orlixai.xyz':  '/app.html',
  'docs.orlixai.xyz': '/docs.html',
  'b20.orlixai.xyz':  '/b20-studio.html',
};

export default function middleware(request) {
  const host = (request.headers.get('host') || '').toLowerCase();
  const dest = HOSTS[host];
  if (dest) return rewrite(new URL(dest, request.url));
  return next();
}
