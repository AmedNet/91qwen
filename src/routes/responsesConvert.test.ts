import { describe, expect, test } from 'bun:test';
import { ResponsesStreamConverter } from './responsesConvert.ts';

describe('ResponsesStreamConverter', () => {
  test('does not create an empty assistant message for a tool-only response', () => {
    const converter = new ResponsesStreamConverter('gpt-4.1');
    const events = converter.processChunk({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });

    const added = events.filter((event) => event.type === 'response.output_item.added');
    const completed = events.filter((event) => event.type === 'response.output_item.done');
    expect(added).toHaveLength(1);
    expect(added[0].type === 'response.output_item.added' && added[0].item.type).toBe('function_call');
    if (added[0].type === 'response.output_item.added' && added[0].item.type === 'function_call') {
      expect(added[0].item.status).toBe('in_progress');
    }
    expect(completed).toHaveLength(1);
    if (completed[0].type === 'response.output_item.done' && completed[0].item.type === 'function_call') {
      expect(completed[0].item.status).toBe('completed');
    }

    const responseCompleted = events.find((event) => event.type === 'response.completed');
    expect(responseCompleted?.type).toBe('response.completed');
    if (responseCompleted?.type === 'response.completed') {
      expect(responseCompleted.response.output).toHaveLength(1);
      expect(responseCompleted.response.output[0].type).toBe('function_call');
      if (responseCompleted.response.output[0].type === 'function_call') {
        expect(responseCompleted.response.output[0].status).toBe('completed');
      }
    }
  });

  test('keeps unique output indexes when tools arrive before text', () => {
    const converter = new ResponsesStreamConverter('gpt-4.1');
    const toolEvents = converter.processChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{}' } }] } }],
    });
    const textEvents = converter.processChunk({
      choices: [{ delta: { content: 'late text' }, finish_reason: 'stop' }],
    });
    const events = [...toolEvents, ...textEvents];
    const added = events.filter((event) => event.type === 'response.output_item.added');
    expect(added.map((event) => event.output_index)).toEqual([0, 1]);
    expect(events.filter((event) => event.type === 'response.content_part.delta')[0].output_index).toBe(1);
    expect(events.filter((event) => event.type === 'response.function_call_arguments.delta')[0].output_index).toBe(0);
    expect(events.filter((event) => event.type === 'response.output_item.done').map((event) => event.output_index)).toEqual([1, 0]);
    const completed = events.find((event) => event.type === 'response.completed');
    if (completed?.type === 'response.completed') {
      expect(completed.response.output.map((item) => item.type)).toEqual(['function_call', 'message']);
    }
  });

  test('keeps stable indexes for multiple tools with sparse upstream indexes', () => {
    const converter = new ResponsesStreamConverter('gpt-4.1');
    const events = converter.processChunk({
      choices: [{
        delta: {
          tool_calls: [
            { index: 3, id: 'call_3', function: { name: 'third', arguments: '{}' } },
            { index: 1, id: 'call_1', function: { name: 'first', arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    });
    expect(events.filter((event) => event.type === 'response.output_item.added').map((event) => event.output_index)).toEqual([0, 1]);
    expect(events.filter((event) => event.type === 'response.output_item.done').map((event) => event.output_index)).toEqual([0, 1]);
  });

  test('completes an empty response only once', () => {
    const converter = new ResponsesStreamConverter('gpt-4.1');
    const first = converter.processChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    const second = converter.processChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    expect(first.filter((event) => event.type === 'response.completed')).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

});
