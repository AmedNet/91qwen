/*
 * File: responses.ts
 * POST /v1/responses — OpenAI Responses API endpoint for Codex CLI compatibility.
 * Translates Responses API ↔ Chat Completions, delegates to existing pipeline.
 */
import { Context } from 'hono';
import { logStore } from '../services/logStore.ts';
import { modelRouter } from '../services/modelRouter.ts';
import type { ResponsesRequest, ResponsesStreamEvent } from '../types/responses.ts';
import {
  convertResponsesRequestToChatCompletions,
  convertChatCompletionToResponsesResponse,
  ResponsesStreamConverter,
  mapCodexModel,
} from './responsesConvert.ts';
import { chatCompletions } from './chat.ts';

const RESPONSE_HISTORY_TTL_MS = 30 * 60 * 1000;
const MAX_RESPONSE_HISTORY = 256;
const responseHistory = new Map<string, { response: any; expiresAt: number }>();

function saveResponse(response: any): void {
  responseHistory.set(response.id, { response, expiresAt: Date.now() + RESPONSE_HISTORY_TTL_MS });
  while (responseHistory.size > MAX_RESPONSE_HISTORY) {
    const oldest = responseHistory.keys().next().value;
    if (oldest) responseHistory.delete(oldest);
  }
}

function getResponse(id: string): any | null {
  const entry = responseHistory.get(id);
  if (!entry || entry.expiresAt <= Date.now()) {
    responseHistory.delete(id);
    return null;
  }
  return entry.response;
}

function historyAsInput(response: any): any[] {
  return (response.output || []).map((item: any) => {
    if (item.type === 'function_call') return { type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments };
    if (item.type === 'message') return { type: 'message', role: 'assistant', content: item.content || [] };
    return item;
  });
}

/**
 * POST /v1/responses — main handler.
 * Strategy: convert to Chat Completions, delegate to chatCompletions(), convert response back.
 */
export async function responsesCreate(c: Context): Promise<Response> {
  const startMs = Date.now();
  const logId = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let body: ResponsesRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'invalid_json', message: 'Invalid JSON in request body', param: null },
    }, 400);
  }

  if (!body.model) {
    return c.json({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'missing_model', message: '"model" is required', param: 'model' },
    }, 400);
  }

  if (!body.input) {
    return c.json({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'missing_input', message: '"input" is required', param: 'input' },
    }, 400);
  }

  const originalModel = body.model;
  const resolvedModel = mapCodexModel(body.model);
  if (body.previous_response_id) {
    const previous = getResponse(body.previous_response_id);
    if (!previous) {
      return c.json({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_previous_response_id', message: `Unknown or expired previous_response_id: ${body.previous_response_id}`, param: 'previous_response_id' } }, 400);
    }
    if (Array.isArray(body.input)) body.input = [...historyAsInput(previous), ...body.input] as any;
  }
  body.model = resolvedModel;

  logStore.log('info', 'http', `[Responses] ${logId} ENTER model=${originalModel}→${resolvedModel} stream=${body.stream ?? false}`);

  const isStreaming = body.stream === true;

  if (isStreaming) {
    return handleStreamingResponses(c, body, logId, startMs, originalModel);
  } else {
    return handleNonStreamingResponses(c, body, logId, startMs, originalModel);
  }
}

/**
 * Streaming: intercept SSE from chatCompletions and re-emit as Responses API events.
 */
async function handleStreamingResponses(
  c: Context,
  body: ResponsesRequest,
  logId: string,
  startMs: number,
  originalModel: string,
): Promise<Response> {
  const converter = new ResponsesStreamConverter(originalModel);
  const chatRequest = convertResponsesRequestToChatCompletions(body);

  // Build synthetic request with the converted body
  const syntheticBody = JSON.stringify(chatRequest);
  const syntheticRequest = new Request(c.req.raw.url, {
    method: 'POST',
    headers: {
      ...Object.fromEntries(c.req.raw.headers),
      'content-type': 'application/json',
      'content-length': String(new TextEncoder().encode(syntheticBody).length),
    },
    body: syntheticBody,
  });

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const outputStream = new ReadableStream({
    async start(controller) {
      function sendEvent(event: ResponsesStreamEvent) {
        const data = JSON.stringify(event);
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${data}\n\n`));
      }

      try {
        // Delegate to chatCompletions with the converted request body
        const proxyC = {
          ...c,
          req: {
            ...c.req,
            json: async () => chatRequest,
            raw: syntheticRequest,
          },
        } as unknown as Context;

        const chatResponse = await chatCompletions(proxyC);

        if (!chatResponse.body) {
          sendEvent({ type: 'error', message: 'No response body from chat completions', code: 'internal_error' });
          controller.close();
          return;
        }

        // Read SSE stream and convert each event
        const reader = chatResponse.body.getReader();
        let buffer = '';

        let sawDone = false;
        const processLine = (line: string): boolean => {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) return false;
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            sawDone = true;
            return true;
          }
          try {
            const chunk = JSON.parse(data);
            if (chunk.error) {
              const errMsg = typeof chunk.error === 'string' ? chunk.error : chunk.error.message || JSON.stringify(chunk.error);
              logStore.log('warn', 'http', `[Responses] ${logId} Upstream SSE error: ${errMsg}`);
              sendEvent({ type: 'error', message: errMsg, code: chunk.error?.code || 'upstream_error' });
              return true;
            }
            for (const evt of converter.processChunk(chunk)) sendEvent(evt);
          } catch {
            // Skip unparseable chunks
          }
          return false;
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (processLine(line)) break;
          }
          if (sawDone) break;
        }

        buffer += decoder.decode();
        if (!sawDone && buffer.trim()) processLine(buffer);
        const finalEvents = converter.finish();
        for (const evt of finalEvents) sendEvent(evt);
        const completedEvent = finalEvents.find((evt) => evt.type === 'response.completed');
        if (completedEvent?.type === 'response.completed') saveResponse(completedEvent.response);
        controller.close();
        logStore.log('info', 'http', `[Responses] ${logId} STREAM DONE duration=${Date.now() - startMs}ms`);
      } catch (err: any) {
        logStore.log('error', 'http', `[Responses] ${logId} STREAM ERROR: ${err.message}`);
        sendEvent({ type: 'error', message: err.message || 'Internal error', code: 'internal_error' });
        controller.close();
      }
    },
  });

  return new Response(outputStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * Non-streaming: call chatCompletions, collect response, convert to Responses format.
 */
async function handleNonStreamingResponses(
  c: Context,
  body: ResponsesRequest,
  logId: string,
  startMs: number,
  originalModel: string,
): Promise<Response> {
  try {
    const chatRequest = convertResponsesRequestToChatCompletions(body);

    const proxyC = {
      ...c,
      req: {
        ...c.req,
        json: async () => chatRequest,
      },
    } as unknown as Context;

    const chatResponse = await chatCompletions(proxyC);
    const chatBody = await chatResponse.json();

    // Check if it's an error response from chatCompletions
    if (chatBody.error) {
      return c.json({
        type: 'error',
        error: {
          type: chatBody.error.type || 'internal_error',
          code: chatBody.error.code || null,
          message: chatBody.error.message || 'Unknown error',
          param: null,
        },
      }, chatResponse.status as any);
    }

    const responsesResponse = convertChatCompletionToResponsesResponse(chatBody, originalModel);
    saveResponse(responsesResponse);
    logStore.log('info', 'http', `[Responses] ${logId} DONE duration=${Date.now() - startMs}ms`);
    return c.json(responsesResponse);
  } catch (err: any) {
    logStore.log('error', 'http', `[Responses] ${logId} ERROR: ${err.message}`);
    return c.json({
      type: 'error',
      error: { type: 'internal_error', code: 'internal_error', message: err.message || 'Internal server error', param: null },
    }, 500);
  }
}

/**
 * GET /v1/responses/:id — stub for response retrieval.
 * Codex CLI may call this to check previous response status.
 */
export async function responsesGet(c: Context): Promise<Response> {
  const id = c.req.param('id');
  if (!id) return c.json({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_request_error', message: 'Missing response id', param: null } }, 400);
  const previous = getResponse(id);
  if (previous) return c.json(previous);
  return c.json({ type: 'error', error: { type: 'invalid_request_error', code: 'response_not_found', message: `Response not found or expired: ${id}`, param: null } }, 404);
}