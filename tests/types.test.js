"use strict";
/**
 * Tests for type definitions
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
(0, vitest_1.describe)('types', () => {
    (0, vitest_1.describe)('Transcript', () => {
        (0, vitest_1.it)('should have required fields', () => {
            const transcript = {
                uri: 'redaksjon://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };
            (0, vitest_1.expect)(transcript.uri).toBe('redaksjon://transcript/test.md');
            (0, vitest_1.expect)(transcript.path).toBe('/path/to/test.md');
            (0, vitest_1.expect)(transcript.filename).toBe('test.md');
            (0, vitest_1.expect)(transcript.date).toBe('2026-01-31');
        });
        (0, vitest_1.it)('should support optional fields', () => {
            const transcript = {
                uri: 'redaksjon://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
                time: '14:30',
                title: 'Test Transcript',
                hasRawTranscript: true,
                createdAt: '2026-01-31T14:30:00Z',
                updatedAt: '2026-01-31T15:00:00Z',
                entities: {
                    people: [{ id: 'john-doe', name: 'John Doe' }],
                    projects: [{ id: 'test-project', name: 'Test Project' }],
                },
            };
            (0, vitest_1.expect)(transcript.time).toBe('14:30');
            (0, vitest_1.expect)(transcript.title).toBe('Test Transcript');
            (0, vitest_1.expect)(transcript.hasRawTranscript).toBe(true);
            (0, vitest_1.expect)(transcript.createdAt).toBe('2026-01-31T14:30:00Z');
            (0, vitest_1.expect)(transcript.updatedAt).toBe('2026-01-31T15:00:00Z');
            (0, vitest_1.expect)(transcript.entities?.people).toHaveLength(1);
            (0, vitest_1.expect)(transcript.entities?.projects).toHaveLength(1);
        });
    });
    (0, vitest_1.describe)('TranscriptsListResponse', () => {
        (0, vitest_1.it)('should have required fields', () => {
            const response = {
                directory: '/path/to/transcripts',
                transcripts: [],
                pagination: {
                    total: 0,
                    limit: 10,
                    offset: 0,
                    hasMore: false,
                },
                filters: {},
            };
            (0, vitest_1.expect)(response.directory).toBe('/path/to/transcripts');
            (0, vitest_1.expect)(response.transcripts).toEqual([]);
            (0, vitest_1.expect)(response.pagination.total).toBe(0);
        });
        (0, vitest_1.it)('should support filter fields', () => {
            const response = {
                directory: '/path/to/transcripts',
                transcripts: [],
                pagination: {
                    total: 0,
                    limit: 10,
                    offset: 0,
                    hasMore: false,
                },
                filters: {
                    startDate: '2026-01-01',
                    endDate: '2026-01-31',
                },
            };
            (0, vitest_1.expect)(response.filters.startDate).toBe('2026-01-01');
            (0, vitest_1.expect)(response.filters.endDate).toBe('2026-01-31');
        });
    });
    (0, vitest_1.describe)('TranscriptContent', () => {
        (0, vitest_1.it)('should have required fields', () => {
            const content = {
                uri: 'redaksjon://transcript/test.md',
                mimeType: 'text/markdown',
                text: '# Test Transcript\n\nContent here.',
            };
            (0, vitest_1.expect)(content.uri).toBe('redaksjon://transcript/test.md');
            (0, vitest_1.expect)(content.mimeType).toBe('text/markdown');
            (0, vitest_1.expect)(content.text).toContain('Test Transcript');
        });
    });
    (0, vitest_1.describe)('JsonRpcRequest', () => {
        (0, vitest_1.it)('should have required fields', () => {
            const request = {
                jsonrpc: '2.0',
                id: 1,
                method: 'test/method',
                params: { key: 'value' },
            };
            (0, vitest_1.expect)(request.jsonrpc).toBe('2.0');
            (0, vitest_1.expect)(request.id).toBe(1);
            (0, vitest_1.expect)(request.method).toBe('test/method');
            (0, vitest_1.expect)(request.params).toEqual({ key: 'value' });
        });
        (0, vitest_1.it)('should support null id', () => {
            const request = {
                jsonrpc: '2.0',
                id: null,
                method: 'test/method',
            };
            (0, vitest_1.expect)(request.id).toBeNull();
        });
    });
    (0, vitest_1.describe)('JsonRpcResponse', () => {
        (0, vitest_1.it)('should support success response', () => {
            const response = {
                jsonrpc: '2.0',
                id: 1,
                result: { success: true },
            };
            (0, vitest_1.expect)(response.jsonrpc).toBe('2.0');
            (0, vitest_1.expect)(response.id).toBe(1);
            (0, vitest_1.expect)(response.result).toEqual({ success: true });
            (0, vitest_1.expect)(response.error).toBeUndefined();
        });
        (0, vitest_1.it)('should support error response', () => {
            const response = {
                jsonrpc: '2.0',
                id: 1,
                error: {
                    code: -32603,
                    message: 'Internal error',
                    data: { details: 'Something went wrong' },
                },
            };
            (0, vitest_1.expect)(response.error?.code).toBe(-32603);
            (0, vitest_1.expect)(response.error?.message).toBe('Internal error');
            (0, vitest_1.expect)(response.error?.data).toEqual({ details: 'Something went wrong' });
        });
    });
    (0, vitest_1.describe)('McpResource', () => {
        (0, vitest_1.it)('should have required fields', () => {
            const resource = {
                uri: 'redaksjon://resource/test',
                name: 'Test Resource',
            };
            (0, vitest_1.expect)(resource.uri).toBe('redaksjon://resource/test');
            (0, vitest_1.expect)(resource.name).toBe('Test Resource');
        });
        (0, vitest_1.it)('should support optional fields', () => {
            const resource = {
                uri: 'redaksjon://resource/test',
                name: 'Test Resource',
                description: 'A test resource',
                mimeType: 'text/plain',
            };
            (0, vitest_1.expect)(resource.description).toBe('A test resource');
            (0, vitest_1.expect)(resource.mimeType).toBe('text/plain');
        });
    });
    (0, vitest_1.describe)('McpResourcesListResponse', () => {
        (0, vitest_1.it)('should have required fields', () => {
            const response = {
                resources: [],
            };
            (0, vitest_1.expect)(response.resources).toEqual([]);
        });
        (0, vitest_1.it)('should support multiple resources', () => {
            const response = {
                resources: [
                    {
                        uri: 'redaksjon://resource/test1',
                        name: 'Test Resource 1',
                    },
                    {
                        uri: 'redaksjon://resource/test2',
                        name: 'Test Resource 2',
                    },
                ],
            };
            (0, vitest_1.expect)(response.resources).toHaveLength(2);
            (0, vitest_1.expect)(response.resources[0].name).toBe('Test Resource 1');
            (0, vitest_1.expect)(response.resources[1].name).toBe('Test Resource 2');
        });
    });
});
//# sourceMappingURL=types.test.js.map