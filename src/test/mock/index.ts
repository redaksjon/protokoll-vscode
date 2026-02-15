/**
 * Mock MCP Server - Main exports
 */

export { MockTransportServer } from './MockTransportServer';
export { SessionManager } from './SessionManager';
export { SseManager } from './SseManager';
export { JsonRpcHandler } from './JsonRpcHandler';

// Export handlers
export * from './handlers';

// Export fixtures
export { FixtureFactory } from './fixtures/FixtureFactory';

// Export scenario presets and composer
export { ScenarioPresets } from './ScenarioPresets';
export type { PresetInfo, PresetDefinition } from './ScenarioPresets';
export { ScenarioComposer, CompiledScenario } from './ScenarioComposer';
export type { ScenarioStep } from './ScenarioComposer';

// Export test utilities
export { MockServerBuilder, TestHelpers } from './TestUtils';
export { SseTestUtils } from './testing/SseTestUtils';
export type {
  ReconnectionTestOptions,
  ReconnectionTestResult,
  NotificationDeliveryResult,
} from './testing/SseTestUtils';

// Export SSE scenarios
export { SseScenarios } from './scenarios/SseScenarios';
export type { SseScenarioDefinition } from './scenarios/SseScenarios';

// Export SSE types
export type { ConnectionEvent, NotificationEvent, SimulationRule } from './SseManager';

export type {
  MockServerConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcNotification,
  SessionData,
  SseConnection,
  McpInitializeParams,
  McpInitializeResult,
  McpToolsListResult,
  McpResourcesListResult,
  McpResourceReadResult,
} from './types';
