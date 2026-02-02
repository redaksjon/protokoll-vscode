/**
 * OpenAI Client Wrapper
 * Handles streaming chat with tool calling support
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { McpClient } from './mcpClient';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export class OpenAIClient {
  private client: OpenAI;
  private mcpClient: McpClient | null = null;
  private availableTools: Map<string, ToolDefinition> = new Map();

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  setMcpClient(client: McpClient): void {
    this.mcpClient = client;
  }

  /**
   * Discover available tools from MCP server and convert to OpenAI format
   */
  async discoverTools(): Promise<ChatCompletionTool[]> {
    if (!this.mcpClient) {
      throw new Error('MCP client not initialized');
    }

    try {
      // Use MCP client's listTools method
      const tools = await this.mcpClient.listTools();
      
      // Store tools for later reference
      this.availableTools.clear();
      for (const tool of tools) {
        this.availableTools.set(tool.name, tool);
      }

      // Convert MCP tools to OpenAI function format
      return tools.map(tool => this.convertToolToOpenAI(tool));
    } catch (error) {
      console.error('Failed to discover tools from MCP server, using known tools:', error);
      // Fallback to known tools if discovery fails
      const knownTools = this.getKnownTools();
      this.availableTools.clear();
      for (const tool of knownTools) {
        this.availableTools.set(tool.name, tool);
      }
      return knownTools.map(tool => this.convertToolToOpenAI(tool));
    }
  }

  /**
   * Get known tools from Protokoll (fallback if discovery fails)
   */
  private getKnownTools(): ToolDefinition[] {
    // These are the main tools we know about from the codebase
    return [
      {
        name: 'protokoll_read_transcript',
        description: 'Read a transcript file and parse its metadata and content. You can provide either an absolute path OR just a filename/partial filename.',
        inputSchema: {
          type: 'object',
          properties: {
            transcriptPath: {
              type: 'string',
              description: 'Filename, partial filename, or absolute path to the transcript',
            },
            contextDirectory: {
              type: 'string',
              description: 'Optional: Path to the .protokoll context directory',
            },
          },
          required: ['transcriptPath'],
        },
      },
      {
        name: 'protokoll_list_transcripts',
        description: 'List transcripts with pagination, filtering, and search. Returns transcript metadata including date, time, title, and file path.',
        inputSchema: {
          type: 'object',
          properties: {
            directory: { type: 'string', description: 'Optional: Directory to search for transcripts' },
            limit: { type: 'number', description: 'Maximum number of results (default: 50)' },
            offset: { type: 'number', description: 'Number of results to skip' },
            sortBy: { type: 'string', enum: ['date', 'filename', 'title'], description: 'Field to sort by' },
            startDate: { type: 'string', description: 'Filter from this date (YYYY-MM-DD)' },
            endDate: { type: 'string', description: 'Filter up to this date (YYYY-MM-DD)' },
            search: { type: 'string', description: 'Search for transcripts containing this text' },
            contextDirectory: { type: 'string', description: 'Optional: Path to the .protokoll context directory' },
          },
          required: [],
        },
      },
      {
        name: 'protokoll_edit_transcript',
        description: 'Edit an existing transcript\'s title, project assignment, and/or tags. IMPORTANT: Changing the title RENAMES THE FILE.',
        inputSchema: {
          type: 'object',
          properties: {
            transcriptPath: { type: 'string', description: 'Filename, partial filename, or absolute path' },
            title: { type: 'string', description: 'New title (will rename file)' },
            projectId: { type: 'string', description: 'New project ID to assign' },
            tagsToAdd: { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
            tagsToRemove: { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
            contextDirectory: { type: 'string', description: 'Optional: Path to the .protokoll context directory' },
          },
          required: ['transcriptPath'],
        },
      },
      {
        name: 'protokoll_provide_feedback',
        description: 'Provide natural language feedback to correct a transcript. The feedback is processed by an agentic model that can fix spelling, add terms, change project assignment, update title, etc.',
        inputSchema: {
          type: 'object',
          properties: {
            transcriptPath: { type: 'string', description: 'Filename, partial filename, or absolute path' },
            feedback: { type: 'string', description: 'Natural language feedback describing corrections needed' },
            model: { type: 'string', description: 'LLM model for processing feedback (default: gpt-5.2)' },
            contextDirectory: { type: 'string', description: 'Optional: Path to the .protokoll context directory' },
          },
          required: ['transcriptPath', 'feedback'],
        },
      },
      {
        name: 'protokoll_list_projects',
        description: 'List all projects configured in the context. Projects define routing rules for where transcripts should be saved.',
        inputSchema: {
          type: 'object',
          properties: {
            contextDirectory: { type: 'string', description: 'Path to the .protokoll context directory' },
            includeInactive: { type: 'boolean', description: 'Include inactive projects (default: false)' },
          },
          required: [],
        },
      },
      {
        name: 'protokoll_combine_transcripts',
        description: 'Combine multiple transcripts into a single document. Source files are automatically deleted after combining.',
        inputSchema: {
          type: 'object',
          properties: {
            transcriptPaths: { type: 'array', items: { type: 'string' }, description: 'Array of filenames or paths' },
            title: { type: 'string', description: 'Title for the combined transcript' },
            projectId: { type: 'string', description: 'Project ID to assign' },
            contextDirectory: { type: 'string', description: 'Optional: Path to the .protokoll context directory' },
          },
          required: ['transcriptPaths'],
        },
      },
    ];
  }

  /**
   * Convert MCP tool to OpenAI function format
   */
  private convertToolToOpenAI(tool: ToolDefinition): ChatCompletionTool {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  }

  /**
   * Execute a tool call via MCP client
   */
  private async executeToolCall(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (!this.mcpClient) {
      throw new Error('MCP client not initialized');
    }

    try {
      const result = await this.mcpClient.callTool(toolName, args);
      
      // Format result as JSON string for OpenAI
      if (typeof result === 'string') {
        return result;
      }
      return JSON.stringify(result, null, 2);
    } catch (error) {
      return `Error executing tool ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Stream chat completion with tool calling support
   */
  async *streamChat(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    onToolCall?: (toolName: string, args: Record<string, unknown>) => void
  ): AsyncGenerator<string, void, unknown> {
    // Log for debugging
    console.log('Protokoll: [OPENAI] streamChat called');
    console.log('Protokoll: [OPENAI] Messages count:', messages.length);
    console.log('Protokoll: [OPENAI] Tools count:', tools.length);
    console.log('Protokoll: [OPENAI] Messages:', JSON.stringify(messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content.substring(0, 100) : '[non-string]',
    })), null, 2));

    if (messages.length === 0) {
      console.error('Protokoll: [OPENAI] ERROR: Empty messages array passed to streamChat!');
      throw new Error('Cannot stream chat with empty messages array');
    }

    try {
      const stream = await this.client.chat.completions.create({
        model: 'gpt-5.2',
        messages,
        tools: tools.length > 0 ? tools : undefined,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        stream: true,
      });

      console.log('Protokoll: [OPENAI] Stream created successfully');

    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    let chunkCount = 0;

    for await (const chunk of stream) {
      chunkCount++;
      if (chunkCount === 1) {
        console.log('Protokoll: [OPENAI] First chunk received');
      }
      const delta = chunk.choices[0]?.delta;

      if (!delta) {
        continue;
      }

      // Handle tool calls
      if (delta.tool_calls) {
        for (const toolCallDelta of delta.tool_calls) {
          const index = toolCallDelta.index ?? 0;

          if (toolCallDelta.id && !toolCalls[index]) {
            // New tool call
            toolCalls[index] = {
              id: toolCallDelta.id,
              name: toolCallDelta.function?.name || '',
              arguments: {},
            };
          }

          if (toolCallDelta.function?.name) {
            toolCalls[index].name = toolCallDelta.function.name;
          }

          if (toolCallDelta.function?.arguments) {
            const currentArgs = toolCalls[index].arguments;
            try {
              // Parse accumulated arguments
              const argsStr = (currentArgs as unknown as string || '') + toolCallDelta.function.arguments;
              toolCalls[index].arguments = JSON.parse(argsStr);
            } catch {
              // Still accumulating
              (toolCalls[index].arguments as unknown as string) = 
                ((currentArgs as unknown as string) || '') + toolCallDelta.function.arguments;
            }
          }
        }
      }

      // Handle content
      if (delta.content) {
        yield delta.content;
      }

      // Check if stream is done and we have tool calls
      const finishReason = chunk.choices[0]?.finish_reason;
      if (finishReason === 'tool_calls' && toolCalls.length > 0) {
        console.log(`Protokoll: [OPENAI] Stream finished with tool_calls. Tool calls: ${toolCalls.length}`);
        
        // Execute all tool calls
        const toolResults: ChatCompletionMessageParam[] = [];
        for (const toolCall of toolCalls) {
          if (!toolCall.name) {
            console.warn('Protokoll: [OPENAI] Tool call missing name:', toolCall);
            continue;
          }

          console.log(`Protokoll: [OPENAI] Executing tool: ${toolCall.name}`);

          if (onToolCall) {
            onToolCall(toolCall.name, toolCall.arguments);
          }

          // Parse arguments if they're still a string
          let parsedArgs = toolCall.arguments;
          if (typeof parsedArgs === 'string') {
            try {
              parsedArgs = JSON.parse(parsedArgs);
              console.log(`Protokoll: [OPENAI] Parsed tool arguments for ${toolCall.name}`);
            } catch (parseError) {
              console.error(`Protokoll: [OPENAI] Failed to parse tool arguments for ${toolCall.name}:`, parseError);
              // If parsing fails, use empty object
              parsedArgs = {};
            }
          }

          try {
            const toolResult = await this.executeToolCall(toolCall.name, parsedArgs as Record<string, unknown>);
            console.log(`Protokoll: [OPENAI] Tool ${toolCall.name} executed successfully`);

            // Add tool result to messages
            toolResults.push({
              role: 'tool',
              // eslint-disable-next-line @typescript-eslint/naming-convention
              tool_call_id: toolCall.id,
              content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
            } as ChatCompletionMessageParam);
          } catch (toolError) {
            console.error(`Protokoll: [OPENAI] Error executing tool ${toolCall.name}:`, toolError);
            toolResults.push({
              role: 'tool',
              // eslint-disable-next-line @typescript-eslint/naming-convention
              tool_call_id: toolCall.id,
              content: `Error: ${toolError instanceof Error ? toolError.message : String(toolError)}`,
            } as ChatCompletionMessageParam);
          }
        }

        // Add assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: null,
          // eslint-disable-next-line @typescript-eslint/naming-convention
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        } as ChatCompletionMessageParam);

        // Add tool results
        messages.push(...toolResults);

        console.log(`Protokoll: [OPENAI] Continuing stream with ${messages.length} messages (including tool results)`);

        // Continue streaming with tool results (recursive call)
        yield* this.streamChat(messages, tools, onToolCall);
        return;
      }
    }

    console.log(`Protokoll: [OPENAI] Stream completed. Total chunks: ${chunkCount}`);
    } catch (error) {
      console.error('Protokoll: [OPENAI] Error in streamChat:', error);
      console.error('Protokoll: [OPENAI] Error details:', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        messagesCount: messages.length,
        toolsCount: tools.length,
      });
      throw error;
    }
  }

  /**
   * Get available tools as OpenAI format
   */
  getTools(): ChatCompletionTool[] {
    return Array.from(this.availableTools.values()).map(tool => this.convertToolToOpenAI(tool));
  }
}
