#!/usr/bin/env node
/**
 * wb-cursor-bridge entry point.
 *
 * Responsibilities kept deliberately small: wire the pieces together, protect
 * stdout (it belongs to the MCP protocol), and shut down without leaving
 * Cursor processes behind.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config.js';
import { VERSION } from './version.js';
import { Logger } from './logger.js';
import { JobManager } from './runner.js';
import { createDispatcher, TOOL_DEFINITIONS } from './tools.js';
import { startAdminServer } from './admin.js';
import { startA2AServer } from './a2a/server.js';
import { BridgeError } from './errors.js';
import { pruneOwnedWorktrees } from './util/git.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Redirect every stray console call away from stdout.
 *
 * One accidental `console.log` in any dependency corrupts the JSON-RPC stream
 * and the client disconnects with an opaque parse error. This makes that class
 * of bug impossible rather than merely unlikely.
 */
function protectStdout(): void {
  const toStderr =
    (...args: unknown[]) =>
    void process.stderr.write(args.map(stringify).join(' ') + '\n');
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
  console.trace = toStderr as never;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

async function main(): Promise<void> {
  protectStdout();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(
      `[wb-cursor-bridge] configuration error: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    process.exit(2);
  }

  const log = new Logger({
    level: config.logLevel,
    fileDir: config.stateDir,
  });
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
  } catch (err) {
    log.warn('state directory creation failed', {
      stateDir: config.stateDir,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('starting', {
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cursorBin: config.cursorBin,
    roots: config.workspaceRoots.length,
    stateDir: config.stateDir,
  });

  if (config.workspaceRoots.length === 0) {
    log.warn(
      'no workspace roots configured - every task will be rejected. Set CURSOR_BRIDGE_WORKSPACE_ROOTS.',
    );
  }

  const manager = new JobManager(config, log);
  const dispatch = createDispatcher(manager);

  const server = new Server(
    { name: 'wb-cursor-bridge', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Exposes the Cursor CLI as a sub-agent. Cursor runs asynchronously: ' +
        'dispatch with cursor_run, then poll with cursor_status using the returned ' +
        'jobId and the cursor value from the previous response. Permission tiers: ' +
        'consult (read-only Q&A), plan (read-only planning), execute (writes inside an ' +
        'isolated git worktree).',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS as unknown as never,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const started = Date.now();
    const result = await dispatch(name, args);
    log.debug('tool call', {
      tool: name,
      ms: Date.now() - started,
      isError: Boolean(result.isError),
    });
    return result as never;
  });

  const admin = startAdminServer(
    manager,
    config.adminPort,
    config.adminShutdownToken,
    log.child('admin'),
  );

  const a2a = startA2AServer(
    manager,
    { config, version: VERSION, log: log.child('a2a') },
  );

  // --- lifecycle -----------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (reason: string, code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { reason });
    try {
      admin?.close();
      a2a?.close();
      await manager.shutdown();
      server.close();
      log.info('shutdown complete');
    } catch (err) {
      log.error('shutdown error', { err: String(err) });
      code = 1;
    } finally {
      process.exit(code);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // SIGBREAK / SIGHUP only exist on Windows and POSIX respectively.
  process.on('SIGBREAK' as never, () => void shutdown('SIGBREAK'));
  process.on('SIGHUP' as never, () => void shutdown('SIGHUP'));

  // An unhandled rejection is a real defect, but a single stray one should not
  // kill a long-running bridge. Count them within a sliding window and only
  // exit when they become sustained — a sharp contrast with uncaughtException,
  // which always exits, so the two handlers stay asymmetric on purpose.
  const UNHANDLED_THRESHOLD = 20;
  const UNHANDLED_WINDOW_MS = 60_000;
  let unhandledCount = 0;
  let unhandledWindowStart = Date.now();
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { reason: String(reason) });
    const now = Date.now();
    if (now - unhandledWindowStart > UNHANDLED_WINDOW_MS) {
      unhandledWindowStart = now;
      unhandledCount = 0;
    }
    unhandledCount += 1;
    if (unhandledCount >= UNHANDLED_THRESHOLD) {
      log.error('unhandled rejections exceeded threshold; shutting down', {
        count: unhandledCount,
        windowMs: UNHANDLED_WINDOW_MS,
      });
      void shutdown('unhandledRejectionThreshold', 1);
    }
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err: String(err), stack: err?.stack });
    void shutdown('uncaughtException', 1);
  });

  // Best-effort cleanup of worktrees left behind by a previous crash.
  if (config.workspaceRoots.length > 0) {
    void (async () => {
      for (const root of config.workspaceRoots) {
        try {
          if (fs.existsSync(root)) {
            await pruneOwnedWorktrees(
              root,
              path.join(config.stateDir, 'worktrees'),
            );
          }
        } catch {
          /* best effort */
        }
      }
    })();
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('ready', { tools: TOOL_DEFINITIONS.length, entry: HERE });

  // Optional self-check used by the installer: `bridge_shutdown` then exit.
  if (process.env.CURSOR_BRIDGE_SELFCHECK === '1') {
    const health = manager.health();
    log.info('selfcheck', health);
    await shutdown('selfcheck', health.ok ? 0 : 1);
  }
}

main().catch((err) => {
  process.stderr.write(
    `[wb-cursor-bridge] fatal: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});

export { BridgeError };