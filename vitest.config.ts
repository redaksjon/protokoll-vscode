import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        setupFiles: ['tests/setup.ts'],
        include: ['tests/**/*.test.ts'],
        exclude: ['node_modules/**/*', 'out/**/*', '.vscode-test/**/*', 'tests/**/*.test.js'],
        testTimeout: 10000,
        hookTimeout: 10000,
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
                // New view providers - tests to be added in follow-up
                'src/peopleView.ts',
                'src/termsView.ts',
                'src/projectsView.ts',
                'src/companiesView.ts',
            ],
            thresholds: {
                lines: 25,
                statements: 25,
                branches: 66,
                functions: 54,
            },
        },
    },
});
