/**
 * Configuration resolution.
 *
 * Precedence: environment variable > config file > built-in default.
 * Every value is validated once at startup so a misconfigured deployment
 * fails immediately and loudly rather than at the first task.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitRoots, expandPath } from './util/paths.js';
import { badConfig } from './errors.js';
import type { Level } from './logger.js';
import type { ExtraSkill } from './a2a/skills.js';

export interface Config {
  cursorBin: string;
  workspaceRoots: string[];
  stateDir: string;
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
  maxConcurrency: number;
  defaultModel?: string;
  forceWorktree: boolean;
  /** Hard cap on the final response string kept in memory. */
  maxResultBytes: number;
  /** Cap on events retained in memory per job. */
  maxEventsPerJob: number;
  /** Cap on jobs kept in memory. */
  maxJobs: number;
  logLevel: Level;
  /** Optional HTTP admin port; 0 disables it. */
  adminPort: number;
  /** Optional token required for /admin/shutdown. */
  adminShutdownToken?: string;
  /** Optional A2A (Agent2Agent) HTTP port; 0 disables the A2A surface. */
  a2aPort: number;
  /** Bind host for the A2A server (default loopback). */
  a2aHost: string;
  /** Optional bearer token guarding the A2A endpoint. */
  a2aAuthToken?: string;
  /** Optional externally reachable A2A base URL (overrides host:port in the Agent Card). */
  a2aPublicUrl?: string;
  /** Hostnames/IPs allowed as push-notification targets even though they are private/loopback (SSRF allowlist). */
  a2aPushUrlAllowlist?: string[];
  /** Cap on how long a blocking `message/send` may wait for a final state before returning the current (non-final) task. */
  a2aBlockingMaxMs?: number;
  /** Allowed CORS origins for the A2A surface (e.g. a web console). Unset = no CORS headers. */
  a2aCorsOrigins?: string[];
  /** Emit `access-control-allow-credentials` for allowed origins. Off by default; rejected together with `*`. */
  a2aCorsAllowCredentials: boolean;
  /** Operator-declared extra A2A skills (same-root multi-skill / subfolder pinning). */
  a2aSkills?: ExtraSkill[];
  /** A2A wire protocol version to advertise and emit ('0.3.0' default; '1.0' for the v1.0 data model). */
  a2aProtocolVersion?: '0.3.0' | '1.0';
  /** A2A POST token-bucket refill rate (requests/sec). Capacity = this value; bursts up to capacity are allowed. */
  a2aRateLimitPerSec?: number;
  /** Optional directory for per-job event JSONL files. */
  eventLogDir?: string;
  /** Extra args always appended to the Cursor invocation. */
  extraArgs: string[];
}

type FileConfig = Partial<{
  cursorBin: string;
  workspaceRoots: string[] | string;
  stateDir: string;
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
  maxConcurrency: number;
  defaultModel: string;
  forceWorktree: boolean;
  maxResultBytes: number;
  maxEventsPerJob: number;
  maxJobs: number;
  logLevel: Level;
  adminPort: number;
  adminShutdownToken?: string;
  eventLogDir?: string;
  extraArgs: string[];
  a2aPort?: number;
  a2aHost?: string;
  a2aAuthToken?: string;
  a2aPublicUrl?: string;
  a2aPushUrlAllowlist?: string[];
  a2aBlockingMaxMs?: number;
  a2aCorsOrigins?: string[];
  a2aCorsAllowCredentials?: boolean;
  a2aSkills?: ExtraSkill[];
  a2aProtocolVersion?: '0.3.0' | '1.0';
  a2aRateLimitPerSec?: number;
}>;

function defaultStateDir(): string {
  if (process.env.LOCALAPPDATA) {
    // Windows: %LOCALAPPDATA%\wb-cursor-bridge
    return path.join(process.env.LOCALAPPDATA, 'wb-cursor-bridge');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'wb-cursor-bridge');
  }
  return path.join(os.homedir(), '.local', 'state', 'wb-cursor-bridge');
}

/** Default config file locations, in priority order. */
function configFileCandidates(): string[] {
  if (process.env.WB_CURSOR_BRIDGE_CONFIG) {
    return [expandPath(process.env.WB_CURSOR_BRIDGE_CONFIG)];
  }
  const home = os.homedir();
  return [
    path.join(process.cwd(), 'wb-cursor-bridge.config.json'),
    path.join(home, '.config', 'wb-cursor-bridge', 'config.json'),
    path.join(process.env.LOCALAPPDATA ?? path.join(home, '.config'), 'wb-cursor-bridge', 'config.json'),
  ];
}

function readFileConfig(): FileConfig {
  for (const candidate of configFileCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as FileConfig;
      parsed.stateDir = parsed.stateDir ? expandPath(parsed.stateDir) : undefined;
      const rootsRaw = parsed.workspaceRoots;
      if (rootsRaw !== undefined) {
        const list = typeof rootsRaw === 'string' ? splitRoots(rootsRaw) : rootsRaw;
        parsed.workspaceRoots = list.map(expandPath);
      }
      return parsed;
    } catch (err) {
      throw badConfig(`invalid config file: ${candidate}`, String(err));
    }
  }
  return {};
}

/**
 * Resolve one numeric setting.
 *
 * `name` is the setting name, not its value: the error message has to tell the
 * operator *which* knob is out of range, otherwise "5 must be between 60 and
 * 86400" is unactionable.
 */
function num(
  name: string,
  env: string | undefined,
  fileValue: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  let value: number;
  if (env !== undefined && env.trim() !== '') {
    // An env var that is set but unparseable is an operator mistake, not a
    // request for the default. Silently running with the fallback is how
    // `CURSOR_BRIDGE_TIMEOUT_SEC=15m` turns into a 15-minute job that nobody
    // can explain hours later: fail at startup, naming the knob.
    value = Number(env);
    if (!Number.isFinite(value)) {
      throw badConfig(
        `${name} is not a number (got "${env}")`,
        'use a plain integer, e.g. 900',
      );
    }
  } else if (fileValue !== undefined) {
    value = Number(fileValue);
    if (!Number.isFinite(value)) {
      throw badConfig(`${name} must be a number (got ${JSON.stringify(fileValue)})`);
    }
  } else {
    return Math.floor(fallback);
  }
  if (value < min || value > max) {
    throw badConfig(
      `${name} must be between ${min} and ${max} (got ${value})`,
    );
  }
  return Math.floor(value);
}

const TRUTHY = /^(1|true|yes|on)$/i;
const FALSY = /^(0|false|no|off)$/i;

function bool(name: string, env: string | undefined, fileValue: boolean | undefined): boolean {
  const raw = env?.trim();
  if (raw) {
    if (TRUTHY.test(raw)) return true;
    if (FALSY.test(raw)) return false;
    // Anything else used to be read as `false`, so `=ture` or `=enable` looked
    // accepted and silently disabled the feature.
    throw badConfig(
      `${name} must be one of 1/0, true/false, yes/no, on/off (got "${raw}")`,
    );
  }
  return fileValue ?? false;
}

/** Parse a comma-separated allowlist from env (highest precedence) or a file list. */
function parseList(
  label: string,
  env: string | undefined,
  fileValue: string[] | undefined,
): string[] | undefined {
  if (env !== undefined && env.trim() !== '') {
    return env
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(fileValue)) return fileValue.map((s) => String(s).trim()).filter((s) => s.length > 0);
  void label;
  return undefined;
}

function candidateBins(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const out = ['agent.exe', 'cursor-agent.exe'];
    if (localAppData) {
      out.push(path.join(localAppData, 'Programs', 'cursor', 'bin', 'agent.exe'));
      out.push(path.join(localAppData, 'Programs', 'cursor-agent', 'agent.exe'));
    }
    out.push(path.join(programFiles, 'Cursor', 'bin', 'agent.exe'));
    return out;
  }
  return [
    'agent',
    'cursor-agent',
    path.join(home, '.local', 'bin', 'agent'),
    path.join(home, '.local', 'bin', 'cursor-agent'),
    '/usr/local/bin/agent',
    '/opt/homebrew/bin/agent',
  ];
}

export function loadConfig(): Config {
  const file = readFileConfig();

  const stateDir = process.env.CURSOR_BRIDGE_STATE_DIR
    ? expandPath(process.env.CURSOR_BRIDGE_STATE_DIR)
    : file.stateDir ?? defaultStateDir();

  const rootsRawEnv = process.env.CURSOR_BRIDGE_WORKSPACE_ROOTS;
  const rootsRaw: string[] = rootsRawEnv
    ? splitRoots(rootsRawEnv)
    : typeof file.workspaceRoots === 'string'
      ? splitRoots(file.workspaceRoots)
      : file.workspaceRoots ?? [];
  const workspaceRoots = rootsRaw.map(expandPath);

  const maxTimeoutSec = num(
    'CURSOR_BRIDGE_MAX_TIMEOUT_SEC',
    process.env.CURSOR_BRIDGE_MAX_TIMEOUT_SEC,
    file.maxTimeoutSec,
    3600,
    60,
    86400,
  );
  const defaultTimeoutSec = num(
    'CURSOR_BRIDGE_TIMEOUT_SEC',
    process.env.CURSOR_BRIDGE_TIMEOUT_SEC,
    file.defaultTimeoutSec,
    900,
    10,
    maxTimeoutSec,
  );

  const extraArgs = process.env.CURSOR_BRIDGE_EXTRA_ARGS
    ? process.env.CURSOR_BRIDGE_EXTRA_ARGS.split(' ').filter(Boolean)
    : file.extraArgs ?? [];

  const persistEvents = bool(
    'CURSOR_BRIDGE_PERSIST_EVENTS',
    process.env.CURSOR_BRIDGE_PERSIST_EVENTS,
    file.eventLogDir !== undefined ? true : undefined,
  );
  let eventLogDir: string | undefined;
  if (process.env.CURSOR_BRIDGE_EVENT_LOG_DIR) {
    eventLogDir = expandPath(process.env.CURSOR_BRIDGE_EVENT_LOG_DIR);
  } else if (file.eventLogDir) {
    eventLogDir = expandPath(file.eventLogDir);
  } else if (persistEvents) {
    eventLogDir = path.join(stateDir, 'events');
  }

  const LOG_LEVELS: Level[] = ['debug', 'info', 'warn', 'error'];
  const rawLogLevel = process.env.CURSOR_BRIDGE_LOG_LEVEL ?? file.logLevel ?? 'info';
  if (!LOG_LEVELS.includes(rawLogLevel as Level)) {
    // An unknown level would quietly map to "always log" or "never log"
    // depending on the comparison, so a typo could suppress the very warnings
    // an operator turned on.
    throw badConfig(
      `CURSOR_BRIDGE_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got "${rawLogLevel}")`,
    );
  }
  const logLevel = rawLogLevel as Level;

  const rawProtocol = process.env.CURSOR_BRIDGE_A2A_PROTOCOL_VERSION ?? file.a2aProtocolVersion ?? '0.3.0';
  if (rawProtocol !== '0.3.0' && rawProtocol !== '1.0') {
    throw badConfig(
      `CURSOR_BRIDGE_A2A_PROTOCOL_VERSION must be "0.3.0" or "1.0" (got "${rawProtocol}")`,
    );
  }
  const a2aProtocolVersion: '0.3.0' | '1.0' = rawProtocol;

  const a2aCorsOrigins = parseList(
    'CURSOR_BRIDGE_A2A_CORS_ORIGINS',
    process.env.CURSOR_BRIDGE_A2A_CORS_ORIGINS,
    file.a2aCorsOrigins,
  );
  const a2aCorsAllowCredentials = bool(
    'CURSOR_BRIDGE_A2A_CORS_ALLOW_CREDENTIALS',
    process.env.CURSOR_BRIDGE_A2A_CORS_ALLOW_CREDENTIALS,
    file.a2aCorsAllowCredentials,
  );
  if (a2aCorsAllowCredentials && a2aCorsOrigins?.includes('*')) {
    // Reflecting an arbitrary origin *and* allowing credentials lets any
    // website read authenticated bridge responses. There is no legitimate use
    // for that pair, so refuse to boot rather than ship a wide-open CORS policy.
    throw badConfig(
      'CURSOR_BRIDGE_A2A_CORS_ALLOW_CREDENTIALS cannot be combined with the wildcard origin "*"',
      'list the console origins explicitly, e.g. CURSOR_BRIDGE_A2A_CORS_ORIGINS=https://console.example.com',
    );
  }

  return {
    cursorBin:
      process.env.CURSOR_BIN ||
      file.cursorBin ||
      candidateBins()[0],
    workspaceRoots,
    stateDir,
    defaultTimeoutSec,
    maxTimeoutSec,
    maxConcurrency: num(
      'CURSOR_BRIDGE_MAX_CONCURRENCY',
      process.env.CURSOR_BRIDGE_MAX_CONCURRENCY,
      file.maxConcurrency,
      4,
      1,
      64,
    ),
    defaultModel:
      process.env.CURSOR_BRIDGE_MODEL || file.defaultModel || undefined,
    forceWorktree: bool(
      'CURSOR_BRIDGE_FORCE_WORKTREE',
      process.env.CURSOR_BRIDGE_FORCE_WORKTREE,
      file.forceWorktree,
    ),
    maxResultBytes: num(
      'CURSOR_BRIDGE_MAX_RESULT_BYTES',
      process.env.CURSOR_BRIDGE_MAX_RESULT_BYTES,
      file.maxResultBytes,
      2 * 1024 * 1024,
      1024,
      64 * 1024 * 1024,
    ),
    maxEventsPerJob: num(
      'CURSOR_BRIDGE_MAX_EVENTS',
      process.env.CURSOR_BRIDGE_MAX_EVENTS,
      file.maxEventsPerJob,
      2000,
      50,
      100000,
    ),
    maxJobs: num('CURSOR_BRIDGE_MAX_JOBS', process.env.CURSOR_BRIDGE_MAX_JOBS, file.maxJobs, 100, 5, 10000),
    logLevel,
    adminPort: num('CURSOR_BRIDGE_ADMIN_PORT', process.env.CURSOR_BRIDGE_ADMIN_PORT, file.adminPort, 0, 0, 65535),
    adminShutdownToken:
      process.env.CURSOR_BRIDGE_ADMIN_SHUTDOWN_TOKEN || file.adminShutdownToken,
    eventLogDir,
    extraArgs,
    a2aPort: num('CURSOR_BRIDGE_A2A_PORT', process.env.CURSOR_BRIDGE_A2A_PORT, file.a2aPort, 0, 0, 65535),
    a2aHost: process.env.CURSOR_BRIDGE_A2A_HOST || file.a2aHost || '127.0.0.1',
    a2aAuthToken:
      process.env.CURSOR_BRIDGE_A2A_AUTH_TOKEN || file.a2aAuthToken,
    a2aPublicUrl:
      process.env.CURSOR_BRIDGE_A2A_PUBLIC_URL || file.a2aPublicUrl,
    a2aPushUrlAllowlist: parseList(
      'CURSOR_BRIDGE_A2A_PUSH_ALLOWLIST',
      process.env.CURSOR_BRIDGE_A2A_PUSH_ALLOWLIST,
      file.a2aPushUrlAllowlist,
    ),
    a2aBlockingMaxMs: num(
      'CURSOR_BRIDGE_A2A_BLOCKING_MAX_MS',
      process.env.CURSOR_BRIDGE_A2A_BLOCKING_MAX_MS,
      file.a2aBlockingMaxMs,
      90_000,
      1_000,
      600_000,
    ),
    a2aCorsOrigins,
    /** Emit `access-control-allow-credentials` for allowed origins. Off by default; forbidden with a wildcard. */
    a2aCorsAllowCredentials,
    a2aSkills: file.a2aSkills?.map((s) => ({ ...s, root: expandPath(s.root) })),
    a2aProtocolVersion,
    a2aRateLimitPerSec: num(
      'CURSOR_BRIDGE_A2A_RATE_LIMIT_PER_SEC',
      process.env.CURSOR_BRIDGE_A2A_RATE_LIMIT_PER_SEC,
      file.a2aRateLimitPerSec,
      250,
      1,
      100_000,
    ),
  };
}

export { candidateBins };