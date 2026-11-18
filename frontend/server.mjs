import { createReadStream, statSync } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { createServer, request as proxyRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? '127.0.0.1';
const backendHost = process.env.BACKEND_HOST ?? '127.0.0.1';
const backendPort = Number(process.env.BACKEND_PORT ?? 3000);
const enableHsts = process.env.ENABLE_HSTS === 'true';
const trustProxyHeaders = process.env.TRUST_PROXY_HEADERS === 'true';
const frameAncestors = process.env.FRAME_ANCESTORS === 'self'
  ? "'self'"
  : process.env.FRAME_ANCESTORS ?? "'self'";

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function isCompressible(filePath) {
  return ['.html', '.js', '.css', '.json', '.svg'].includes(path.extname(filePath));
}

function baseHeaders(extra = {}) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'SAMEORIGIN',
    'cross-origin-resource-policy': 'same-site',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' http: https:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      `frame-ancestors ${frameAncestors}`,
    ].join('; '),
    ...extra,
  };

  if (enableHsts) {
    headers['strict-transport-security'] = 'max-age=15552000; includeSubDomains';
  }

  return headers;
}

function cleanProxyHeaders(headers, host, keepContentLength = false) {
  const next = { ...headers, host };
  delete next.connection;
  if (!keepContentLength) {
    delete next['content-length'];
  }
  delete next['accept-encoding'];
  return next;
}

function appendForwardedFor(current, remoteAddress) {
  const value = Array.isArray(current) ? current[0] : current;
  return [value, remoteAddress].filter(Boolean).join(', ');
}

function forwardedFor(headers, remoteAddress) {
  if (!trustProxyHeaders) {
    return remoteAddress ?? '';
  }
  return appendForwardedFor(headers['x-forwarded-for'], remoteAddress);
}

function isInsideDist(filePath) {
  const relative = path.relative(distDir, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function proxy(req, res, upstreamTarget, options = {}) {
  const hostHeader = options.hostHeader ?? req.headers.host;
  const upstreamReq = proxyRequest(
    {
      hostname: upstreamTarget.host,
      port: upstreamTarget.port,
      path: req.url,
      method: req.method,
      headers: {
        ...cleanProxyHeaders(
        req.headers,
        hostHeader,
        options.keepContentLength,
        ),
        'x-forwarded-for': forwardedFor(req.headers, req.socket.remoteAddress),
        'x-forwarded-host': req.headers.host ?? hostHeader,
        'x-forwarded-proto': req.headers['x-forwarded-proto'] ?? 'http',
      },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, baseHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on('error', () => {
    res.writeHead(502, baseHeaders({ 'content-type': 'application/json; charset=utf-8' }));
    res.end(JSON.stringify({ message: 'Upstream service unavailable' }));
  });

  req.pipe(upstreamReq);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  const requested = path.normalize(path.join(distDir, pathname));
  const safePath = isInsideDist(requested) ? requested : distDir;
  const exists = await fileExists(safePath);

  if (pathname.startsWith('/.') || pathname.includes('/../')) {
    res.writeHead(404, baseHeaders({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    }));
    res.end(JSON.stringify({ message: 'Not found' }));
    return;
  }

  if (!exists && pathname.startsWith('/assets/')) {
    res.writeHead(404, baseHeaders({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    }));
    res.end(JSON.stringify({ message: 'Asset not found. Refresh the page to load the latest version.' }));
    return;
  }

  const filePath = exists ? safePath : path.join(distDir, 'index.html');
  const ext = path.extname(filePath);
  const info = statSync(filePath);
  const headers = baseHeaders({
    'content-type': mimeTypes[ext] ?? 'application/octet-stream',
    'cache-control': pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });

  if (
    req.headers['accept-encoding']?.includes('gzip') &&
    isCompressible(filePath)
  ) {
    res.writeHead(200, {
      ...headers,
      'content-encoding': 'gzip',
      vary: 'Accept-Encoding',
    });
    createReadStream(filePath).pipe(createGzip()).pipe(res);
    return;
  }

  res.writeHead(200, {
    ...headers,
    'content-length': info.size,
  });
  createReadStream(filePath).pipe(res);
}

/**
 * Probe the backend's unauthenticated readiness endpoint
 * (GET /api/system/ready), which itself checks Postgres + Redis.
 * Resolves { ok } and never throws: any transport error, timeout, or
 * non-ok payload means the backend is not ready.
 */
function checkBackendReady(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const settle = (value) => resolve(value);
    const req = proxyRequest(
      {
        hostname: backendHost,
        port: backendPort,
        path: '/api/system/ready',
        method: 'GET',
        timeout: timeoutMs,
      },
      (upstreamRes) => {
        let body = '';
        upstreamRes.on('data', (chunk) => {
          body += chunk;
        });
        upstreamRes.on('end', () => {
          let ok = false;
          try {
            ok = upstreamRes.statusCode === 200 && JSON.parse(body).status === 'ok';
          } catch {
            ok = false;
          }
          settle({ ok, httpStatus: upstreamRes.statusCode ?? 0 });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      settle({ ok: false, httpStatus: 0 });
    });
    req.on('error', () => settle({ ok: false, httpStatus: 0 }));
    req.end();
  });
}

async function handleHealth(req, res) {
  // /healthz and /readyz are only "ok" when the backend (and through it
  // Postgres + Redis) is reachable. A frontend that can serve static
  // files while its API is down must not report healthy.
  const backend = await checkBackendReady();
  const healthy = backend.ok;
  const payload = {
    status: healthy ? 'ok' : 'error',
    backend: healthy ? 'ok' : 'unavailable',
    uptimeSeconds: Math.round(process.uptime()),
  };
  res.writeHead(healthy ? 200 : 503, baseHeaders({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
  }));
  res.end(JSON.stringify(payload));
}

createServer(async (req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    await handleHealth(req, res);
    return;
  }

  if (req.url?.startsWith('/api/')) {
    proxy(req, res, { host: backendHost, port: backendPort });
    return;
  }

  try {
    await serveStatic(req, res);
  } catch {
    const html = await readFile(path.join(distDir, 'index.html'));
    res.writeHead(200, baseHeaders({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }));
    res.end(html);
  }
}).listen(port, host, () => {
  console.log(`PicVault frontend listening on http://${host}:${port}`);
});
