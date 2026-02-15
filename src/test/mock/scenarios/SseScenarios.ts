/**
 * SSE-Specific Scenarios
 * 
 * Pre-configured scenarios for testing SSE connection lifecycle,
 * reconnection, keepalive, and notification delivery.
 */

import type { MockTransportServer } from '../MockTransportServer';

export interface SseScenarioDefinition {
  description: string;
  setup: (server: MockTransportServer) => void;
}

/**
 * Library of SSE testing scenarios
 */
export class SseScenarios {
  static readonly scenarios: Record<string, SseScenarioDefinition> = {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    'connection-lifecycle': {
      description: 'Tests complete SSE connection lifecycle',
      setup: (server: MockTransportServer) => {
        // Connection lifecycle is tested through normal flow
        // This scenario just ensures default behavior
        if (server.isRunning()) {
          console.log('[SSE Scenario] connection-lifecycle: Using default behavior');
        }
      },
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'notification-delivery': {
      description: 'Tests notification delivery reliability',
      setup: (server: MockTransportServer) => {
        const sseManager = server.getSseManager();

        // Schedule test notifications to be sent after connection
        setTimeout(() => {
          const sessions = server.getSessionManager().getAllSessions();
          for (const session of sessions) {
            if (sseManager.hasConnection(session.sessionId)) {
              // Send test notification
              sseManager.sendToSession(session.sessionId, {
                jsonrpc: '2.0',
                method: 'notifications/resources/updated',
                params: { uri: 'protokoll://transcripts' },
              });
            }
          }
        }, 500);
      },
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'keepalive-testing': {
      description: 'Tests SSE keepalive mechanism',
      setup: (server: MockTransportServer) => {
        void server; // Available for future implementation
        // Keepalive is built into SseManager (15-second interval)
        // This scenario documents that keepalive is always active
        console.log('[SSE Scenario] keepalive-testing: Keepalive active (15s interval)');
      },
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'connection-drop-and-recovery': {
      description: 'Tests connection drop and recovery',
      setup: (server: MockTransportServer) => {
        const sseManager = server.getSseManager();

        // Schedule connection drop after 2 messages
        sseManager.simulateConnectionDropAfter(2, 'messages');
      },
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'network-delay': {
      description: 'Tests notification delivery with network delay',
      setup: (server: MockTransportServer) => {
        const sseManager = server.getSseManager();

        // Apply network delay to all sessions
        setTimeout(() => {
          const sessions = server.getSessionManager().getAllSessions();
          for (const session of sessions) {
            if (sseManager.hasConnection(session.sessionId)) {
              sseManager.simulateNetworkDelay(session.sessionId, 1000);
            }
          }
        }, 100);
      },
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'multiple-notifications': {
      description: 'Tests handling of multiple rapid notifications',
      setup: (server: MockTransportServer) => {
        const sseManager = server.getSseManager();

        // Schedule multiple notifications in rapid succession
        setTimeout(() => {
          const sessions = server.getSessionManager().getAllSessions();
          for (const session of sessions) {
            if (sseManager.hasConnection(session.sessionId)) {
              // Send 10 notifications rapidly
              for (let i = 0; i < 10; i++) {
                sseManager.sendToSession(session.sessionId, {
                  jsonrpc: '2.0',
                  method: 'notifications/test',
                  params: { sequence: i },
                });
              }
            }
          }
        }, 500);
      },
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'broadcast-testing': {
      description: 'Tests broadcast to multiple sessions',
      setup: (server: MockTransportServer) => {
        const sseManager = server.getSseManager();

        // Schedule broadcast notification
        setTimeout(() => {
          sseManager.broadcast({
            jsonrpc: '2.0',
            method: 'notifications/resources/list_changed',
            params: { uri: 'protokoll://transcripts' },
          });
        }, 500);
      },
    },
  };

  /**
   * Load an SSE scenario onto a server
   */
  static load(scenarioName: string, server: MockTransportServer): void {
    const scenario = this.scenarios[scenarioName];
    if (!scenario) {
      throw new Error(`Unknown SSE scenario: ${scenarioName}`);
    }

    scenario.setup(server);
  }

  /**
   * List all available SSE scenarios
   */
  static listScenarios(): Array<{ name: string; description: string }> {
    return Object.entries(this.scenarios).map(([name, scenario]) => ({
      name,
      description: scenario.description,
    }));
  }

  /**
   * Check if a scenario exists
   */
  static has(scenarioName: string): boolean {
    return scenarioName in this.scenarios;
  }
}
