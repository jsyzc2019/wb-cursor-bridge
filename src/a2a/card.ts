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
