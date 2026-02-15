/**
 * SSE Infrastructure Tests
 * 
 * Comprehensive tests for SSE connection lifecycle, reconnection,
 * keepalive, and notification delivery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MockTransportServer,
  SseTestUtils,
  SseScenarios,
  type JsonRpcRequest,
  type JsonRpcNotification,
} from '../src/test/mock';

describe('SSE Connection Lifecycle', () => {
  let server: MockTransportServer;
  let sessionId: string;

  beforeEach(async () => {
    server = new MockTransportServer({ verbose: false });
    await server.start();

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

  afterEach(async () => {
    await server.stop();
  });

  it('should establish SSE connection', async () => {
    const response = await fetch(`${server.getBaseUrl()}/mcp`, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Mcp-Session-Id': sessionId,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    // Wait for connection to be registered
    await server.waitForSseConnection(sessionId, 1000);

    // Verify connection is tracked
    const sseManager = server.getSseManager();
    expect(sseManager.hasConnection(sessionId)).toBe(true);

    // Check connection history
    const history = sseManager.getConnectionHistory(sessionId);
    expect(history.length).toBeGreaterThan(0);
    expect(history.some(e => e.type === 'connected')).toBe(true);
  });

  it('should record connection events', async () => {
    // Establish connection
    await fetch(`${server.getBaseUrl()}/mcp`, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Mcp-Session-Id': sessionId,
      },
    });

    await server.waitForSseConnection(sessionId, 1000);

    const sseManager = server.getSseManager();
    const history = sseManager.getConnectionHistory(sessionId);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      type: 'connected',
      sessionId,
    });
    expect(history[0].timestamp).toBeGreaterThan(0);
  });

  it('should handle connection drop', async () => {
    // Establish connection
    await fetch(`${server.getBaseUrl()}/mcp`, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Mcp-Session-Id': sessionId,
      },
    });

    await server.waitForSseConnection(sessionId, 1000);

    const sseManager = server.getSseManager();

    // Simulate drop
    sseManager.simulateConnectionDrop(sessionId);

    // Verify connection is dropped
    expect(sseManager.hasConnection(sessionId)).toBe(false);

    // Check history
    const history = sseManager.getConnectionHistory(sessionId);
    expect(history.some(e => e.type === 'connection_dropped')).toBe(true);
  });
});

describe('SSE Notification Delivery', () => {
  let server: MockTransportServer;
  let sessionId: string;

  beforeEach(async () => {
    server = new MockTransportServer({ verbose: false });
    await server.start();

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

    // Establish SSE connection
    await fetch(`${server.getBaseUrl()}/mcp`, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Mcp-Session-Id': sessionId,
      },
    });

    await server.waitForSseConnection(sessionId, 1000);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should deliver notification to connected session', async () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri: 'protokoll://transcripts' },
    };

    server.sendNotification(sessionId, notification);

    // Wait for delivery
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check notification history
    const sseManager = server.getSseManager();
    const history = sseManager.getSessionNotificationHistory(sessionId);

    expect(history.length).toBeGreaterThan(0);
    expect(history[0].notification.method).toBe('notifications/resources/updated');
    expect(history[0].delivered).toBe(true);
  });

  it('should record failed delivery for disconnected session', () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/test',
      params: { test: true },
    };

    // Send to non-existent session
    server.sendNotification('invalid-session', notification);

    // Check notification history
    const sseManager = server.getSseManager();
    const history = sseManager.getNotificationHistory();

    const failedNotification = history.find(
      e => e.sessionId === 'invalid-session' && !e.delivered
    );

    expect(failedNotification).toBeTruthy();
  });

  it('should broadcast to all connected sessions', async () => {
    // Create second session
    const initRequest2: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test2', version: '1.0' },
      },
    };

    const response2 = await fetch(`${server.getBaseUrl()}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initRequest2),
    });

    const sessionId2 = response2.headers.get('mcp-session-id')!;

    // Establish second SSE connection
    await fetch(`${server.getBaseUrl()}/mcp`, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Mcp-Session-Id': sessionId2,
      },
    });

    await server.waitForSseConnection(sessionId2, 1000);

    // Broadcast notification
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/broadcast',
      params: { message: 'test' },
    };

    server.broadcastNotification(notification);

    // Wait for delivery
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check that both sessions received it
    const sseManager = server.getSseManager();
    const history = sseManager.getNotificationHistory();

    const session1Notifications = history.filter(e => e.sessionId === sessionId && e.delivered);
    const session2Notifications = history.filter(e => e.sessionId === sessionId2 && e.delivered);

    expect(session1Notifications.length).toBeGreaterThan(0);
    expect(session2Notifications.length).toBeGreaterThan(0);
  });

  it('should handle network delay simulation', async () => {
    const sseManager = server.getSseManager();

    // Apply network delay
    sseManager.simulateNetworkDelay(sessionId, 500);

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/test',
      params: { delayed: true },
    };

    const startTime = Date.now();
    server.sendNotification(sessionId, notification);

    // Wait for delayed delivery
    await new Promise(resolve => setTimeout(resolve, 600));

    const history = sseManager.getSessionNotificationHistory(sessionId);
    const deliveryTime = history.length > 0 ? history[0].timestamp - startTime : 0;

    // Should take at least 500ms due to delay
    expect(deliveryTime).toBeGreaterThanOrEqual(450); // Allow some margin
  });
});

describe('SSE Test Utilities', () => {
  let server: MockTransportServer;
  let sessionId: string;

  beforeEach(async () => {
    server = new MockTransportServer({ verbose: false });
    await server.start();

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

    // Establish SSE connection
    await fetch(`${server.getBaseUrl()}/mcp`, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Mcp-Session-Id': sessionId,
      },
    });

    await server.waitForSseConnection(sessionId, 1000);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should test notification delivery', async () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri: 'protokoll://transcripts' },
    };

    const result = await SseTestUtils.testNotificationDelivery(
      sessionId,
      server,
      notification
    );

    expect(result.delivered).toBe(true);
    expect(result.deliveryTime).toBeGreaterThanOrEqual(0); // Can be 0 for synchronous delivery
    expect(result.content).toBeTruthy();
  });

  it('should test connection stability', async () => {
    const result = await SseTestUtils.testConnectionStability(
      sessionId,
      server,
      2000 // 2 seconds
    );

    expect(result.stable).toBe(true);
    expect(result.drops).toBe(0);
    expect(result.uptime).toBeGreaterThan(90); // Should be nearly 100%
  });

  it('should test broadcast', async () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/broadcast',
      params: { test: true },
    };

    const result = await SseTestUtils.testBroadcast(
      server,
      notification
    );

    expect(result.delivered).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
  });
});

describe('SSE Scenarios', () => {
  let server: MockTransportServer;

  beforeEach(async () => {
    server = new MockTransportServer({ verbose: false });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should list all SSE scenarios', () => {
    const scenarios = SseScenarios.listScenarios();
    expect(scenarios.length).toBeGreaterThan(0);

    scenarios.forEach(scenario => {
      expect(scenario).toHaveProperty('name');
      expect(scenario).toHaveProperty('description');
    });
  });

  it('should check if scenario exists', () => {
    expect(SseScenarios.has('connection-lifecycle')).toBe(true);
    expect(SseScenarios.has('unknown-scenario')).toBe(false);
  });

  it('should load connection-lifecycle scenario', () => {
    expect(() => {
      SseScenarios.load('connection-lifecycle', server);
    }).not.toThrow();
  });

  it('should load notification-delivery scenario', () => {
    expect(() => {
      SseScenarios.load('notification-delivery', server);
    }).not.toThrow();
  });

  it('should throw error for unknown scenario', () => {
    expect(() => {
      SseScenarios.load('unknown-scenario', server);
    }).toThrow('Unknown SSE scenario');
  });
});

describe('SSE Statistics', () => {
  let server: MockTransportServer;
  let sessionId: string;

  beforeEach(async () => {
    server = new MockTransportServer({ verbose: false });
    await server.start();

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

    // Establish SSE connection
    await fetch(`${server.getBaseUrl()}/mcp`, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Mcp-Session-Id': sessionId,
      },
    });

    await server.waitForSseConnection(sessionId, 1000);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should track active connections', () => {
    const stats = server.getSseStatistics();
    expect(stats.activeConnections).toBe(1);
  });

  it('should track connection events', () => {
    const stats = server.getSseStatistics();
    expect(stats.totalConnectionEvents).toBeGreaterThan(0);
  });

  it('should track notifications', async () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/test',
      params: { test: true },
    };

    server.sendNotification(sessionId, notification);
    await new Promise(resolve => setTimeout(resolve, 100));

    const stats = server.getSseStatistics();
    expect(stats.totalNotifications).toBeGreaterThan(0);
    expect(stats.deliveredNotifications).toBeGreaterThan(0);
  });

  it('should track failed notifications', () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/test',
      params: { test: true },
    };

    // Send to invalid session
    server.sendNotification('invalid-session', notification);

    const stats = server.getSseStatistics();
    expect(stats.failedNotifications).toBeGreaterThan(0);
  });

  it('should clear history', async () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/test',
      params: { test: true },
    };

    server.sendNotification(sessionId, notification);
    await new Promise(resolve => setTimeout(resolve, 100));

    let stats = server.getSseStatistics();
    expect(stats.totalNotifications).toBeGreaterThan(0);

    // Clear history
    server.clearSseHistory();

    stats = server.getSseStatistics();
    expect(stats.totalNotifications).toBe(0);
    expect(stats.totalConnectionEvents).toBe(0);
  });
});

describe('SSE Connection Issues Simulation', () => {
  let server: MockTransportServer;
  let sessionId: string;

  beforeEach(async () => {
    server = new MockTransportServer({ verbose: false });
    await server.start();

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

    // Establish SSE connection
    await fetch(`${server.getBaseUrl()}/mcp`, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Mcp-Session-Id': sessionId,
      },
    });

    await server.waitForSseConnection(sessionId, 1000);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should simulate drop_and_reconnect', () => {
    server.simulateConnectionIssues(sessionId, {
      type: 'drop_and_reconnect',
    });

    const sseManager = server.getSseManager();
    expect(sseManager.hasConnection(sessionId)).toBe(false);

    const history = sseManager.getConnectionHistory(sessionId);
    expect(history.some(e => e.type === 'connection_dropped')).toBe(true);
  });

  it('should simulate network_delay', () => {
    server.simulateConnectionIssues(sessionId, {
      type: 'network_delay',
      delayMs: 1000,
    });

    // Connection should still be active
    const sseManager = server.getSseManager();
    expect(sseManager.hasConnection(sessionId)).toBe(true);
  });

  it('should simulate keepalive_timeout', () => {
    server.simulateConnectionIssues(sessionId, {
      type: 'keepalive_timeout',
    });

    const sseManager = server.getSseManager();
    expect(sseManager.hasConnection(sessionId)).toBe(false);
  });
});

describe('SSE Connection Drop After Messages', () => {
  let server: MockTransportServer;
  let sessionId: string;

  beforeEach(async () => {
    server = new MockTransportServer({ verbose: false });
    await server.start();

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

    // Establish SSE connection
    await fetch(`${server.getBaseUrl()}/mcp`, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Mcp-Session-Id': sessionId,
      },
    });

    await server.waitForSseConnection(sessionId, 1000);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should drop connection after N messages', async () => {
    const sseManager = server.getSseManager();

    // Schedule drop after 3 messages
    sseManager.simulateConnectionDropAfter(3, 'messages');

    // Send 3 notifications
    for (let i = 0; i < 3; i++) {
      server.sendNotification(sessionId, {
        jsonrpc: '2.0',
        method: 'notifications/test',
        params: { sequence: i },
      });
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Connection should be dropped now
    expect(sseManager.hasConnection(sessionId)).toBe(false);

    const history = sseManager.getConnectionHistory(sessionId);
    expect(history.some(e => e.type === 'connection_dropped')).toBe(true);
  });
});
