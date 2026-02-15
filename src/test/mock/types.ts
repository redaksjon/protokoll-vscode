/**
 * Type definitions for the Mock MCP Server
 */

import type { ServerResponse } from 'http';

// ============================================================================
// JSON-RPC Types
// ============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// ============================================================================
// Session Types
// ============================================================================

export interface SessionData {
  sessionId: string;
  initialized: boolean;
  subscriptions: Set<string>;
  lastActivity: number;
  requestCount: number;
}

// ============================================================================
// Server Configuration
// ============================================================================

export interface MockServerConfig {
  /**
   * Port to listen on (0 = random available port)
   */
  port?: number;

  /**
   * Session timeout in milliseconds
   */
  sessionTimeout?: number;

  /**
   * Enable verbose logging for debugging
   */
  verbose?: boolean;

  /**
   * Default responses for tools (can be overridden per-test)
   */
  defaultResponses?: Record<string, unknown>;
}

// ============================================================================
// SSE Types
// ============================================================================

export interface SseConnection {
  sessionId: string;
  response: ServerResponse;
  connected: boolean;
  delayMs?: number;
}

// ============================================================================
// Tool Handler Types
// ============================================================================

export interface ToolHandler {
  readonly category: string;
  readonly tools: string[];
  
  handleTool(toolName: string, args: unknown): Promise<unknown>;
  setResponse(toolName: string, response: unknown): void;
  setError(toolName: string, error: JsonRpcError): void;
  reset(): void;
}

// ============================================================================
// MCP Protocol Types
// ============================================================================

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: {
    roots?: {
      listChanged?: boolean;
    };
  };
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    resources?: {
      subscribe?: boolean;
      listChanged?: boolean;
    };
    tools?: Record<string, unknown>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface McpToolsListResult {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
  }>;
}

export interface McpResourcesListResult {
  resources: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
  }>;
}

export interface McpResourceReadResult {
  contents: Array<{
    uri: string;
    mimeType: string;
    text: string;
  }>;
}
