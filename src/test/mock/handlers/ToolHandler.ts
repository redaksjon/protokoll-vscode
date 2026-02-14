/**
 * Base ToolHandler interface and registry for modular tool handling
 */

import type { JsonRpcError } from '../types';

/**
 * Interface that all tool handlers must implement
 */
export interface ToolHandler {
  /**
   * Category name for this handler (e.g., 'system', 'transcripts')
   */
  readonly category: string;

  /**
   * List of tool names this handler supports
   */
  readonly tools: string[];

  /**
   * Handle a tool call
   */
  handleTool(toolName: string, args: unknown): Promise<unknown>;

  /**
   * Set a custom response for a tool
   */
  setResponse(toolName: string, response: unknown): void;

  /**
   * Set an error response for a tool
   */
  setError(toolName: string, error: JsonRpcError): void;

  /**
   * Reset handler to default state
   */
  reset(): void;
}

/**
 * Registry for managing tool handlers
 */
export class ToolHandlerRegistry {
  private handlers = new Map<string, ToolHandler>();
  private toolToHandler = new Map<string, ToolHandler>();

  /**
   * Register a tool handler
   */
  register(handler: ToolHandler): void {
    this.handlers.set(handler.category, handler);

    // Build tool-to-handler mapping for fast lookup
    for (const toolName of handler.tools) {
      this.toolToHandler.set(toolName, handler);
    }
  }

  /**
   * Get a handler by category name
   */
  getHandler(category: string): ToolHandler | null {
    return this.handlers.get(category) || null;
  }

  /**
   * Get the handler for a specific tool
   */
  getHandlerForTool(toolName: string): ToolHandler | null {
    return this.toolToHandler.get(toolName) || null;
  }

  /**
   * Handle a tool call by routing to the appropriate handler
   */
  async handleToolCall(toolName: string, args: unknown): Promise<unknown> {
    const handler = this.getHandlerForTool(toolName);
    
    if (!handler) {
      throw new Error(`No handler registered for tool: ${toolName}`);
    }

    return handler.handleTool(toolName, args);
  }

  /**
   * Get all registered handlers
   */
  getAllHandlers(): ToolHandler[] {
    return Array.from(this.handlers.values());
  }

  /**
   * Get all registered tool names
   */
  getAllTools(): string[] {
    return Array.from(this.toolToHandler.keys());
  }

  /**
   * Reset all handlers to default state
   */
  resetAll(): void {
    for (const handler of this.handlers.values()) {
      handler.reset();
    }
  }

  /**
   * Clear all registered handlers
   */
  clear(): void {
    this.handlers.clear();
    this.toolToHandler.clear();
  }
}
