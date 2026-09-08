#!/usr/bin/env node
/**
 * Static file server for the SpellLang demo.
 *
 * Same job as `python3 -m http.server`, but sends `Cache-Control: no-store`
 * so the browser always picks up a rebuilt dist/ on a plain refresh
 * (python's http.server sends no cache headers, so Chrome heuristic-caches
 * the ES modules and stale code survives F5).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8177);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    if (path.split(sep).includes('..')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(join(ROOT, path)); // ENOENT → 404 below
    res.writeHead(200, {
      'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Serving ${ROOT} on http://127.0.0.1:${PORT} (Ctrl+C to stop)`);
  console.log(`Open: http://127.0.0.1:${PORT}/demo/blocks.html`);
});
