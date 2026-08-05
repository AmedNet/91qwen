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

function convertResponsesToolChoice(choice: ResponsesRequest['tool_choice']): OpenAIRequest['tool_choice'] {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function convertResponsesInputItem(item: any): Message | null {
  if (item.type === 'function_call_output') {
    return { role: 'tool', content: item.output, tool_call_id: item.call_id };
  }
  if (item.type === 'function_call') {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: item.call_id || item.id || generateId('call'),
        type: 'function',
        function: { name: item.name || '', arguments: item.arguments || '{}' },
      }],
    };
  }
  const msg = item as { role?: string; content?: string | any[] };
  if (!msg.role) return null;
  const content = typeof msg.content === 'string'
    ? msg.content
    : (msg.content || [])
        .filter((p: any) => p.type === 'input_text' || p.type === 'output_text')
        .map((p: any) => p.text || '')
        .join('\n');
  return { role: msg.role, content };
}

export function convertResponsesRequestToChatCompletions(req: ResponsesRequest): OpenAIRequest {
  const messages = convertInputToMessages(req.input, req.instructions);
  const tools = req.tools ? convertResponsesToolsToOpenAI(req.tools) : undefined;

  const chatReq: OpenAIRequest = {
    model: req.model,
    messages,
    stream: req.stream ?? false,
    tools,
    tool_choice: convertResponsesToolChoice(req.tool_choice),
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
    const message = convertResponsesInputItem(item);
    if (message) messages.push(message);
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
  private hasStartedResponse = false;
  private hasStartedContent = false;
  private accumulatedContent = '';
  private messageOutputIndex: number | null = null;
  private nextOutputIndex = 0;
  private toolCallBuffers: Map<string, { id: string; callId: string; name: string; argsBuffer: string; outputIndex: number }> = new Map();
  private nextFallbackToolKey = 0;
  private createdAt: number;
  private finalized = false;

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
    if (this.finalized) return [];
    const events: ResponsesStreamEvent[] = [];
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    const hasText = !!delta?.content;
    const hasTools = Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0;

    // Start the response once, then create only the output item represented by
    // this first chunk. A tool-only response must not contain an empty message
    // item before its function_call items.
    if (!this.hasStartedResponse && (hasText || hasTools)) {
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
      this.hasStartedResponse = true;
    }
    if (hasText && !this.hasStartedMessage) {
      this.messageOutputIndex = this.nextOutputIndex++;
      events.push({
        type: 'response.output_item.added',
        output_index: this.messageOutputIndex,
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
          output_index: this.messageOutputIndex!,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
        this.hasStartedContent = true;
      }
      events.push({
        type: 'response.content_part.delta',
        item_id: this.messageId,
        output_index: this.messageOutputIndex!,
        content_index: 0,
        delta: { type: 'text_delta', text: delta.content },
      });
      this.accumulatedContent += delta.content;
    }

    // Tool calls delta. Each output item receives a stable index on first appearance.
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        const toolKey = idx !== undefined && idx !== null
          ? `index:${idx}`
          : tc.id
            ? `id:${tc.id}`
            : `fallback:${this.nextFallbackToolKey++}`;
        if (!this.toolCallBuffers.has(toolKey)) {
          const tcId = tc.id || generateId('call');
          this.toolCallBuffers.set(toolKey, {
            id: generateId('fc'),
            callId: tcId,
            name: tc.function?.name || '',
            argsBuffer: '',
            outputIndex: this.nextOutputIndex++,
          });
          events.push({
            type: 'response.output_item.added',
            output_index: this.toolCallBuffers.get(toolKey)!.outputIndex,
            item: {
              type: 'function_call',
              id: this.toolCallBuffers.get(toolKey)!.id,
              call_id: tcId,
              name: tc.function?.name || '',
              arguments: '{}',
              status: 'in_progress',
            } as ResponsesOutputFunctionCall,
          });
        }
        const buf = this.toolCallBuffers.get(toolKey)!;
        if (tc.function?.name) buf.name = tc.function.name;
        if (tc.function?.arguments) {
          buf.argsBuffer += tc.function.arguments;
          events.push({
            type: 'response.function_call_arguments.delta',
            item_id: buf.id,
            output_index: buf.outputIndex,
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

  finish(usage?: any): ResponsesStreamEvent[] {
    return this.finalize(usage);
  }

  private finalize(usage?: any): ResponsesStreamEvent[] {
    if (this.finalized) return [];
    this.finalized = true;
    const events: ResponsesStreamEvent[] = [];

    // A provider may terminate without sending any content or tool delta. Emit
    // the lifecycle opening before the terminal event so the Responses stream
    // remains valid even for an empty response.
    if (!this.hasStartedResponse) {
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
      this.hasStartedResponse = true;
    }

    if (this.hasStartedContent) {
      events.push({
        type: 'response.content_part.done',
        item_id: this.messageId,
        output_index: this.messageOutputIndex!,
        content_index: 0,
        part: { type: 'output_text', text: this.accumulatedContent, annotations: [] },
      });
    }

    if (this.hasStartedMessage) {
      events.push({
        type: 'response.output_item.done',
        output_index: this.messageOutputIndex!,
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
    for (const [, buf] of this.toolCallBuffers) {
      events.push({
        type: 'response.function_call_arguments.done',
        item_id: buf.id,
        output_index: buf.outputIndex,
        arguments: buf.argsBuffer,
      });
      events.push({
        type: 'response.output_item.done',
        output_index: buf.outputIndex,
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

    // Build final output for response.completed in the same order as output indexes.
    const outputByIndex: Array<{ index: number; item: ResponsesOutputItem }> = [];
    if (this.hasStartedMessage) {
      outputByIndex.push({
        index: this.messageOutputIndex!,
        item: {
          type: 'message',
          id: this.messageId,
          role: 'assistant',
          content: [{ type: 'output_text', text: this.accumulatedContent, annotations: [] }],
          status: 'completed',
        } as ResponsesOutputMessage,
      });
    }
    for (const [, buf] of this.toolCallBuffers) {
      outputByIndex.push({
        index: buf.outputIndex,
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
    const output = outputByIndex.sort((a, b) => a.index - b.index).map(({ item }) => item);

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
