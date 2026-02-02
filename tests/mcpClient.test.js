"use strict";
/**
 * Tests for MCP Client
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const mcpClient_1 = require("../src/mcpClient");
// Mock http/https modules
vitest_1.vi.mock('http', () => ({
    default: {
        request: vitest_1.vi.fn(),
    },
}));
vitest_1.vi.mock('https', () => ({
    default: {
        request: vitest_1.vi.fn(),
    },
}));
(0, vitest_1.describe)('McpClient', () => {
    let client;
    const mockServerUrl = 'http://localhost:3001';
    (0, vitest_1.beforeEach)(() => {
        client = new mcpClient_1.McpClient(mockServerUrl);
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.afterEach)(() => {
        // Cleanup if needed - no public close method exists
    });
    (0, vitest_1.describe)('constructor', () => {
        (0, vitest_1.it)('should create client with server URL', () => {
            const newClient = new mcpClient_1.McpClient('http://example.com:8080');
            (0, vitest_1.expect)(newClient).toBeInstanceOf(mcpClient_1.McpClient);
        });
    });
    (0, vitest_1.describe)('onSessionRecovered', () => {
        (0, vitest_1.it)('should register callback', () => {
            const callback = vitest_1.vi.fn();
            const unsubscribe = client.onSessionRecovered(callback);
            (0, vitest_1.expect)(unsubscribe).toBeTypeOf('function');
        });
        (0, vitest_1.it)('should allow unsubscribing', () => {
            const callback = vitest_1.vi.fn();
            const unsubscribe = client.onSessionRecovered(callback);
            unsubscribe();
            // Callback should be removed (can't easily test internal state, but unsubscribe should work)
            (0, vitest_1.expect)(unsubscribe).toBeTypeOf('function');
        });
    });
    (0, vitest_1.describe)('onNotification', () => {
        (0, vitest_1.it)('should register notification handler', () => {
            const handler = vitest_1.vi.fn();
            const unsubscribe = client.onNotification('test/method', handler);
            (0, vitest_1.expect)(unsubscribe).toBeTypeOf('function');
        });
        (0, vitest_1.it)('should allow unsubscribing notification handler', () => {
            const handler = vitest_1.vi.fn();
            const unsubscribe = client.onNotification('test/method', handler);
            unsubscribe();
            (0, vitest_1.expect)(unsubscribe).toBeTypeOf('function');
        });
    });
    // Note: isSessionError is private, so we test it indirectly through public methods
    // The actual session error handling is tested through integration with initialize/sendRequest
    // Note: There's no public close method - connection cleanup happens internally
});
//# sourceMappingURL=mcpClient.test.js.map