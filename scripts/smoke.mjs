// Cross-runtime smoke test against the BUILT output (dist/).
// Runs under both Node and Bun to confirm the published package loads and works.
// No real network: a fake `fetch` streams an SSE body from in-memory chunks.
import assert from "node:assert/strict";
import { z } from "zod";
import { CoercionError, structured } from "../dist/index.js";

assert.equal(typeof structured, "function");
assert.equal(typeof CoercionError, "function");

const enc = new TextEncoder();

// A fake fetch that streams `chunks` as the SSE response body.
function sseFetch(chunks) {
  return async () => {
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

const frames = (...datas) => datas.map((d) => `data: ${d}\n\n`);

const User = z.object({ id: z.number(), name: z.string(), active: z.boolean() });

// Raw JSON stream, split across SSE events: partials grow, final value validates.
{
  const chunks = frames('{"id":4', '2,"name":"A', 'da","active":true}');
  const stream = structured({ url: "https://x", fetch: sseFetch(chunks) }, User);

  let count = 0;
  for await (const partial of stream) {
    count++;
    assert.equal(typeof partial, "object");
  }
  assert.ok(count > 1, "should yield multiple partial snapshots");

  const value = await stream.value;
  assert.deepEqual(value, { id: 42, name: "Ada", active: true });
}

// OpenAI envelope, auto-detected, with stringly-typed fields coerce-json repairs.
{
  const content = '{"id":"7","name":"Ed","active":"true"}';
  const evs = frames(JSON.stringify({ choices: [{ delta: { content } }] }), "[DONE]");
  const stream = structured({ url: "https://x", fetch: sseFetch(evs) }, User);
  const value = await stream.value;
  assert.deepEqual(value, { id: 7, name: "Ed", active: true });
  assert.ok((await stream.changes).length > 0, "coercion should report repairs");
}

// A value that can't satisfy the schema rejects with CoercionError.
{
  const stream = structured(
    { url: "https://x", fetch: sseFetch(frames('{"id":"nope","name":5}')) },
    User,
  );
  await assert.rejects(stream.value, (e) => e instanceof CoercionError);
}

console.log(`smoke ok (${typeof Bun !== "undefined" ? "bun" : "node"})`);
