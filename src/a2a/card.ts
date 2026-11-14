/**
 * Build the A2A Agent Card.
 *
 * The Agent Card is the discovery document an A2A client fetches from
 * `/.well-known/agent.json` before it ever sends a task. It advertises the
 * protocol version, the endpoint URL, the capabilities the bridge actually
 * implements (streaming, push notifications, state-transition history) and the
 * skills derived from the configured workspace roots. Keeping the card honest —
 * only advertising what the server truly serves — is what makes another A2A
 * agent able to interoperate without trial and error.
 */
import type { AgentCard } from './types.js';
import { toAgentSkills, type SkillEntry } from './skills.js';

export interface AgentCardOptions {
  name: string;
  description: string;
  version: string;
  /** Public base URL of the A2A endpoint, e.g. http://host:1234/a2a. */
  endpointUrl: string;
  skills: SkillEntry[];
  /** True when an auth token guards the endpoint. */
  authEnabled: boolean;
  provider?: { organization: string; url: string };
  documentationUrl?: string;
}

const AGENT_CARD_SCHEMA = 'https://schema.a2a.dev/v1/agent-card.json';
/** Protocol version the bridge speaks. Bump when the method set changes. */
const PROTOCOL_VERSION = '0.3.0';

/**
 * Output MIME types the bridge can produce, advertised on the Agent Card and
 * used to honour `acceptedOutputModes` content negotiation on `message/send`
 * (and `message/stream`). A real A2A client opens with the modes it can
 * consume; if none overlap we reject early instead of producing unreadable output.
 */
export const AGENT_OUTPUT_MODES = ['text/plain', 'text/markdown', 'application/json'] as const;

export function buildAgentCard(opts: AgentCardOptions): AgentCard {
  const card: AgentCard = {
    schema: AGENT_CARD_SCHEMA,
    protocolVersion: PROTOCOL_VERSION,
    name: opts.name,
    description: opts.description,
    url: opts.endpointUrl,
    version: opts.version,
    provider: opts.provider,
    documentationUrl: opts.documentationUrl,
    capabilities: {
      streaming: true,
      pushNotifications: true,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: [...AGENT_OUTPUT_MODES],
    skills: toAgentSkills(opts.skills),
    preferredTransport: 'HTTP/json',
  };

  if (opts.authEnabled) {
    card.securitySchemes = {
      bearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'Bearer token sent as `Authorization: Bearer <token>` or `X-A2A-Token`.',
      },
    };
    card.security = [{ bearer: [] }];
  }

  return card;
}

/**
 * Build the *wire-compliant* A2A v1.0 Agent Card served at the v1.0 discovery
 * path `/.well-known/agent-card.json`.
 *
 * This is deliberately separate from `buildAgentCard` (the legacy v0.3.0
 * card). v1.0 is not a field rename: the schema drops the top-level
 * `protocolVersion`, `preferredTransport` and `security` fields, and REQUIRES
 * `supportedInterfaces` whose first entry declares a `protocolBinding`. TCK
 * builds its JSON-RPC client from `supportedInterfaces[0].url` and refuses to
 * run at all without at least one standard binding.
 *
 * `Agent Interface` schema is strict (additionalProperties:false) and allows
 * only { protocolBinding, protocolVersion, tenant, url }, so the emitted
 * interface carries exactly those keys — no extra metadata.
 */
export function buildV1AgentCard(opts: AgentCardOptions): Record<string, unknown> {
  const base = buildAgentCard(opts);

  /**
   * Build the fields explicitly rather than spreading the v0.3.0 card. The
   * v1.0 `Agent Card` schema is strict (additionalProperties:false): it has
   * no top-level `schema`, `url`, `protocolVersion`, `preferredTransport` or
   * `security`, and `AgentCapabilities` has no `stateTransitionHistory`.
   * `Agent Interface` is even stricter — exactly { protocolBinding,
   * protocolVersion, tenant, url } — so the first (and preferred) interface
   * carries only those keys.
   *
   * `pushNotifications` is deliberately false on the v1.0 wire: the bridge's
   * webhook delivery still speaks the v0.3.0 event shape and requires an auth
   * token + SSRF-safe public target, so it is NOT a conformant v1.0 push
   * implementation. Declaring false is honest: a v1.0 client skips those
   * operations instead of watching them fail, and the TCK's capability-gated
   * MUST cases (CORE-CAP-001 / CARD-EXT-*) take their documented skip/error
   * paths. Implementing the v1.0 push contract is tracked as follow-up work.
   *
   * `extendedAgentCard` is likewise omitted (not supported), which makes
   * GetExtendedAgentCard correctly answer UnsupportedOperationError (-32004).
   * Endpoint authentication is unchanged: it remains a standard HTTP
   * Authorization header on the RPC surface, not a card-declared scheme.
   */
  const card: Record<string, unknown> = {
    name: base.name,
    description: base.description,
    version: base.version,
    capabilities: {
      streaming: base.capabilities.streaming ?? false,
      pushNotifications: false,
    },
    defaultInputModes: base.defaultInputModes,
    defaultOutputModes: base.defaultOutputModes,
    skills: base.skills,
    supportedInterfaces: [
      {
        url: opts.endpointUrl,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ],
  };
  if (base.provider) card.provider = base.provider;
  if (base.documentationUrl) card.documentationUrl = base.documentationUrl;
  return card;
}
