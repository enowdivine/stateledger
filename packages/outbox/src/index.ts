/**
 * @stateledger/outbox — transactional outbox for stateledger.
 *
 * Public API:
 *
 *   import {
 *     enqueue,
 *     enqueueBatch,
 *     createWorker,
 *     OUTBOX_SCHEMA_STATEMENTS,
 *     OUTBOX_SCHEMA_SQL,
 *   } from "@stateledger/outbox";
 */

export { enqueue, enqueueBatch } from "./enqueue.js";
export { createWorker, defaultBackoffMs } from "./worker.js";
export {
  OUTBOX_SCHEMA_STATEMENTS,
  OUTBOX_SCHEMA_SQL,
} from "./schema-sql.js";

export {
  OutboxError,
  OutboxAdapterError,
  UnknownKindError,
} from "./errors.js";

export type {
  OutboxTx,
  OutboxRecord,
  OutboxStatus,
  EnqueueInput,
  OutboxHandler,
  HandlerRegistry,
  WorkerConfig,
  WorkerEvent,
  WorkerHandle,
} from "./types.js";
