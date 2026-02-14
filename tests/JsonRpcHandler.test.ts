/**
 * JsonRpcHandler Tests
 * 
 * Tests for JSON-RPC 2.0 protocol handling including method routing,
 * tool calls, resource operations, and subscriptions.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JsonRpcHandler } from '../src/test/mock/JsonRpcHandler';
import { SystemToolHandler, TranscriptToolHandler } from '../src/test/mock/handlers';
import type { JsonRpcRequest, SessionData } from '../src/test/mock/types';

describe('JsonRpcHandler', () => {
  let handler: JsonRpcHandler;
  let session: SessionData;

  beforeEach(() => {
    handler = new JsonRpcHandler(false);
    
    // Create mock session
    session = {
      sessionId: 'test-session',
      initialized: false,
      subscriptions: new Set(),
      lastActivity: Date.now(),
      requestCount: 0,
    };

    // Register some tool handlers
    handler.registerToolHandler(new SystemToolHandler());
    handler.registerToolHandler(new TranscriptToolHandler());
  });

  describe('Tool Handler Registration', () => {
    it('should register tool handler', () => {
      const systemHandler = new SystemToolHandler();
      handler.registerToolHandler(systemHandler);
      
      expect(handler.getToolHandler('system')).toBe(systemHandler);
    });

    it('should get handler by category', () => {
      const systemHandler = handler.getToolHandler('system');
      expect(systemHandler).toBeTruthy();
      expect(systemHandler?.category).toBe('system');
    });

    it('should get handler for specific tool', () => {
      const toolHandler = handler.getHandlerForTool('protokoll_get_version');
      expect(toolHandler).toBeTruthy();
      expect(toolHandler?.tools).toContain('protokoll_get_version');
    });

    it('should return undefined for unknown tool', () => {
      const toolHandler = handler.getHandlerForTool('unknown_tool');
      expect(toolHandler).toBeUndefined();
    });
  });

  describe('Initialize Handshake', () => {
    it('should handle initialize request', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const response = await handler.handleRequest(request, session);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result).toHaveProperty('protocolVersion', '2024-11-05');
      expect(response.result).toHaveProperty('serverInfo');
      expect(session.initialized).toBe(true);
    });

    it('should handle initialized notification', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: null,
        method: 'notifications/initialized',
        params: {},
      };

      const response = await handler.handleRequest(request, session);

      expect(response.result).toEqual({});
    });
  });

  describe('Tools Operations', () => {
    it('should handle tools/list request', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      };

      const response = await handler.handleRequest(request, session);

      expect(response.result).toHaveProperty('tools');
      const tools = (response.result as any).tools;
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should handle tools/call request', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'protokoll_get_version',
          arguments: {},
        },
      };

      const response = await handler.handleRequest(request, session);

      expect(response.result).toHaveProperty('content');
      const content = (response.result as any).content;
      expect(Array.isArray(content)).toBe(true);
      expect(content[0]).toHaveProperty('type', 'text');
    });

    it('should return error for unknown tool', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'unknown_tool',
          arguments: {},
        },
      };

      const response = await handler.handleRequest(request, session);

      expect(response.error).toBeTruthy();
      expect(response.error?.message).toContain('Unknown tool');
    });
  });

  describe('Resources Operations', () => {
    it('should handle resources/list request', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 5,
        method: 'resources/list',
      };

      const response = await handler.handleRequest(request, session);

      expect(response.result).toHaveProperty('resources');
      expect(Array.isArray((response.result as any).resources)).toBe(true);
    });

    it('should handle resources/read request', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 6,
        method: 'resources/read',
        params: { uri: 'protokoll://test' },
      };

      const response = await handler.handleRequest(request, session);

      expect(response.result).toHaveProperty('contents');
      const contents = (response.result as any).contents;
      expect(Array.isArray(contents)).toBe(true);
      expect(contents[0]).toHaveProperty('uri');
      expect(contents[0]).toHaveProperty('mimeType');
      expect(contents[0]).toHaveProperty('text');
    });

    it('should handle resources/subscribe request', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 7,
        method: 'resources/subscribe',
        params: { uri: 'protokoll://transcripts' },
      };

      const response = await handler.handleRequest(request, session);

      expect(response.error).toBeUndefined();
      expect(session.subscriptions.has('protokoll://transcripts')).toBe(true);
    });

    it('should handle resources/unsubscribe request', async () => {
      // First subscribe
      session.subscriptions.add('protokoll://transcripts');
      
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 8,
        method: 'resources/unsubscribe',
        params: { uri: 'protokoll://transcripts' },
      };

      const response = await handler.handleRequest(request, session);

      expect(response.error).toBeUndefined();
      expect(session.subscriptions.has('protokoll://transcripts')).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should return error for unknown method', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 9,
        method: 'unknown/method',
      };

      const response = await handler.handleRequest(request, session);

      expect(response.error).toBeTruthy();
      expect(response.error?.code).toBe(-32603);
      expect(response.error?.message).toContain('Unknown method');
    });

    it('should handle tool handler errors', async () => {
      const systemHandler = handler.getToolHandler('system');
      if (systemHandler) {
        systemHandler.setError('protokoll_get_version', {
          code: -32001,
          message: 'Test error',
        });
      }

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'protokoll_get_version',
          arguments: {},
        },
      };

      const response = await handler.handleRequest(request, session);

      expect(response.error).toBeTruthy();
      expect(response.error?.message).toContain('Test error');
    });

    it('should include error data in response', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 11,
        method: 'unknown/method',
      };

      const response = await handler.handleRequest(request, session);

      expect(response.error?.data).toBeTruthy();
    });
  });

  describe('Tool Call Response Format', () => {
    it('should wrap tool response in content array', async () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'protokoll_get_version',
          arguments: {},
        },
      };

      const response = await handler.handleRequest(request, session);

      expect(response.result).toHaveProperty('content');
      const content = (response.result as any).content;
      expect(Array.isArray(content)).toBe(true);
      expect(content[0].type).toBe('text');
      expect(content[0].text).toBeTruthy();
    });

    it('should handle string tool responses', async () => {
      const systemHandler = handler.getToolHandler('system');
      if (systemHandler) {
        systemHandler.setResponse('protokoll_get_version', 'string response');
      }

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: 'protokoll_get_version',
          arguments: {},
        },
      };

      const response = await handler.handleRequest(request, session);

      const content = (response.result as any).content;
      expect(content[0].text).toBe('string response');
    });

    it('should handle object tool responses', async () => {
      const systemHandler = handler.getToolHandler('system');
      if (systemHandler) {
        systemHandler.setResponse('protokoll_get_version', { version: '1.0' });
      }

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: {
          name: 'protokoll_get_version',
          arguments: {},
        },
      };

      const response = await handler.handleRequest(request, session);

      const content = (response.result as any).content;
      const parsed = JSON.parse(content[0].text);
      expect(parsed).toEqual({ version: '1.0' });
    });
  });
});
