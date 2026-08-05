import { describe, expect, test } from 'bun:test';
import type { Message } from '../types/openai.ts';
import { trimMessagesToContext } from './chat.ts';

const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string): Message => ({ role: 'assistant', content });

describe('trimMessagesToContext', () => {
  test('leaves requests under the limit unchanged', () => {
    const messages = [user('hello'), assistant('world')];
    const result = trimMessagesToContext(messages, 1000);
    expect(result.trimmed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  test('preserves instruction and conversation order when trimming', () => {
    const messages: Message[] = [
      { role: 'system', content: 'system one' },
      user('old '.repeat(100)),
      { role: 'developer', content: 'developer two' },
      user('latest'),
    ];
    const result = trimMessagesToContext(messages, 80);
    expect(result.messages.map((message) => message.role)).toEqual(['system', 'developer', 'user']);
    expect(result.messages.map((message) => message.content)).toEqual(['system one', 'developer two', 'latest']);
  });

  test('reserves max output tokens while selecting history', () => {
    const messages = [user('old '.repeat(40)), user('latest')];
    const result = trimMessagesToContext(messages, 100, undefined, 80);
    expect(result.messages).toEqual([messages[1]]);
  });

  test('retains a tool call only together with all tool results', () => {
    const messages: Message[] = [
      user('old '.repeat(100)),
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'call_b', type: 'function', function: { name: 'b', arguments: '{}' } },
      ] },
      { role: 'tool', content: 'result a', tool_call_id: 'call_a' },
      { role: 'tool', content: 'result b', tool_call_id: 'call_b' },
      user('latest'),
    ];
    const result = trimMessagesToContext(messages, 75);
    expect(result.messages).toEqual(messages.slice(1));
  });

  test('drops incomplete tool turns rather than creating an orphan', () => {
    const messages: Message[] = [
      user('old '.repeat(100)),
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'a', arguments: '{}' } }] },
      { role: 'tool', content: 'result a', tool_call_id: 'other_call' },
      user('latest'),
    ];
    const result = trimMessagesToContext(messages, 100);
    expect(result.messages.map((message) => message.role)).toEqual(['user']);
    expect(result.messages[0].content).toBe('latest');
  });
});
