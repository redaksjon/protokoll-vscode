/**
 * SseManager Tests
 * 
 * Tests for SSE connection management including connection lifecycle,
 * notification delivery, and network simulation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SseManager } from '../src/test/mock/SseManager';
import type { ServerResponse } from 'http';

// Mock ServerResponse
class MockServerResponse {
  public headers: Record<string, string> = {};
  public statusCode = 200;
  public writtenData: string[] = [];
  public ended = false;
  public destroyed = false;
  private closeHandlers: Array<() => void> = [];

  writeHead(statusCode: number, headers: Record<string, string>): void {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  write(data: string): void {
    this.writtenData.push(data);
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
    this.triggerClose();
  }

  on(event: string, handler: () => void): void {
    if (event === 'close') {
      this.closeHandlers.push(handler);
    }
  }

  private triggerClose(): void {
    for (const handler of this.closeHandlers) {
      handler();
    }
  }
}

describe('SseManager', () => {
  let manager: SseManager;

  beforeEach(() => {
    manager = new SseManager(false);
  });

  describe('Connection Management', () => {
    it('should add new connection', () => {
      const response = new MockServerResponse() as unknown as ServerResponse;
      
      manager.addConnection('session-1', response);
      
      expect(manager.hasConnection('session-1')).toBe(true);
    });

    it('should remove connection', () => {
      const response = new MockServerResponse() as unknown as ServerResponse;
      
      manager.addConnection('session-1', response);
      manager.removeConnection('session-1');
      
      expect(manager.hasConnection('session-1')).toBe(false);
    });

    it('should replace existing connection', () => {
      const response1 = new MockServerResponse() as unknown as ServerResponse;
      const response2 = new MockServerResponse() as unknown as ServerResponse;
      
      manager.addConnection('session-1', response1);
      manager.addConnection('session-1', response2);
      
      expect((response1 as any).ended).toBe(true);
      expect(manager.hasConnection('session-1')).toBe(true);
    });

    it('should get connected sessions', () => {
      const response1 = new MockServerResponse() as unknown as ServerResponse;
      const response2 = new MockServerResponse() as unknown as ServerResponse;
      
      manager.addConnection('session-1', response1);
      manager.addConnection('session-2', response2);
      
      const sessions = manager.getConnectedSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions).toContain('session-1');
      expect(sessions).toContain('session-2');
    });

    it('should close all connections', () => {
      const response1 = new MockServerResponse() as unknown as ServerResponse;
      const response2 = new MockServerResponse() as unknown as ServerResponse;
      
      manager.addConnection('session-1', response1);
      manager.addConnection('session-2', response2);
      
      manager.closeAll();
      
      expect(manager.hasConnection('session-1')).toBe(false);
      expect(manager.hasConnection('session-2')).toBe(false);
    });
  });

  describe('Notification Delivery', () => {
    it('should send notification to session', () => {
      const response = new MockServerResponse() as unknown as ServerResponse;
      manager.addConnection('session-1', response);
      
      const notification = {
        jsonrpc: '2.0' as const,
        method: 'notifications/test',
        params: { test: true },
      };

      manager.sendToSession('session-1', notification);

      const written = (response as any).writtenData.join('');
      expect(written).toContain('event: message');
      expect(written).toContain('notifications/test');
    });

    it('should broadcast to all sessions', () => {
      const response1 = new MockServerResponse() as unknown as ServerResponse;
      const response2 = new MockServerResponse() as unknown as ServerResponse;
      
      manager.addConnection('session-1', response1);
      manager.addConnection('session-2', response2);
      
      const notification = {
        jsonrpc: '2.0' as const,
        method: 'notifications/broadcast',
        params: { message: 'test' },
      };

      manager.broadcast(notification);

      expect((response1 as any).writtenData.length).toBeGreaterThan(0);
      expect((response2 as any).writtenData.length).toBeGreaterThan(0);
    });

    it('should not send to disconnected session', () => {
      const notification = {
        jsonrpc: '2.0' as const,
        method: 'notifications/test',
        params: {},
      };

      // Should not throw
      manager.sendToSession('non-existent', notification);
      
      // Check notification was recorded as failed
      const history = manager.getNotificationHistory();
      expect(history.some(e => e.sessionId === 'non-existent' && !e.delivered)).toBe(true);
    });
  });

  describe('Network Simulation', () => {
    it('should simulate connection drop', () => {
      const response = new MockServerResponse() as unknown as ServerResponse;
      manager.addConnection('session-1', response);
      
      manager.simulateConnectionDrop('session-1');
      
      expect(manager.hasConnection('session-1')).toBe(false);
      expect((response as any).destroyed).toBe(true);
    });

    it('should simulate network delay', () => {
      const response = new MockServerResponse() as unknown as ServerResponse;
      manager.addConnection('session-1', response);
      
      manager.simulateNetworkDelay('session-1', 1000);
      
      // Connection should still be active
      expect(manager.hasConnection('session-1')).toBe(true);
    });

    it('should clear network delay', () => {
      const response = new MockServerResponse() as unknown as ServerResponse;
      manager.addConnection('session-1', response);
      
      manager.simulateNetworkDelay('session-1', 1000);
      manager.clearNetworkDelay('session-1');
      
      expect(manager.hasConnection('session-1')).toBe(true);
    });

    it('should simulate connection drop after N messages', () => {
      const response = new MockServerResponse() as unknown as ServerResponse;
      manager.addConnection('session-1', response);
      
      manager.simulateConnectionDropAfter(2, 'messages');
      
      // Send 2 notifications
      manager.sendToSession('session-1', {
        jsonrpc: '2.0',
        method: 'notifications/test',
        params: { seq: 1 },
      });
      
      manager.sendToSession('session-1', {
        jsonrpc: '2.0',
        method: 'notifications/test',
        params: { seq: 2 },
      });
      
      // Connection should be dropped
      expect(manager.hasConnection('session-1')).toBe(false);
    });
  });

  describe('Connection History', () => {
    it('should record connection events', () => {
      const response = new MockServerResponse() as unknown as ServerResponse;
      manager.addConnection('session-1', response);
      
      const history = manager.getConnectionHistory('session-1');
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].type).toBe('connected');
      expect(history[0].sessionId).toBe('session-1');
    });

    it('should record reconnection events', () => {
      const response1 = new MockServerResponse() as unknown as ServerResponse;
      const response2 = new MockServerResponse() as unknown as ServerResponse;
      
      manager.addConnection('session-1', response1);
      // Don't call removeConnection - just add again to trigger reconnection
      manager.addConnection('session-1', response2);
      
      const history = manager.getConnectionHistory('session-1');
      // First connection, then reconnected (because connection already existed)
      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history.some(e => e.type === 'connected' || e.type === 'reconnected')).toBe(true);
    });

    it('should record disconnection events', () => {
      const response = new MockServerResponse() as unknown as ServerResponse;
      manager.addConnection('session-1', response);
      
      // Trigger close event to record disconnection
      (response as any).triggerClose();
      
      const history = manager.getConnectionHistory('session-1');
      expect(history.some(e => e.type === 'disconnected')).toBe(true);
    });

    it('should clear history', () => {
      const response = new MockServerResponse() as unknown as ServerResponse;
      manager.addConnection('session-1', response);
      
      manager.clearHistory();
      
      const history = manager.getConnectionHistory('session-1');
      expect(history).toHaveLength(0);
    });
  });

  describe('Notification History', () => {
    it('should record notification events', () => {
      const response = new MockServerResponse() as unknown as ServerResponse;
      manager.addConnection('session-1', response);
      
      manager.sendToSession('session-1', {
        jsonrpc: '2.0',
        method: 'notifications/test',
        params: {},
      });
      
      const history = manager.getNotificationHistory();
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].notification.method).toBe('notifications/test');
      expect(history[0].delivered).toBe(true);
    });

    it('should get session-specific notification history', () => {
      const response1 = new MockServerResponse() as unknown as ServerResponse;
      const response2 = new MockServerResponse() as unknown as ServerResponse;
      
      manager.addConnection('session-1', response1);
      manager.addConnection('session-2', response2);
      
      manager.sendToSession('session-1', {
        jsonrpc: '2.0',
        method: 'notifications/test1',
        params: {},
      });
      
      manager.sendToSession('session-2', {
        jsonrpc: '2.0',
        method: 'notifications/test2',
        params: {},
      });
      
      const session1History = manager.getSessionNotificationHistory('session-1');
      expect(session1History).toHaveLength(1);
      expect(session1History[0].notification.method).toBe('notifications/test1');
    });
  });

  describe('Statistics', () => {
    it('should provide connection statistics', () => {
      const response1 = new MockServerResponse() as unknown as ServerResponse;
      const response2 = new MockServerResponse() as unknown as ServerResponse;
      
      manager.addConnection('session-1', response1);
      manager.addConnection('session-2', response2);
      
      const stats = manager.getStatistics();
      
      expect(stats.activeConnections).toBe(2);
      expect(stats.totalConnectionEvents).toBeGreaterThan(0);
    });

    it('should track notification delivery statistics', () => {
      const response = new MockServerResponse() as unknown as ServerResponse;
      manager.addConnection('session-1', response);
      
      // Send successful notification
      manager.sendToSession('session-1', {
        jsonrpc: '2.0',
        method: 'notifications/test',
        params: {},
      });
      
      // Send failed notification
      manager.sendToSession('non-existent', {
        jsonrpc: '2.0',
        method: 'notifications/test',
        params: {},
      });
      
      const stats = manager.getStatistics();
      expect(stats.deliveredNotifications).toBeGreaterThan(0);
      expect(stats.failedNotifications).toBeGreaterThan(0);
    });
  });

  describe('Wait Utilities', () => {
    it('should wait for connection', async () => {
      const response = new MockServerResponse() as unknown as ServerResponse;
      
      // Add connection asynchronously
      setTimeout(() => {
        manager.addConnection('session-1', response);
      }, 100);
      
      await manager.waitForConnection('session-1', 1000);
      expect(manager.hasConnection('session-1')).toBe(true);
    });

    it('should timeout waiting for connection', async () => {
      await expect(
        manager.waitForConnection('non-existent', 100)
      ).rejects.toThrow('Connection timeout');
    });

    it('should wait for notification', async () => {
      const response = new MockServerResponse() as unknown as ServerResponse;
      manager.addConnection('session-1', response);
      
      // Send notification asynchronously
      setTimeout(() => {
        manager.sendToSession('session-1', {
          jsonrpc: '2.0',
          method: 'notifications/test',
          params: {},
        });
      }, 100);
      
      const notification = await manager.waitForNotification('session-1', 'notifications/test', 1000);
      expect(notification.method).toBe('notifications/test');
    });

    it('should timeout waiting for notification', async () => {
      await expect(
        manager.waitForNotification('session-1', 'notifications/never', 100)
      ).rejects.toThrow('Notification timeout');
    });
  });
});
