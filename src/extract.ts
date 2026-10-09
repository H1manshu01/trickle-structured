/**
 * Turn a parsed SSE event into the next fragment of JSON text.
 *
 * Providers wrap model output in different envelopes; these extractors unwrap
 * the common ones. In `"object"` mode we pull message content; in `"tool"` mode
 * we pull the streamed arguments of a tool/function call. When no provider is
 * given we sniff the first event and pick one, falling back to treating
 * `event.data` as the raw JSON text.
 */
import type { SSEEvent } from "sse-wire";
import type { Extractor, StructuredOptions } from "./types.js";

// Provider envelopes are untyped JSON; `any` keeps the field-sniffing readable.
type Json = any;

function parseData(event: SSEEvent): Json | null | undefined {
  const data = event.data?.trim();
  if (!data || data === "[DONE]") return null; // nothing to decode
  try {
    return JSON.parse(data);
  } catch {
    return undefined; // not JSON — caller treats event.data as raw text
  }
}

/** OpenAI chat completions: `choices[0].delta.content`. */
export function openaiContent(event: SSEEvent): string | null {
  const o = parseData(event);
  if (!o) return null;
  const c = o.choices?.[0]?.delta?.content;
  return typeof c === "string" && c.length > 0 ? c : null;
}

/** Anthropic messages: `content_block_delta` text (or tool input_json) deltas. */
export function anthropicContent(event: SSEEvent): string | null {
  const o = parseData(event);
  if (!o) return null;
  const d = o.delta;
  if (d?.type === "text_delta" && typeof d.text === "string") return d.text;
  if (d?.type === "input_json_delta" && typeof d.partial_json === "string") return d.partial_json;
  return null;
}

/** Raw: `event.data` is itself the JSON text (or a fragment of it). */
function rawContent(event: SSEEvent): string | null {
  const data = event.data;
  if (!data || data.trim() === "[DONE]") return null;
  return data;
}

/**
 * OpenAI tool/function call: accumulate `delta.tool_calls[…].function.arguments`.
 * When a `name` is given, lock onto that call's index once it is announced;
 * otherwise follow index 0.
 */
export function openaiToolArgs(name?: string): Extractor {
  let index = name ? -1 : 0; // -1 = haven't seen the named call yet
  return (event) => {
    const o = parseData(event);
    if (!o) return null;
    const calls = o.choices?.[0]?.delta?.tool_calls;
    if (!Array.isArray(calls)) return null;
    let out = "";
    for (const c of calls) {
      const ci = typeof c.index === "number" ? c.index : 0;
      if (name && c.function?.name === name) index = ci;
      if (ci === index && typeof c.function?.arguments === "string") out += c.function.arguments;
    }
    return out.length > 0 ? out : null;
  };
}

/** Anthropic tool use: `input_json_delta.partial_json` fragments. */
export function anthropicToolArgs(): Extractor {
  return (event) => {
    const o = parseData(event);
    if (!o) return null;
    const d = o.delta;
    if (d?.type === "input_json_delta" && typeof d.partial_json === "string") return d.partial_json;
    return null;
  };
}

/** Sniff the first decodable event, then commit to one extractor for the rest. */
function autoExtractor(tool: boolean, name?: string): Extractor {
  let chosen: Extractor | null = null;
  const nullExtractor: Extractor = () => null;
  return (event) => {
    if (!chosen) {
      const o = parseData(event);
      if (o === null) return null; // [DONE]/blank — stay undecided
      if (o === undefined) {
        chosen = tool ? nullExtractor : rawContent; // not JSON → raw text fragments
      } else if (o.choices) {
        chosen = tool ? openaiToolArgs(name) : openaiContent;
      } else if (typeof o.type === "string" && o.type.startsWith("content_block")) {
        chosen = tool ? anthropicToolArgs() : anthropicContent;
      } else if (o.delta?.type) {
        chosen = tool ? anthropicToolArgs() : anthropicContent;
      } else {
        chosen = tool ? nullExtractor : rawContent; // JSON, unknown envelope → treat as raw
      }
    }
    return chosen(event);
  };
}

/** Resolve the extractor implied by the options. */
export function resolveExtractor<T>(options: StructuredOptions<T>): Extractor {
  if (options.extract) return options.extract;
  const tool = options.mode === "tool";
  if (options.provider === "openai") return tool ? openaiToolArgs(options.tool) : openaiContent;
  if (options.provider === "anthropic") return tool ? anthropicToolArgs() : anthropicContent;
  return autoExtractor(tool, options.tool);
}
