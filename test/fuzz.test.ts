import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { structured } from "../src/index.js";

// A fake fetch that streams the given byte-chunks as one SSE response body.
function sseFetch(chunks: string[]): typeof fetch {
  const enc = new TextEncoder();
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

// Build a single SSE payload (one event per OpenAI content delta) for a JSON string.
function openaiPayload(json: string, deltaCount: number): string {
  const size = Math.ceil(json.length / deltaCount);
  let payload = "";
  for (let i = 0; i < json.length; i += size) {
    const content = json.slice(i, i + size);
    payload += `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  }
  payload += "data: [DONE]\n\n";
  return payload;
}

// Split a string into N chunks at the given sorted cut points.
function splitAt(s: string, cuts: number[]): string[] {
  const points = [...new Set(cuts.filter((c) => c > 0 && c < s.length))].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = 0;
  for (const p of points) {
    out.push(s.slice(prev, p));
    prev = p;
  }
  out.push(s.slice(prev));
  return out;
}

const Obj = z.object({
  id: z.number(),
  name: z.string(),
  tags: z.array(z.string()),
  nested: z.object({ ok: z.boolean(), n: z.number() }),
});

async function run(chunks: string[]) {
  const stream = structured({ url: "https://x", fetch: sseFetch(chunks) }, Obj, {
    provider: "openai",
  });
  let last: unknown;
  for await (const p of stream) last = structuredClone(p);
  const value = await stream.value;
  return { last, value };
}

describe("structured — boundary-split parity", () => {
  it("final value and terminal partial are independent of how the stream is chunked", async () => {
    const json = JSON.stringify({
      id: 42,
      name: 'Ada "the analyst" Lovelace',
      tags: ["math", "engine", "notes"],
      nested: { ok: true, n: -3.14 },
    });
    const expected = JSON.parse(json);

    // Baseline: one SSE event carrying the whole JSON, delivered as one network chunk.
    const baseline = await run([openaiPayload(json, 1)]);
    expect(baseline.value).toEqual(expected);
    expect(baseline.last).toEqual(expected);

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 24 }), // how many content deltas to split the JSON into
        fc.array(fc.integer({ min: 1, max: 4000 }), { maxLength: 40 }), // arbitrary network cut points
        async (deltaCount, cuts) => {
          const payload = openaiPayload(json, deltaCount);
          const { last, value } = await run(splitAt(payload, cuts));
          expect(value).toEqual(expected);
          expect(last).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
  });
});
