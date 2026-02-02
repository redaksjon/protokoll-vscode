"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("vitest/config");
exports.default = (0, config_1.defineConfig)({
    test: {
        globals: true,
        environment: 'node',
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
                'src/**/*.d.ts',
                // Type definitions only - no executable code
                'src/types.ts',
                // VS Code extension files - hard to test without VS Code API mocks
                'src/extension.ts',
                'src/transcriptsView.ts',
                'src/transcriptDetailView.ts',
                'src/connectionStatusView.ts',
            ],
            thresholds: {
                lines: 10,
                statements: 10,
                branches: 10,
                functions: 10,
            },
        },
    },
});
//# sourceMappingURL=vitest.config.js.map