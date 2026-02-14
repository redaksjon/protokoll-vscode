/**
 * Protocol Compliance Tests for Mock MCP Server
 * 
 * Verifies that the mock server correctly implements the MCP protocol:
 * - Initialize handshake with session ID generation
 * - JSON-RPC 2.0 request/response handling
 * - SSE connection establishment and notification delivery
 * - Session lifecycle management
 * 
 * @vitest-environment node
 */

// @vitest-environment node tells Vitest to skip the global setup for this file
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockTransportServer } from '../src/test/mock/MockTransportServer';
import type { JsonRpcRequest, JsonRpcResponse } from '../src/test/mock/types';

describe('MockTransportServer', () => {
  let server: MockTransportServer;

  beforeEach(async () => {
    server = new MockTransportServer({ verbose: false });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('Server Lifecycle', () => {
    it('should start on an available port', () => {
      expect(server.getPort()).toBeGreaterThan(0);
      expect(server.isRunning()).toBe(true);
    });

    it('should provide a base URL', () => {
      const baseUrl = server.getBaseUrl();
      expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it('should stop cleanly', async () => {
      await server.stop();
      expect(server.isRunning()).toBe(false);
    });
  });

  describe('Health Check', () => {
    it('should respond to health check requests', async () => {
      const response = await fetch(`${server.getBaseUrl()}/health`);
      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data).toEqual({ status: 'ok' });
    });
  });

  describe('MCP Initialize Handshake', () => {
    it('should handle initialize request and return session ID', async () => {
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
            name: 'test-client',
            version: '1.0.0',
          },
        },
      };

      const response = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeTruthy();

      const data = await response.json() as JsonRpcResponse;
      expect(data.jsonrpc).toBe('2.0');
      expect(data.id).toBe(1);
      expect(data.result).toMatchObject({
        protocolVersion: '2024-11-05',
        serverInfo: {
          name: 'protokoll-mock',
          version: '1.0.0',
        },
      });
    });

    it('should accept initialized notification', async () => {
      // First initialize
      const initRequest: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const initResponse = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initRequest),
      });

      const sessionId = initResponse.headers.get('mcp-session-id')!;

      // Then send initialized notification
      const notification: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: null,
        method: 'notifications/initialized',
        params: {},
      };

      const notifResponse = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sessionId,
        },
        body: JSON.stringify(notification),
      });

      expect(notifResponse.status).toBe(202); // Notifications return 202
    });
  });

  describe('Session Management', () => {
    it('should reject requests without session ID (except initialize)', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      };

      const response = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      expect(response.status).toBe(404);
      const data = await response.json() as JsonRpcResponse;
      expect(data.error?.message).toContain('Session not found');
    });

    it('should reject requests with invalid session ID', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      };

      const response = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'invalid-session-id',
        },
        body: JSON.stringify(request),
      });

      expect(response.status).toBe(404);
    });

    it('should track session activity', async () => {
      // Initialize
      const initRequest: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const initResponse = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initRequest),
      });

      const sessionId = initResponse.headers.get('mcp-session-id')!;
      const sessionManager = server.getSessionManager();
      const session = sessionManager.getSession(sessionId);

      expect(session).toBeTruthy();
      expect(session!.initialized).toBe(true);
      expect(session!.requestCount).toBe(1);
    });

    it('should support controlled session expiration for testing', async () => {
      // Initialize
      const initRequest: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const initResponse = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initRequest),
      });

      const sessionId = initResponse.headers.get('mcp-session-id')!;

      // Schedule expiration after 2 requests
      server.getSessionManager().expireSessionAfter(sessionId, 2);

      // Make a second request (should succeed)
      const request2: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      };

      const response2 = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sessionId,
        },
        body: JSON.stringify(request2),
      });

      expect(response2.status).toBe(200);

      // Session should now be expired, third request should fail
      const request3: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
      };

      const response3 = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sessionId,
        },
        body: JSON.stringify(request3),
      });

      expect(response3.status).toBe(404);
    });
  });

  describe('JSON-RPC Protocol', () => {
    let sessionId: string;

    beforeEach(async () => {
      // Initialize session
      const initRequest: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const response = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initRequest),
      });

      sessionId = response.headers.get('mcp-session-id')!;
    });

    it('should handle tools/list request', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      };

      const response = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sessionId,
        },
        body: JSON.stringify(request),
      });

      expect(response.status).toBe(200);
      const data = await response.json() as JsonRpcResponse;
      expect(data.result).toHaveProperty('tools');
      expect(Array.isArray((data.result as any).tools)).toBe(true);
    });

    it('should handle resources/list request', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/list',
      };

      const response = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sessionId,
        },
        body: JSON.stringify(request),
      });

      expect(response.status).toBe(200);
      const data = await response.json() as JsonRpcResponse;
      expect(data.result).toHaveProperty('resources');
    });

    it('should return error for unknown method', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'unknown/method',
      };

      const response = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sessionId,
        },
        body: JSON.stringify(request),
      });

      expect(response.status).toBe(200);
      const data = await response.json() as JsonRpcResponse;
      expect(data.error).toBeTruthy();
      expect(data.error?.message).toContain('Unknown method');
    });

    it('should return parse error for invalid JSON', async () => {
      const response = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sessionId,
        },
        body: 'invalid json',
      });

      expect(response.status).toBe(400);
      const data = await response.json() as JsonRpcResponse;
      expect(data.error?.code).toBe(-32700);
      expect(data.error?.message).toContain('Parse error');
    });
  });

  describe('SSE Connection', () => {
    let sessionId: string;

    beforeEach(async () => {
      // Initialize session
      const initRequest: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const response = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initRequest),
      });

      sessionId = response.headers.get('mcp-session-id')!;
    });

    it('should accept SSE connection with valid session ID', async () => {
      const response = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Mcp-Session-Id': sessionId,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
    });

    it('should reject SSE connection without session ID', async () => {
      const response = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
        },
      });

      expect(response.status).toBe(400);
    });

    it('should reject SSE connection with invalid session ID', async () => {
      const response = await fetch(`${server.getBaseUrl()}/mcp`, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Mcp-Session-Id': 'invalid-session',
        },
      });

      expect(response.status).toBe(404);
    });
  });
});
