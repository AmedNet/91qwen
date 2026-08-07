import type { ParsedToolCall } from '../types/openai.ts';
import { parseToolEnvelope, toolEnvelopeClose, toolEnvelopeOpen } from './nonceToolParser.ts';

export interface NonceToolStreamState {
  pending: string;
  envelopeOpen: boolean;
  completed: boolean;
  failed: boolean;
  stagedToolCalls: ParsedToolCall[];
  /** Full envelope text (opener + json + closer) once completed, used to drop
   *  cumulative re-sends of already-seen bytes after completion. */
  completedEnvelope?: string;
}

export interface NonceToolStreamResult {
  content: string;
  toolCalls: ParsedToolCall[];
  error?: string;
}

export function createNonceToolStreamState(): NonceToolStreamState {
  return { pending: '', envelopeOpen: false, completed: false, failed: false, stagedToolCalls: [] };
}

function longestOpenerPrefixSuffix(text: string, opener: string): number {
  const max = Math.min(text.length, opener.length - 1);
  for (let length = max; length > 0; length--) {
    if (text.endsWith(opener.slice(0, length))) return length;
  }
  return 0;
}

function parseOpenedEnvelope(
  state: NonceToolStreamState,
  nonce: string,
  clientTools?: any[],
): NonceToolStreamResult {
  const opener = toolEnvelopeOpen(nonce);
  const closer = toolEnvelopeClose(nonce);
  const closeIndex = state.pending.indexOf(closer);
  if (closeIndex < 0) return { content: '', toolCalls: [] };

  const json = state.pending.slice(0, closeIndex).trim();
  const trailing = state.pending.slice(closeIndex + closer.length);
  state.pending = '';
  state.envelopeOpen = false;
  state.completed = true;
  // Record the exact envelope bytes (opener + json + closer) so a trailing
  // cumulative re-send of the whole envelope can be recognized and dropped
  // instead of tripping the "final output" check.
  state.completedEnvelope = `${opener}${json}${closer}`;

  const parsed = parseToolEnvelope(json, clientTools);
  if (!parsed.valid) {
    state.failed = true;
    return { content: '', toolCalls: [], error: parsed.errors.join(' ') || 'Invalid tool envelope.' };
  }
  if (trailing.trim()) {
    state.failed = true;
    return { content: '', toolCalls: [], error: 'Tool envelope must be the final output in the response.' };
  }
  state.stagedToolCalls = parsed.toolCalls;
  return { content: '', toolCalls: [] };
}

/**
 * Consume an answer delta while withholding only bytes that can still become
 * this request's exact opener. Once opened, no envelope bytes are released.
 */
export function consumeNonceToolChunk(
  state: NonceToolStreamState,
  chunk: string,
  nonce: string,
  clientTools?: any[],
): NonceToolStreamResult {
  if (!chunk) return { content: '', toolCalls: [] };
  if (state.failed) return { content: '', toolCalls: [] };
  if (state.completed) {
    // Qwen re-emits the full answer as a cumulative snapshot after the
    // incremental stream, so the already-consumed envelope (and only that)
    // can legitimately arrive again after completion. Drop re-sends of the
    // completed envelope; anything else after it is a real protocol violation.
    if (!state.completedEnvelope) {
      if (chunk.trim()) {
        state.stagedToolCalls = [];
        state.failed = true;
        return { content: '', toolCalls: [], error: 'Tool envelope must be the final output in the response.' };
      }
      return { content: '', toolCalls: [] };
    }
    const combined = state.pending + chunk;
    // Progress check: the re-send must extend the already-seen prefix.
    if (combined.length <= state.completedEnvelope.length && state.completedEnvelope.startsWith(combined)) {
      state.pending = combined;
      return { content: '', toolCalls: [] };
    }
    // Beyond the completed envelope, or diverging from it — real trailing content.
    state.stagedToolCalls = [];
    state.failed = true;
    state.completedEnvelope = undefined;
    return { content: '', toolCalls: [], error: 'Tool envelope must be the final output in the response.' };
  }

  state.pending += chunk;
  if (state.envelopeOpen) return parseOpenedEnvelope(state, nonce, clientTools);

  const opener = toolEnvelopeOpen(nonce);
  const openIndex = state.pending.indexOf(opener);
  if (openIndex >= 0) {
    // Bytes immediately before the opener that are themselves an opener prefix
    // cannot be released: a cumulative snapshot whose first chunk was too short
    // to be detected re-sends previously withheld marker bytes, which would
    // otherwise leak as ordinary content.
    const leading = state.pending.slice(0, openIndex);
    const duplicated = longestOpenerPrefixSuffix(leading, opener);
    const content = leading.slice(0, leading.length - duplicated);
    state.pending = state.pending.slice(openIndex + opener.length);
    state.envelopeOpen = true;
    const parsed = parseOpenedEnvelope(state, nonce, clientTools);
    return { content, toolCalls: parsed.toolCalls, error: parsed.error };
  }

  const genericPrefix = '<<<QG_TOOL_';
  const genericStart = state.pending.indexOf(genericPrefix);
  if (genericStart >= 0) {
    const markerEnd = state.pending.indexOf('>>>', genericStart + genericPrefix.length);
    if (markerEnd < 0) {
      const content = state.pending.slice(0, genericStart);
      state.pending = state.pending.slice(genericStart);
      return { content, toolCalls: [] };
    }
    state.pending = '';
    state.failed = true;
    return { content: '', toolCalls: [], error: 'Tool envelope used a nonce that does not match this request.' };
  }

  const heldLength = longestOpenerPrefixSuffix(state.pending, opener);
  const releaseEnd = state.pending.length - heldLength;
  const content = state.pending.slice(0, releaseEnd);
  state.pending = state.pending.slice(releaseEnd);
  return { content, toolCalls: [] };
}

/** Release an ordinary partial prefix, or reject an opened but incomplete envelope. */
export function flushNonceToolStream(state: NonceToolStreamState): NonceToolStreamResult {
  if (state.envelopeOpen) {
    state.pending = '';
    state.stagedToolCalls = [];
    state.failed = true;
    return { content: '', toolCalls: [], error: 'Tool envelope ended before its closing marker.' };
  }
  const content = state.pending;
  const toolCalls = state.stagedToolCalls;
  state.pending = '';
  state.stagedToolCalls = [];
  return { content, toolCalls };
}
