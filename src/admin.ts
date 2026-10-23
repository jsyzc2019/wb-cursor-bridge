/**
 * Optional HTTP admin surface.
 *
 * Off by default (`CURSOR_BRIDGE_ADMIN_PORT=0`). It exists so an operator can
 * check liveness and read metrics without attaching an MCP client - useful when
 * the bridge runs as a scheduled or background process. It binds to loopback
 * only and exposes read-only endpoints plus a shutdown trigger.
 */
import http from 'node:http';
import type { JobManager } from './runner.js';
import type { Logger } from './logger.js';

export function startAdminServer(
  mgr: JobManager,
  port: number,
  shutdownToken: string | undefined,
  log: Logger,
): http.Server | null {
  if (!port) return null;

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const send = (code: number, body: unknown) => {
      const payload = JSON.stringify(body, null, 2);
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
      });
      res.end(payload);
    };

    if (req.method !== 'GET' && url !== '/admin/shutdown') {
      return send(405, { error: 'method not allowed' });
    }

    switch (url) {
      case '/healthz':
      case '/health': {
        const health = mgr.health();
        return send(health.ok ? 200 : 503, health);
      }
      case '/stats':
      case '/metrics':
        return send(200, mgr.getMetrics());
      case '/jobs':
        return send(
          200,
          mgr.store.list({ limit: 50 }).map((j) => ({
            jobId: j.id,
            status: j.status,
            tier: j.tier,
            durationMs: j.durationMs,
            createdAt: j.createdAt,
          })),
        );
        case '/admin/shutdown': {
        if (shutdownToken) {
          const provided =
            (req.headers['x-shutdown-token'] as string | undefined) ??
            new URL(req.url ?? '', `http://127.0.0.1:${port}`).searchParams.get('token') ??
            '';
          if (provided !== shutdownToken) {
            return send(401, { error: 'unauthorized: missing or invalid shutdown token' });
          }
        }
        send(200, { ok: true });
        void mgr.shutdown().then(
          () => {
            // Let the HTTP response flush before tearing the process down.
            setTimeout(() => process.exit(0), 100).unref?.();
          },
          (err) => {
            log.error('admin shutdown failed', { err: String(err) });
            setTimeout(() => process.exit(1), 100).unref?.();
          },
        );
        return;
      }
      default:
        return send(404, {
          error: 'not found',
          routes: ['/healthz', '/stats', '/jobs', '/admin/shutdown'],
        });
    }
  });

  server.on('error', (err) => {
    log.error('admin server failed', { err: String(err) });
  });

  // Loopback only: never expose job control to the network.
  server.listen(port, '127.0.0.1', () => {
    log.info('admin server listening', { url: `http://127.0.0.1:${port}/healthz` });
  });

  return server;
}