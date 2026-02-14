/**
 * Test Utilities
 * 
 * High-level builder API for clean, readable test setup.
 * Provides fluent interface for configuring mock servers.
 */

import { MockTransportServer } from './MockTransportServer';
import type { MockServerConfig, JsonRpcError } from './types';
import type { CompiledScenario } from './ScenarioComposer';
import type { ToolHandler } from './handlers';
import { ScenarioPresets } from './ScenarioPresets';

/**
 * Fluent builder for MockTransportServer
 */
export class MockServerBuilder {
  private server: MockTransportServer;
  private presets: string[] = [];
  private scenarios: CompiledScenario[] = [];

  constructor(config?: MockServerConfig) {
    this.server = new MockTransportServer(config);
  }

  /**
   * Create a new builder
   */
  static create(config?: MockServerConfig): MockServerBuilder {
    return new MockServerBuilder(config);
  }

  /**
   * Load a preset scenario
   */
  withPreset(presetName: string): MockServerBuilder {
    this.presets.push(presetName);
    return this;
  }

  /**
   * Load a compiled scenario
   */
  withScenario(scenario: CompiledScenario): MockServerBuilder {
    this.scenarios.push(scenario);
    return this;
  }

  /**
   * Configure a specific tool
   */
  withTool(toolName: string): ToolConfigBuilder {
    return new ToolConfigBuilder(this, this.server, toolName);
  }

  /**
   * Configure a tool handler by category
   */
  withHandler<T extends ToolHandler>(category: string): HandlerConfigBuilder<T> {
    return new HandlerConfigBuilder<T>(this, this.server, category);
  }

  /**
   * Configure session behavior
   */
  withSession(): SessionConfigBuilder {
    return new SessionConfigBuilder(this, this.server);
  }

  /**
   * Configure SSE behavior
   */
  withSSE(): SSEConfigBuilder {
    return new SSEConfigBuilder(this, this.server);
  }

  /**
   * Build and start the server
   */
  async build(): Promise<MockTransportServer> {
    // Apply presets
    for (const preset of this.presets) {
      ScenarioPresets.load(preset, this.server);
    }

    // Apply scenarios
    for (const scenario of this.scenarios) {
      this.server.loadScenario(scenario);
    }

    // Start server
    await this.server.start();
    return this.server;
  }

  /**
   * Build without starting (useful for additional configuration)
   */
  buildWithoutStarting(): MockTransportServer {
    // Apply presets
    for (const preset of this.presets) {
      ScenarioPresets.load(preset, this.server);
    }

    // Apply scenarios
    for (const scenario of this.scenarios) {
      this.server.loadScenario(scenario);
    }

    return this.server;
  }
}

/**
 * Builder for configuring individual tools
 */
export class ToolConfigBuilder {
  private delayMs?: number;

  constructor(
    private builder: MockServerBuilder,
    private server: MockTransportServer,
    private toolName: string
  ) {}

  /**
   * Set the response for this tool
   */
  returning(response: unknown): MockServerBuilder {
    const handler = this.server.getHandlerForTool(this.toolName);
    if (handler) {
      handler.setResponse(this.toolName, response);
    }
    return this.builder;
  }

  /**
   * Set an error response for this tool
   */
  throwing(error: JsonRpcError): MockServerBuilder {
    const handler = this.server.getHandlerForTool(this.toolName);
    if (handler) {
      handler.setError(this.toolName, error);
    }
    return this.builder;
  }

  /**
   * Add a delay before responding (not yet implemented in handlers)
   */
  delayed(ms: number): ToolConfigBuilder {
    this.delayMs = ms;
    console.log(`[TestUtils] Delay of ${ms}ms configured for ${this.toolName} (not yet implemented)`);
    return this;
  }
}

/**
 * Builder for configuring tool handlers
 */
export class HandlerConfigBuilder<T extends ToolHandler> {
  constructor(
    private builder: MockServerBuilder,
    private server: MockTransportServer,
    private category: string
  ) {}

  /**
   * Configure the handler with a callback
   */
  configure(callback: (handler: T) => void): MockServerBuilder {
    const handler = this.server.getHandler<T>(this.category);
    if (handler) {
      callback(handler);
    }
    return this.builder;
  }

  /**
   * Reset the handler to defaults
   */
  reset(): MockServerBuilder {
    const handler = this.server.getHandler<T>(this.category);
    if (handler) {
      handler.reset();
    }
    return this.builder;
  }
}

/**
 * Builder for configuring session behavior
 */
export class SessionConfigBuilder {
  constructor(
    private builder: MockServerBuilder,
    private server: MockTransportServer
  ) {}

  /**
   * Set session timeout
   */
  timeout(ms: number): SessionConfigBuilder {
    this.server.getSessionManager().setSessionTimeout(ms);
    return this;
  }

  /**
   * Configure session to expire after N requests
   */
  expireAfter(count: number): SessionConfigBuilder {
    // This will be applied after server starts and session is created
    setTimeout(() => {
      const sessions = this.server.getSessionManager().getAllSessions();
      if (sessions.length > 0) {
        this.server.getSessionManager().expireSessionAfter(sessions[0].sessionId, count);
      }
    }, 100);
    return this;
  }

  /**
   * Return to builder
   */
  done(): MockServerBuilder {
    return this.builder;
  }
}

/**
 * Builder for configuring SSE behavior
 */
export class SSEConfigBuilder {
  constructor(
    private builder: MockServerBuilder,
    private server: MockTransportServer
  ) {}

  /**
   * Simulate network delay for SSE messages
   */
  withDelay(ms: number): SSEConfigBuilder {
    // This will be applied after server starts and connection is established
    setTimeout(() => {
      const sessions = this.server.getSessionManager().getAllSessions();
      if (sessions.length > 0) {
        this.server.getSseManager().simulateNetworkDelay(sessions[0].sessionId, ms);
      }
    }, 100);
    return this;
  }

  /**
   * Return to builder
   */
  done(): MockServerBuilder {
    return this.builder;
  }
}

/**
 * Quick helper functions for common test setups
 */
export class TestHelpers {
  /**
   * Create a server with happy path preset
   */
  static async createHappyPathServer(config?: MockServerConfig): Promise<MockTransportServer> {
    return MockServerBuilder.create(config)
      .withPreset('happy-path-transcripts')
      .build();
  }

  /**
   * Create a server with empty project preset
   */
  static async createEmptyProjectServer(config?: MockServerConfig): Promise<MockTransportServer> {
    return MockServerBuilder.create(config)
      .withPreset('empty-project')
      .build();
  }

  /**
   * Create a server with custom configuration
   */
  static async createCustomServer(
    config: MockServerConfig,
    setup: (builder: MockServerBuilder) => MockServerBuilder
  ): Promise<MockTransportServer> {
    const builder = MockServerBuilder.create(config);
    return setup(builder).build();
  }
}
