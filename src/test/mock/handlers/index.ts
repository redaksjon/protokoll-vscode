/**
 * Tool Handlers - Main exports
 */

export { ToolHandler, ToolHandlerRegistry } from './ToolHandler';
export { BaseToolHandler } from './BaseToolHandler';
export { SystemToolHandler } from './SystemToolHandler';
export { TranscriptToolHandler } from './TranscriptToolHandler';
export { ContextToolHandler } from './ContextToolHandler';
export { EntityToolHandler } from './EntityToolHandler';
export { AudioToolHandler } from './AudioToolHandler';
export { DiscoveryToolHandler } from './DiscoveryToolHandler';
export { RelationshipToolHandler } from './RelationshipToolHandler';
export { ContentToolHandler } from './ContentToolHandler';
export { AssistToolHandler } from './AssistToolHandler';
export { StatusToolHandler } from './StatusToolHandler';

/**
 * Create and register all default tool handlers
 */
import { ToolHandlerRegistry } from './ToolHandler';
import { SystemToolHandler } from './SystemToolHandler';
import { TranscriptToolHandler } from './TranscriptToolHandler';
import { ContextToolHandler } from './ContextToolHandler';
import { EntityToolHandler } from './EntityToolHandler';
import { AudioToolHandler } from './AudioToolHandler';
import { DiscoveryToolHandler } from './DiscoveryToolHandler';
import { RelationshipToolHandler } from './RelationshipToolHandler';
import { ContentToolHandler } from './ContentToolHandler';
import { AssistToolHandler } from './AssistToolHandler';
import { StatusToolHandler } from './StatusToolHandler';

export function createDefaultHandlers(): ToolHandlerRegistry {
  const registry = new ToolHandlerRegistry();

  // Register all handlers
  registry.register(new SystemToolHandler());
  registry.register(new TranscriptToolHandler());
  registry.register(new ContextToolHandler());
  registry.register(new EntityToolHandler());
  registry.register(new AudioToolHandler());
  registry.register(new DiscoveryToolHandler());
  registry.register(new RelationshipToolHandler());
  registry.register(new ContentToolHandler());
  registry.register(new AssistToolHandler());
  registry.register(new StatusToolHandler());

  return registry;
}
