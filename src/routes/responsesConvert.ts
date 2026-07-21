/*
 * File: responsesConvert.ts
 * Converts between OpenAI Responses API ↔ Chat Completions format.
 */
import type {
  ResponsesRequest,
  ResponsesInputItem,
  ResponsesResponse,
  ResponsesOutputItem,
  ResponsesOutputMessage,
  ResponsesOutputFunctionCall,
  ResponsesOutputContent,
  ResponsesUsage,
  ResponsesStreamEvent,
  ResponsesTool,
} from '../types/responses.ts';
import type { Message, OpenAIRequest, FunctionToolDefinition } from '../types/openai.ts';

// ── Utility ────────────────────────────────────────────────────

function generateId(prefix: string): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 24; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}_${result}`;
}

// ── Request Conversion: Responses → Chat Completions ───────────

export function convertResponsesRequestToChatCompletions(req: ResponsesRequest): OpenAIRequest {
  const messages = convertInputToMessages(req.input, req.instructions);
  const tools = req.tools ? convertResponsesToolsToOpenAI(req.tools) : undefined;

  const chatReq: OpenAIRequest = {
    model: req.model,
    messages,
    stream: req.stream ?? false,
    tools,
    tool_choice: req.tool_choice as any,
    stream_options: req.stream ? { include_usage: true } : undefined,
  };
  return chatReq;
}

function convertInputToMessages(input: string | ResponsesInputItem[], instructions?: string): Message[] {
  const messages: Message[] = [];

  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  for (const item of input) {
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        content: item.output,
        tool_call_id: item.call_id,
      });
    } else {
      // Message item
      const msg = item as { role: string; content: string | any[] };
      const content = typeof msg.content === 'string'
        ? msg.content
        : (msg.content as any[])
            .filter((p: any) => p.type === 'input_text' || p.type === 'output_text')
            .map((p: any) => p.text || '')
            .join('\n');
      // Map 'developer' → 'system'
      const role = msg.role === 'developer' ? 'system' : msg.role;
      messages.push({ role, content });
    }
  }
  return messages;
}

function convertResponsesToolsToOpenAI(tools: ResponsesTool[]): FunctionToolDefinition[] {
  return tools
    .filter((t) => t.type === 'function' && t.name)
    .map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name!,
        description: t.description,
        parameters: t.parameters as any,
        strict: t.strict,
      },
    }));
}

// ── Response Conversion: Chat Completions → Responses ──────────

export function convertChatCompletionToResponsesResponse(chatResponse: any, model: string): ResponsesResponse {
  const choice = chatResponse.choices?.[0];
  const message = choice?.message;
  const usage = chatResponse.usage;
  const output: ResponsesOutputItem[] = [];

  if (message?.content) {
    output.push({
      type: 'message',
      id: generateId('msg'),
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
      status: 'completed',
    });
  }

  if (message?.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      output.push({
        type: 'function_call',
        id: generateId('fc'),
        call_id: tc.id,
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '{}',
        status: 'completed',
      });
    }
  }

  const responsesUsage: ResponsesUsage = {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
    input_tokens_details: { cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens_details: { reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0 },
  };

  return {
    id: chatResponse.id ? chatResponse.id.replace('chatcmpl-', 'resp_') : generateId('resp'),
    object: 'response',
    created_at: chatResponse.created ?? Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output,
    usage: responsesUsage,
    error: null,
    incomplete_details: null,
  };
}

// ── Streaming Converter ────────────────────────────────────────

export class ResponsesStreamConverter {
  private responseId: string;
  private model: string;
  private messageId: string;
  private hasStartedMessage = false;
  private hasStartedContent = false;
  private accumulatedContent = '';
  private toolCallBuffers: Map<number, { id: string; callId: string; name: string; argsBuffer: string }> = new Map();
  private createdAt: number;

  constructor(model: string) {
    this.responseId = generateId('resp');
    this.model = model;
    this.messageId = generateId('msg');
    this.createdAt = Math.floor(Date.now() / 1000);
  }

  getResponseId(): string {
    return this.responseId;
  }

  processChunk(chunk: any): ResponsesStreamEvent[] {
    const events: ResponsesStreamEvent[] = [];
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    // First chunk with content: emit response.created + output_item.added
    if (!this.hasStartedMessage && (delta?.content || delta?.tool_calls)) {
      events.push({
        type: 'response.created',
        response: {
          id: this.responseId,
          object: 'response',
          created_at: this.createdAt,
          status: 'in_progress',
          model: this.model,
          output: [],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      });
      events.push({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'message',
          id: this.messageId,
          role: 'assistant',
          content: [],
          status: 'in_progress',
        } as ResponsesOutputMessage,
      });
      this.hasStartedMessage = true;
    }

    // Text content delta
    if (delta?.content) {
      if (!this.hasStartedContent) {
        events.push({
          type: 'response.content_part.added',
          item_id: this.messageId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
        this.hasStartedContent = true;
      }
      events.push({
        type: 'response.content_part.delta',
        item_id: this.messageId,
        output_index: 0,
        content_index: 0,
        delta: { type: 'text_delta', text: delta.content },
      });
      this.accumulatedContent += delta.content;
    }

    // Tool calls delta
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!this.toolCallBuffers.has(idx)) {
          const tcId = tc.id || generateId('call');
          this.toolCallBuffers.set(idx, {
            id: generateId('fc'),
            callId: tcId,
            name: tc.function?.name || '',
            argsBuffer: '',
          });
          events.push({
            type: 'response.output_item.added',
            output_index: 1 + idx,
            item: {
              type: 'function_call',
              id: this.toolCallBuffers.get(idx)!.id,
              call_id: tcId,
              name: tc.function?.name || '',
              arguments: '{}',
              status: 'completed',
            } as ResponsesOutputFunctionCall,
          });
        }
        const buf = this.toolCallBuffers.get(idx)!;
        if (tc.function?.name) buf.name = tc.function.name;
        if (tc.function?.arguments) {
          buf.argsBuffer += tc.function.arguments;
          events.push({
            type: 'response.function_call_arguments.delta',
            item_id: buf.id,
            output_index: 1 + idx,
            delta: tc.function.arguments,
          });
        }
      }
    }

    // Stream ended — emit completion events
    if (choice?.finish_reason) {
      events.push(...this.finalize(chunk.usage));
    }

    return events;
  }

  private finalize(usage?: any): ResponsesStreamEvent[] {
    const events: ResponsesStreamEvent[] = [];

    if (this.hasStartedContent) {
      events.push({
        type: 'response.content_part.done',
        item_id: this.messageId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: this.accumulatedContent, annotations: [] },
      });
    }

    if (this.hasStartedMessage) {
      events.push({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: this.messageId,
          role: 'assistant',
          content: [{ type: 'output_text', text: this.accumulatedContent, annotations: [] }],
          status: 'completed',
        } as ResponsesOutputMessage,
      });
    }

    // Close tool call items
    for (const [idx, buf] of this.toolCallBuffers) {
      events.push({
        type: 'response.function_call_arguments.done',
        item_id: buf.id,
        output_index: 1 + idx,
        arguments: buf.argsBuffer,
      });
      events.push({
        type: 'response.output_item.done',
        output_index: 1 + idx,
        item: {
          type: 'function_call',
          id: buf.id,
          call_id: buf.callId,
          name: buf.name,
          arguments: buf.argsBuffer,
          status: 'completed',
        } as ResponsesOutputFunctionCall,
      });
    }

    // Build final output for response.completed
    const output: ResponsesOutputItem[] = [];
    if (this.hasStartedMessage) {
      output.push({
        type: 'message',
        id: this.messageId,
        role: 'assistant',
        content: [{ type: 'output_text', text: this.accumulatedContent, annotations: [] }],
        status: 'completed',
      });
    }
    for (const [, buf] of this.toolCallBuffers) {
      output.push({
        type: 'function_call',
        id: buf.id,
        call_id: buf.callId,
        name: buf.name,
        arguments: buf.argsBuffer,
        status: 'completed',
      });
    }

    const responsesUsage: ResponsesUsage = {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      total_tokens: usage?.total_tokens ?? 0,
      input_tokens_details: { cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens_details: { reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0 },
    };

    events.push({
      type: 'response.completed',
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: 'completed',
        model: this.model,
        output,
        usage: responsesUsage,
        error: null,
        incomplete_details: null,
      },
    });

    return events;
  }
}

// ── Model Mapping ──────────────────────────────────────────────

const MODEL_MAP: Record<string, string> = {
  // OpenAI reasoning → Qwen reasoning
  'o4-mini': 'qwq-plus',
  'o3': 'qwq-plus',
  'o3-mini': 'qwq-plus',
  'o3-pro': 'qwq-plus',
  'o1': 'qwq-plus',
  'o1-mini': 'qwq-plus',
  // OpenAI general → Qwen 3.7 series
  'gpt-4.1': 'qwen3-7-max',
  'gpt-4.1-mini': 'qwen3-7-plus',
  'gpt-4.1-nano': 'qwen3-7-plus',
  'gpt-4o': 'qwen3-7-max',
  'gpt-4o-mini': 'qwen3-7-plus',
  'gpt-4-turbo': 'qwen3-7-max',
  'gpt-4': 'qwen3-7-max',
  'gpt-3.5-turbo': 'qwen3-7-plus',
};

export function mapCodexModel(requestedModel: string): string {
  return MODEL_MAP[requestedModel] || requestedModel;
}