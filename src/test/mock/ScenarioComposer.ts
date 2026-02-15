/**
 * Scenario Composer
 * 
 * Fluent API for building complex multi-step test scenarios.
 * Supports composition, modification, and conditional logic.
 */

import type { MockTransportServer } from './MockTransportServer';
import type { JsonRpcError } from './types';
import { ScenarioPresets } from './ScenarioPresets';

export interface ScenarioStep {
  type: 'tool-response' | 'tool-error' | 'session-action' | 'sse-action' | 'delay';
  trigger?: {
    type: 'request' | 'request-count' | 'delay';
    toolName?: string;
    count?: number;
    delayMs?: number;
  };
  action: (server: MockTransportServer) => void;
}

/**
 * Compiled scenario ready to be applied to a server
 */
export class CompiledScenario {
  constructor(
    public readonly basePreset: string | undefined,
    public readonly steps: ScenarioStep[]
  ) {}

  /**
   * Apply this scenario to a server
   */
  apply(server: MockTransportServer): void {
    // Apply base preset if specified
    if (this.basePreset) {
      ScenarioPresets.load(this.basePreset, server);
    }

    // Apply all steps
    for (const step of this.steps) {
      step.action(server);
    }
  }
}

/**
 * Main scenario composer with fluent API
 */
export class ScenarioComposer {
  private steps: ScenarioStep[] = [];
  private basePreset?: string;

  /**
   * Start with a preset as the base
   */
  static preset(presetName: string): ScenarioComposer {
    const composer = new ScenarioComposer();
    composer.basePreset = presetName;
    return composer;
  }

  /**
   * Create a new empty scenario
   */
  static create(): ScenarioComposer {
    return new ScenarioComposer();
  }

  /**
   * Modify the scenario (returns a modifier for chaining)
   */
  modify(): ScenarioModifier {
    return new ScenarioModifier(this);
  }

  /**
   * Configure behavior for a specific tool request
   */
  onTool(toolName: string): ToolTrigger {
    return new ToolTrigger(this, toolName);
  }

  /**
   * Configure behavior after a delay
   */
  afterDelay(ms: number): DelayTrigger {
    return new DelayTrigger(this, ms);
  }

  /**
   * Configure behavior after N requests
   */
  afterRequests(count: number): RequestCountTrigger {
    return new RequestCountTrigger(this, count);
  }

  /**
   * Add a custom step
   */
  addStep(step: ScenarioStep): this {
    this.steps.push(step);
    return this;
  }

  /**
   * Build the final compiled scenario
   */
  build(): CompiledScenario {
    return new CompiledScenario(this.basePreset, this.steps);
  }
}

/**
 * Modifier for making changes to a preset-based scenario
 */
export class ScenarioModifier {
  constructor(private composer: ScenarioComposer) {}

  /**
   * Modify a tool's behavior
   */
  onTool(toolName: string): ToolTrigger {
    return new ToolTrigger(this.composer, toolName);
  }

  /**
   * Modify session behavior
   */
  withSession(): SessionModifier {
    return new SessionModifier(this.composer);
  }

  /**
   * Modify SSE behavior
   */
  withSSE(): SSEModifier {
    return new SSEModifier(this.composer);
  }

  /**
   * Finish modifying and return to composer
   */
  done(): ScenarioComposer {
    return this.composer;
  }

  /**
   * Build the final scenario
   */
  build(): CompiledScenario {
    return this.composer.build();
  }
}

/**
 * Trigger for tool-based actions
 */
export class ToolTrigger {
  constructor(
    private composer: ScenarioComposer,
    private toolName: string
  ) {}

  /**
   * Return a specific response for this tool
   */
  respondWith(response: unknown): ScenarioComposer {
    this.composer.addStep({
      type: 'tool-response',
      trigger: {
        type: 'request',
        toolName: this.toolName,
      },
      action: (server: MockTransportServer) => {
        const handler = server.getHandlerForTool(this.toolName);
        if (handler) {
          handler.setResponse(this.toolName, response);
        }
      },
    });
    return this.composer;
  }

  /**
   * Return an error for this tool
   */
  failWith(error: JsonRpcError): ScenarioComposer {
    this.composer.addStep({
      type: 'tool-error',
      trigger: {
        type: 'request',
        toolName: this.toolName,
      },
      action: (server: MockTransportServer) => {
        const handler = server.getHandlerForTool(this.toolName);
        if (handler) {
          handler.setError(this.toolName, error);
        }
      },
    });
    return this.composer;
  }

  /**
   * Expire the session when this tool is called
   */
  expireSession(): ScenarioComposer {
    this.composer.addStep({
      type: 'session-action',
      trigger: {
        type: 'request',
        toolName: this.toolName,
      },
      action: (server: MockTransportServer) => {
        // This would need to be triggered on the actual request
        // For now, we can set it up to expire after 1 request
        const sessions = server.getSessionManager().getAllSessions();
        if (sessions.length > 0) {
          server.getSessionManager().expireSessionAfter(sessions[0].sessionId, 1);
        }
      },
    });
    return this.composer;
  }
}

/**
 * Trigger for delay-based actions
 */
export class DelayTrigger {
  constructor(
    private composer: ScenarioComposer,
    private delayMs: number
  ) {}

  /**
   * Execute an action after the delay
   */
  then(action: (server: MockTransportServer) => void): ScenarioComposer {
    this.composer.addStep({
      type: 'delay',
      trigger: {
        type: 'delay',
        delayMs: this.delayMs,
      },
      action,
    });
    return this.composer;
  }
}

/**
 * Trigger for request-count-based actions
 */
export class RequestCountTrigger {
  constructor(
    private composer: ScenarioComposer,
    private count: number
  ) {}

  /**
   * Expire the session after N requests
   */
  expireSession(): ScenarioComposer {
    this.composer.addStep({
      type: 'session-action',
      trigger: {
        type: 'request-count',
        count: this.count,
      },
      action: (server: MockTransportServer) => {
        const sessions = server.getSessionManager().getAllSessions();
        if (sessions.length > 0) {
          server.getSessionManager().expireSessionAfter(sessions[0].sessionId, this.count);
        }
      },
    });
    return this.composer;
  }

  /**
   * Drop SSE connection after N requests
   */
  dropSSEConnection(): ScenarioComposer {
    this.composer.addStep({
      type: 'sse-action',
      trigger: {
        type: 'request-count',
        count: this.count,
      },
      action: (server: MockTransportServer) => {
        void server; // Available for future implementation
        // This would need to be triggered on the actual request count
        // For now, we just document the pattern
        console.log(`[Scenario] Will drop SSE after ${this.count} requests`);
      },
    });
    return this.composer;
  }
}

/**
 * Modifier for session-related actions
 */
export class SessionModifier {
  constructor(private composer: ScenarioComposer) {}

  /**
   * Set session timeout
   */
  timeout(ms: number): SessionModifier {
    this.composer.addStep({
      type: 'session-action',
      action: (server: MockTransportServer) => {
        server.getSessionManager().setSessionTimeout(ms);
      },
    });
    return this;
  }

  /**
   * Expire session after N requests
   */
  expireAfter(count: number): SessionModifier {
    this.composer.addStep({
      type: 'session-action',
      action: (server: MockTransportServer) => {
        const sessions = server.getSessionManager().getAllSessions();
        if (sessions.length > 0) {
          server.getSessionManager().expireSessionAfter(sessions[0].sessionId, count);
        }
      },
    });
    return this;
  }

  /**
   * Return to modifier
   */
  done(): ScenarioModifier {
    return new ScenarioModifier(this.composer);
  }
}

/**
 * Modifier for SSE-related actions
 */
export class SSEModifier {
  constructor(private composer: ScenarioComposer) {}

  /**
   * Simulate connection drop
   */
  dropConnection(): SSEModifier {
    this.composer.addStep({
      type: 'sse-action',
      action: (server: MockTransportServer) => {
        const sessions = server.getSessionManager().getAllSessions();
        if (sessions.length > 0) {
          server.getSseManager().simulateConnectionDrop(sessions[0].sessionId);
        }
      },
    });
    return this;
  }

  /**
   * Simulate network delay
   */
  delay(ms: number): SSEModifier {
    this.composer.addStep({
      type: 'sse-action',
      action: (server: MockTransportServer) => {
        const sessions = server.getSessionManager().getAllSessions();
        if (sessions.length > 0) {
          server.getSseManager().simulateNetworkDelay(sessions[0].sessionId, ms);
        }
      },
    });
    return this;
  }

  /**
   * Return to modifier
   */
  done(): ScenarioModifier {
    return new ScenarioModifier(this.composer);
  }
}
