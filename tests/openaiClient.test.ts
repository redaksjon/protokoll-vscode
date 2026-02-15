/**
 * Tests for OpenAI Client
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIClient } from '../src/openaiClient';
import { McpClient } from '../src/mcpClient';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

// Mock OpenAI
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    })),
  };
});

describe('OpenAIClient', () => {
  let client: OpenAIClient;
  let mockMcpClient: McpClient;
  let mockOpenAI: any;

  beforeEach(async () => {
    const OpenAI = (await import('openai')).default;
    mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    (OpenAI as any).mockImplementation(() => mockOpenAI);

    client = new OpenAIClient('test-api-key');
    mockMcpClient = {
      listTools: vi.fn(),
      callTool: vi.fn(),
    } as any;

    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create OpenAI client with API key', () => {
      expect(client).toBeInstanceOf(OpenAIClient);
    });
  });

  describe('setMcpClient', () => {
    it('should set MCP client', () => {
      client.setMcpClient(mockMcpClient);
      expect(client).toBeDefined();
    });
  });

  describe('discoverTools', () => {
    it('should discover tools from MCP client', async () => {
      const mockTools = [
        {
          name: 'protokoll_read_transcript',
          description: 'Read a transcript',
          inputSchema: {
            type: 'object',
            properties: {
              transcriptPath: { type: 'string' },
            },
            required: ['transcriptPath'],
          },
        },
      ];

      mockMcpClient.listTools = vi.fn().mockResolvedValue(mockTools);
      client.setMcpClient(mockMcpClient);

      const tools = await client.discoverTools();

      expect(mockMcpClient.listTools).toHaveBeenCalled();
      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({
        type: 'function',
        function: {
          name: 'protokoll_read_transcript',
          description: 'Read a transcript',
          parameters: mockTools[0].inputSchema,
        },
      });
    });

    it('should throw error if MCP client not initialized', async () => {
      await expect(client.discoverTools()).rejects.toThrow('MCP client not initialized');
    });

    it('should fallback to known tools if discovery fails', async () => {
      mockMcpClient.listTools = vi.fn().mockRejectedValue(new Error('Discovery failed'));
      client.setMcpClient(mockMcpClient);

      const tools = await client.discoverTools();

      expect(tools.length).toBeGreaterThan(0);
      expect(tools[0].type).toBe('function');
    });

    it('should convert multiple tools correctly', async () => {
      const mockTools = [
        {
          name: 'tool1',
          description: 'Tool 1',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'tool2',
          description: 'Tool 2',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      mockMcpClient.listTools = vi.fn().mockResolvedValue(mockTools);
      client.setMcpClient(mockMcpClient);

      const tools = await client.discoverTools();

      expect(tools).toHaveLength(2);
      expect(tools[0].function.name).toBe('tool1');
      expect(tools[1].function.name).toBe('tool2');
    });
  });

  describe('getTools', () => {
    it('should return empty array initially', () => {
      const tools = client.getTools();
      expect(tools).toEqual([]);
    });

    it('should return discovered tools', async () => {
      const mockTools = [
        {
          name: 'test_tool',
          description: 'Test tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      mockMcpClient.listTools = vi.fn().mockResolvedValue(mockTools);
      client.setMcpClient(mockMcpClient);

      await client.discoverTools();
      const tools = client.getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].function.name).toBe('test_tool');
    });
  });

  describe('streamChat', () => {
    it('should stream chat completion', async () => {
      const mockMessages = [
        { role: 'user' as const, content: 'Hello' },
      ];

      // Mock streaming response
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            choices: [{
              delta: { content: 'Hello ' },
            }],
          };
          yield {
            choices: [{
              delta: { content: 'there!' },
            }],
          };
        },
      };

      mockOpenAI.chat.completions.create.mockResolvedValue(mockStream);

      const chunks: string[] = [];
      for await (const chunk of client.streamChat(mockMessages, [])) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(['Hello ', 'there!']);
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalledWith({
        model: 'gpt-5.2',
        messages: mockMessages,
        tools: undefined,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        tool_choice: undefined,
        stream: true,
      });
    });

    it('should throw error for empty messages array', async () => {
      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _chunk of client.streamChat([], [])) {
          // Should not reach here
        }
      }).rejects.toThrow('Cannot stream chat with empty messages array');
    });

    it('should include tools in request when provided', async () => {
      const mockMessages = [
        { role: 'user' as const, content: 'Hello' },
      ];

      const mockTools: ChatCompletionTool[] = [
        {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'Test',
            parameters: { type: 'object', properties: {} },
          },
        },
      ];

      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            choices: [{
              delta: { content: 'Response' },
            }],
          };
        },
      };

      mockOpenAI.chat.completions.create.mockResolvedValue(mockStream);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of client.streamChat(mockMessages, mockTools)) {
        // Just consume the stream
      }

      expect(mockOpenAI.chat.completions.create).toHaveBeenCalledWith({
        model: 'gpt-5.2',
        messages: mockMessages,
        tools: mockTools,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        tool_choice: 'auto',
        stream: true,
      });
    });

    it('should handle tool calls in stream', async () => {
      const mockMessages = [
        { role: 'user' as const, content: 'Read transcript' },
      ];

      const mockTools: ChatCompletionTool[] = [
        {
          type: 'function',
          function: {
            name: 'protokoll_read_transcript',
            description: 'Read transcript',
            parameters: { type: 'object', properties: {} },
          },
        },
      ];

      mockMcpClient.callTool = vi.fn().mockResolvedValue({ content: 'Transcript content' });
      client.setMcpClient(mockMcpClient);

      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            choices: [{
              delta: {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                tool_calls: [{
                  index: 0,
                  id: 'call_123',
                  function: {
                    name: 'protokoll_read_transcript',
                    arguments: '{"transcriptPath":"test.md"}',
                  },
                }],
              },
            }],
          };
          yield {
            choices: [{
              delta: {},
              // eslint-disable-next-line @typescript-eslint/naming-convention
              finish_reason: 'tool_calls',
            }],
          };
        },
      };

      mockOpenAI.chat.completions.create.mockResolvedValue(mockStream);

      const onToolCall = vi.fn();
      const chunks: string[] = [];

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const chunk of client.streamChat(mockMessages, mockTools, onToolCall)) {
        chunks.push(chunk);
      }

      expect(onToolCall).toHaveBeenCalledWith('protokoll_read_transcript', { transcriptPath: 'test.md' });
      expect(mockMcpClient.callTool).toHaveBeenCalledWith('protokoll_read_transcript', { transcriptPath: 'test.md' });
    });

    it('should handle streaming errors gracefully', async () => {
      const mockMessages = [
        { role: 'user' as const, content: 'Hello' },
      ];

      mockOpenAI.chat.completions.create.mockRejectedValue(new Error('API Error'));

      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _chunk of client.streamChat(mockMessages, [])) {
          // Should not reach here
        }
      }).rejects.toThrow('API Error');
    });

    it('should handle chunks without delta', async () => {
      const mockMessages = [
        { role: 'user' as const, content: 'Hello' },
      ];

      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            choices: [{
              delta: { content: 'Hello' },
            }],
          };
          yield {
            choices: [{}], // No delta
          };
          yield {
            choices: [{
              delta: { content: ' world' },
            }],
          };
        },
      };

      mockOpenAI.chat.completions.create.mockResolvedValue(mockStream);

      const chunks: string[] = [];
      for await (const chunk of client.streamChat(mockMessages, [])) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(['Hello', ' world']);
    });
  });
});
