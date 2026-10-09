---
title: "One call, from fetch to a validated object — streaming structured output without the plumbing"
published: false
description: "Streaming a typed object out of an LLM means wiring three awkward steps: read the SSE envelope, parse JSON that's broken until the last token, then validate and repair the result. Here's trickle-structured — one framework-agnostic call that does all three, yielding typed partials as tokens arrive and a validated value at the end."
tags: typescript, ai, javascript, opensource
series: "Streaming structured output"
cover_image: https://raw.githubusercontent.com/H1manshu01/trickle-structured/main/assets/cover.png
---

You asked the model for a JSON object and set `stream: true`, because you want the UI (or the next step) to start the moment the first field lands instead of blocking on the last token. Then you're here:

```ts
const res = await fetch(url, { method: "POST", body });
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buf = "", json = "";

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  for (const line of buf.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    json += JSON.parse(payload).choices[0].delta.content ?? ""; // provider-specific
    try { setState(JSON.parse(json)); } catch {} // 💥 throws on every partial
  }
  buf = buf.slice(buf.lastIndexOf("\n") + 1);
}

const final = Schema.parse(JSON.parse(json)); // 💥 and throws here if the model added a trailing comma
```

Three separate problems are tangled together in that loop:

1. **The transport.** SSE framing by hand — splitting on newlines, handling a frame split across two network chunks, skipping `[DONE]`.
2. **The partial parse.** `JSON.parse(json)` throws on every chunk until the object is complete, so you get nothing to render in the meantime.
3. **The validation.** At the end you still have to validate — and models emit trailing commas, wrap JSON in ` ```json ` fences, and send `"true"` where you wanted `true`, so a strict `.parse()` rejects output that's *almost* right.

Each of those is a small, well-defined job. I built one tiny zero-dependency package for each — and then one more that wires them together.

## One call

```ts
import { structured } from "trickle-structured";
import { z } from "zod";

const User = z.object({ id: z.number(), name: z.string(), active: z.boolean() });

const stream = structured(
  {
    url: "https://api.openai.com/v1/chat/completions",
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      stream: true,
      response_format: { type: "json_object" },
      messages,
    }),
  },
  User,
);

for await (const partial of stream) {
  render(partial);              // {}, { id: 42 }, { id: 42, name: "Ad" }, … typed as DeepPartial<User>
}

const user = await stream.value; // User — validated, and repaired if the model slipped
```

That's the whole thing. No reader loop, no `try/catch` around `JSON.parse`, no provider-specific envelope code, no separate validation step.

## One stream, two surfaces

The return value is both an **async iterable** of partial snapshots and a holder for the **final promise**:

```ts
const stream = structured(request, User);

// iterate for live partials…
for await (const partial of stream) updateUI(partial);

// …and/or await the validated result
const user = await stream.value;        // User
const repairs = await stream.changes;   // what coerce-json had to fix
```

- Each `partial` is a `DeepPartial<User>` — every field optional at every depth, because the object is still being built. Perfect for rendering skeletons that fill in.
- `.value` resolves once the stream ends, with the **validated and coerced** result. If the output can't satisfy the schema even after repair, it rejects with a typed `CoercionError` carrying everything that was attempted.
- The underlying fetch runs **exactly once**, no matter which surface you touch. Awaiting `.value` without iterating still drains the stream; iterating without awaiting `.value` never leaves a dangling rejection.

## It composes three tiny packages

`trickle-structured` is the capstone of a small stack. The pipeline is literally the dependency list:

```
fetch → SSE (sse-wire) → parse partial JSON (trickle-json) → validate + repair (coerce-json)
```

- **[sse-wire](https://www.npmjs.com/package/sse-wire)** — fetch-based SSE: the POST, custom headers, and `AbortSignal` that the browser's `EventSource` can't do.
- **[trickle-json](https://www.npmjs.com/package/trickle-json)** — an incremental partial-JSON parser that returns the best valid value on every chunk, in O(n) total regardless of how the bytes are split.
- **[coerce-json](https://www.npmjs.com/package/coerce-json)** — repairs and coerces almost-valid model JSON to fit your schema (strips fences, fixes `"7"`→`7`), and logs every change.

Each is useful on its own; `trickle-structured` is the one import when you want all three wired correctly.

## Providers are handled

OpenAI and Anthropic wrap model output in different SSE envelopes. `trickle-structured` decodes both, and **auto-detects** from the first event when you don't say which:

```ts
structured(request, Schema);                          // sniffs the first event
structured(request, Schema, { provider: "anthropic" }); // or be explicit
structured(request, Schema, { extract: (e) => JSON.parse(e.data).output?.text ?? null }); // or bring your own
```

## Tool calls too

More and more, models return structured data as a **tool/function call**, where the object lands in the call's `arguments` rather than in message content. Same pipeline, one flag:

```ts
const WeatherArgs = z.object({ city: z.string(), units: z.enum(["c", "f"]) });

const stream = structured(request, WeatherArgs, {
  provider: "openai",
  mode: "tool",
  tool: "get_weather",
});

const args = await stream.value; // { city: "Paris", units: "c" }
```

## Using React?

`trickle-structured` is deliberately framework-agnostic — a plain async iterable plus a promise. For React, [`trickle-react`](https://www.npmjs.com/package/trickle-react) wraps the same pipeline in a `useStreamingObject` hook with per-field status and lifecycle-aware abort. Same stack, different top layer.

## Try it

```sh
npm install trickle-structured
npm install zod   # optional peer, only if you pass a Zod schema
```

- **npm:** https://www.npmjs.com/package/trickle-structured
- **GitHub:** https://github.com/H1manshu01/trickle-structured

The orchestration layer is ~1.2 kB min+brotli (its three dependencies are separate, deduped packages). ESM + CJS + `.d.ts`, Node ≥ 18 and modern browsers, published with provenance. Tested with a 200-run byte-split fuzz that proves the final value is identical no matter how the stream is chunked.

If it mis-parses something, open an issue with the stream and the schema — a ⭐ is appreciated if it saves you a reader loop and a pile of `try/catch`.
