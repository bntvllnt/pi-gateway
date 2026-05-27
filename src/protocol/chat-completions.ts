/**
 * OpenAI Chat Completions request schema (Typebox).
 *
 * Accepts the published surface for /v1/chat/completions. Unknown fields are
 * ignored at the schema level (additionalProperties: true) but logged debug at
 * the handler level so contract drift surfaces.
 */
import { type Static, Type } from "@sinclair/typebox";

const TextContent = Type.Object({
  text: Type.String(),
  type: Type.Literal("text"),
});

const ImageUrlContent = Type.Object({
  image_url: Type.Union([
    Type.Object({
      detail: Type.Optional(Type.String()),
      url: Type.String(),
    }),
    Type.String(),
  ]),
  type: Type.Literal("image_url"),
});

const UserContentPart = Type.Union([TextContent, ImageUrlContent]);

const SystemMessage = Type.Object(
  {
    content: Type.Union([Type.String(), Type.Array(TextContent)]),
    name: Type.Optional(Type.String()),
    role: Type.Literal("system"),
  },
  { additionalProperties: true },
);

const DeveloperMessage = Type.Object(
  {
    content: Type.Union([Type.String(), Type.Array(TextContent)]),
    name: Type.Optional(Type.String()),
    role: Type.Literal("developer"),
  },
  { additionalProperties: true },
);

const UserMessage = Type.Object(
  {
    content: Type.Union([Type.String(), Type.Array(UserContentPart)]),
    name: Type.Optional(Type.String()),
    role: Type.Literal("user"),
  },
  { additionalProperties: true },
);

const ToolCallShape = Type.Object({
  function: Type.Object({
    arguments: Type.String(),
    name: Type.String(),
  }),
  id: Type.String(),
  type: Type.Literal("function"),
});

const AssistantMessageShape = Type.Object(
  {
    content: Type.Optional(
      Type.Union([Type.String(), Type.Array(TextContent), Type.Null()]),
    ),
    name: Type.Optional(Type.String()),
    reasoning_content: Type.Optional(Type.String()),
    role: Type.Literal("assistant"),
    tool_calls: Type.Optional(Type.Array(ToolCallShape)),
  },
  { additionalProperties: true },
);

const ToolResultMessage = Type.Object(
  {
    content: Type.Union([Type.String(), Type.Array(TextContent)]),
    name: Type.Optional(Type.String()),
    role: Type.Literal("tool"),
    tool_call_id: Type.String(),
  },
  { additionalProperties: true },
);

const ChatMessage = Type.Union([
  SystemMessage,
  DeveloperMessage,
  UserMessage,
  AssistantMessageShape,
  ToolResultMessage,
]);

const ToolDefinition = Type.Object({
  function: Type.Object({
    description: Type.Optional(Type.String()),
    name: Type.String(),
    parameters: Type.Optional(Type.Any()),
    strict: Type.Optional(Type.Boolean()),
  }),
  type: Type.Literal("function"),
});

export const ChatCompletionRequest = Type.Object(
  {
    frequency_penalty: Type.Optional(Type.Number()),
    max_completion_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    messages: Type.Array(ChatMessage, { minItems: 1 }),
    model: Type.String(),
    n: Type.Optional(Type.Integer({ maximum: 1, minimum: 1 })),
    presence_penalty: Type.Optional(Type.Number()),
    response_format: Type.Optional(Type.Any()),
    seed: Type.Optional(Type.Integer()),
    stop: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
    stream: Type.Optional(Type.Boolean()),
    stream_options: Type.Optional(
      Type.Object(
        {
          include_usage: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: true },
      ),
    ),
    temperature: Type.Optional(Type.Number()),
    tool_choice: Type.Optional(Type.Any()),
    tools: Type.Optional(Type.Array(ToolDefinition)),
    top_p: Type.Optional(Type.Number()),
    user: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export type ChatCompletionRequest = Static<typeof ChatCompletionRequest>;
export type ChatMessage = Static<typeof ChatMessage>;
export type ChatToolDefinition = Static<typeof ToolDefinition>;
