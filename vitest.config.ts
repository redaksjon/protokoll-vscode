import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        setupFiles: ['tests/setup.ts'],
        include: ['tests/**/*.test.ts'],
        exclude: ['node_modules/**/*', 'out/**/*', '.vscode-test/**/*'],
        testTimeout: 10000,
        hookTimeout: 10000,
        // CRITICAL: Prevent memory leaks by controlling test execution
        // Use threads pool with limited concurrency to avoid too many HTTP servers
        pool: 'threads',
        poolOptions: {
            threads: {
                minThreads: 1,
                maxThreads: 2, // Limit to 2 threads max to control resource usage
            },
        },
        // Isolate tests to prevent state leakage
        isolate: true,
        // Run tests sequentially within each file
        fileParallelism: false, // Don't run test files in parallel
        // Force garbage collection between tests
        sequence: {
            shuffle: false, // Run tests in order for predictability
        },
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'lcov'],
            include: ['src/**/*.ts'],
            exclude: [
                'out/**/*',
                'node_modules/**/*',
                'tests/**/*',
                'src/test/**/*',
                'src/**/*.d.ts',
                // Type definitions only - no executable code
                'src/types.ts',
            ],
            thresholds: {
                lines: 50,
                statements: 50,
                branches: 70,
                functions: 65,
            },
        },
    },
});
