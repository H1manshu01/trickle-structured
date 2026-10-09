# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-09

Initial public release — stream a typed, schema-validated object out of an LLM
in one call. The capstone of the suite: it composes `sse-wire` (transport),
`trickle-json` (incremental parse), and `coerce-json` (validate + repair) into a
single framework-agnostic helper.

### Added
- **`structured(request, schema, options?) → StructuredStream<T>`** — opens an
  SSE request lazily (runs once, no matter how many surfaces are used) and
  returns a dual-surface stream. `request` is the URL plus fetch init handed to
  `sse-wire`; `schema` is a Zod schema, a JSON Schema, or a raw coerce-json spec,
  with `T` inferred from Zod.
- **`StructuredStream<T>`** — an `AsyncIterable<DeepPartial<T>>` that also
  exposes:
  - **`value: Promise<T>`** — resolves with the validated, coerced result when
    the stream ends; rejects with a `CoercionError` if the output can't satisfy
    the schema even after repair. Awaiting it alone drives the stream to
    completion.
  - **`changes: Promise<Change[]>`** — every repair coerce-json applied to
    produce `value` (resolves even when `value` rejects).
  - **`abort(reason?)`** — cancels the underlying fetch; iteration ends and the
    promises reject.
- **Provider envelope extraction** — built-in decoders for **OpenAI**
  (`choices[0].delta.content`) and **Anthropic** (`content_block_delta`), with
  auto-detection from the first event (falling back to treating `event.data` as
  raw JSON text). Overridable via `provider`, or a custom `extract(event)`.
  Named decoders are exported: `openaiContent`, `anthropicContent`,
  `openaiToolArgs`, `anthropicToolArgs`.
- **Tool-call mode** — `mode: "tool"` (with an optional `tool` name) streams a
  function/tool-call's JSON arguments instead of message content, for both
  OpenAI (`tool_calls[].function.arguments`) and Anthropic (`input_json_delta`).
- **`onPartial`** callback and `coerce` pass-through options; external
  cancellation via `signal`.
- **`CoercionError`** carrying `.value` (best-effort coerced value) and
  `.changes` (repairs attempted).
- Ships ESM + CJS + `.d.ts`. Orchestration layer ~1.2 kB min+brotli (its three
  dependencies are separate, deduped packages). Node ≥ 18 and modern browsers.
  `zod` is an optional peer.

[0.1.0]: https://github.com/H1manshu01/trickle-structured/releases/tag/v0.1.0
