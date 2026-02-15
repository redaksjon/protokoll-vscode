# Integration Tests (Future)

This directory is prepared for future integration tests using @vscode/test-electron.

## Current Status

**Not yet implemented.** The mock MCP server infrastructure is ready, but the @vscode/test-electron integration is not yet set up.

## Why Not Implemented Yet?

The current test suite (314 tests with Vitest) provides excellent coverage of:
- Mock MCP server protocol compliance
- Tool handlers and fixtures
- SSE connection lifecycle
- Scenario composition
- View providers (with mocked VS Code APIs)

Integration tests with @vscode/test-electron would add:
- Real VS Code environment testing
- Actual extension activation
- Real webview rendering
- Full command execution

**Decision**: Implement integration tests when needed for specific scenarios that can't be tested with mocked VS Code APIs.

## When to Add Integration Tests

Consider adding @vscode/test-electron integration tests when:

1. Testing complex webview interactions
2. Testing extension activation edge cases
3. Testing VS Code API interactions that are hard to mock
4. Testing cross-extension communication
5. Testing file system watchers and workspace events

## How to Add Integration Tests

When ready to implement:

### 1. Install Dependencies

```bash
npm install --save-dev @vscode/test-electron mocha @types/mocha
```

### 2. Create Test Runner

Create `test-integration/runTest.ts`:

```typescript
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();
```

### 3. Create Test Suite

Create `test-integration/suite/index.ts`:

```typescript
import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 30000,
  });

  const testsRoot = path.resolve(__dirname, '.');

  return new Promise((resolve, reject) => {
    glob('**/**.test.js', { cwd: testsRoot }, (err, files) => {
      if (err) {
        return reject(err);
      }

      files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));

      try {
        mocha.run(failures => {
          if (failures > 0) {
            reject(new Error(`${failures} tests failed.`));
          } else {
            resolve();
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}
```

### 4. Create Example Integration Test

Create `test-integration/suite/extension.test.ts`:

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';
import { MockServerBuilder } from '../../src/test/mock';

suite('Extension Integration Tests', () => {
  let mockServer: any;

  suiteSetup(async () => {
    // Start mock server before all tests
    mockServer = await MockServerBuilder
      .create()
      .withPreset('happy-path-transcripts')
      .build();

    // Configure extension to use mock server
    const config = vscode.workspace.getConfiguration('protokoll');
    await config.update('serverUrl', mockServer.getBaseUrl(), true);
  });

  suiteTeardown(async () => {
    await mockServer?.stop();
  });

  test('Extension should activate', async () => {
    const ext = vscode.extensions.getExtension('protokoll-vscode');
    assert.ok(ext);
    
    await ext.activate();
    assert.ok(ext.isActive);
  });

  test('Should load transcripts from mock server', async () => {
    // Test transcript loading
    // ...
  });
});
```

### 5. Add Test Script

Add to `package.json`:

```json
{
  "scripts": {
    "test:integration": "tsc -p test-integration && node ./test-integration/runTest.js",
    "test:all": "npm run test && npm run test:integration"
  }
}
```

### 6. Update CI

Add to `.github/workflows/test.yml`:

```yaml
- name: Run integration tests
  run: npm run test:integration
  if: github.event_name == 'pull_request'  # Only on PRs
```

## Current Testing Approach

For now, the **unit tests with mocked VS Code APIs** provide excellent coverage:

- **Fast** - Tests run in ~4 seconds
- **Reliable** - No flakiness from real VS Code environment
- **Comprehensive** - 314 tests covering all major functionality
- **CI-friendly** - No special setup required

The mock MCP server is **production-ready** and can be used immediately for integration tests when needed.

## Mock Server vs Real Server

### When to Use Mock Server

✅ Unit tests
✅ Protocol compliance testing
✅ Tool handler testing
✅ SSE connection testing
✅ Error handling testing
✅ Fast feedback during development

### When to Use Real Server

❌ Not needed for most tests (mock server is sufficient)
✅ End-to-end testing (manual)
✅ Performance testing
✅ Real-world data validation

## Resources

- Mock Server: `src/test/mock/README.md`
- Scenarios: `src/test/mock/SCENARIOS.md`
- SSE Testing: `src/test/mock/SSE_TESTING.md`
- Vitest Docs: https://vitest.dev/
- VS Code Testing: https://code.visualstudio.com/api/working-with-extensions/testing-extension

## Questions?

The mock MCP server is comprehensive and ready to use. If you need help:

1. Check the documentation in `src/test/mock/`
2. Look at existing test files for examples
3. Use preset scenarios for common cases
4. Use the builder API for custom scenarios

Happy testing! 🎉
