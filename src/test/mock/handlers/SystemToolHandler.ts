/**
 * System Tool Handler
 * 
 * Handles system information tools:
 * - protokoll_get_version
 * - protokoll_info
 */

import type { ToolHandler } from './ToolHandler';
import type { JsonRpcError } from '../types';

export class SystemToolHandler implements ToolHandler {
  readonly category = 'system';
  readonly tools = ['protokoll_get_version', 'protokoll_info'];

  private responses = new Map<string, unknown>();
  private errors = new Map<string, JsonRpcError>();

  constructor() {
    this.initializeDefaults();
  }

  private initializeDefaults(): void {
    // Default version response
    this.responses.set('protokoll_get_version', {
      version: '1.0.13-dev.0',
      commit: 'abc123def456',
      buildDate: new Date().toISOString(),
    });

    // Default info response
    this.responses.set('protokoll_info', {
      name: 'protokoll-mock',
      version: '1.0.0',
      description: 'Mock MCP server for testing',
      capabilities: {
        tools: true,
        resources: true,
        subscriptions: true,
      },
    });
  }

  async handleTool(toolName: string, args: unknown): Promise<unknown> {
    void args; // Available for future use
    // Check for configured error
    const error = this.errors.get(toolName);
    if (error) {
      throw new Error(error.message);
    }

    // Return configured response or default
    const response = this.responses.get(toolName);
    if (!response) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    return response;
  }

  setResponse(toolName: string, response: unknown): void {
    if (!this.tools.includes(toolName)) {
      throw new Error(`Tool ${toolName} is not handled by ${this.category} handler`);
    }
    this.responses.set(toolName, response);
  }

  setError(toolName: string, error: JsonRpcError): void {
    if (!this.tools.includes(toolName)) {
      throw new Error(`Tool ${toolName} is not handled by ${this.category} handler`);
    }
    this.errors.set(toolName, error);
  }

  reset(): void {
    this.responses.clear();
    this.errors.clear();
    this.initializeDefaults();
  }
}
