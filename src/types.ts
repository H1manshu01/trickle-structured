import type { Change, CoerceOptions } from "coerce-json";
import type { SSEEvent, SSEInit } from "sse-wire";

/**
 * Every property of `T` made recursively optional. This is the shape of an
 * in-progress value: as tokens arrive, fields appear and fill in, so any field
 * (at any depth) may still be missing.
 */
export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Minimal schema contract: anything with a Zod-style `safeParse`. */
export interface SchemaLike<T = unknown> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error?: unknown };
}

/** Infer the validated output type of a {@link SchemaLike}. */
export type Infer<S> = S extends SchemaLike<infer T> ? T : unknown;

/**
 * Where to stream from. This is the request handed to the underlying SSE
 * transport: a URL plus the usual fetch init (method, headers, body, …). The
 * abort signal lives in {@link StructuredOptions.signal} instead.
 */
export type StructuredRequest = { url: string | URL } & Omit<SSEInit, "signal">;

/** Pull the text delta out of one SSE event, or `null` to skip it. */
export type Extractor = (event: SSEEvent) => string | null;

export interface StructuredOptions<T = unknown> {
  /**
   * Response envelope to decode. `"openai"` reads `choices[0].delta.content`,
   * `"anthropic"` reads `content_block_delta`. Omit to auto-detect from the
   * first event (falling back to treating `event.data` as the raw JSON text).
   */
  provider?: "openai" | "anthropic";
  /** Custom extractor, taking precedence over {@link provider}. */
  extract?: Extractor;
  /** `"tool"` decodes a streamed tool/function-call's JSON arguments instead of message content. */
  mode?: "object" | "tool";
  /** In `"tool"` mode, the tool/function name to follow when the response has several. */
  tool?: string;
  /** Passed through to coerce-json for the final {@link StructuredStream.value}. */
  coerce?: CoerceOptions;
  /** Abort the stream (also abortable via {@link StructuredStream.abort}). */
  signal?: AbortSignal | null;
  /** Called with every partial snapshot as it is produced. */
  onPartial?: (partial: DeepPartial<T>) => void;
}

/**
 * The dual-surface result of {@link structured}. It is an async-iterable of
 * {@link DeepPartial} snapshots (one per decoded chunk), and it also exposes a
 * promise for the final, schema-validated value.
 */
export interface StructuredStream<T> extends AsyncIterable<DeepPartial<T>> {
  /** Resolves with the validated value when the stream ends; rejects with {@link CoercionError} if it never satisfies the schema. */
  readonly value: Promise<T>;
  /** Resolves with every repair coerce-json applied to produce {@link value}. */
  readonly changes: Promise<Change[]>;
  /** Abort the underlying stream. Iteration ends and pending promises reject. */
  abort(reason?: unknown): void;
}

/** Thrown from {@link StructuredStream.value} when the streamed output never satisfies the schema. */
export class CoercionError extends Error {
  /** The best-effort coerced value that still failed validation. */
  readonly value: unknown;
  /** Every repair coerce-json attempted before giving up. */
  readonly changes: Change[];
  constructor(value: unknown, changes: Change[]) {
    super("trickle-structured: the streamed value did not satisfy the schema after coercion");
    this.name = "CoercionError";
    this.value = value;
    this.changes = changes;
  }
}
