import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CoercionError, structured } from "../src/index.js";

/** A fake `fetch` that streams `chunks` as the SSE response body, one Uint8Array per chunk. */
function sseFetch(chunks: string[], opts: { delayMs?: number } = {}): typeof fetch {
  const enc = new TextEncoder();
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const c of chunks) {
          if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
          controller.enqueue(enc.encode(c));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

/** Build SSE `data:` frames from raw strings. */
function frames(...datas: string[]): string[] {
  return datas.map((d) => `data: ${d}\n\n`);
}

/** Split a JSON string into N roughly equal character slices. */
function slice(s: string, n: number): string[] {
  const out: string[] = [];
  const size = Math.ceil(s.length / n);
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

const User = z.object({ id: z.number(), name: z.string(), active: z.boolean() });

describe("structured — raw JSON stream", () => {
  it("yields deep-partial snapshots and resolves a validated value", async () => {
    const json = '{"id":42,"name":"Ada","active":true}';
    const stream = structured(
      { url: "https://x", fetch: sseFetch(frames(...slice(json, 6))) },
      User,
    );

    const seen: unknown[] = [];
    for await (const partial of stream) seen.push(structuredClone(partial));

    // Partials grow toward the final object and never exceed it.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toEqual({ id: 42, name: "Ada", active: true });
    const value = await stream.value;
    expect(value).toEqual({ id: 42, name: "Ada", active: true });
    // A clean stream needs no type repairs — only the initial text->JSON parse.
    const changes = await stream.changes;
    expect(changes.every((c) => c.type === "parse-json-string")).toBe(true);
  });

  it("awaiting .value alone drives the stream (no iteration needed)", async () => {
    const json = '{"id":1,"name":"Bo","active":false}';
    const stream = structured({ url: "https://x", fetch: sseFetch(frames(json)) }, User);
    expect(await stream.value).toEqual({ id: 1, name: "Bo", active: false });
  });

  it("calls onPartial for each snapshot", async () => {
    const onPartial = vi.fn();
    const json = '{"id":2,"name":"Cy","active":true}';
    const stream = structured(
      { url: "https://x", fetch: sseFetch(frames(...slice(json, 4))) },
      User,
      { onPartial },
    );
    await stream.value;
    expect(onPartial).toHaveBeenCalled();
    expect(onPartial.mock.calls.at(-1)?.[0]).toEqual({ id: 2, name: "Cy", active: true });
  });

  it("runs the underlying fetch exactly once across both surfaces", async () => {
    const fetchImpl = vi.fn(sseFetch(frames('{"id":3,"name":"Di","active":true}')));
    const stream = structured({ url: "https://x", fetch: fetchImpl }, User);
    // Touch value, changes, and iterate.
    const p = stream.value;
    for await (const _ of stream) void _;
    await p;
    await stream.changes;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("structured — coercion", () => {
  it("repairs stringly-typed fields and reports the changes", async () => {
    const json = '{"id":"7","name":"Ed","active":"true"}';
    const stream = structured({ url: "https://x", fetch: sseFetch(frames(json)) }, User);
    const value = await stream.value;
    expect(value).toEqual({ id: 7, name: "Ed", active: true });
    expect((await stream.changes).length).toBeGreaterThan(0);
  });

  it("strips a markdown fence delivered inside content deltas", async () => {
    // The fence (with its newlines) rides inside the JSON-encoded content field,
    // so SSE framing stays intact; coerce-json strips it for the final value.
    const fenced = '```json\n{"id":9,"name":"Fi","active":false}\n```';
    const evs = frames(JSON.stringify({ choices: [{ delta: { content: fenced } }] }), "[DONE]");
    const stream = structured({ url: "https://x", fetch: sseFetch(evs) }, User, {
      provider: "openai",
    });
    expect(await stream.value).toEqual({ id: 9, name: "Fi", active: false });
  });

  it("rejects .value with CoercionError when the output can't satisfy the schema", async () => {
    const stream = structured(
      { url: "https://x", fetch: sseFetch(frames('{"id":"not-a-number","name":5}')) },
      User,
    );
    await expect(stream.value).rejects.toBeInstanceOf(CoercionError);
    // changes still resolve (they describe what was attempted).
    await expect(stream.changes).resolves.toBeInstanceOf(Array);
  });
});

describe("structured — provider envelopes", () => {
  it("auto-detects and decodes OpenAI content deltas", async () => {
    const parts = ['{"id":', "11,", '"name":', '"Gu",', '"active":true}'];
    const evs = frames(
      ...parts.map((p) => JSON.stringify({ choices: [{ delta: { content: p } }] })),
      "[DONE]",
    );
    const stream = structured({ url: "https://x", fetch: sseFetch(evs) }, User);
    expect(await stream.value).toEqual({ id: 11, name: "Gu", active: true });
  });

  it("auto-detects and decodes Anthropic text deltas", async () => {
    const parts = ['{"id":12,', '"name":"Ha",', '"active":false}'];
    const evs = frames(
      ...parts.map((p) =>
        JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: p } }),
      ),
    );
    const stream = structured({ url: "https://x", fetch: sseFetch(evs) }, User);
    expect(await stream.value).toEqual({ id: 12, name: "Ha", active: false });
  });

  it("respects an explicit provider over auto-detection", async () => {
    const evs = frames(
      JSON.stringify({ choices: [{ delta: { content: '{"id":13,"name":"Ix","active":true}' } }] }),
    );
    const stream = structured({ url: "https://x", fetch: sseFetch(evs) }, User, {
      provider: "openai",
    });
    expect(await stream.value).toEqual({ id: 13, name: "Ix", active: true });
  });
});

describe("structured — tool-call mode", () => {
  const Args = z.object({ city: z.string(), units: z.string() });

  it("accumulates OpenAI tool_call arguments", async () => {
    const argParts = ['{"city":', '"Paris",', '"units":"c"}'];
    const evs = frames(
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: "weather", arguments: "" } }] } },
        ],
      }),
      ...argParts.map((a) =>
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: a } }] } }],
        }),
      ),
      "[DONE]",
    );
    const stream = structured({ url: "https://x", fetch: sseFetch(evs) }, Args, {
      provider: "openai",
      mode: "tool",
      tool: "weather",
    });
    expect(await stream.value).toEqual({ city: "Paris", units: "c" });
  });

  it("decodes Anthropic input_json_delta in tool mode", async () => {
    const evs = frames(
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"city":"Rome",' },
      }),
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '"units":"c"}' },
      }),
    );
    const stream = structured({ url: "https://x", fetch: sseFetch(evs) }, Args, {
      provider: "anthropic",
      mode: "tool",
    });
    expect(await stream.value).toEqual({ city: "Rome", units: "c" });
  });
});

describe("structured — abort & errors", () => {
  it("abort() ends iteration and rejects pending promises", async () => {
    const json = '{"id":20,"name":"Jo","active":true}';
    const stream = structured(
      { url: "https://x", fetch: sseFetch(frames(...slice(json, 10)), { delayMs: 5 }) },
      User,
    );
    const iterate = (async () => {
      const seen: unknown[] = [];
      try {
        for await (const p of stream) {
          seen.push(p);
          stream.abort(new Error("stop"));
        }
      } catch {
        /* aborting surfaces as a throw; that's fine */
      }
      return seen;
    })();
    await expect(stream.value).rejects.toBeTruthy();
    await iterate; // does not hang
  });

  it("forwards an external AbortSignal", async () => {
    const ac = new AbortController();
    ac.abort(new Error("pre-aborted"));
    const stream = structured(
      { url: "https://x", fetch: sseFetch(frames('{"id":1,"name":"x","active":true}')) },
      User,
      { signal: ac.signal },
    );
    await expect(stream.value).rejects.toBeTruthy();
  });

  it("rejects when fetch returns a non-2xx response", async () => {
    const badFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const stream = structured({ url: "https://x", fetch: badFetch }, User);
    await expect(stream.value).rejects.toBeTruthy();
  });
});
