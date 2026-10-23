/**
 * Parser for the Cursor CLI `--output-format stream-json` protocol.
 *
 * Cursor's stream format has shifted across releases (and the CLI is still
 * beta), so the parser is deliberately permissive: every field is optional and
 * a change in shape degrades the summary rather than crashing the job.
 *
 * Observed and handled shapes:
 *   {"type":"system","subtype":"init","thread_id":"...","model":"..."}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"tool_call","tool_call":{"readToolCall":{"args":{"path":"..."}}}}
 *   {"type":"result","result":"final text","thread_id":"..."}
 */
export interface ParsedEvent {
  kind: 'init' | 'text' | 'tool' | 'result' | 'error' | 'other';
  text?: string;
  tool?: string;
  target?: string;
  threadId?: string;
  model?: string;
  isError?: boolean;
}

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

/** Parse one NDJSON line. Returns null for blank or non-object input. */
export function parseStreamLine(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;

  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;

  const type = typeof msg.type === 'string' ? msg.type : '';

  // Thread id has appeared under several names across CLI versions.
  const threadId = pickString(msg.thread_id, msg.threadId, msg.session_id, msg.sessionId);

  if (type === 'system' && msg.subtype === 'init') {
    return { kind: 'init', threadId, model: pickString(msg.model) };
  }

  if (type === 'assistant') {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (block && typeof block.text === 'string') parts.push(block.text);
      }
      if (parts.length > 0) {
        return { kind: 'text', text: parts.join(''), threadId };
      }
    }
    return { kind: 'text', text: pickString(msg.text) ?? '', threadId };
  }

  if (type === 'tool_call') {
    const call = msg.tool_call ?? msg.toolCall ?? {};
    for (const [key, value] of Object.entries(call)) {
      if (!value || typeof value !== 'object') continue;
      const name = key.endsWith('ToolCall')
        ? key.replace(/ToolCall$/, '').toLowerCase()
        : key.toLowerCase();
      const args = (value as any).args ?? {};
      const target = pickString(args.path, args.file_path, args.command, args.url, args.pattern);
      return { kind: 'tool', tool: name, target, threadId };
    }
    return { kind: 'tool', tool: 'unknown', threadId };
  }

  if (type === 'result' || type === 'error') {
    const isError = type === 'error' || msg.is_error === true || msg.isError === true;
    const text = pickString(msg.result, msg.text, msg.error, msg.message);
    if (threadId) return { kind: isError ? 'error' : 'result', text, threadId, isError };
    return { kind: isError ? 'error' : 'result', text, isError };
  }

  return { kind: 'other', threadId };
}

/**
 * Human-readable one-line summary of a tool call, for polling UIs.
 */
export function describeTool(ev: ParsedEvent): string {
  if (ev.kind !== 'tool') return '';
  const tool = ev.tool ?? 'tool';
  return ev.target ? `${tool} ${ev.target}` : tool;
}