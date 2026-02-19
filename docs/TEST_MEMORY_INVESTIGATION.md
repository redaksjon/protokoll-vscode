# Test Memory Investigation

## Summary

Investigation into memory leaks / high memory usage when running the protokoll-vscode test suite. The project already shows signs of known memory pressure: `NODE_OPTIONS='--max-old-space-size=4096 --expose-gc'` and a `test:fast` script that excludes the heaviest tests.

## Current Test Setup

| Script | What it runs | Notes |
|--------|--------------|-------|
| `npm test` | Full suite + v8 coverage | Runs all tests including extension, mcpClient, openaiClient, transcriptsView |
| `npm run test:fast` | Same but excludes 4 heavy files | Skips extension.test, mcpClient.test, openaiClient.test, transcriptsView.test |
| `npm run test:watch` | Watch mode + coverage | Keeps process alive; memory can accumulate over time |

## Likely Memory Contributors

### 1. V8 Coverage (Primary suspect)

- **Vitest issue #4476**: Coverage providers store reports in memory on the main thread during test runs. Larger projects hit Node heap limits.
- The fix (PR #4603) writes temp files to disk instead of holding everything in memory, but coverage is still inherently memory-intensive.
- **Mitigation**: Run without coverage for day-to-day development: `vitest run` (no `--coverage`). Use coverage only in CI or before releases.

### 2. Heavy Test Files (Excluded from test:fast)

These are excluded from `test:fast` because they are known to be heavy:

- **extension.test.ts** (~1100 lines) – Activates the full extension, mocks vscode, HTTP, MCP; loads all view providers.
- **mcpClient.test.ts** – MCP client with HTTP/SSE; likely spawns connections and mocks.
- **openaiClient.test.ts** – OpenAI client; may load large fixtures or models.
- **transcriptsView.test.ts** (~620 lines) – TranscriptsViewProvider, tree views, HTTP mocks.

### 3. Watch Mode

- `test:watch` keeps the Vitest process running. Each re-run can leave references in memory (mocks, modules, coverage data).
- Long watch sessions can accumulate memory.

### 4. Extension Activation

- `activate()` loads: McpClient, TranscriptsViewProvider, TranscriptDetailViewProvider, ConnectionStatusViewProvider, ChatViewProvider, ChatsViewProvider, PeopleViewProvider, TermsViewProvider, ProjectsViewProvider, CompaniesViewProvider, UploadService.
- `extension.test.ts` runs activation; all of this is loaded and exercised in a single process.

## Step 7 and Memory

Step 7 added `_fetchStats()` and the project stats section to `dashboardView.ts`. **DashboardViewProvider is not yet wired into extension.ts** (that’s Step 10), so it is not loaded during extension activation. Step 7’s changes are therefore unlikely to be the direct cause of a new memory leak.

If the leak appeared when running tests after Step 7, it is more likely due to:

1. Running the full `npm test` (with coverage) instead of `test:fast`
2. Running `test:watch` for an extended period
3. Existing coverage/activation memory pressure, not new dashboard code

## Recommendations

### Immediate

1. **Use `test:fast` for local development**  
   `npm run test:fast` skips the heaviest tests and is less likely to hit memory limits.

2. **Add a no-coverage script** for quick runs:
   ```json
   "test:no-cov": "vitest run"
   ```
   Use this when you need fast feedback and don’t care about coverage.

3. **Avoid long `test:watch` sessions**  
   Restart the watch process periodically if you notice memory growth.

### Medium-term

4. **Run coverage only in CI**  
   Configure CI to run `npm test` (with coverage); use `test:fast` or `test:no-cov` locally.

5. **Split heavy tests**  
   Consider splitting `extension.test.ts` into smaller files (e.g. by feature) so each run loads less.

6. **Upgrade Vitest**  
   Ensure you’re on a version that includes the coverage memory fix (post–PR #4603).

### Verification

To see if coverage is the main factor:

```bash
# With coverage (current default)
npm test

# Without coverage
npx vitest run
```

If `npx vitest run` uses significantly less memory and completes without OOM, coverage is a major contributor.
