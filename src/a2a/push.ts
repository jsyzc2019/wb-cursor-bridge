/**
 * A2A v1.0 push notification contract.
 *
 * P0 deliberately declared `pushNotifications: false` on the v1.0 card because
 * the existing webhook path (watch.ts) emits a bare v0.3 TaskEvent and only
 * understands a `token`. That is not a v1.0 implementation: the spec requires
 * CRUD over `TaskPushNotificationConfig`, a `StreamResponse` payload, and the
 * `authentication.scheme/credentials` pair on the outbound request.
 *
 * This module is the v1.0 contract, kept separate from the legacy watcher so
 * the 0.3 behaviour stays byte-for-byte unchanged. Security is inherited:
 *
 *   - config creation runs the same string-level SSRF gate as the legacy path;
 *   - delivery additionally runs the full DNS-resolution gate before POST;
 *   - `redirect: 'manual'` prevents an unvalidated second request;
 *   - delivery only happens when the A2A surface is authenticated (the same
 *     guard the legacy `maybePush` has always applied).
 *
 * A registry is scoped to one JobManager via a WeakMap. Every request path in
 * server.ts already receives `mgr`, so no signature threading is needed and
 * tests that boot several servers cannot share config state.
 */
import { randomUUID } from 'node:crypto';
import type { JobManager } from '../runner.js';
import type { Logger } from '../logger.js';
import { badArgument, notFound } from '../errors.js';
import { subscribeTask } from './watch.js';
import { isV1Terminal, toV1StreamResponse } from './v1.js';

export interface V1PushAuthentication {
  /** v1.0 AuthenticationInfo: a single IANA scheme + credentials. */
  scheme?: string;
  /** v0.3 spelling, tolerated on input. */
  schemes?: string[];
  credentials?: string;
}

export interface V1PushConfig {
  id: string;
  taskId?: string;
  url: string;
  token?: string;
  authentication?: V1PushAuthentication;
  tenant?: string;
}

export interface PushRegistryDeps {
  log: Logger;
  allowlist?: string[];
  /** Synchronous literal check (no DNS) — used at config creation time. */
  isSafeLiteral(url: string, allowlist?: string[]): string | null;
  /** Full check including DNS resolution — used immediately before delivery. */
  verifyTarget(url: string, allowlist?: string[]): Promise<string | null>;
  /** Delivery is only enabled on an authenticated A2A surface. */
  deliveryEnabled(): boolean;
}

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

function normaliseAuth(raw: unknown): V1PushAuthentication | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const a = raw as Record<string, unknown>;
  const out: V1PushAuthentication = {};
  if (nonEmpty(a.scheme)) out.scheme = a.scheme as string;
  if (Array.isArray(a.schemes)) out.schemes = a.schemes.filter((s): s is string => typeof s === 'string');
  if (nonEmpty(a.credentials)) out.credentials = a.credentials as string;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Outbound Authorization header, v1.0 first, v0.3 token fallback. */
export function pushAuthHeader(cfg: V1PushConfig): string | undefined {
  const scheme = cfg.authentication?.scheme ?? cfg.authentication?.schemes?.[0];
  const credentials = cfg.authentication?.credentials;
  if (scheme && credentials) return `${scheme} ${credentials}`;
  if (cfg.token) return `Bearer ${cfg.token}`;
  return undefined;
}

export class PushRegistry {
  private readonly byTask = new Map<string, Map<string, V1PushConfig>>();
  private readonly watching = new Set<string>();

  constructor(private readonly deps: PushRegistryDeps) {}

  /** Create (or replace) a config. Returns the wire-shaped v1.0 config. */
  create(taskId: string, input: Record<string, unknown>): V1PushConfig {
    const task = nonEmpty(taskId);
    if (!task) throw badArgument('taskId is required for a push notification config');
    const url = nonEmpty(input.url);
    if (!url) throw badArgument('url is required for a push notification config');
    const unsafe = this.deps.isSafeLiteral(url, this.deps.allowlist);
    if (unsafe) throw badArgument(`push target rejected: ${unsafe}`);

    const cfg: V1PushConfig = {
      id: nonEmpty(input.id) ?? randomUUID(),
      taskId: task,
      url,
    };
    if (nonEmpty(input.token)) cfg.token = input.token as string;
    const auth = normaliseAuth(input.authentication);
    if (auth) cfg.authentication = auth;
    if (nonEmpty(input.tenant)) cfg.tenant = input.tenant as string;

    let m = this.byTask.get(task);
    if (!m) {
      m = new Map();
      this.byTask.set(task, m);
    }
    m.set(cfg.id, cfg);
    return cfg;
  }

  /**
   * Register the inline `configuration.taskPushNotificationConfig` carried on
   * SendMessage. The spec says its taskId should be empty; the server binds it
   * to the task it just created.
   */
  registerInline(taskId: string, raw: Record<string, unknown>): V1PushConfig {
    return this.create(taskId, raw);
  }

  get(taskId: string, id: string): V1PushConfig {
    const cfg = this.byTask.get(taskId)?.get(id);
    if (!cfg) throw notFound(`push notification config "${id}" not found for task "${taskId}"`);
    return cfg;
  }

  list(
    taskId: string,
    pageSize?: number,
    pageToken?: string,
  ): { configs: V1PushConfig[]; nextPageToken: string } {
    const all = [...(this.byTask.get(taskId)?.values() ?? [])];
    const size = typeof pageSize === 'number' && pageSize > 0 ? Math.min(Math.floor(pageSize), 1000) : 100;
    const start = pageToken ? Math.max(0, Number.parseInt(pageToken, 10) || 0) : 0;
    const page = all.slice(start, start + size);
    return {
      configs: page,
      nextPageToken: start + page.length < all.length ? String(start + page.length) : '',
    };
  }

  /** Idempotent: deleting an already-deleted config is a success (PUSH-DEL-002). */
  delete(taskId: string, id: string): Record<string, never> {
    const m = this.byTask.get(taskId);
    if (m) {
      m.delete(id);
      if (m.size === 0) this.byTask.delete(taskId);
    }
    return {};
  }

  active(taskId: string): V1PushConfig[] {
    return [...(this.byTask.get(taskId)?.values() ?? [])];
  }

  /**
   * Watch a task and POST a v1.0 StreamResponse for every observed update.
   * One watcher per task; fire-and-forget so a slow webhook never blocks the
   * RPC response. The watcher re-reads `active()` on each event, so a config
   * created via CRUD mid-flight is picked up too.
   */
  watch(mgr: JobManager, taskId: string, signal?: AbortSignal): void {
    if (this.watching.has(taskId)) return;
    this.watching.add(taskId);
    void (async () => {
      try {
        for await (const ev of subscribeTask(mgr, taskId, signal)) {
          const payload = toV1StreamResponse(ev);
          const configs = this.active(taskId);
          await Promise.all(configs.map((c) => this.deliver(c, payload)));
          if (isV1Terminal(ev)) break;
        }
      } catch (err) {
        this.deps.log.warn('v1 push watcher error', { taskId, err: String(err) });
      } finally {
        this.watching.delete(taskId);
      }
    })();
  }

  /** Best-effort delivery with the full SSRF gate and bounded retries. */
  async deliver(cfg: V1PushConfig, payload: unknown): Promise<void> {
    if (!this.deps.deliveryEnabled()) return;
    let blocked: string | null;
    try {
      blocked = await this.deps.verifyTarget(cfg.url, this.deps.allowlist);
    } catch (err) {
      blocked = String(err);
    }
    if (blocked) {
      // Never log the raw URL: query strings routinely carry webhook secrets.
      this.deps.log.warn('v1 push target rejected', { configId: cfg.id, reason: blocked });
      return;
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const auth = pushAuthHeader(cfg);
    if (auth) headers.authorization = auth;
    const body = JSON.stringify(payload);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const res = await fetch(cfg.url, {
          method: 'POST',
          headers,
          body,
          // A redirect is a second, unvalidated request: the SSRF gate only
          // saw the original URL. Refuse to follow it.
          redirect: 'manual',
        });
        if (res.status >= 300 && res.status < 400) return;
        if (res.ok) return;
      } catch {
        /* network error, retry */
      }
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
    this.deps.log.warn('v1 push delivery failed after retries', { configId: cfg.id });
  }
}

/* -------------------------------------------------------------- registry scope */

const registries = new WeakMap<object, PushRegistry>();

export function attachPushRegistry(mgr: JobManager, registry: PushRegistry): void {
  registries.set(mgr, registry);
}

/**
 * Resolve the registry for a JobManager. A server always attaches one at
 * startup; the lazy fallback keeps direct unit-test / embedded use working
 * with the strictest defaults (no allowlist, delivery disabled).
 */
export function pushRegistryFor(mgr: JobManager): PushRegistry {
  let reg = registries.get(mgr);
  if (!reg) {
    reg = new PushRegistry({
      log: { warn: () => {} } as unknown as Logger,
      isSafeLiteral: () => 'push registry not attached to an A2A server',
      verifyTarget: async () => 'push registry not attached to an A2A server',
      deliveryEnabled: () => false,
    });
    registries.set(mgr, reg);
  }
  return reg;
}
