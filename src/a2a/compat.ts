/**
 * A2A protocol-version compatibility layer.
 *
 * The bridge ships a faithful v0.3.0 wire implementation today. A2A v1.0 is a
 * backward-incompatible revision of the data model (the Part/FileContent shape
 * changed, and `protocolVersion` moved off the Agent Card top level into
 * `supportedInterfaces`). Rather than fork the engine, this module is a
 * *serialisation boundary* that translates the single internal v0.3.0 model the
 * bridge already produces into v1.0-shaped JSON when a client opts in. This is
 * the lowest-risk path to v1.0 interop and keeps the migration incremental:
 * flip one config knob, the same Jobs/store/engine keep running.
 *
 * v1.0 field mapping applied here:
 *   FileContent.name        -> filename
 *   FileContent.mimeType    -> mediaType
 *   FileContent.uri         -> url
 *   FileContent.bytes_inline -> raw   (base64 inline content)
 *   AgentCard.protocolVersion (top-level) -> supportedInterfaces[].protocolVersion
 *   AgentCard.extensions    -> []      (v1.0 introduced the extensions array)
 */

export type A2AVersion = '0.3.0' | '1.0';

import type { AgentCard, Task } from './types.js';

/**
 * Translate a v0.3.0 Task into v1.0-shaped JSON. The Task type itself is mostly
 * stable across versions (id / contextId / status / artifacts / history /
 * metadata all survive), so only the FileContent parts need remapping.
 */
export function toV1Task(task: Task): Task {
  const out: Task = { ...task };
  if (Array.isArray(task.artifacts)) {
    out.artifacts = task.artifacts.map((a) => ({
      ...a,
      parts: a.parts.map((p) => {
        if (p.kind !== 'file' || !p.file) return p;
        const { name, mimeType, uri, bytes_inline, ...rest } = p.file;
        return {
          kind: 'file',
          file: {
            ...rest,
            filename: name,
            mediaType: mimeType,
            url: uri,
            raw: bytes_inline,
            // `rest` already excludes the v0.3.0 names, so a strict v1.0 client
            // never sees `name`/`mimeType`/`uri`/`bytes_inline`.
          } as Record<string, unknown>,
        };
      }),
    }));
  }
  return out;
}

/**
 * Translate a v0.3.0 Agent Card into the v1.0 shape: drop the top-level
 * `protocolVersion`, advertise it under `supportedInterfaces`, and add the v1.0
 * `extensions` array. Other fields (capabilities, skills, securitySchemes) carry
 * over unchanged.
 */
export function toV1Card(card: AgentCard, endpointUrl: string): AgentCard {
  const { protocolVersion, ...rest } = card;
  void protocolVersion;
  return {
    ...rest,
    supportedInterfaces: [
      { protocolVersion: '1.0', url: endpointUrl },
      ...(rest.supportedInterfaces ?? []),
    ],
    extensions: [],
  };
}

/** Whether an Agent Card should be emitted in v1.0 shape. */
export function isV1(version: A2AVersion | undefined): boolean {
  return version === '1.0';
}
