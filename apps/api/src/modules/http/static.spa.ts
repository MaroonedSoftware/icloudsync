import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Context, Middleware } from 'koa';

/** Minimal extension → MIME map for the assets a Vite SPA bundle emits. */
const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
};

/** Send a single file at `abs`, setting content-type, length and a cache header. */
async function sendFile(ctx: Context, abs: string, immutable: boolean): Promise<void> {
    const info = await stat(abs);
    ctx.set('Content-Type', MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream');
    ctx.set('Content-Length', String(info.size));
    // Vite emits content-hashed filenames under /assets — safe to cache forever.
    ctx.set('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    ctx.status = 200;
    ctx.body = ctx.method === 'HEAD' ? null : createReadStream(abs);
}

/** Options for {@link staticSpa}. */
export interface StaticSpaOptions {
    /**
     * Path prefixes to *not* serve or fall back for — they're passed through to
     * the next middleware so unmatched API routes 404 instead of returning the
     * SPA shell. Mounted after the routers, this is how `GET /icloud/bogus`
     * still yields a 404.
     */
    passthroughPrefixes?: string[];
}

/**
 * Serve a built single-page app from `root`, with history-API fallback: any GET
 * that doesn't resolve to a real file returns `index.html` so client-side
 * routing works on deep links / refreshes. Non-GET requests and any path under
 * {@link StaticSpaOptions.passthroughPrefixes} are passed through to the next
 * middleware, so this must be mounted **after** the routers — only unmatched
 * routes reach it.
 *
 * Paths are resolved against `root` and rejected if they escape it, so a crafted
 * `../` cannot read outside the bundle directory.
 */
export function staticSpa(root: string, options: StaticSpaOptions = {}): Middleware {
    const rootDir = path.resolve(root);
    const indexHtml = path.join(rootDir, 'index.html');
    const passthrough = options.passthroughPrefixes ?? [];

    return async (ctx, next) => {
        if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return next();
        if (passthrough.some(prefix => ctx.path === prefix || ctx.path.startsWith(prefix + '/'))) return next();

        const rel = decodeURIComponent(ctx.path).replace(/^\/+/, '');
        const abs = path.resolve(rootDir, rel);
        if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) {
            ctx.status = 403;
            return;
        }

        try {
            const info = await stat(abs).catch(() => undefined);
            if (info?.isFile()) {
                await sendFile(ctx, abs, abs.startsWith(path.join(rootDir, 'assets') + path.sep));
                return;
            }
            // No such file → SPA history fallback.
            await sendFile(ctx, indexHtml, false);
        } catch {
            // index.html missing (no bundle shipped) — let the request 404 normally.
            await next();
        }
    };
}
