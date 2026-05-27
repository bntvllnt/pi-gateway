/**
 * Translates an OpenAI Chat Completions request into a pi-ai Context.
 *
 * Key rules:
 *   - The FIRST system / developer message becomes `Context.systemPrompt`.
 *   - Subsequent system / developer messages are folded into a user message
 *     prefix (rare; OpenAI clients almost never send these).
 *   - user / assistant / tool messages translate 1:1 to pi-ai
 *     UserMessage / AssistantMessage / ToolResultMessage.
 *   - Assistant `tool_calls[].function.arguments` (JSON string) is parsed back
 *     into the pi-ai `ToolCall.arguments` object shape.
 *   - For inbound `role: "tool"` messages, the OpenAI contract carries only
 *     `tool_call_id`; pi-ai's `ToolResultMessage` requires `toolName`. We
 *     recover toolName by scanning the messages array for the matching
 *     `assistant.tool_calls[].id`. Stateless per-request lookup.
 *   - Image inputs are forwarded only as `image` content blocks; the caller is
 *     responsible for rejecting if the model lacks image support.
 *   - No system prompt, no tools, no skills are injected by pi-gateway.
 */
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

import type {
  ChatMessage,
  ChatToolDefinition,
} from "../protocol/chat-completions.js";

export interface TranslateRequestOptions {
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
}

export interface TranslatedRequest {
  context: Context;
}

export function translateRequest(
  input: TranslateRequestOptions,
): TranslatedRequest {
  let systemPrompt: string | undefined;
  const piMessages: Message[] = [];
  const toolCallNames = new Map<string, string>();

  let consumedFirstSystem = false;
  const now = Date.now();

  for (const msg of input.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = contentToString(msg.content);
      if (!consumedFirstSystem) {
        systemPrompt = text;
        consumedFirstSystem = true;
      } else if (systemPrompt) {
        systemPrompt = `${systemPrompt}\n\n${text}`;
      } else {
        systemPrompt = text;
      }
      continue;
    }

    if (msg.role === "user") {
      const userContent = translateUserContent(msg.content);
      const piUser: UserMessage = {
        content: userContent,
        role: "user",
        timestamp: now,
      };
      piMessages.push(piUser);
      continue;
    }

    if (msg.role === "assistant") {
      const piContent: (TextContent | ToolCall)[] = [];
      if (typeof msg.content === "string" && msg.content.length > 0) {
        piContent.push({ text: msg.content, type: "text" });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            piContent.push({ text: part.text, type: "text" });
          }
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const parsed = safeJsonParse(tc.function.arguments) ?? {};
          piContent.push({
            arguments: parsed as Record<string, unknown>,
            id: tc.id,
            name: tc.function.name,
            type: "toolCall",
          });
          toolCallNames.set(tc.id, tc.function.name);
        }
      }
      const piAssistant: AssistantMessage = {
        api: "openai-completions",
        content: piContent,
        model: "passthrough",
        provider: "passthrough",
        role: "assistant",
        stopReason:
          msg.tool_calls && msg.tool_calls.length > 0 ? "toolUse" : "stop",
        timestamp: now,
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      };
      piMessages.push(piAssistant);
      continue;
    }

    if (msg.role === "tool") {
      const toolName =
        msg.name ?? toolCallNames.get(msg.tool_call_id) ?? "unknown";
      const text = contentToString(msg.content);
      const piToolResult: ToolResultMessage = {
        content: [{ text, type: "text" }],
        isError: false,
        role: "toolResult",
        timestamp: now,
        toolCallId: msg.tool_call_id,
        toolName,
      };
      piMessages.push(piToolResult);
      continue;
    }
  }

  const context: Context = {
    messages: piMessages,
    systemPrompt,
    tools: translateTools(input.tools),
  };

  return { context };
}

function translateUserContent(
  content:
    | string
    | { text: string; type: "text" }[]
    | {
        image_url: { detail?: string; url: string } | string;
        type: "image_url";
      }[]
    | (TextContent | ImageContent)[]
    | unknown,
): UserMessage["content"] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: (TextContent | ImageContent)[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      parts.push({ text: p.text, type: "text" });
    } else if (p.type === "image_url") {
      const url =
        typeof p.image_url === "string"
          ? p.image_url
          : typeof p.image_url === "object" &&
              p.image_url !== null &&
              typeof (p.image_url as Record<string, unknown>).url === "string"
            ? ((p.image_url as Record<string, unknown>).url as string)
            : undefined;
      if (url) {
        const dataUrl = parseDataUrl(url);
        if (dataUrl) {
          parts.push({
            data: dataUrl.data,
            mimeType: dataUrl.mimeType,
            type: "image",
          });
        }
      }
    }
  }
  return parts;
}

function translateTools(
  tools: ChatToolDefinition[] | undefined,
): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    description: t.function.description ?? "",
    name: t.function.name,
    parameters: (t.function.parameters ?? {
      properties: {},
      type: "object",
    }) as Tool["parameters"],
  }));
}

function contentToString(
  content: string | { text: string; type: "text" }[] | unknown,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object") {
      const p = item as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
    }
  }
  return parts.join("\n");
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function parseDataUrl(url: string): { data: string; mimeType: string } | null {
  if (!url.startsWith("data:")) return null;
  const commaIndex = url.indexOf(",");
  if (commaIndex === -1) return null;
  const header = url.slice(5, commaIndex);
  const data = url.slice(commaIndex + 1);
  const isBase64 = header.includes(";base64");
  const mimeType = header.split(";")[0] ?? "application/octet-stream";
  if (!isBase64) return { data, mimeType };
  return { data, mimeType };
}
