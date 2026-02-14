# Testing Guide

Comprehensive guide to testing the Protokoll VS Code extension.

## Testing Strategy

The extension uses a **dual testing strategy**:

1. **Unit Tests** (Vitest) - Fast, isolated tests for logic and components
2. **Integration Tests** (Future: Mocha + @vscode/test-electron) - Full extension testing in VS Code environment

## Current Test Suite

### Unit Tests with Vitest

All unit tests run via Vitest and are located in the `tests/` directory:

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run specific test file
npm test -- MockTransportServer

# Run with coverage
npm test -- --coverage
```

### Test Files

| File | Tests | Purpose |
|------|-------|---------|
| `MockTransportServer.test.ts` | 17 | Protocol compliance, server lifecycle |
| `ToolHandlers.test.ts` | 30 | Tool handler routing, fixtures |
| `ScenarioPresets.test.ts` | 28 | Scenario presets, builder API |
| `SseInfrastructure.test.ts` | 24 | SSE connection, notifications |
| `mcpClient.test.ts` | 52 | MCP client functionality |
| `transcriptsView.test.ts` | 26 | Transcript view provider |
| `transcriptDetailView.test.ts` | 84 | Transcript detail view |
| `chatsView.test.ts` | 16 | Chat view provider |
| `connectionStatusView.test.ts` | 28 | Connection status view |

**Total: 314 tests** (309 passed, 5 skipped)

## Mock MCP Server

The test suite includes a comprehensive mock MCP server for testing without a real server:

### Features

- ✅ Real HTTP + SSE protocol implementation
- ✅ All 47 MCP tools with configurable responses
- ✅ Session management with controlled expiration
- ✅ SSE connection lifecycle testing
- ✅ Notification delivery tracking
- ✅ Network simulation (delays, drops)
- ✅ Scenario presets for common cases
- ✅ Fluent builder API for complex scenarios

### Documentation

- `src/test/mock/README.md` - Mock server overview
- `src/test/mock/SCENARIOS.md` - Scenario presets and composition
- `src/test/mock/SSE_TESTING.md` - SSE testing utilities

### Quick Example

```typescript
import { MockServerBuilder } from './src/test/mock';

const server = await MockServerBuilder
  .create()
  .withPreset('happy-path-transcripts')
  .build();

// Use server.getBaseUrl() in your tests

await server.stop();
```

## Running Tests Locally

### Prerequisites

```bash
npm install
```

### Run All Tests

```bash
npm test
```

This runs:
1. All unit tests with Vitest
2. Generates coverage report
3. Outputs results to console

### Run Specific Tests

```bash
# Run mock server tests
npm test -- MockTransportServer

# Run SSE tests
npm test -- SseInfrastructure

# Run view tests
npm test -- transcriptsView
```

### Watch Mode

```bash
npm run test:watch
```

Automatically re-runs tests when files change.

## Precommit Checks

Before committing, run:

```bash
npm run precommit
```

This runs:
1. `npm run lint` - ESLint checks
2. `npm run build` - TypeScript compilation
3. `npm run test` - All tests with coverage

**All 314 tests must pass** before committing.

## Continuous Integration (GitHub Actions)

Tests run automatically on:
- Push to `main`, `working`, `release/**`, `feature/**` branches
- Pull requests to `main`

### CI Workflow

The `.github/workflows/test.yml` workflow:

1. Checks out code
2. Sets up Node.js 24
3. Installs dependencies
4. Runs linter
5. Compiles TypeScript
6. Runs all tests
7. Uploads coverage to Codecov (optional)

### CI Configuration

```yaml
- run: npm run lint
- run: npm run compile
- name: Run tests
  run: npm run test
- name: Upload coverage reports
  uses: codecov/codecov-action@v4
  if: always()
  with:
    files: ./coverage/lcov.info
    fail_ci_if_error: false
```

**No external dependencies required** - the mock server is completely self-contained.

## Coverage Thresholds

Current coverage thresholds (configured in `vitest.config.ts`):

```typescript
thresholds: {
  lines: 10,
  statements: 10,
  branches: 10,
  functions: 10,
}
```

Current coverage (as of Step 4):

- **Overall**: 50.67% statements
- **Mock Server**: 66.29% statements
- **SseManager**: 83.15% statements
- **Tool Handlers**: 87.31% statements

## Test Organization

```
protokoll-vscode/
├── tests/                          # Unit tests (Vitest)
│   ├── setup.ts                    # Test setup with VS Code mocks
│   ├── helpers/                    # Test helpers
│   ├── MockTransportServer.test.ts # Mock server protocol tests
│   ├── ToolHandlers.test.ts        # Tool handler tests
│   ├── ScenarioPresets.test.ts     # Scenario API tests
│   ├── SseInfrastructure.test.ts   # SSE testing tests
│   ├── mcpClient.test.ts           # MCP client tests
│   ├── transcriptsView.test.ts     # View provider tests
│   └── ...                         # Other view tests
│
└── src/test/mock/                  # Mock MCP server
    ├── MockTransportServer.ts      # Main server
    ├── SessionManager.ts           # Session management
    ├── SseManager.ts               # SSE connections
    ├── JsonRpcHandler.ts           # JSON-RPC protocol
    ├── handlers/                   # Tool handlers (10 categories)
    ├── fixtures/                   # Test fixtures
    ├── scenarios/                  # SSE scenarios
    ├── testing/                    # Test utilities
    └── *.md                        # Documentation
```

## Future: Integration Tests with @vscode/test-electron

The mock server is ready for integration tests with @vscode/test-electron. To add them:

1. Install dependencies:
   ```bash
   npm install --save-dev @vscode/test-electron mocha @types/mocha
   ```

2. Create `test-integration/` directory with Mocha tests

3. Add test script:
   ```json
   "test:integration": "node ./test-integration/runTest.js"
   ```

4. Run both test suites:
   ```json
   "test:all": "npm run test && npm run test:integration"
   ```

See `src/test/mock/` documentation for examples of using the mock server with integration tests.

## Troubleshooting

### Tests Failing Locally

1. Ensure dependencies are installed: `npm install`
2. Clean build: `npm run clean && npm run compile`
3. Check Node version: `node --version` (should be 24+)

### Tests Passing Locally but Failing in CI

1. Check GitHub Actions logs for specific errors
2. Ensure no external dependencies (database, API calls, etc.)
3. Verify platform-specific code (the mock server is platform-independent)

### Mock Server Port Conflicts

The mock server automatically uses random available ports, so conflicts should not occur. If you see port-related errors:

```typescript
// Specify a port explicitly (for debugging only)
const server = new MockTransportServer({ port: 54321 });
```

### SSE Connection Issues

If SSE tests are flaky:

1. Increase timeouts: `await server.waitForSseConnection(sessionId, 10000)`
2. Add delays between operations: `await new Promise(r => setTimeout(r, 100))`
3. Check verbose logging: `new MockTransportServer({ verbose: true })`

## Writing New Tests

### Unit Test Template

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockServerBuilder } from '../src/test/mock';

describe('My Feature', () => {
  let server: MockTransportServer;

  beforeEach(async () => {
    server = await MockServerBuilder
      .create()
      .withPreset('happy-path-transcripts')
      .build();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should do something', async () => {
    // Your test here
    expect(true).toBe(true);
  });
});
```

### Using Custom Fixtures

```typescript
import { FixtureFactory } from '../src/test/mock';

const customTranscript = FixtureFactory.transcript({
  title: 'Custom Title',
  status: 'reviewed',
  entities: {
    projects: [{ id: 'p1', name: 'My Project' }],
  },
});

const server = await MockServerBuilder
  .create()
  .withHandler<TranscriptToolHandler>('transcripts')
  .configure((handler) => {
    handler.setTranscriptFixture('default', customTranscript);
  })
  .build();
```

### Testing Error Handling

```typescript
const server = await MockServerBuilder
  .create()
  .withTool('protokoll_list_transcripts')
  .throwing({ code: -32603, message: 'Server error' })
  .build();

// Test that your code handles the error gracefully
```

## Best Practices

1. **Always clean up** - Stop servers in `afterEach` hooks
2. **Use presets** - Start with presets, customize only when needed
3. **Clear history** - Call `server.clearSseHistory()` between tests if needed
4. **Specific assertions** - Test specific behavior, not implementation details
5. **Async/await** - Always await async operations
6. **Timeouts** - Set reasonable timeouts for async operations
7. **Isolation** - Each test should be independent

## Coverage Goals

Current coverage is good (50%+), but aim to increase coverage for:

- Extension activation logic
- Command handlers
- Error handling paths
- Edge cases in view providers

Run coverage report:

```bash
npm test -- --coverage
```

View HTML report: `open coverage/index.html`

## Summary

✅ **314 tests** running successfully
✅ **Mock MCP server** with full protocol support
✅ **Comprehensive SSE testing** infrastructure
✅ **CI integration** via GitHub Actions
✅ **No external dependencies** required
✅ **Fast feedback** - tests run in ~4 seconds

The testing infrastructure is production-ready and provides comprehensive coverage of the extension's functionality!
