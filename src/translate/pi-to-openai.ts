/**
 * Translates pi-ai AssistantMessage / AssistantMessageEventStream back into
 * OpenAI Chat Completions response envelopes (non-stream JSON + SSE chunks).
 *
 * Rules (per spec — see specs/active/...):
 *   - Single `id: chatcmpl-<random>` generated once per request, reused across
 *     every SSE chunk AND the non-stream envelope.
 *   - Multi-block content merge rule: thinking NEVER appears in non-stream
 *     `choices[].message.content` (string). During streaming, thinking_delta
 *     emits as `delta.reasoning_content` (OpenRouter / Ollama convention).
 *     Multiple text blocks concatenated with `\n\n` in non-stream.
 *   - Tool calls: pi-ai `ToolCall.arguments` (object) → `function.arguments`
 *     (JSON string).
 *   - `finish_reason` map: stop→stop, length→length, toolUse→tool_calls,
 *     error/aborted→stop (error carried in mid-stream error frame).
 *   - Mid-stream errors emit `data: {"error":{...}}\n\n` then close — NO
 *     trailing `data: [DONE]`. (OpenAI mid-stream convention; Open WebUI /
 *     Cursor expect this shape.)
 *   - `usage` block emitted on the final pre-`[DONE]` chunk unconditionally.
 *     Field map: pi-ai input → prompt_tokens, output → completion_tokens, sum
 *     → total_tokens.
 */
import { randomBytes } from "node:crypto";

import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  StopReason,
  Usage,
} from "@mariozechner/pi-ai";

export interface ChatCompletionJson {
  choices: {
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter";
    index: number;
    logprobs: null;
    message: {
      content: string | null;
      reasoning_content?: string;
      role: "assistant";
      tool_calls?: ChatCompletionToolCall[];
    };
  }[];
  created: number;
  id: string;
  model: string;
  object: "chat.completion";
  system_fingerprint: string;
  usage?: ChatCompletionUsage;
}

export interface ChatCompletionToolCall {
  function: { arguments: string; name: string };
  id: string;
  type: "function";
}

export interface ChatCompletionUsage {
  completion_tokens: number;
  prompt_tokens: number;
  total_tokens: number;
}

export function newChatCompletionId(): string {
  return `chatcmpl-${randomBytes(12).toString("hex")}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function translateResponse(input: {
  id: string;
  message: AssistantMessage;
  modelLabel: string;
}): ChatCompletionJson {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ChatCompletionToolCall[] = [];

  for (const block of input.message.content) {
    switch (block.type) {
      case "text":
        textParts.push(block.text);

        break;

      case "thinking":
        reasoningParts.push(block.thinking);

        break;

      case "toolCall": {
        const tc = block;
        toolCalls.push({
          function: { arguments: JSON.stringify(tc.arguments), name: tc.name },
          id: tc.id,
          type: "function",
        });

        break;
      }
      // No default
    }
  }

  const content = textParts.length > 0 ? textParts.join("\n\n") : null;
  const usage = mapUsage(input.message.usage);

  return {
    choices: [
      {
        finish_reason: mapStopReason(
          input.message.stopReason,
          toolCalls.length > 0,
        ),
        index: 0,
        logprobs: null,
        message: {
          content,
          role: "assistant",
          ...(reasoningParts.length > 0
            ? { reasoning_content: reasoningParts.join("\n\n") }
            : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    created: nowSeconds(),
    id: input.id,
    model: input.modelLabel,
    object: "chat.completion",
    system_fingerprint: SYSTEM_FINGERPRINT,
    usage,
  };
}

// Stable per-process fingerprint so caching clients see a consistent value.
// OpenAI shape is `fp_<hex>`.
const SYSTEM_FINGERPRINT = `fp_pi_${randomBytes(8).toString("hex")}`;

export function mapUsage(usage: Usage): ChatCompletionUsage {
  const prompt = usage.input ?? 0;
  const completion = usage.output ?? 0;
  return {
    completion_tokens: completion,
    prompt_tokens: prompt,
    total_tokens: usage.totalTokens ?? prompt + completion,
  };
}

export function mapStopReason(
  reason: StopReason,
  hasToolCalls: boolean,
): "stop" | "length" | "tool_calls" | "content_filter" {
  if (reason === "length") return "length";
  if (reason === "toolUse" || hasToolCalls) return "tool_calls";
  return "stop";
}

export interface SseChunkInit {
  created: number;
  id: string;
  modelLabel: string;
}

export interface SseEmitter {
  /** Write the terminator `data: [DONE]\n\n`. */
  done(): void;
  /** Emit an OpenAI mid-stream error frame and close WITHOUT [DONE]. */
  emitError(error: {
    code: string;
    message: string;
    param?: string;
    type: string;
  }): void;
  /** Send any SSE frame; caller provides the full payload object (will be JSON.stringify'd). */
  write(payload: unknown): void;
  /** Write a raw SSE field; used for heartbeat comment frames. */
  writeRaw(text: string): void;
}

/**
 * Drains a pi-ai event stream and emits OpenAI chat.completion.chunk frames.
 *
 * Yields control after every push. Caller provides an SseEmitter (HTTP res
 * adapter) that handles backpressure / write ordering.
 *
 * Returns the final assistant message (for non-stream callers that prefer to
 * batch via this same pipeline). Throws if the stream ended with error.
 */
export async function pipeStreamToSse(
  init: SseChunkInit,
  stream: AssistantMessageEventStream,
  emitter: SseEmitter,
): Promise<AssistantMessage> {
  let pendingFinish:
    | "stop"
    | "length"
    | "tool_calls"
    | "content_filter"
    | null = null;
  let finalMessage: AssistantMessage | null = null;
  let emittedRole = false;
  let errored = false;
  let errorPayload: { code: string; message: string; type: string } | null =
    null;

  // Track tool calls already emitted so we don't re-emit the same one across
  // partial.content snapshots from text deltas.
  const emittedToolCallIndices = new Set<number>();

  for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
    const e = event;
    switch (e.type) {
      case "start":
        if (!emittedRole) {
          emitter.write(makeChunk(init, { content: "", role: "assistant" }));
          emittedRole = true;
        }
        break;

      case "text_delta":
        if (!emittedRole) {
          emitter.write(makeChunk(init, { content: "", role: "assistant" }));
          emittedRole = true;
        }
        emitter.write(makeChunk(init, { content: e.delta }));
        break;

      case "thinking_delta":
        if (!emittedRole) {
          emitter.write(makeChunk(init, { content: "", role: "assistant" }));
          emittedRole = true;
        }
        emitter.write(makeChunk(init, { reasoning_content: e.delta }));
        break;

      case "text_end":
      case "text_start":
      case "thinking_start":
      case "thinking_end":
        // Look for newly-materialized tool calls in the partial.
        emitNewToolCalls(init, e.partial, emittedToolCallIndices, emitter);
        break;

      case "done":
        emitNewToolCalls(init, e.message, emittedToolCallIndices, emitter);
        finalMessage = e.message;
        pendingFinish = mapStopReason(e.reason, countToolCalls(e.message) > 0);
        break;

      case "error":
        finalMessage = e.error;
        errored = true;
        errorPayload = {
          code:
            e.reason === "aborted" ? "client_disconnected" : "provider_error",
          message: e.error.errorMessage ?? "stream ended with error",
          type: e.reason === "aborted" ? "request_aborted" : "upstream_error",
        };
        break;

      default:
        break;
    }
  }

  if (errored && errorPayload) {
    emitter.emitError(errorPayload);
    if (!finalMessage) throw new Error(errorPayload.message);
    return finalMessage;
  }

  // Final chunk carries finish_reason + usage. Per OpenAI shape, finish_reason
  // and content live in separate chunks but many servers fold them; we send a
  // closing chunk with finish_reason + usage on the same payload.
  if (finalMessage) {
    const usage = mapUsage(finalMessage.usage);
    emitter.write(
      makeChunk(init, {}, { finish_reason: pendingFinish ?? "stop", usage }),
    );
  } else {
    emitter.write(makeChunk(init, {}, { finish_reason: "stop" }));
  }
  emitter.done();
  if (!finalMessage) {
    throw new Error("stream ended without a final message");
  }
  return finalMessage;
}

function countToolCalls(message: AssistantMessage): number {
  let count = 0;
  for (const block of message.content) {
    if (block.type === "toolCall") count += 1;
  }
  return count;
}

function emitNewToolCalls(
  init: SseChunkInit,
  message: AssistantMessage,
  emitted: Set<number>,
  emitter: SseEmitter,
): void {
  let toolIndex = -1;
  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    toolIndex += 1;
    if (emitted.has(toolIndex)) continue;
    const tc = block;
    emitter.write(
      makeChunk(init, {
        tool_calls: [
          {
            function: {
              arguments: JSON.stringify(tc.arguments),
              name: tc.name,
            },
            id: tc.id,
            index: toolIndex,
            type: "function",
          },
        ],
      }),
    );
    emitted.add(toolIndex);
  }
}

interface ChunkDelta {
  content?: string;
  reasoning_content?: string;
  role?: "assistant";
  tool_calls?: {
    function: { arguments: string; name: string };
    id: string;
    index: number;
    type: "function";
  }[];
}

interface ChunkExtras {
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter";
  usage?: ChatCompletionUsage;
}

function makeChunk(
  init: SseChunkInit,
  delta: ChunkDelta,
  extras: ChunkExtras = {},
): Record<string, unknown> {
  const choice: Record<string, unknown> = {
    delta,
    index: 0,
    logprobs: null,
  };
  choice.finish_reason = extras.finish_reason ?? null;
  const payload: Record<string, unknown> = {
    choices: [choice],
    created: init.created,
    id: init.id,
    model: init.modelLabel,
    object: "chat.completion.chunk",
    system_fingerprint: SYSTEM_FINGERPRINT,
  };
  if (extras.usage) payload.usage = extras.usage;
  return payload;
}
