/**
 * SSE Test Utilities
 * 
 * High-level utilities for comprehensive SSE testing including
 * connection lifecycle, reconnection, and notification delivery.
 */

import type { MockTransportServer } from '../MockTransportServer';
import type { JsonRpcNotification } from '../types';
import type { ConnectionEvent } from '../SseManager';

export interface ReconnectionTestOptions {
  timeoutMs?: number;
  maxRetries?: number;
  dropDelayMs?: number;
}

export interface ReconnectionTestResult {
  connectionEstablished: boolean;
  connectionDropped: boolean;
  reconnectionSuccessful: boolean;
  reconnectionTime: number;
  totalEvents: number;
  events: ConnectionEvent[];
}

export interface NotificationDeliveryResult {
  delivered: boolean;
  deliveryTime: number | null;
  content: JsonRpcNotification | null;
}

/**
 * Utilities for testing SSE functionality
 */
export class SseTestUtils {
  /**
   * Test connection and reconnection flow
   */
  static async testConnectionReconnection(
    sessionId: string,
    server: MockTransportServer,
    options: ReconnectionTestOptions = {}
  ): Promise<ReconnectionTestResult> {
    const sseManager = server.getSseManager();
    const timeoutMs = options.timeoutMs || 10000;
    const dropDelayMs = options.dropDelayMs || 100;

    // Wait for initial connection
    try {
      await sseManager.waitForConnection(sessionId, timeoutMs);
    } catch (error) {
      return {
        connectionEstablished: false,
        connectionDropped: false,
        reconnectionSuccessful: false,
        reconnectionTime: 0,
        totalEvents: 0,
        events: [],
      };
    }

    // Connection established successfully

    // Wait a bit, then simulate connection drop
    await new Promise(resolve => setTimeout(resolve, dropDelayMs));
    sseManager.simulateConnectionDrop(sessionId);

    // Record drop time
    const dropTime = Date.now();

    // Wait for reconnection
    let reconnectionSuccessful = false;
    let reconnectionTime = 0;

    try {
      await sseManager.waitForConnection(sessionId, timeoutMs);
      reconnectionSuccessful = true;
      reconnectionTime = Date.now() - dropTime;
    } catch (error) {
      // Reconnection failed or timed out
    }

    // Analyze results
    const history = sseManager.getConnectionHistory(sessionId);

    return {
      connectionEstablished: history.some(e => e.type === 'connected'),
      connectionDropped: history.some(e => e.type === 'connection_dropped'),
      reconnectionSuccessful,
      reconnectionTime,
      totalEvents: history.length,
      events: history,
    };
  }

  /**
   * Test notification delivery
   */
  static async testNotificationDelivery(
    sessionId: string,
    server: MockTransportServer,
    notification: JsonRpcNotification,
    timeoutMs = 5000
  ): Promise<NotificationDeliveryResult> {
    const sseManager = server.getSseManager();

    // Record send time
    const sendTime = Date.now();

    // Send notification
    sseManager.sendToSession(sessionId, notification);

    // Wait for delivery confirmation
    try {
      const receivedNotification = await sseManager.waitForNotification(
        sessionId,
        notification.method,
        timeoutMs
      );

      return {
        delivered: true,
        deliveryTime: Date.now() - sendTime,
        content: receivedNotification,
      };
    } catch (error) {
      return {
        delivered: false,
        deliveryTime: null,
        content: null,
      };
    }
  }

  /**
   * Test notification delivery with connection drop
   */
  static async testNotificationDeliveryWithDrop(
    sessionId: string,
    server: MockTransportServer,
    notification: JsonRpcNotification,
    dropAfterMs: number
  ): Promise<NotificationDeliveryResult> {
    const sseManager = server.getSseManager();

    // Schedule connection drop
    setTimeout(() => {
      sseManager.simulateConnectionDrop(sessionId);
    }, dropAfterMs);

    // Try to send notification
    return this.testNotificationDelivery(sessionId, server, notification);
  }

  /**
   * Test keepalive mechanism
   */
  static async testKeepalive(
    sessionId: string,
    server: MockTransportServer,
    durationMs = 20000
  ): Promise<{
    keepaliveCount: number;
    averageInterval: number;
    events: ConnectionEvent[];
  }> {
    const sseManager = server.getSseManager();

    // Clear history before test
    const initialHistoryLength = sseManager.getConnectionHistory(sessionId).length;

    // Wait for the specified duration
    await new Promise(resolve => setTimeout(resolve, durationMs));

    // Analyze keepalive events
    const history = sseManager.getConnectionHistory(sessionId);
    const keepaliveEvents = history.slice(initialHistoryLength).filter(e => e.type === 'keepalive');

    let averageInterval = 0;
    if (keepaliveEvents.length > 1) {
      const intervals = [];
      for (let i = 1; i < keepaliveEvents.length; i++) {
        intervals.push(keepaliveEvents[i].timestamp - keepaliveEvents[i - 1].timestamp);
      }
      averageInterval = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
    }

    return {
      keepaliveCount: keepaliveEvents.length,
      averageInterval,
      events: keepaliveEvents,
    };
  }

  /**
   * Test broadcast functionality
   */
  static async testBroadcast(
    server: MockTransportServer,
    notification: JsonRpcNotification
  ): Promise<{
    totalSent: number;
    delivered: number;
    failed: number;
  }> {
    const sseManager = server.getSseManager();
    const initialHistoryLength = sseManager.getNotificationHistory().length;

    // Broadcast notification
    sseManager.broadcast(notification);

    // Wait a bit for delivery
    await new Promise(resolve => setTimeout(resolve, 100));

    // Analyze results
    const history = sseManager.getNotificationHistory().slice(initialHistoryLength);
    const delivered = history.filter(e => e.delivered).length;
    const failed = history.filter(e => !e.delivered).length;

    return {
      totalSent: history.length,
      delivered,
      failed,
    };
  }

  /**
   * Calculate reconnection time from event history
   */
  private static calculateReconnectionTime(history: ConnectionEvent[]): number {
    const dropEvent = history.find(e => e.type === 'connection_dropped');
    const reconnectEvent = history.find(
      e => e.type === 'reconnected' && e.timestamp > (dropEvent?.timestamp || 0)
    );

    if (dropEvent && reconnectEvent) {
      return reconnectEvent.timestamp - dropEvent.timestamp;
    }

    return 0;
  }

  /**
   * Verify connection stability over time
   */
  static async testConnectionStability(
    sessionId: string,
    server: MockTransportServer,
    durationMs = 10000
  ): Promise<{
    stable: boolean;
    drops: number;
    reconnections: number;
    uptime: number;
  }> {
    const sseManager = server.getSseManager();
    const startTime = Date.now();

    // Monitor for the specified duration
    await new Promise(resolve => setTimeout(resolve, durationMs));

    // Analyze connection history
    const history = sseManager.getConnectionHistory(sessionId);
    const drops = history.filter(e => e.type === 'connection_dropped').length;
    const reconnections = history.filter(e => e.type === 'reconnected').length;

    // Calculate uptime (time connected vs total time)
    let uptime = 0;
    let lastConnectTime = startTime;
    let connected = true;

    for (const event of history) {
      if (event.type === 'connection_dropped') {
        if (connected) {
          uptime += event.timestamp - lastConnectTime;
          connected = false;
        }
      } else if (event.type === 'connected' || event.type === 'reconnected') {
        lastConnectTime = event.timestamp;
        connected = true;
      }
    }

    // Add final uptime if still connected
    if (connected) {
      uptime += Date.now() - lastConnectTime;
    }

    const uptimePercentage = (uptime / durationMs) * 100;

    return {
      stable: drops === 0,
      drops,
      reconnections,
      uptime: uptimePercentage,
    };
  }
}
