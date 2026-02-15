/**
 * Base Tool Handler
 * 
 * Provides common functionality for all tool handlers
 */

import type { ToolHandler } from './ToolHandler';
import type { JsonRpcError } from '../types';

export abstract class BaseToolHandler implements ToolHandler {
  abstract readonly category: string;
  abstract readonly tools: string[];

  protected responses = new Map<string, unknown>();
  protected errors = new Map<string, JsonRpcError>();

  constructor() {
    // Note: initializeDefaults() must be called by subclass after properties are set
  }

  /**
   * Initialize default responses for this handler
   * Must be called by subclass constructor after properties are initialized
   */
  protected abstract initializeDefaults(): void;

  async handleTool(toolName: string, args: unknown): Promise<unknown> {
    // Check for configured error
    const error = this.errors.get(toolName);
    if (error) {
      throw new Error(error.message);
    }

    // Return configured response or default
    const response = this.responses.get(toolName);
    if (response === undefined) {
      throw new Error(`No response configured for tool: ${toolName}`);
    }

    // args is available for subclasses to use
    void args;
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
