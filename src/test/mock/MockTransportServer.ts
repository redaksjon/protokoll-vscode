/**
 * Mock MCP Transport Server
 * 
 * Implements a complete HTTP + SSE MCP server for testing the Protokoll VS Code extension.
 * Speaks real MCP protocol (JSON-RPC 2.0) to genuinely exercise the extension's transport layer.
 */

import * as http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { SessionManager } from './SessionManager';
import { SseManager } from './SseManager';
import { JsonRpcHandler } from './JsonRpcHandler';
import { createDefaultHandlers } from './handlers';
import type { ToolHandler } from './handlers';
import type {
  MockServerConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from './types';

export class MockTransportServer {
  private httpServer: http.Server | null = null;
  private sessionManager: SessionManager;
  private sseManager: SseManager;
  private jsonRpcHandler: JsonRpcHandler;
  private port = 0;
  private running = false;
  private verbose: boolean;

  constructor(config: MockServerConfig = {}) {
    this.verbose = config.verbose ?? false;
    this.sessionManager = new SessionManager(config.sessionTimeout);
    this.sseManager = new SseManager(this.verbose);
    this.jsonRpcHandler = new JsonRpcHandler(this.verbose);

    // Register default tool handlers
    const registry = createDefaultHandlers();
    for (const handler of registry.getAllHandlers()) {
      this.jsonRpcHandler.registerToolHandler(handler);
    }
  }

  /**
   * Start the mock server on the specified port (or random available port)
   */
  async start(port = 0): Promise<void> {
    if (this.running) {
      throw new Error('Server is already running');
    }

    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          console.error('[MockServer] Error handling request:', error);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Internal server error' }));
        });
      });

      this.httpServer.on('error', reject);

      this.httpServer.listen(port, () => {
        const address = this.httpServer!.address();
        if (typeof address === 'object' && address !== null) {
          this.port = address.port;
        }
        this.running = true;

        if (this.verbose) {
          console.log(`[MockServer] Started on port ${this.port}`);
        }

        resolve();
      });
    });
  }

  /**
   * Stop the mock server and clean up resources
   */
  async stop(): Promise<void> {
    if (!this.running || !this.httpServer) {
      return;
    }

    return new Promise((resolve, reject) => {
      // Close all SSE connections
      this.sseManager.closeAll();

      // Close HTTP server
      this.httpServer!.close((error) => {
        if (error) {
          reject(error);
        } else {
          this.running = false;
          this.httpServer = null;

          if (this.verbose) {
            console.log('[MockServer] Stopped');
          }

          resolve();
        }
      });
    });
  }

  /**
   * Get the port the server is listening on
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get the base URL of the server
   */
  getBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Check if the server is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the session manager (for test utilities)
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Get the SSE manager (for test utilities)
   */
  getSseManager(): SseManager {
    return this.sseManager;
  }

  /**
   * Get the JSON-RPC handler (for registering tool handlers)
   */
  getJsonRpcHandler(): JsonRpcHandler {
    return this.jsonRpcHandler;
  }

  /**
   * Register a tool handler
   */
  registerToolHandler(handler: ToolHandler): void {
    this.jsonRpcHandler.registerToolHandler(handler);
  }

  /**
   * Get a tool handler by category
   */
  getHandler<T extends ToolHandler>(category: string): T | undefined {
    return this.jsonRpcHandler.getToolHandler(category) as T | undefined;
  }


  /**
   * Load a compiled scenario
   */
  loadScenario(scenario: { apply: (server: MockTransportServer) => void }): void {
    if (this.verbose) {
      console.log(`[MockServer] Loading scenario`);
    }

    scenario.apply(this);
  }

  /**
   * Get a tool handler for a specific tool (for scenario composition)
   */
  getHandlerForTool(toolName: string): ToolHandler | undefined {
    return this.jsonRpcHandler.getHandlerForTool(toolName);
  }

  // ============================================================================
  // SSE Testing Integration
  // ============================================================================

  /**
   * Wait for SSE connection to be established
   */
  async waitForSseConnection(sessionId: string, timeoutMs = 5000): Promise<void> {
    return this.sseManager.waitForConnection(sessionId, timeoutMs);
  }

  /**
   * Send a notification to a specific session
   */
  sendNotification(sessionId: string, notification: JsonRpcNotification): void {
    this.sseManager.sendToSession(sessionId, notification);
  }

  /**
   * Broadcast a notification to all connected sessions
   */
  broadcastNotification(notification: JsonRpcNotification): void {
    this.sseManager.broadcast(notification);
  }

  /**
   * Simulate connection issues for testing
   */
  simulateConnectionIssues(sessionId: string, scenario: {
    type: 'drop_and_reconnect' | 'network_delay' | 'keepalive_timeout';
    delayMs?: number;
  }): void {
    switch (scenario.type) {
      case 'drop_and_reconnect':
        this.sseManager.simulateConnectionDrop(sessionId);
        break;
      case 'network_delay':
        this.sseManager.simulateNetworkDelay(sessionId, scenario.delayMs || 1000);
        break;
      case 'keepalive_timeout':
        // Simulate keepalive timeout by dropping connection
        this.sseManager.simulateConnectionDrop(sessionId);
        break;
    }
  }

  /**
   * Get SSE statistics for testing
   */
  getSseStatistics(): {
    activeConnections: number;
    totalConnectionEvents: number;
    totalNotifications: number;
    deliveredNotifications: number;
    failedNotifications: number;
  } {
    return this.sseManager.getStatistics();
  }

  /**
   * Clear SSE history (useful between tests)
   */
  clearSseHistory(): void {
    this.sseManager.clearHistory();
  }

  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Health check endpoint
    if (url.pathname === '/health' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // MCP endpoint
    if (url.pathname === '/mcp') {
      if (req.method === 'GET') {
        // SSE connection request
        await this.handleSseConnection(req, res);
      } else if (req.method === 'POST') {
        // JSON-RPC request
        await this.handleJsonRpcRequest(req, res);
      } else {
        res.statusCode = 405;
        res.end('Method not allowed');
      }
      return;
    }

    // Unknown endpoint
    res.statusCode = 404;
    res.end('Not found');
  }

  /**
   * Handle SSE connection request
   */
  private async handleSseConnection(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
      res.statusCode = 400;
      res.end('Missing Mcp-Session-Id header');
      return;
    }

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      res.statusCode = 404;
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Session not found',
        },
      }));
      return;
    }

    // Establish SSE connection
    this.sseManager.addConnection(sessionId, res);
  }

  /**
   * Handle JSON-RPC request
   */
  private async handleJsonRpcRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Read request body
    const body = await this.readRequestBody(req);
    let request: JsonRpcRequest;

    try {
      request = JSON.parse(body);
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
        },
      }));
      return;
    }

    // Get or create session
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let session = sessionId ? this.sessionManager.getSession(sessionId) : null;

    // Create new session if needed (for initialize request)
    if (!session && request.method === 'initialize') {
      session = this.sessionManager.createSession();
    }

    if (!session) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32001,
          message: 'Session not found',
        },
      }));
      return;
    }

    // Update session activity
    this.sessionManager.updateActivity(session.sessionId);

    // Handle the request
    const response: JsonRpcResponse = await this.jsonRpcHandler.handleRequest(
      request,
      session
    );

    // Send response
    res.statusCode = request.id === null ? 202 : 200; // 202 for notifications
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Mcp-Session-Id', session.sessionId);
    res.end(JSON.stringify(response));
  }

  /**
   * Read the request body
   */
  private readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        resolve(body);
      });
      req.on('error', reject);
    });
  }
}
