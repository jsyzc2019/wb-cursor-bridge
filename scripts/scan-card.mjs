#!/usr/bin/env node
/**
 * P4: static Agent Card scanner (zero runtime dependencies).
 *
 * The Agent Card is the trust anchor another A2A agent reads before it ever
 * sends a task. A malformed or over-claiming card is both an interop bug and a
 * security issue (it advertises capabilities the server does not implement).
 *
 * Rather than pulling in an external `a2a-scanner` (which would break the
 * zero-runtime-dependency / single-file offline bundle rule), this scanner
 * builds BOTH cards from the real production builders in dist/ and validates
 * their structure, field sets and honesty constraints.
 *
 * The module doubles as a library: scanCardPair() is a pure function so the
 * test suite can feed it deliberately broken cards and assert that the gate
 * actually catches regressions (a scanner nobody tests is decoration).
 *
 * Exit 0 = clean, 1 = findings. CI treats any finding as a failure.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Read the version from package.json so the scan gate never drifts from the
// release version (the card built here must describe the shipping build).
const PKG_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const V1_CARD_ALLOWED = new Set([
  'name', 'description', 'version', 'capabilities', 'defaultInputModes',
  'defaultOutputModes', 'skills', 'supportedInterfaces', 'provider',
  'documentationUrl', 'iconUrl', 'securitySchemes', 'security',
]);
const V1_FORBIDDEN = new Set([
  'schema', 'url', 'protocolVersion', 'preferredTransport',
  'securityRequirements', 'stateTransitionHistory',
]);
const INTERFACE_ALLOWED = new Set(['url', 'protocolBinding', 'protocolVersion', 'tenant']);
/** A2A v1.0 §AgentInterface: only these three bindings are defined. */
export const BINDINGS = new Set(['JSONRPC', 'GRPC', 'HTTP+JSON']);
const CAPS_ALLOWED = new Set(['streaming', 'pushNotifications', 'extendedAgentCard']);
const SKILL_ALLOWED = new Set([
  'id', 'name', 'description', 'tags', 'examples', 'inputModes', 'outputModes',
]);

function checkString(ctx, card, obj, key, required = true) {
  const v = obj?.[key];
  if (v === undefined || v === null) {
    if (required) ctx.fail(card, `missing required field "${key}"`);
    return;
  }
  if (typeof v !== 'string' || v.length === 0) ctx.fail(card, `"${key}" must be a non-empty string`);
}

function scanLegacy(legacy, ctx) {
  checkString(ctx, 'agent.json', legacy, 'name');
  checkString(ctx, 'agent.json', legacy, 'description');
  checkString(ctx, 'agent.json', legacy, 'version');
  if (legacy.protocolVersion !== '0.3.0') {
    ctx.fail('agent.json', `legacy card must advertise 0.3.0 (got ${legacy.protocolVersion})`);
  }
  if (!Array.isArray(legacy.skills) || legacy.skills.length === 0) {
    ctx.fail('agent.json', 'skills must be a non-empty array');
  }
}

function scanV1(v1, ctx) {
  for (const k of Object.keys(v1 ?? {})) {
    if (V1_FORBIDDEN.has(k)) ctx.fail('agent-card.json', `v0.3-only field "${k}" leaked into v1.0 card`);
    else if (!V1_CARD_ALLOWED.has(k)) ctx.fail('agent-card.json', `unknown top-level field "${k}"`);
  }
  checkString(ctx, 'agent-card.json', v1, 'name');
  checkString(ctx, 'agent-card.json', v1, 'description');
  checkString(ctx, 'agent-card.json', v1, 'version');
  if (!Array.isArray(v1.defaultInputModes) || v1.defaultInputModes.length === 0) {
    ctx.fail('agent-card.json', 'defaultInputModes must be a non-empty array');
  }
  if (!Array.isArray(v1.defaultOutputModes) || v1.defaultOutputModes.length === 0) {
    ctx.fail('agent-card.json', 'defaultOutputModes must be a non-empty array');
  }
  if (!Array.isArray(v1.skills) || v1.skills.length === 0) {
    ctx.fail('agent-card.json', 'skills must be a non-empty array');
  } else {
    for (const s of v1.skills) {
      for (const k of Object.keys(s ?? {})) {
        if (!SKILL_ALLOWED.has(k)) ctx.fail('agent-card.json', `skill field "${k}" is not allowed`);
      }
      checkString(ctx, 'agent-card.json', s, 'id');
      checkString(ctx, 'agent-card.json', s, 'name');
    }
  }

  const caps = v1.capabilities;
  if (!caps || typeof caps !== 'object') {
    ctx.fail('agent-card.json', 'capabilities is required');
  } else {
    for (const k of Object.keys(caps)) {
      if (!CAPS_ALLOWED.has(k)) ctx.fail('agent-card.json', `unknown capability "${k}"`);
    }
    if (typeof caps.streaming !== 'boolean') ctx.fail('agent-card.json', 'capabilities.streaming must be boolean');
    if (typeof caps.pushNotifications !== 'boolean') {
      ctx.fail('agent-card.json', 'capabilities.pushNotifications must be boolean');
    }
  }

  const interfaces = v1.supportedInterfaces;
  if (!Array.isArray(interfaces) || interfaces.length === 0) {
    ctx.fail('agent-card.json', 'supportedInterfaces must be a non-empty array (TCK BIND-FIELD-001)');
    return;
  }
  const seen = new Set();
  for (const [i, it] of interfaces.entries()) {
    for (const k of Object.keys(it ?? {})) {
      if (!INTERFACE_ALLOWED.has(k)) {
        ctx.fail('agent-card.json', `supportedInterfaces[${i}] has unknown field "${k}"`);
      }
    }
    checkString(ctx, 'agent-card.json', it, 'url');
    checkString(ctx, 'agent-card.json', it, 'protocolBinding');
    if (typeof it.protocolBinding === 'string' && !BINDINGS.has(it.protocolBinding)) {
      ctx.fail('agent-card.json', `unsupported protocolBinding "${it.protocolBinding}"`);
    }
    if (typeof it.protocolBinding === 'string') {
      if (seen.has(it.protocolBinding)) {
        ctx.fail('agent-card.json', `duplicate protocolBinding "${it.protocolBinding}"`);
      }
      seen.add(it.protocolBinding);
    }
    if (typeof it.url === 'string') {
      try {
        const u = new URL(it.url);
        if (!['http:', 'https:'].includes(u.protocol)) {
          ctx.fail('agent-card.json', `interface url must be http(s), got ${u.protocol}`);
        }
        if (u.hostname === '0.0.0.0' || u.hostname === '') {
          ctx.fail('agent-card.json', 'interface url must not be a wildcard/empty host');
        }
        if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
          ctx.warn('agent-card.json', 'interface url is loopback (expected for a local bridge; ensure it is not published as a public card)');
        }
      } catch {
        ctx.fail('agent-card.json', `interface url is not a valid URL: ${it.url}`);
      }
    }
  }
  if (!BINDINGS.has(interfaces[0]?.protocolBinding)) {
    ctx.fail('agent-card.json', 'supportedInterfaces[0] must declare a standard protocolBinding');
  }
  // The TCK's jsonrpc transport gate reads supportedInterfaces[0]; if JSONRPC
  // is not advertised at all, no jsonrpc client can be built.
  if (!seen.has('JSONRPC')) {
    ctx.warn('agent-card.json', 'no JSONRPC interface declared; the official TCK jsonrpc gate cannot run');
  }
}

/**
 * Pure validation of a card pair. Returns findings/notes/ok without side
 * effects, so the CI gate and the unit tests exercise exactly the same logic.
 */
export function scanCardPair(legacy, v1) {
  const findings = [];
  const notes = [];
  const ctx = {
    fail: (card, msg) => findings.push({ card, severity: 'error', message: msg }),
    warn: (card, msg) => notes.push({ card, severity: 'warning', message: msg }),
  };
  scanLegacy(legacy, ctx);
  scanV1(v1, ctx);

  // Honesty: a v1.0 card must not claim a capability the server cannot serve.
  if (legacy?.capabilities?.streaming !== v1?.capabilities?.streaming) {
    ctx.fail('consistency', 'v1.0 streaming capability disagrees with the legacy card');
  }
  if (v1?.capabilities?.pushNotifications === true && legacy?.capabilities?.pushNotifications !== true) {
    ctx.fail('consistency', 'v1.0 card claims pushNotifications=true but the server has no push delivery contract');
  }
  if (v1?.capabilities?.extendedAgentCard === true) {
    ctx.warn('consistency', 'extendedAgentCard declared; GetExtendedAgentCard must be implemented');
  }
  return { findings, notes, ok: findings.length === 0 };
}

/**
 * Build both cards from the real production builders.
 *
 * dist/ is loaded lazily: importing this module as a library (unit tests) must
 * not require a prior build, while the CLI always runs against the compiled
 * production builders rather than a hand-written copy of the card.
 */
export async function buildProductionCards() {
  const [{ deriveSkills }, { buildAgentCard, buildV1AgentCard }, { Logger }] = await Promise.all([
    import('../dist/a2a/skills.js'),
    import('../dist/a2a/card.js'),
    import('../dist/logger.js'),
  ]);
  const log = new Logger({ level: 'error' });
  const skills = deriveSkills([process.cwd()], 'execute', [], log);
  const options = {
    name: 'wb-cursor-bridge',
    description: 'Governed Cursor CLI sub-agent exposed over MCP + A2A',
    version: PKG_VERSION,
    endpointUrl: 'http://127.0.0.1:0/a2a',
    skills,
    authEnabled: true,
  };
  return { legacy: buildAgentCard(options), v1: buildV1AgentCard(options) };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { legacy, v1 } = await buildProductionCards();
  const { findings, notes, ok } = scanCardPair(legacy, v1);
  const report = {
    tool: 'scan-card',
    timestamp: new Date().toISOString(),
    cards: ['agent.json (v0.3.0)', 'agent-card.json (v1.0)'],
    findings,
    notes,
    ok,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!ok) {
    process.stderr.write(`[scan-card] ${findings.length} finding(s); failing the build\n`);
    process.exit(1);
  }
  process.stdout.write('[scan-card] OK: Agent Cards are well-formed and honest\n');
}
