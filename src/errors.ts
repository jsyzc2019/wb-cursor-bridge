/** Typed error classes so failures carry a machine-readable code. */

export type BridgeErrorCode =
  | 'E_CONFIG'
  | 'E_PATH_DENIED'
  | 'E_NOT_FOUND'
  | 'E_CONCURRENCY'
  | 'E_TIMEOUT'
  | 'E_SPAWN'
  | 'E_BAD_ARGUMENT'
  | 'E_INTERNAL';

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly detail?: unknown;

  constructor(code: BridgeErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.detail = detail;
  }
}

export const badArgument = (m: string, d?: unknown) =>
  new BridgeError('E_BAD_ARGUMENT', m, d);
export const pathDenied = (m: string, d?: unknown) =>
  new BridgeError('E_PATH_DENIED', m, d);
export const notFound = (m: string, d?: unknown) =>
  new BridgeError('E_NOT_FOUND', m, d);
export const concurrency = (m: string, d?: unknown) =>
  new BridgeError('E_CONCURRENCY', m, d);
export const spawnFailed = (m: string, d?: unknown) =>
  new BridgeError('E_SPAWN', m, d);
export const badConfig = (m: string, d?: unknown) =>
  new BridgeError('E_CONFIG', m, d);