/**
 * trickle-structured — stream a typed, schema-validated object out of an LLM.
 *
 * One call wires three tiny libraries into a pipeline:
 *
 *   sse-wire (transport)  →  trickle-json (incremental parse)  →  coerce-json (validate)
 *
 * As tokens arrive, each decoded fragment is fed to an incremental JSON parser,
 * and the best-effort snapshot is yielded as a {@link DeepPartial}. When the
 * stream ends cleanly, the accumulated text is coerced and validated against the
 * schema to produce the final `.value`.
 *
 * The returned object is consumed in whichever way suits you: iterate it for
 * live partials, await `.value` for the final result, or both. The underlying
 * stream runs exactly once no matter how many surfaces you touch.
 */
import { coerce } from "coerce-json";
import type { Change } from "coerce-json";
import { sse } from "sse-wire";
import { IncrementalParser } from "trickle-json";
import { resolveExtractor } from "./extract.js";
import { CoercionError } from "./types.js";
import type {
  DeepPartial,
  Infer,
  SchemaLike,
  StructuredOptions,
  StructuredRequest,
  StructuredStream,
} from "./types.js";

export function structured<S extends SchemaLike, T = Infer<S>>(
  request: StructuredRequest,
  schema: S,
  options: StructuredOptions<T> = {},
): StructuredStream<T> {
  // One controller drives aborts, whether from options.signal or .abort().
  const controller = new AbortController();
  const external = options.signal;
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else
      external.addEventListener("abort", () => controller.abort(external.reason), { once: true });
  }
  const { signal } = controller;
  const extract = resolveExtractor(options);

  // Snapshots buffer here; iterators replay from index 0, so awaiting `.value`
  // without iterating still works (the pump just fills the buffer unread).
  const partials: Array<DeepPartial<T>> = [];
  let finished = false;
  let failure: unknown;
  let hasFailure = false;
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const w of waiters) w();
    waiters.clear();
  };

  let resolveValue!: (v: T) => void;
  let rejectValue!: (e: unknown) => void;
  const valuePromise = new Promise<T>((res, rej) => {
    resolveValue = res;
    rejectValue = rej;
  });
  let resolveChanges!: (c: Change[]) => void;
  let rejectChanges!: (e: unknown) => void;
  const changesPromise = new Promise<Change[]>((res, rej) => {
    resolveChanges = res;
    rejectChanges = rej;
  });
  // A consumer may touch only one surface; keep the other from being an
  // unhandled rejection without swallowing it for whoever does await.
  valuePromise.catch(() => {});
  changesPromise.catch(() => {});

  let started = false;
  function start(): void {
    if (started) return;
    started = true;
    void pump();
  }

  async function pump(): Promise<void> {
    const parser = new IncrementalParser();
    let text = "";
    try {
      const { url, ...init } = request;
      for await (const event of sse(url, { ...init, signal })) {
        const delta = extract(event);
        if (delta == null) continue;
        text += delta;
        parser.writeChunk(delta);
        const snap = (parser.snapshot() ?? {}) as DeepPartial<T>;
        partials.push(snap);
        options.onPartial?.(snap);
        wake();
      }
      const result = coerce(text, schema as never, options.coerce);
      resolveChanges(result.changes as Change[]);
      if (result.ok) resolveValue(result.value as T);
      else rejectValue(new CoercionError(result.value, result.changes as Change[]));
    } catch (err) {
      failure = err;
      hasFailure = true;
      rejectValue(err);
      rejectChanges(err);
    } finally {
      finished = true;
      wake();
    }
  }

  async function* iterate(): AsyncGenerator<DeepPartial<T>> {
    start();
    let i = 0;
    for (;;) {
      while (i < partials.length) {
        yield partials[i++] as DeepPartial<T>;
      }
      if (finished) {
        if (hasFailure) throw failure;
        return;
      }
      await new Promise<void>((resolve) => waiters.add(resolve));
    }
  }

  return {
    [Symbol.asyncIterator]: iterate,
    get value(): Promise<T> {
      start();
      return valuePromise;
    },
    get changes(): Promise<Change[]> {
      start();
      return changesPromise;
    },
    abort(reason?: unknown): void {
      controller.abort(reason);
    },
  };
}
