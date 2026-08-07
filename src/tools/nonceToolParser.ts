import { randomBytes, randomUUID } from 'node:crypto';
import type { ParsedToolCall } from '../types/openai.ts';
import { alignArgsToSchema } from './xmlToolParser.ts';
import { detectParallelToolLoop, validateSingleToolCall } from './guard.ts';

export interface ToolEnvelopeExtraction {
  /** True once the exact request-specific opener has been observed. */
  opened: boolean;
  /** True when a matching closer was observed after the opener. */
  closed: boolean;
  /** JSON text between the opener and closer, when closed. */
  json?: string;
  /** Index of the opener in rawText, or -1 when absent. */
  openIndex: number;
  /** Index of the closer in rawText, or -1 when absent. */
  closeIndex: number;
}

export interface NonceToolCallResult {
  toolCalls: ParsedToolCall[];
  valid: boolean;
  errors: string[];
  correctionPrompt: string;
}

/** Generate the per-request token used to bind the prompt and response protocol. */
export function createToolNonce(): string {
  return randomBytes(8).toString('hex');
}

export function toolEnvelopeOpen(nonce: string): string {
  return `<<<QG_TOOL_${nonce}>>>`;
}

export function toolEnvelopeClose(nonce: string): string {
  return `<<<QG_END_${nonce}>>>`;
}

/**
 * Extract only a complete envelope for this request's nonce.
 * A matching opener without a closer is deliberately not treated as content:
 * callers must either wait for more data or surface a protocol error at flush.
 */
export function extractToolEnvelope(rawText: string, nonce: string): ToolEnvelopeExtraction {
  const opener = toolEnvelopeOpen(nonce);
  const closer = toolEnvelopeClose(nonce);
  const openIndex = rawText.indexOf(opener);
  if (openIndex < 0) {
    return { opened: false, closed: false, openIndex: -1, closeIndex: -1 };
  }
  const contentStart = openIndex + opener.length;
  const closeIndex = rawText.indexOf(closer, contentStart);
  if (closeIndex < 0) {
    return { opened: true, closed: false, openIndex, closeIndex: -1 };
  }
  return {
    opened: true,
    closed: true,
    json: rawText.slice(contentStart, closeIndex).trim(),
    openIndex,
    closeIndex,
  };
}

function toolNameOf(tool: any): string {
  return String(tool?.function?.name || tool?.name || '');
}

function schemaOf(tool: any): any {
  return tool?.function?.parameters || tool?.parameters || tool?.inputSchema;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isEmptyRequired(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function matchesSchema(value: unknown, schema: any): boolean {
  if (!schema || typeof schema !== 'object') return true;
  if (schema.nullable === true && value === null) return true;

  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : [];
  if (anyOf.length > 0 && !anyOf.some((candidate: any) => matchesSchema(value, candidate))) return false;
  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  if (oneOf.length > 0 && oneOf.filter((candidate: any) => matchesSchema(value, candidate)).length !== 1) return false;
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate: unknown) => JSON.stringify(candidate) === JSON.stringify(value))) return false;

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type: string) => matchesSchemaType(value, type, schema))) return false;
  return true;
}

function matchesSchemaType(value: unknown, type: string, schema: any): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': {
      if (!isPlainObject(value)) return false;
      const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const key of required) if (isEmptyRequired(value[key])) return false;
      for (const [key, childSchema] of Object.entries(properties)) {
        if (value[key] !== undefined && !matchesSchema(value[key], childSchema)) return false;
      }
      return true;
    }
    case 'array':
      return Array.isArray(value) && (!schema.items || value.every((item: unknown) => matchesSchema(item, schema.items)));
    case 'null': return value === null;
    default: return true;
  }
}

/**
 * Parse and validate the JSON payload inside a nonce envelope.
 * Invalid calls are rejected as a group so callers never execute a partially
 * valid model response that may contain malformed sibling calls.
 */
export function parseToolEnvelope(json: string, clientTools?: any[]): NonceToolCallResult {
  const errors: string[] = [];
  let payload: any;
  try {
    payload = JSON.parse(json);
  } catch {
    return { toolCalls: [], valid: false, errors: ['Tool envelope contains invalid JSON.'], correctionPrompt: 'Fix: Emit valid JSON inside the tool envelope.' };
  }
  if (!isPlainObject(payload) || !Array.isArray(payload.tool_calls)) {
    return { toolCalls: [], valid: false, errors: ['Tool envelope must contain a "tool_calls" array.'], correctionPrompt: 'Fix: Put tool calls in a tool_calls array.' };
  }
  if (payload.tool_calls.length === 0) {
    return { toolCalls: [], valid: false, errors: ['Tool envelope must contain at least one tool call.'], correctionPrompt: 'Fix: Include at least one tool call, or answer with ordinary text.' };
  }

  const tools = Array.isArray(clientTools) ? clientTools : [];
  const byName = new Map(tools.map((tool) => [toolNameOf(tool).toLowerCase(), tool]));
  const parsed: ParsedToolCall[] = [];

  for (let index = 0; index < payload.tool_calls.length; index++) {
    const item = payload.tool_calls[index];
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const tool = byName.get(name.toLowerCase());
    if (!tool) {
      errors.push(`Tool call ${index + 1} uses unknown tool "${name || '?'}".`);
      continue;
    }
    if (!isPlainObject(item.arguments)) {
      errors.push(`Tool call "${name}" arguments must be a JSON object.`);
      continue;
    }

    const args = alignArgsToSchema(toolNameOf(tool), item.arguments, tools);
    const schema = schemaOf(tool);
    const required = Array.isArray(schema?.required) ? schema.required : [];
    const missing = required.filter((key: string) => isEmptyRequired(args[key]));
    if (missing.length > 0) {
      errors.push(`Tool call "${name}" is missing required arguments: ${missing.join(', ')}.`);
      continue;
    }
    if (!matchesSchema(args, schema)) {
      errors.push(`Tool call "${name}" arguments do not match the registered schema.`);
      continue;
    }

    const parsedCall: ParsedToolCall = { id: `call_${randomUUID()}`, name: toolNameOf(tool), arguments: args };
    const guard = validateSingleToolCall(parsedCall);
    if (!guard.ok) {
      errors.push(...guard.errors);
      continue;
    }
    parsed.push(parsedCall);
  }

  if (errors.length > 0 || parsed.length !== payload.tool_calls.length) {
    return { toolCalls: [], valid: false, errors, correctionPrompt: `Fix: ${errors.join('; ')}` };
  }
  const loopGuard = detectParallelToolLoop(parsed);
  if (!loopGuard.ok) {
    return { toolCalls: [], valid: false, errors: loopGuard.errors, correctionPrompt: loopGuard.correctionPrompt };
  }
  return { toolCalls: parsed, valid: true, errors: [], correctionPrompt: '' };
}
