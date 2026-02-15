/**
 * JSON-RPC 2.0 Handler for Mock MCP Server
 * 
 * Implements the MCP protocol's JSON-RPC request/response handling,
 * including method routing for initialize, tools, resources, and subscriptions.
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  SessionData,
  McpInitializeParams,
  McpInitializeResult,
  McpToolsListResult,
  McpResourcesListResult,
  McpResourceReadResult,
  ToolHandler,
} from './types';

export class JsonRpcHandler {
  private toolHandlers = new Map<string, ToolHandler>();
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  /**
   * Register a tool handler
   */
  registerToolHandler(handler: ToolHandler): void {
    this.toolHandlers.set(handler.category, handler);
  }

  /**
   * Get a tool handler by category
   */
  getToolHandler(category: string): ToolHandler | undefined {
    return this.toolHandlers.get(category);
  }

  /**
   * Get a tool handler for a specific tool
   */
  getHandlerForTool(toolName: string): ToolHandler | undefined {
    for (const handler of this.toolHandlers.values()) {
      if (handler.tools.includes(toolName)) {
        return handler;
      }
    }
    return undefined;
  }

  /**
   * Handle a JSON-RPC request
   */
  async handleRequest(
    request: JsonRpcRequest,
    session: SessionData
  ): Promise<JsonRpcResponse> {
    if (this.verbose) {
      console.log(`[JSON-RPC] Handling method: ${request.method}`);
    }

    try {
      const result = await this.routeMethod(request.method, request.params, session);
      
      return {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };
    } catch (error) {
      const jsonRpcError: JsonRpcError = error instanceof Error
        ? {
            code: -32603,
            message: error.message,
            data: error.stack,
          }
        : {
            code: -32603,
            message: 'Internal error',
            data: String(error),
          };

      return {
        jsonrpc: '2.0',
        id: request.id,
        error: jsonRpcError,
      };
    }
  }

  /**
   * Route a method to the appropriate handler
   */
  private async routeMethod(
    method: string,
    params: unknown,
    session: SessionData
  ): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.handleInitialize(params as McpInitializeParams, session);
      
      case 'notifications/initialized':
        return {}; // Acknowledge initialized notification
      
      case 'tools/list':
        return this.handleToolsList();
      
      case 'tools/call':
        return this.handleToolsCall(params as { name: string; arguments: unknown });
      
      case 'resources/list':
        return this.handleResourcesList();
      
      case 'resources/read':
        return this.handleResourcesRead(params as { uri: string });
      
      case 'resources/subscribe':
        return this.handleResourcesSubscribe(params as { uri: string }, session);
      
      case 'resources/unsubscribe':
        return this.handleResourcesUnsubscribe(params as { uri: string }, session);
      
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /**
   * Handle initialize handshake
   */
  private handleInitialize(
    params: McpInitializeParams,
    session: SessionData
  ): McpInitializeResult {
    if (this.verbose) {
      console.log(`[JSON-RPC] Initialize from ${params.clientInfo.name} ${params.clientInfo.version}`);
    }

    // Mark session as initialized
    session.initialized = true;

    return {
      protocolVersion: '2024-11-05',
      capabilities: {
        resources: {
          subscribe: true,
          listChanged: true,
        },
        tools: {},
      },
      serverInfo: {
        name: 'protokoll-mock',
        version: '1.0.0',
      },
    };
  }

  /**
   * Handle tools/list request
   */
  private handleToolsList(): McpToolsListResult {
    const tools: McpToolsListResult['tools'] = [];

    // Collect tools from all registered handlers
    for (const handler of this.toolHandlers.values()) {
      for (const toolName of handler.tools) {
        tools.push({
          name: toolName,
          description: `Mock implementation of ${toolName}`,
          inputSchema: {
            type: 'object',
            properties: {},
          },
        });
      }
    }

    return { tools };
  }

  /**
   * Handle tools/call request
   */
  private async handleToolsCall(params: {
    name: string;
    arguments: unknown;
  }): Promise<unknown> {
    const { name, arguments: args } = params;

    if (this.verbose) {
      console.log(`[JSON-RPC] Tool call: ${name}`);
    }

    // Find the handler for this tool
    for (const handler of this.toolHandlers.values()) {
      if (handler.tools.includes(name)) {
        const result = await handler.handleTool(name, args);
        
        // Wrap result in MCP tool response format
        return {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result),
            },
          ],
        };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Handle resources/list request
   */
  private handleResourcesList(): McpResourcesListResult {
    // Return empty list for now - will be populated by resource handlers in Step 2
    return {
      resources: [],
    };
  }

  /**
   * Handle resources/read request
   */
  private handleResourcesRead(params: { uri: string }): McpResourceReadResult {
    // Basic implementation - will be enhanced in Step 2
    if (this.verbose) {
      console.log(`[JSON-RPC] Resource read: ${params.uri}`);
    }

    // Return mock response for now
    return {
      contents: [
        {
          uri: params.uri,
          mimeType: 'application/json',
          text: JSON.stringify({ mock: true }),
        },
      ],
    };
  }

  /**
   * Handle resources/subscribe request
   */
  private handleResourcesSubscribe(
    params: { uri: string },
    session: SessionData
  ): void {
    if (this.verbose) {
      console.log(`[JSON-RPC] Subscribe to resource: ${params.uri}`);
    }

    session.subscriptions.add(params.uri);
  }

  /**
   * Handle resources/unsubscribe request
   */
  private handleResourcesUnsubscribe(
    params: { uri: string },
    session: SessionData
  ): void {
    if (this.verbose) {
      console.log(`[JSON-RPC] Unsubscribe from resource: ${params.uri}`);
    }

    session.subscriptions.delete(params.uri);
  }
}
