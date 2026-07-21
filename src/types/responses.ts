/*
 * File: responses.ts
 * OpenAI Responses API type definitions for Codex CLI compatibility.
 */

// ── Request Types ──────────────────────────────────────────────

export interface ResponsesRequest {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: ResponsesToolChoice;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  previous_response_id?: string | null;
  reasoning?: {
    effort?: 'low' | 'medium' | 'high';
    summary?: 'auto' | 'concise' | 'detailed';
  };
  text?: {
    format?: {
      type: 'text' | 'json_object' | 'json_schema';
      json_schema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
    };
  };
  store?: boolean;
  parallel_tool_calls?: boolean;
  metadata?: Record<string, string>;
  truncation?: 'auto' | 'disabled';
}

export type ResponsesInputItem = ResponsesInputMessage | ResponsesInputFunctionCallOutput;

export interface ResponsesInputMessage {
  type?: 'message';
  role: 'system' | 'user' | 'assistant' | 'developer';
  content: string | ResponsesContentPart[];
}

export interface ResponsesContentPart {
  type: 'input_text' | 'output_text' | 'input_file' | 'input_image';
  text?: string;
  image_url?: string;
}

export interface ResponsesInputFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export interface ResponsesTool {
  type: 'function' | 'web_search' | 'file_search' | 'computer_use';
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export type ResponsesToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; name: string };

// ── Response Types ─────────────────────────────────────────────

export interface ResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'failed' | 'in_progress' | 'incomplete';
  model: string;
  output: ResponsesOutputItem[];
  usage: ResponsesUsage;
  error?: ResponsesError | null;
  incomplete_details?: { reason: string } | null;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  metadata?: Record<string, string>;
  parallel_tool_calls?: boolean;
  truncation?: string;
}

export type ResponsesOutputItem = ResponsesOutputMessage | ResponsesOutputFunctionCall;

export interface ResponsesOutputMessage {
  type: 'message';
  id: string;
  role: 'assistant';
  content: ResponsesOutputContent[];
  status: 'completed' | 'in_progress';
}

export interface ResponsesOutputContent {
  type: 'output_text';
  text: string;
  annotations?: unknown[];
}

export interface ResponsesOutputFunctionCall {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed';
}

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens: number };
  output_tokens_details?: { reasoning_tokens: number };
}

export interface ResponsesError {
  type: string;
  code: string | null;
  message: string;
  param: string | null;
}

// ── Streaming Event Types ──────────────────────────────────────

export type ResponsesStreamEvent =
  | { type: 'response.created'; response: Partial<ResponsesResponse> }
  | { type: 'response.in_progress'; response: Partial<ResponsesResponse> }
  | { type: 'response.completed'; response: ResponsesResponse }
  | { type: 'response.failed'; response: ResponsesResponse }
  | { type: 'response.output_item.added'; output_index: number; item: ResponsesOutputItem }
  | { type: 'response.output_item.done'; output_index: number; item: ResponsesOutputItem }
  | { type: 'response.content_part.added'; item_id: string; output_index: number; content_index: number; part: ResponsesOutputContent }
  | { type: 'response.content_part.delta'; item_id: string; output_index: number; content_index: number; delta: { type: 'text_delta'; text: string } }
  | { type: 'response.content_part.done'; item_id: string; output_index: number; content_index: number; part: ResponsesOutputContent }
  | { type: 'response.function_call_arguments.delta'; item_id: string; output_index: number; delta: string }
  | { type: 'response.function_call_arguments.done'; item_id: string; output_index: number; arguments: string }
  | { type: 'error'; message: string; param?: string; code?: string };