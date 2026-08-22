import type { ParsedToolCall } from '../types/openai.ts';

export interface GuardResult {
  valid: ParsedToolCall[];
  errors: string[];
  correctionPrompt: string;
  ok: boolean;
}

/**
 * Tool-call objects circulating through the stream pipeline appear in two
 * shapes:
 *   - ParsedToolCall (flat):       { id, name, arguments }
 *   - MessageToolCall (OpenAI):    { id, type:'function', function:{ name, arguments:string } }
 *
 * `toolCallsOut` (the buffer emitted to OpenAI clients) uses the nested
 * shape, and `chatNonStreaming.ts` passes it through guard before pushing —
 * so guard must accept BOTH shapes to avoid the false "missing name /
 * arguments" rejection that broke every non-streaming tool-call request.
 *
 * Normalize here, before field-level checks, so all downstream checks
 * (validation, parallel-loop detection, spam guard) see a uniform view.
 */
type RawTC = Record<string, unknown> & {
  name?: unknown;
  arguments?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

function normalizeToolCall(tc: RawTC): { name: unknown; arguments: unknown } {
  const fn = tc.function;
  const name = tc.name ?? fn?.name;
  let args = tc.arguments;
  if (args === undefined && fn?.arguments !== undefined) {
    // OpenAI nested form serializes arguments as a JSON string.
    if (typeof fn.arguments === 'string') {
      try {
        args = JSON.parse(fn.arguments);
      } catch {
        args = fn.arguments; // keep the raw string; the object-type check below will surface it
      }
    } else {
      args = fn.arguments;
    }
  }
  return { name, arguments: args };
}

function validateSingleTC(tc: ParsedToolCall): string[] {
  const errors: string[] = [];
  const { name, arguments: args } = normalizeToolCall(tc as unknown as RawTC);
  if (!name || typeof name !== 'string' || name.trim() === '') {
    errors.push('Tool call missing or has invalid "name" field.');
  }
  if (args === undefined || args === null) {
    errors.push(`Tool call "${name as string}" missing "arguments" field.`);
  } else if (typeof args !== 'object') {
    errors.push(`Tool call "${name as string}" has non-object arguments.`);
  }
  return errors;
}

export function validateSingleToolCall(tc: ParsedToolCall): GuardResult {
  const errors = validateSingleTC(tc);
  const correctionPrompt = errors.length > 0 ? buildCorrectionPrompt(errors) : '';
  return {
    valid: errors.length === 0 ? [tc] : [],
    errors,
    correctionPrompt,
    ok: errors.length === 0,
  };
}

/**
 * Read `name` / `arguments` from a tool-call object regardless of whether it
 * uses the flat (`{name, arguments}`) or OpenAI-nested
 * (`{function:{name, arguments:string}}`) shape. Arguments from the nested
 * form are JSON-parsed back to an object so callers see a uniform type.
 */
export function readToolCall(tc: any): { name: string; arguments: unknown } {
  const { name, arguments: args } = normalizeToolCall(tc);
  return { name: typeof name === 'string' ? name : '', arguments: args };
}

function buildCorrectionPrompt(errors: string[]): string {
  if (errors.length === 0) return '';
  if (errors.length === 1) return `Fix: ${errors[0]}`;
  if (errors.length <= 3) return `Fix: ${errors.join('; ')}`;
  return `Fix: ${errors.slice(0, 3).join('; ')} and ${errors.length - 3} more.`;
}

/**
 * Serialize tool arguments to a stable string key for comparison.
 * Sorts object keys to ensure consistent serialization regardless of order.
 */
function serializeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  const parts = keys.map((k) => `${k}:${JSON.stringify(args[k])}`);
  return parts.join('|');
}

/**
 * Detect parallel tool call loops: multiple identical tool calls within the
 * same response (same name + same arguments array). This catches models that
 * generate the same tool call N times in parallel.
 */
export function detectParallelToolLoop(toolCalls: ParsedToolCall[]): GuardResult {
  if (toolCalls.length < 2) {
    return { valid: toolCalls, errors: [], correctionPrompt: '', ok: true };
  }

  const seen = new Map<string, number[]>();
  for (let i = 0; i < toolCalls.length; i++) {
    const key = `${toolCalls[i].name}::${serializeArgs(toolCalls[i].arguments as Record<string, unknown>)}`;
    const indices = seen.get(key) || [];
    indices.push(i);
    seen.set(key, indices);
  }

  for (const [key, indices] of seen) {
    if (indices.length >= 3) {
      const [name] = key.split('::');
      const msg = `Parallel loop detected: "${name}" called ${indices.length} times with identical arguments in the same response. Only call each distinct tool+args once.`;
      const valid = toolCalls.filter((_, i) => !indices.includes(i));
      return {
        valid,
        errors: [msg],
        correctionPrompt: `Fix: Do not call "${name}" multiple times with the same arguments. Call each tool once.`,
        ok: false,
      };
    }
  }

  return { valid: toolCalls, errors: [], correctionPrompt: '', ok: true };
}
