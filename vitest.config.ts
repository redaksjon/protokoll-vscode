import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        setupFiles: ['tests/setup.ts'],
        include: ['tests/**/*.test.ts'],
        exclude: ['node_modules/**/*', 'out/**/*', '.vscode-test/**/*'],
        testTimeout: 10000,
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
