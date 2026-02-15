# Scenario Presets and Composition

High-level API for configuring mock server test scenarios. Provides both preset scenarios for common cases and fluent composition for complex edge cases.

## Quick Start

### Using Preset Scenarios

```typescript
import { MockServerBuilder } from './test/mock';

// Simple: use a preset
const server = await MockServerBuilder
  .create()
  .withPreset('happy-path-transcripts')
  .build();

// Run your tests...

await server.stop();
```

### Using Builder API

```typescript
// Explicit configuration
const server = await MockServerBuilder
  .create()
  .withTool('protokoll_list_transcripts')
  .returning(customTranscriptList)
  .withSession()
  .timeout(30000)
  .done()
  .build();
```

### Using Scenario Composer

```typescript
import { ScenarioComposer } from './test/mock';

// Build complex multi-step scenario
const scenario = ScenarioComposer
  .preset('happy-path-transcripts')
  .modify()
  .onTool('protokoll_get_version')
  .respondWith({ version: 'custom' })
  .afterRequests(3)
  .expireSession()
  .build();

const server = await MockServerBuilder
  .create()
  .withScenario(scenario)
  .build();
```

## Available Presets

### `happy-path-transcripts`

Working transcript operations with sample data.

**Configures:**
- Transcript list with 2 sample transcripts
- Transcript content with full metadata
- Active context with entities

**Use for:** Basic transcript viewing and reading tests

### `empty-project`

New project with no transcripts or entities.

**Configures:**
- Empty transcript list
- Zero entity counts
- Empty context

**Use for:** Testing empty states and first-time user experience

### `large-dataset`

Large dataset with 100 transcripts for pagination testing.

**Configures:**
- 100 transcript entries
- Pagination enabled

**Use for:** Testing pagination, scrolling, performance

### `transcripts-with-tasks`

Transcripts with open tasks for workflow testing.

**Configures:**
- Transcripts with various task counts
- Mixed task statuses

**Use for:** Testing task management UI

### `session-expiration`

Tests session recovery and reconnection scenarios.

**Configures:**
- Short session timeout (5 seconds)

**Use for:** Testing session recovery logic

### `error-responses`

All operations return errors for error handling testing.

**Configures:**
- List and read operations fail with errors

**Use for:** Testing error handling and user feedback

### `mixed-status-transcripts`

Transcripts in various lifecycle states.

**Configures:**
- One transcript in each status (initial, enhanced, reviewed, in_progress, closed)

**Use for:** Testing status filtering and lifecycle UI

## MockServerBuilder API

### Basic Setup

```typescript
const server = await MockServerBuilder.create().build();
```

### With Configuration

```typescript
const server = await MockServerBuilder
  .create({ verbose: true, sessionTimeout: 60000 })
  .build();
```

### With Preset

```typescript
const server = await MockServerBuilder
  .create()
  .withPreset('happy-path-transcripts')
  .build();
```

### With Tool Configuration

```typescript
const server = await MockServerBuilder
  .create()
  .withTool('protokoll_list_transcripts')
  .returning(customData)
  .build();

// Or with error
const server = await MockServerBuilder
  .create()
  .withTool('protokoll_list_transcripts')
  .throwing({ code: -32603, message: 'Server error' })
  .build();
```

### With Handler Configuration

```typescript
const server = await MockServerBuilder
  .create()
  .withHandler<TranscriptToolHandler>('transcripts')
  .configure((handler) => {
    handler.setTranscriptFixture('default', myTranscript);
    handler.setListingFixture('default', myList);
  })
  .build();
```

### With Session Configuration

```typescript
const server = await MockServerBuilder
  .create()
  .withSession()
  .timeout(10000)
  .expireAfter(5)  // Expire after 5 requests
  .done()
  .build();
```

### Chaining Multiple Configurations

```typescript
const server = await MockServerBuilder
  .create({ verbose: false })
  .withPreset('happy-path-transcripts')
  .withTool('protokoll_get_version')
  .returning({ version: '1.0.0' })
  .withSession()
  .timeout(30000)
  .done()
  .build();
```

## ScenarioComposer API

### Create Empty Scenario

```typescript
const scenario = ScenarioComposer.create().build();
```

### Start from Preset

```typescript
const scenario = ScenarioComposer
  .preset('happy-path-transcripts')
  .build();
```

### Modify Preset

```typescript
const scenario = ScenarioComposer
  .preset('happy-path-transcripts')
  .modify()
  .onTool('protokoll_get_version')
  .respondWith({ version: 'modified' })
  .build();
```

### Configure Tool Responses

```typescript
const scenario = ScenarioComposer
  .create()
  .onTool('protokoll_list_transcripts')
  .respondWith(transcriptList)
  .onTool('protokoll_read_transcript')
  .respondWith(transcriptContent)
  .build();
```

### Configure Tool Errors

```typescript
const scenario = ScenarioComposer
  .create()
  .onTool('protokoll_list_transcripts')
  .failWith({ code: -32603, message: 'Internal error' })
  .build();
```

### Session Expiration

```typescript
const scenario = ScenarioComposer
  .create()
  .afterRequests(3)
  .expireSession()
  .build();
```

### Complex Multi-Step Scenario

```typescript
const scenario = ScenarioComposer
  .preset('happy-path-transcripts')
  .modify()
  .onTool('protokoll_list_transcripts')
  .respondWith(customList)
  .afterRequests(5)
  .expireSession()
  .withSSE()
  .dropConnection()
  .done()
  .build();
```

## TestHelpers

Quick helper functions for common setups:

```typescript
import { TestHelpers } from './test/mock';

// Happy path server
const server = await TestHelpers.createHappyPathServer();

// Empty project server
const server = await TestHelpers.createEmptyProjectServer();

// Custom server
const server = await TestHelpers.createCustomServer(
  { verbose: true },
  (builder) => builder
    .withPreset('happy-path-transcripts')
    .withTool('protokoll_get_version')
    .returning({ version: 'custom' })
);
```

## Example Test Patterns

### Simple Test with Preset

```typescript
describe('Transcript List', () => {
  let server: MockTransportServer;

  beforeEach(async () => {
    server = await TestHelpers.createHappyPathServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should display transcripts', async () => {
    // Test your extension against the mock server
    // ...
  });
});
```

### Test with Custom Configuration

```typescript
it('should handle empty transcript list', async () => {
  const server = await MockServerBuilder
    .create()
    .withPreset('empty-project')
    .build();

  // Test empty state handling
  // ...

  await server.stop();
});
```

### Test with Error Simulation

```typescript
it('should handle server errors gracefully', async () => {
  const server = await MockServerBuilder
    .create()
    .withTool('protokoll_list_transcripts')
    .throwing({ code: -32603, message: 'Server error' })
    .build();

  // Test error handling
  // ...

  await server.stop();
});
```

### Test Session Recovery

```typescript
it('should recover from session expiration', async () => {
  const scenario = ScenarioComposer
    .preset('happy-path-transcripts')
    .modify()
    .afterRequests(2)
    .expireSession()
    .build();

  const server = await MockServerBuilder
    .create()
    .withScenario(scenario)
    .build();

  // First 2 requests succeed
  // Third request triggers session recovery
  // Fourth request succeeds with new session

  await server.stop();
});
```

## Design Philosophy

The hybrid approach provides three levels of abstraction:

1. **Presets** - Fastest setup for common cases
2. **Builder API** - Explicit configuration with fluent interface
3. **Scenario Composer** - Complex multi-step scenarios with full control

Choose the right level for your test:

- **Simple test?** Use a preset
- **Need custom data?** Use builder API
- **Testing edge cases?** Use scenario composer
- **Very complex?** Combine all three

This gradual learning curve means developers can start simple and add complexity only when needed.
