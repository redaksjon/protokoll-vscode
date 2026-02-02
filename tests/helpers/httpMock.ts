/**
 * HTTP Mock Helper for testing
 */

import { vi } from 'vitest';

export interface MockHttpResponse {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
}

// Global state for mock responses
let mockResponseQueue: MockHttpResponse[] = [];

export function mockHttpRequest(mockResponse: MockHttpResponse) {
  mockResponseQueue.push(mockResponse);
  // Return mock objects for test access
  return {
    mockRequest: currentMockRequest,
    mockResponseObj: currentMockResponseObj,
  };
}

export function getNextMockResponse(): MockHttpResponse | undefined {
  return mockResponseQueue.shift();
}

export function resetHttpMocks() {
  mockResponseQueue = [];
}

// Store the current mock request/response for access in tests
let currentMockRequest: any = null;
let currentMockResponseObj: any = null;

// Create mock implementations
function createMockRequest() {
  return vi.fn((options: unknown, callback?: (res: any) => void) => {
    const mockResponse = getNextMockResponse() || { statusCode: 200, body: '' };
    
    currentMockRequest = {
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn((event: string, handler: (data?: unknown) => void) => {
        if (event === 'error') {
          (currentMockRequest as any)._errorHandler = handler;
        } else if (event === 'timeout') {
          (currentMockRequest as any)._timeoutHandler = handler;
        }
        return currentMockRequest;
      }),
      destroy: vi.fn(),
      setTimeout: vi.fn(),
    };

    // Track registered handlers
    const handlers: { data?: (chunk: Buffer) => void; end?: () => void } = {};
    let responseTriggered = false;

    const triggerResponse = () => {
      if (responseTriggered) return;
      
      // Wait for both handlers if body exists
      if (mockResponse.body && (!handlers.data || !handlers.end)) {
        return;
      }
      
      responseTriggered = true;

      if (mockResponse.body && handlers.data && handlers.end) {
        // CRITICAL: Send data synchronously first
        handlers.data(Buffer.from(mockResponse.body));
        // Then send end in the next microtask to ensure data accumulation completes
        queueMicrotask(() => {
          if (handlers.end) {
            handlers.end();
          }
        });
      } else if (handlers.end && !mockResponse.body) {
        // No body, just send end
        handlers.end();
      }
    };

    currentMockResponseObj = {
      statusCode: mockResponse.statusCode || 200,
      headers: mockResponse.headers || {},
      on: vi.fn((event: string, handler: (data?: unknown) => void) => {
        if (event === 'data') {
          handlers.data = handler as (chunk: Buffer) => void;
          // Trigger response if end is also registered or no body
          if (handlers.end || !mockResponse.body) {
            queueMicrotask(triggerResponse);
          }
        } else if (event === 'end') {
          handlers.end = handler as () => void;
          // Trigger response if data is also registered or no body
          if (handlers.data || !mockResponse.body) {
            queueMicrotask(triggerResponse);
          }
        }
      }),
    };

    if (callback) {
      // Call callback immediately
      callback(currentMockResponseObj);
    }
    
    return currentMockRequest;
  });
}

// Export mock implementations
export const mockHttpRequestFn = createMockRequest();
export const mockHttpsRequestFn = createMockRequest();

export function getCurrentMockRequest() {
  return currentMockRequest;
}

export function getCurrentMockResponse() {
  return currentMockResponseObj;
}
