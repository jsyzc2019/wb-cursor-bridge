/** Public surface of the shared Action layer (P1). */
export type { Action, ActionContext, JsonObjectSchema } from './types.js';
export {
  ACTIONS,
  getAction,
  actionNames,
  toolDefinitions,
  runAction,
  statusAction,
  replyAction,
  cancelAction,
  listAction,
  diffAction,
  healthAction,
  statsAction,
  shutdownAction,
} from './registry.js';
export type {
  ErasedAction,
  RunArgs,
  StatusArgs,
  ReplyArgs,
  CancelArgs,
  ListArgs,
  DiffArgs,
  DiffPayload,
  ShutdownArgs,
} from './registry.js';
export { str, num, enumOf, bool, clamp } from './validate.js';
