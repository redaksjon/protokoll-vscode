/**
 * Tests for type definitions
 */

import { describe, it, expect } from 'vitest';
import type {
    Transcript,
    TranscriptsListResponse,
    TranscriptContent,
    JsonRpcRequest,
    JsonRpcResponse,
    McpResource,
    McpResourcesListResponse,
} from '../src/types';

describe('types', () => {
    describe('Transcript', () => {
        it('should have required fields', () => {
            const transcript: Transcript = {
                uri: 'redaksjon://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };
            
            expect(transcript.uri).toBe('redaksjon://transcript/test.md');
            expect(transcript.path).toBe('/path/to/test.md');
            expect(transcript.filename).toBe('test.md');
            expect(transcript.date).toBe('2026-01-31');
        });

        it('should support optional fields', () => {
            const transcript: Transcript = {
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
            
            expect(transcript.time).toBe('14:30');
            expect(transcript.title).toBe('Test Transcript');
            expect(transcript.hasRawTranscript).toBe(true);
            expect(transcript.createdAt).toBe('2026-01-31T14:30:00Z');
            expect(transcript.updatedAt).toBe('2026-01-31T15:00:00Z');
            expect(transcript.entities?.people).toHaveLength(1);
            expect(transcript.entities?.projects).toHaveLength(1);
        });
    });

    describe('TranscriptsListResponse', () => {
        it('should have required fields', () => {
            const response: TranscriptsListResponse = {
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
            
            expect(response.directory).toBe('/path/to/transcripts');
            expect(response.transcripts).toEqual([]);
            expect(response.pagination.total).toBe(0);
        });

        it('should support filter fields', () => {
            const response: TranscriptsListResponse = {
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
            
            expect(response.filters.startDate).toBe('2026-01-01');
            expect(response.filters.endDate).toBe('2026-01-31');
        });
    });

    describe('TranscriptContent', () => {
        it('should have required fields', () => {
            const content: TranscriptContent = {
                uri: 'redaksjon://transcript/test.md',
                mimeType: 'text/markdown',
                text: '# Test Transcript\n\nContent here.',
            };
            
            expect(content.uri).toBe('redaksjon://transcript/test.md');
            expect(content.mimeType).toBe('text/markdown');
            expect(content.text).toContain('Test Transcript');
        });
    });

    describe('JsonRpcRequest', () => {
        it('should have required fields', () => {
            const request: JsonRpcRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'test/method',
                params: { key: 'value' },
            };
            
            expect(request.jsonrpc).toBe('2.0');
            expect(request.id).toBe(1);
            expect(request.method).toBe('test/method');
            expect(request.params).toEqual({ key: 'value' });
        });

        it('should support null id', () => {
            const request: JsonRpcRequest = {
                jsonrpc: '2.0',
                id: null,
                method: 'test/method',
            };
            
            expect(request.id).toBeNull();
        });
    });

    describe('JsonRpcResponse', () => {
        it('should support success response', () => {
            const response: JsonRpcResponse = {
                jsonrpc: '2.0',
                id: 1,
                result: { success: true },
            };
            
            expect(response.jsonrpc).toBe('2.0');
            expect(response.id).toBe(1);
            expect(response.result).toEqual({ success: true });
            expect(response.error).toBeUndefined();
        });

        it('should support error response', () => {
            const response: JsonRpcResponse = {
                jsonrpc: '2.0',
                id: 1,
                error: {
                    code: -32603,
                    message: 'Internal error',
                    data: { details: 'Something went wrong' },
                },
            };
            
            expect(response.error?.code).toBe(-32603);
            expect(response.error?.message).toBe('Internal error');
            expect(response.error?.data).toEqual({ details: 'Something went wrong' });
        });
    });

    describe('McpResource', () => {
        it('should have required fields', () => {
            const resource: McpResource = {
                uri: 'redaksjon://resource/test',
                name: 'Test Resource',
            };
            
            expect(resource.uri).toBe('redaksjon://resource/test');
            expect(resource.name).toBe('Test Resource');
        });

        it('should support optional fields', () => {
            const resource: McpResource = {
                uri: 'redaksjon://resource/test',
                name: 'Test Resource',
                description: 'A test resource',
                mimeType: 'text/plain',
            };
            
            expect(resource.description).toBe('A test resource');
            expect(resource.mimeType).toBe('text/plain');
        });
    });

    describe('McpResourcesListResponse', () => {
        it('should have required fields', () => {
            const response: McpResourcesListResponse = {
                resources: [],
            };
            
            expect(response.resources).toEqual([]);
        });

        it('should support multiple resources', () => {
            const response: McpResourcesListResponse = {
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
            
            expect(response.resources).toHaveLength(2);
            expect(response.resources[0].name).toBe('Test Resource 1');
            expect(response.resources[1].name).toBe('Test Resource 2');
        });
    });
});
