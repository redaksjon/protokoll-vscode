/**
 * MCP Client for communicating with Protokoll HTTP MCP server
 */

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  TranscriptsListResponse,
  TranscriptContent,
  McpResourceResponse,
  McpResourcesListResponse,
} from './types';

export class McpClient {
  private sessionId: string | null = null;
  private serverUrl: string;
  private sseConnection: http.ClientRequest | null = null; // HTTP request for SSE connection (works for both http and https)
  private notificationHandlers: Map<string, Array<(data: unknown) => void>> = new Map();
  private recoveringSession: boolean = false; // Flag to prevent infinite recovery loops
  private onSessionRecoveredCallbacks: Array<() => void | Promise<void>> = []; // Callbacks to run after session recovery

  constructor(serverUrl: string) {
    // Remove trailing slash to ensure consistent URL handling
    this.serverUrl = serverUrl.replace(/\/+$/, '');
  }

  /**
   * Register a callback to be called after session recovery
   * Useful for re-subscribing to resources after recovery
   */
  onSessionRecovered(callback: () => void | Promise<void>): () => void {
    this.onSessionRecoveredCallbacks.push(callback);
    // Return unsubscribe function
    return () => {
      const index = this.onSessionRecoveredCallbacks.indexOf(callback);
      if (index > -1) {
        this.onSessionRecoveredCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Initialize a session with the MCP server
   */
  async initialize(): Promise<void> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          roots: {
            listChanged: true,
          },
        },
        clientInfo: {
          name: 'protokoll-vscode',
          version: '0.1.0',
        },
      },
    };

    const response = await this.sendRequest(request);
    
    if (response.error) {
      throw new Error(`MCP initialization failed: ${response.error.message}`);
    }

    // Send initialized notification
    await this.sendNotification('notifications/initialized', {});

    // SSE connection will be started automatically when session ID is received
  }

  /**
   * Check if an error indicates a session problem that requires reinitialization
   */
  private isSessionError(error: unknown, response?: JsonRpcResponse): boolean {
    // Check HTTP 404 status
    if (error instanceof Error && error.message.includes('HTTP 404')) {
      return true;
    }
    
    // Check JSON-RPC error response
    if (response?.error) {
      const errorMessage = response.error.message?.toLowerCase() || '';
      return errorMessage.includes('session not found') || 
             errorMessage.includes('session not found');
    }
    
    return false;
  }

  /**
   * Send a JSON-RPC request with automatic session recovery
   */
  private async sendRequest(request: JsonRpcRequest, retryOnSessionError: boolean = true): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.serverUrl}/mcp`);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.sessionId) {
        headers['Mcp-Session-Id'] = this.sessionId;
      }
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers,
      };

      const httpModule = url.protocol === 'https:' ? https : http;
      const req = httpModule.request(options, (res) => {
        // Get session ID from response header if present
        const sessionIdHeader = res.headers['mcp-session-id'] as string | undefined;
        if (sessionIdHeader && !this.sessionId) {
          this.sessionId = sessionIdHeader;
          // Start SSE connection after we get the session ID
          this.startSSEConnection();
        }

        if (res.statusCode === 202) {
          // 202 Accepted for notifications
          resolve({ jsonrpc: '2.0', id: request.id, result: {} });
          return;
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          let errorText = '';
          res.on('data', (chunk) => {
            errorText += chunk.toString();
          });
          res.on('end', async () => {
            const error = new Error(`HTTP ${res.statusCode}: ${errorText}`);
            
            // Try to parse error as JSON-RPC to check for session errors
            let jsonRpcError: JsonRpcResponse | null = null;
            try {
              jsonRpcError = JSON.parse(errorText);
            } catch {
              // Not JSON, that's okay
            }
            
            // Check if this is a session error and we should retry
            if (retryOnSessionError && !this.recoveringSession && this.isSessionError(error, jsonRpcError || undefined)) {
              console.warn('Protokoll: [SESSION] Session error detected, attempting to recover...');
              try {
                await this.recoverSession();
                // Retry the original request (but don't retry again if it fails)
                try {
                  const retryResponse = await this.sendRequest(request, false);
                  resolve(retryResponse);
                  return;
                } catch (retryError) {
                  reject(retryError);
                  return;
                }
              } catch (recoveryError) {
                console.error('Protokoll: [SESSION] Failed to recover session:', recoveryError);
                reject(error);
                return;
              }
            }
            
            reject(error);
          });
          return;
        }

        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
        });
        res.on('end', async () => {
          try {
            const responseData: JsonRpcResponse = JSON.parse(data);
            
            // Check for session errors in JSON-RPC response
            if (retryOnSessionError && !this.recoveringSession && this.isSessionError(null, responseData)) {
              console.warn('Protokoll: [SESSION] Session error in response, attempting to recover...');
              try {
                await this.recoverSession();
                // Retry the original request (but don't retry again if it fails)
                try {
                  const retryResponse = await this.sendRequest(request, false);
                  resolve(retryResponse);
                  return;
                } catch (retryError) {
                  reject(retryError);
                  return;
                }
              } catch (recoveryError) {
                console.error('Protokoll: [SESSION] Failed to recover session:', recoveryError);
                resolve(responseData); // Return the original error response
                return;
              }
            }
            
            resolve(responseData);
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(JSON.stringify(request));
      req.end();
    });
  }

  /**
   * Recover session by reinitializing
   */
  private async recoverSession(): Promise<void> {
    if (this.recoveringSession) {
      console.warn('Protokoll: [SESSION] Already recovering session, skipping duplicate recovery attempt');
      return;
    }

    this.recoveringSession = true;
    console.log('Protokoll: [SESSION] 🔄 Recovering session...');
    
    try {
      // Clear the old session ID
      const oldSessionId = this.sessionId;
      this.sessionId = null;
      
      // Stop SSE connection (it will be restarted after reinitialize)
      this.stopSSEConnection();
      
      // Reinitialize
      await this.initialize();
      
      console.log(`Protokoll: [SESSION] ✅ Session recovered (old: ${oldSessionId}, new: ${this.sessionId})`);
      
      // Notify callbacks that session was recovered (e.g., to re-subscribe)
      console.log(`Protokoll: [SESSION] Notifying ${this.onSessionRecoveredCallbacks.length} callback(s) about recovery`);
      for (const callback of this.onSessionRecoveredCallbacks) {
        try {
          await callback();
        } catch (error) {
          console.error('Protokoll: [SESSION] Error in session recovery callback:', error);
        }
      }
    } catch (error) {
      console.error('Protokoll: [SESSION] ❌ Failed to recover session:', error);
      throw error;
    } finally {
      this.recoveringSession = false;
    }
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  private async sendNotification(method: string, params?: unknown): Promise<void> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: null,
      method,
      params,
    };

    await this.sendRequest(request);
  }

  /**
   * List available resources
   */
  async listResources(): Promise<McpResourcesListResponse> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'resources/list',
    };

    const response = await this.sendRequest(request);
    
    if (response.error) {
      throw new Error(`Failed to list resources: ${response.error.message}`);
    }

    return response.result as McpResourcesListResponse;
  }

  /**
   * Read a resource by URI
   * Returns raw MCP resource response with uri, mimeType, and text
   */
  async readResource(uri: string): Promise<McpResourceResponse> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'resources/read',
      params: { uri },
    };

    const response = await this.sendRequest(request);
    
    if (response.error) {
      throw new Error(`Failed to read resource: ${response.error.message}`);
    }

    const result = response.result as { contents: McpResourceResponse[] };
    if (!result.contents || result.contents.length === 0) {
      throw new Error('No content returned from resource');
    }

    return result.contents[0];
  }

  /**
   * List transcripts from a directory
   * If directory is not provided, uses the server's configured outputDirectory
   */
  async listTranscripts(directory?: string, options?: {
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
    projectId?: string;
  }): Promise<TranscriptsListResponse> {
    // Build the transcripts list URI
    const params = new URLSearchParams();
    // Only include directory if provided (server will use configured outputDirectory as fallback)
    if (directory) {
      params.set('directory', directory);
    }
    if (options?.startDate) {
      params.set('startDate', options.startDate);
    }
    if (options?.endDate) {
      params.set('endDate', options.endDate);
    }
    if (options?.limit !== undefined) {
      params.set('limit', String(options.limit));
    }
    if (options?.offset !== undefined) {
      params.set('offset', String(options.offset));
    }
    if (options?.projectId) {
      params.set('projectId', options.projectId);
    }

    const queryString = params.toString();
    const uri = queryString ? `protokoll://transcripts?${queryString}` : 'protokoll://transcripts';
    const resource = await this.readResource(uri);
    
    return JSON.parse(resource.text) as TranscriptsListResponse;
  }

  /**
   * Read a transcript by URI
   * Returns structured JSON with metadata and content - no parsing needed
   */
  async readTranscript(transcriptUri: string): Promise<TranscriptContent> {
    const resource = await this.readResource(transcriptUri);
    // Server returns structured JSON - parse it directly
    return JSON.parse(resource.text) as TranscriptContent;
  }

  /**
   * Check if server is healthy
   */
  async healthCheck(): Promise<boolean> {
    return new Promise((resolve) => {
      const url = new URL(`${this.serverUrl}/health`);
      const httpModule = url.protocol === 'https:' ? https : http;
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'GET',
        timeout: 5000,
      };

      const req = httpModule.request(options, (res) => {
        resolve(res.statusCode === 200);
      });

      req.on('error', () => {
        resolve(false);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.end();
    });
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Start a new session by clearing the current session ID and reinitializing
   */
  async startNewSession(): Promise<void> {
    this.sessionId = null;
    await this.initialize();
  }

  /**
   * List available MCP tools
   */
  async listTools(): Promise<Array<{
    name: string;
    description: string;
    inputSchema: {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
  }>> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/list',
    };

    const response = await this.sendRequest(request);
    
    if (response.error) {
      throw new Error(`Failed to list tools: ${response.error.message}`);
    }

    const result = response.result as { tools?: Array<{
      name: string;
      description: string;
      inputSchema: {
        type: string;
        properties: Record<string, unknown>;
        required?: string[];
      };
    }> };
    
    return result.tools || [];
  }

  /**
   * Call an MCP tool
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    };

    const response = await this.sendRequest(request);
    
    if (response.error) {
      throw new Error(`Failed to call tool ${toolName}: ${response.error.message}`);
    }

    const result = response.result as { content?: Array<{ type: string; text?: string }> };
    
    // Extract text content from result if present
    if (result.content && result.content.length > 0) {
      const textContent = result.content.find(c => c.type === 'text');
      if (textContent?.text) {
        try {
          return JSON.parse(textContent.text);
        } catch {
          return textContent.text;
        }
      }
    }

    return result;
  }

  /**
   * Start Server-Sent Events connection to receive notifications
   */
  private startSSEConnection(): void {
    if (!this.sessionId) {
      console.warn('Protokoll: [SSE] Cannot start SSE connection without session ID');
      return;
    }

    // Close existing connection if any
    this.stopSSEConnection();

    console.log('Protokoll: [SSE] Starting SSE connection...');
    console.log(`Protokoll: [SSE] Server URL: ${this.serverUrl}`);
    console.log(`Protokoll: [SSE] Session ID: ${this.sessionId}`);

    try {
      const url = new URL(`${this.serverUrl}/mcp`);
      const httpModule = url.protocol === 'https:' ? https : http;
      
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache', // eslint-disable-line @typescript-eslint/naming-convention
          'Mcp-Session-Id': this.sessionId,
        },
      };

      const req = httpModule.request(options, (res) => {
        if (res.statusCode !== 200) {
          console.error(`Protokoll: [SSE] Connection failed with status ${res.statusCode}`);
          
          // Read error response body
          let errorBody = '';
          res.on('data', (chunk) => {
            errorBody += chunk.toString();
          });
          res.on('end', () => {
            console.error(`Protokoll: [SSE] Error response: ${errorBody}`);
            
            // If we get a 404, the session might be invalid
            // Try to recover the session
            if (res.statusCode === 404 && !this.recoveringSession) {
              console.warn('Protokoll: [SSE] 404 error - session may be invalid, attempting recovery...');
              this.recoverSession().catch((error) => {
                console.error('Protokoll: [SSE] Failed to recover session:', error);
              });
            }
          });
          
          return;
        }

        console.log('Protokoll: [SSE] ✅ Connection established, waiting for events...');

        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          const dataStr = chunk.toString();
          console.log(`Protokoll: [SSE] 📥 Received ${dataStr.length} bytes of data`);
          buffer += dataStr;
          
          // Process complete SSE messages (events end with double newline)
          while (buffer.includes('\n\n')) {
            const eventEnd = buffer.indexOf('\n\n');
            const eventText = buffer.substring(0, eventEnd);
            buffer = buffer.substring(eventEnd + 2);

            console.log(`Protokoll: [SSE] 📨 Processing SSE event:\n${eventText}`);

            // Parse SSE event
            let eventType = 'message';
            const dataLines: string[] = [];

            for (const line of eventText.split('\n')) {
              if (line.startsWith('event:')) {
                eventType = line.substring(6).trim();
                console.log(`Protokoll: [SSE] Event type: ${eventType}`);
              } else if (line.startsWith('data:')) {
                dataLines.push(line.substring(5));
              } else if (line.startsWith(':')) {
                // Comment line (like : connected or : ping), ignore
                const comment = line.substring(1).trim();
                if (comment === 'connected') {
                  console.log('Protokoll: [SSE] ✅ Server confirmed connection');
                } else if (comment === 'ping') {
                  console.log('Protokoll: [SSE] 💓 Received ping');
                } else {
                  console.log(`Protokoll: [SSE] 💬 Comment: ${comment}`);
                }
                continue;
              }
            }

            // Join multi-line data
            const eventData = dataLines.join('\n').trim();
            
            if (eventData) {
              console.log(`Protokoll: [SSE] 📦 Event data: ${eventData.substring(0, 200)}${eventData.length > 200 ? '...' : ''}`);
              this.handleSSEEvent(eventType, eventData);
            }
          }
        });

        res.on('end', () => {
          console.log('Protokoll: [SSE] ⚠️ Connection closed by server (end event)');
          console.log(`Protokoll: [SSE] Remaining buffer: ${buffer.length} bytes`);
          this.sseConnection = null;
          // Attempt to reconnect after a delay
          setTimeout(() => {
            if (this.sessionId) {
              console.log('Protokoll: [SSE] 🔄 Attempting to reconnect...');
              this.startSSEConnection();
            }
          }, 5000);
        });

        res.on('error', (error) => {
          console.error('Protokoll: [SSE] ❌ Connection error:', error);
          console.error('Protokoll: [SSE] Error details:', error.message, error.stack);
          this.sseConnection = null;
        });
      });

      req.on('error', (error) => {
        console.error('Protokoll: [SSE] ❌ Request error:', error);
        console.error('Protokoll: [SSE] Request error details:', error.message, error.stack);
        this.sseConnection = null;
      });

      req.end();
      this.sseConnection = req;
      
      console.log('Protokoll: [SSE] Connection request sent');
    } catch (error) {
      console.error('Protokoll: [SSE] ❌ Failed to start SSE connection:', error);
    }
  }

  /**
   * Stop SSE connection
   */
  private stopSSEConnection(): void {
    if (this.sseConnection) {
      try {
        this.sseConnection.destroy();
      } catch (error) {
        // Ignore errors when closing
      }
      this.sseConnection = null;
    }
  }

  /**
   * Handle SSE event
   */
  private handleSSEEvent(eventType: string, data: string): void {
    console.log('Protokoll: [SSE] 📨 Received SSE event');
    console.log(`Protokoll: [SSE] Event type: ${eventType}`);
    
    try {
      // Parse JSON-RPC notification format
      const notification = JSON.parse(data);
      
      console.log(`Protokoll: [SSE] Notification method: ${notification.method || '(none)'}`);
      if (notification.params) {
        console.log(`Protokoll: [SSE] Notification params:`, JSON.stringify(notification.params, null, 2));
      }
      
      if (notification.method) {
        const handlers = this.notificationHandlers.get(notification.method) || [];
        console.log(`Protokoll: [SSE] Found ${handlers.length} handler(s) for ${notification.method}`);
        
        if (handlers.length === 0) {
          console.warn(`Protokoll: [SSE] ⚠️ No handlers registered for notification: ${notification.method}`);
        }
        
        for (const handler of handlers) {
          try {
            handler(notification.params || {});
            console.log(`Protokoll: [SSE] ✅ Handler executed for ${notification.method}`);
          } catch (error) {
            console.error(`Protokoll: [SSE] ❌ Error in notification handler for ${notification.method}:`, error);
          }
        }
      } else {
        console.warn('Protokoll: [SSE] ⚠️ SSE event has no method field');
      }
    } catch (error) {
      // If not JSON, treat as plain text
      console.log(`Protokoll: [SSE] Received non-JSON event (${eventType}):`, data);
      console.error(`Protokoll: [SSE] Parse error:`, error);
    }
  }

  /**
   * Subscribe to a notification type
   */
  onNotification(method: string, handler: (data: unknown) => void): () => void {
    if (!this.notificationHandlers.has(method)) {
      this.notificationHandlers.set(method, []);
    }
    this.notificationHandlers.get(method)!.push(handler);

    // Return unsubscribe function
    return () => {
      const handlers = this.notificationHandlers.get(method);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index > -1) {
          handlers.splice(index, 1);
        }
      }
    };
  }

  /**
   * Subscribe to changes for a specific resource URI
   */
  async subscribeToResource(uri: string): Promise<void> {
    console.log('Protokoll: [SUBSCRIPTION] Starting subscription request...');
    console.log(`Protokoll: [SUBSCRIPTION] Resource URI: ${uri}`);
    console.log(`Protokoll: [SUBSCRIPTION] Session ID: ${this.sessionId || '(none)'}`);
    
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'resources/subscribe',
      params: { uri },
    };

    const response = await this.sendRequest(request);
    
    if (response.error) {
      console.error(`Protokoll: [SUBSCRIPTION] Failed to subscribe: ${response.error.message}`);
      throw new Error(`Failed to subscribe to resource: ${response.error.message}`);
    }

    console.log(`Protokoll: [SUBSCRIPTION] ✅ Successfully subscribed to resource: ${uri}`);
  }

  /**
   * Unsubscribe from changes for a specific resource URI
   */
  async unsubscribeFromResource(uri: string): Promise<void> {
    console.log('Protokoll: [UNSUBSCRIPTION] Starting unsubscribe request...');
    console.log(`Protokoll: [UNSUBSCRIPTION] Resource URI: ${uri}`);
    console.log(`Protokoll: [UNSUBSCRIPTION] Session ID: ${this.sessionId || '(none)'}`);
    
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'resources/unsubscribe',
      params: { uri },
    };

    const response = await this.sendRequest(request);
    
    if (response.error) {
      console.error(`Protokoll: [UNSUBSCRIPTION] Failed to unsubscribe: ${response.error.message}`);
      throw new Error(`Failed to unsubscribe from resource: ${response.error.message}`);
    }

    console.log(`Protokoll: [UNSUBSCRIPTION] ✅ Successfully unsubscribed from resource: ${uri}`);
  }

  /**
   * Cleanup: stop SSE connection
   */
  dispose(): void {
    this.stopSSEConnection();
    this.notificationHandlers.clear();
  }
}
