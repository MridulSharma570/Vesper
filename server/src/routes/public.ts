/**
 * Public, unauthenticated surface of Vesper.
 *
 * Two responsibilities live here:
 *
 *  1. Discovery files for search engines and link previews. robots.txt and
 *     og-image.png are static assets in client/public (they never change per
 *     deployment); the sitemap is generated per request because its absolute
 *     URLs must match whatever host served it (preview, staging, production).
 *
 *  2. The public abuse-report form. Someone who never installed the app — a
 *     visitor reading a shared link, a store reviewer — still needs an abuse
 *     path. It is the one write endpoint that does not require a session, so
 *     it is defended three ways: a strict rate limit, a honeypot field a human
 *     never fills, and a length-capped schema.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, rateLimitConfig } from '../middleware/index.js';
import { NODE_ENV } from '../config.js';
import { keyedHash } from '../security/crypto.js';
import { newId } from '../lib/ids.js';
import { createPublicReport } from '../adapters/moderation/index.js';

/** Every route a human (or crawler) can land on without signing in. */
export const PUBLIC_PAGES = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/faq', changefreq: 'monthly', priority: '0.8' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.6' },
  { path: '/terms', changefreq: 'yearly', priority: '0.6' },
  { path: '/terms-of-use', changefreq: 'yearly', priority: '0.6' },
  { path: '/cookies', changefreq: 'yearly', priority: '0.5' },
  { path: '/encryption', changefreq: 'yearly', priority: '0.6' },
  { path: '/license', changefreq: 'yearly', priority: '0.4' },
  { path: '/report', changefreq: 'yearly', priority: '0.5' },
] as const;

export function publicRoutes(app: FastifyInstance): void {
  /* Generated per request like the sitemap: the Sitemap line must point at the
   * host that actually served the file, whatever deployment that is. */
  app.get('/robots.txt', async (req, reply) => {
    // Behind a TLS-terminating proxy the forwarded proto wins; elsewhere a
    // production deployment is https by policy, and development reports what
    // the socket actually speaks so local crawls see truthful URLs.
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
      ?? (NODE_ENV === 'production' ? 'https' : req.protocol);
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost';
    const body = [
      '# Vesper — anonymous, by design.',
      '# The public marketing and policy pages are open to crawlers. Everything',
      '# behind authentication (accounts, conversations, media) is not part of',
      '# the web surface and never will be.',
      'User-agent: *',
      'Allow: /',
      'Disallow: /auth/',
      'Disallow: /users/',
      'Disallow: /conversations/',
      'Disallow: /messages/',
      'Disallow: /media/',
      'Disallow: /calls/',
      'Disallow: /settings',
      'Disallow: /admin',
      '',
      `Sitemap: ${proto}://${host}/sitemap.xml`,
      '',
    ].join('\n');
    void reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .send(body);
  });

  app.get('/sitemap.xml', async (req, reply) => {
    // Behind a TLS-terminating proxy the forwarded proto wins; elsewhere a
    // production deployment is https by policy, and development reports what
    // the socket actually speaks so local crawls see truthful URLs.
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
      ?? (NODE_ENV === 'production' ? 'https' : req.protocol);
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost';
    const origin = `${proto}://${host}`;
    const today = new Date().toISOString().slice(0, 10);
    const urls = PUBLIC_PAGES.map(
      (p) =>
        `  <url>\n    <loc>${origin}${p.path}</loc>\n    <lastmod>${today}</lastmod>\n` +
        `    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`,
    ).join('\n');
    void reply
      .header('Content-Type', 'application/xml; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  app.post('/public/reports', { config: { rateLimit: rateLimitConfig('auth') } }, async (req, reply) => {
    const body = z.object({
      reason: z.enum(['spam', 'harassment', 'impersonation', 'illegal_content', 'csae', 'self_harm', 'malware', 'scam', 'other']),
      details: z.string().min(10).max(1000),
      contact: z.string().max(254).optional(),
      // Honeypot: hidden from humans by CSS, irresistible to bots. A filled
      // field means automation — answer as if everything worked, store
      // nothing, waste nothing. The schema must ACCEPT the value or the 400
      // tells the bot it was caught, which is how bots learn to dodge traps.
      website: z.string().max(2000).optional(),
    }).strict().parse(await req.body);

    if (body.website) {
      return reply.status(201).send({ reportId: newId(), message: 'Thanks — a moderator will review this shortly.' });
    }

    const id = createPublicReport({
      reason: body.reason,
      details: body.details,
      contact: body.contact ?? null,
      ipHash: keyedHash(clientIp(req), 'client-ip'),
    });
    return reply.status(201).send({
      reportId: id,
      message: 'Thanks — a moderator will review this shortly.',
    });
  });
}
