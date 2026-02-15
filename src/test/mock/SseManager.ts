/**
 * SSE (Server-Sent Events) Manager for Mock MCP Server
 * 
 * Manages SSE connections for delivering notifications to clients.
 * Supports connection lifecycle, notification delivery, and test utilities
 * for simulating connection issues.
 */

import type { ServerResponse } from 'http';
import type { JsonRpcNotification, SseConnection } from './types';

export interface ConnectionEvent {
  type: 'connected' | 'disconnected' | 'connection_dropped' | 'reconnected' | 'keepalive';
  timestamp: number;
  sessionId: string;
}

export interface NotificationEvent {
  notification: JsonRpcNotification;
  sessionId: string;
  timestamp: number;
  delivered: boolean;
}

export interface SimulationRule {
  type: 'delay' | 'drop_after' | 'keepalive_timeout';
  params: {
    ms?: number;
    count?: number;
    unit?: 'messages' | 'seconds';
  };
}

export class SseManager {
  private connections = new Map<string, SseConnection>();
  private verbose: boolean;
  
  // Testing utilities
  private connectionHistory = new Map<string, ConnectionEvent[]>();
  private notificationHistory: NotificationEvent[] = [];
  private simulationRules = new Map<string, SimulationRule[]>();
  private messageCounters = new Map<string, number>();
  
  // Track keepalive intervals to ensure proper cleanup
  private keepaliveIntervals = new Map<string, NodeJS.Timeout>();

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  /**
   * Add a new SSE connection for a session
   */
  addConnection(sessionId: string, response: ServerResponse): void {
    // Close existing connection if any
    const wasReconnection = this.connections.has(sessionId);
    this.removeConnection(sessionId);

    const connection: SseConnection = {
      sessionId,
      response,
      connected: true,
    };

    this.connections.set(sessionId, connection);
    this.messageCounters.set(sessionId, 0);

    // Record connection event
    this.recordEvent(sessionId, wasReconnection ? 'reconnected' : 'connected');

    // Set up SSE headers
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial connection confirmation
    this.sendComment(sessionId, 'connected');

    // Set up periodic keepalive
    const keepaliveInterval = setInterval(() => {
      if (this.connections.has(sessionId)) {
        this.sendComment(sessionId, 'ping');
        this.recordEvent(sessionId, 'keepalive');
      } else {
        clearInterval(keepaliveInterval);
        this.keepaliveIntervals.delete(sessionId);
      }
    }, 15000); // Ping every 15 seconds
    
    // Store the interval reference for proper cleanup
    this.keepaliveIntervals.set(sessionId, keepaliveInterval);

    // Clean up on connection close
    response.on('close', () => {
      const interval = this.keepaliveIntervals.get(sessionId);
      if (interval) {
        clearInterval(interval);
        this.keepaliveIntervals.delete(sessionId);
      }
      this.recordEvent(sessionId, 'disconnected');
      this.removeConnection(sessionId);
      if (this.verbose) {
        console.log(`[SSE] Connection closed for session ${sessionId}`);
      }
    });

    if (this.verbose) {
      console.log(`[SSE] Connection established for session ${sessionId}`);
    }
  }

  /**
   * Remove an SSE connection
   */
  removeConnection(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    if (connection) {
      connection.connected = false;
      
      // Clear keepalive interval to prevent memory leak
      const interval = this.keepaliveIntervals.get(sessionId);
      if (interval) {
        clearInterval(interval);
        this.keepaliveIntervals.delete(sessionId);
      }
      
      try {
        connection.response.end();
      } catch (error) {
        // Ignore errors when closing
      }
      this.connections.delete(sessionId);

      if (this.verbose) {
        console.log(`[SSE] Connection removed for session ${sessionId}`);
      }
    }
  }

  /**
   * Broadcast a notification to all connected sessions
   */
  broadcast(notification: JsonRpcNotification): void {
    for (const sessionId of this.connections.keys()) {
      this.sendToSession(sessionId, notification);
    }
  }

  /**
   * Send a notification to a specific session
   */
  sendToSession(sessionId: string, notification: JsonRpcNotification): void {
    const connection = this.connections.get(sessionId);
    if (!connection || !connection.connected) {
      if (this.verbose) {
        console.warn(`[SSE] Cannot send to session ${sessionId}: not connected`);
      }
      // Record failed delivery
      this.recordNotification(sessionId, notification, false);
      return;
    }

    // Increment message counter
    const currentCount = (this.messageCounters.get(sessionId) || 0) + 1;
    this.messageCounters.set(sessionId, currentCount);

    // Check simulation rules before sending
    this.checkSimulationRules(sessionId);

    const sendNotification = () => {
      try {
        const data = JSON.stringify(notification);
        connection.response.write(`event: message\n`);
        connection.response.write(`data: ${data}\n\n`);

        // Record successful delivery
        this.recordNotification(sessionId, notification, true);

        if (this.verbose) {
          console.log(`[SSE] Sent notification to session ${sessionId}:`, notification.method);
        }
      } catch (error) {
        if (this.verbose) {
          console.error(`[SSE] Error sending to session ${sessionId}:`, error);
        }
        // Record failed delivery
        this.recordNotification(sessionId, notification, false);
        this.removeConnection(sessionId);
      }
    };

    // Apply delay if configured (for testing)
    if (connection.delayMs && connection.delayMs > 0) {
      setTimeout(sendNotification, connection.delayMs);
    } else {
      sendNotification();
    }
  }

  /**
   * Send a comment line (for keepalive or connection confirmation)
   */
  private sendComment(sessionId: string, comment: string): void {
    const connection = this.connections.get(sessionId);
    if (connection && connection.connected) {
      try {
        connection.response.write(`: ${comment}\n\n`);
      } catch (error) {
        // Ignore errors
      }
    }
  }

  /**
   * Check if a session has an active SSE connection
   */
  hasConnection(sessionId: string): boolean {
    const connection = this.connections.get(sessionId);
    return connection !== undefined && connection.connected;
  }

  /**
   * Get all connected session IDs
   */
  getConnectedSessions(): string[] {
    return Array.from(this.connections.keys()).filter(
      (sessionId) => this.connections.get(sessionId)?.connected
    );
  }

  // ============================================================================
  // Test Utilities
  // ============================================================================

  /**
   * Simulate a connection drop for testing reconnection logic
   */
  simulateConnectionDrop(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    if (connection) {
      if (this.verbose) {
        console.log(`[SSE] Simulating connection drop for session ${sessionId}`);
      }
      
      // Record the drop event
      this.recordEvent(sessionId, 'connection_dropped');
      
      connection.connected = false;
      try {
        connection.response.destroy();
      } catch (error) {
        // Ignore errors
      }
      this.connections.delete(sessionId);
    }
  }

  /**
   * Simulate network delay for testing
   */
  simulateNetworkDelay(sessionId: string, delayMs: number): void {
    const connection = this.connections.get(sessionId);
    if (connection) {
      connection.delayMs = delayMs;
      if (this.verbose) {
        console.log(`[SSE] Simulating ${delayMs}ms delay for session ${sessionId}`);
      }
    }
  }

  /**
   * Clear network delay simulation
   */
  clearNetworkDelay(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    if (connection) {
      connection.delayMs = undefined;
    }
  }

  /**
   * Close all connections
   */
  closeAll(): void {
    // Clear all keepalive intervals first
    for (const interval of this.keepaliveIntervals.values()) {
      clearInterval(interval);
    }
    this.keepaliveIntervals.clear();
    
    // Then close all connections
    for (const sessionId of Array.from(this.connections.keys())) {
      this.removeConnection(sessionId);
    }
  }

  // ============================================================================
  // Testing Observability
  // ============================================================================

  /**
   * Record a connection event for testing
   */
  private recordEvent(sessionId: string, type: ConnectionEvent['type']): void {
    if (!this.connectionHistory.has(sessionId)) {
      this.connectionHistory.set(sessionId, []);
    }

    this.connectionHistory.get(sessionId)!.push({
      type,
      timestamp: Date.now(),
      sessionId,
    });

    if (this.verbose) {
      console.log(`[SSE] Recorded event: ${type} for session ${sessionId}`);
    }
  }

  /**
   * Record a notification event for testing
   */
  private recordNotification(
    sessionId: string,
    notification: JsonRpcNotification,
    delivered: boolean
  ): void {
    this.notificationHistory.push({
      notification,
      sessionId,
      timestamp: Date.now(),
      delivered,
    });
  }

  /**
   * Get connection history for a session
   */
  getConnectionHistory(sessionId: string): ConnectionEvent[] {
    return this.connectionHistory.get(sessionId) || [];
  }

  /**
   * Get all notification history
   */
  getNotificationHistory(): NotificationEvent[] {
    return [...this.notificationHistory];
  }

  /**
   * Get notification history for a specific session
   */
  getSessionNotificationHistory(sessionId: string): NotificationEvent[] {
    return this.notificationHistory.filter(e => e.sessionId === sessionId);
  }

  /**
   * Clear all history (useful between tests)
   */
  clearHistory(): void {
    this.connectionHistory.clear();
    this.notificationHistory = [];
    this.messageCounters.clear();
  }

  /**
   * Wait for a connection to be established
   */
  waitForConnection(sessionId: string, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const checkConnection = () => {
        if (this.hasConnection(sessionId)) {
          resolve();
        } else if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Connection timeout for session ${sessionId}`));
        } else {
          setTimeout(checkConnection, 50);
        }
      };

      checkConnection();
    });
  }

  /**
   * Wait for a specific notification to be sent
   */
  waitForNotification(
    sessionId: string,
    method: string,
    timeoutMs = 5000
  ): Promise<JsonRpcNotification> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const checkNotification = () => {
        const notification = this.notificationHistory.find(
          e => e.sessionId === sessionId && e.notification.method === method && e.delivered
        );

        if (notification) {
          resolve(notification.notification);
        } else if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Notification timeout: ${method} for session ${sessionId}`));
        } else {
          setTimeout(checkNotification, 50);
        }
      };

      checkNotification();
    });
  }

  // ============================================================================
  // Advanced Simulation
  // ============================================================================

  /**
   * Simulate connection drop after N messages
   */
  simulateConnectionDropAfter(count: number, unit: 'messages' | 'seconds'): void {
    const rule: SimulationRule = {
      type: 'drop_after',
      params: { count, unit },
    };

    if (!this.simulationRules.has('global')) {
      this.simulationRules.set('global', []);
    }

    this.simulationRules.get('global')!.push(rule);

    if (this.verbose) {
      console.log(`[SSE] Scheduled connection drop after ${count} ${unit}`);
    }
  }

  /**
   * Check if simulation rules should trigger
   */
  private checkSimulationRules(sessionId: string): void {
    const globalRules = this.simulationRules.get('global') || [];
    const sessionRules = this.simulationRules.get(sessionId) || [];
    const allRules = [...globalRules, ...sessionRules];

    for (const rule of allRules) {
      if (rule.type === 'drop_after' && rule.params.unit === 'messages') {
        const messageCount = this.messageCounters.get(sessionId) || 0;
        if (messageCount >= (rule.params.count || 0)) {
          this.simulateConnectionDrop(sessionId);
          // Remove the rule after triggering
          this.simulationRules.delete(sessionId);
        }
      }
    }
  }

  /**
   * Get statistics about SSE connections
   */
  getStatistics(): {
    activeConnections: number;
    totalConnectionEvents: number;
    totalNotifications: number;
    deliveredNotifications: number;
    failedNotifications: number;
  } {
    const activeConnections = this.getConnectedSessions().length;
    const totalConnectionEvents = Array.from(this.connectionHistory.values())
      .reduce((sum, events) => sum + events.length, 0);
    const totalNotifications = this.notificationHistory.length;
    const deliveredNotifications = this.notificationHistory.filter(e => e.delivered).length;
    const failedNotifications = this.notificationHistory.filter(e => !e.delivered).length;

    return {
      activeConnections,
      totalConnectionEvents,
      totalNotifications,
      deliveredNotifications,
      failedNotifications,
    };
  }
}
