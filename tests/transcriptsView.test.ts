/**
 * Tests for Transcripts View
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { TranscriptsViewProvider, TranscriptItem } from '../src/transcriptsView';
import { McpClient } from '../src/mcpClient';
import type { Transcript, TranscriptsListResponse } from '../src/types';
import { mockHttpRequest } from './helpers/httpMock';

describe('TranscriptsViewProvider', () => {
    let provider: TranscriptsViewProvider;
    let mockContext: vscode.ExtensionContext;
    let mockClient: McpClient;

    beforeEach(() => {
        mockContext = new vscode.ExtensionContext();
        provider = new TranscriptsViewProvider(mockContext);
        mockClient = new McpClient('http://localhost:3001');
        vi.clearAllMocks();
    });

    describe('constructor', () => {
        it('should initialize provider', () => {
            expect(provider).toBeInstanceOf(TranscriptsViewProvider);
        });
    });

    describe('setClient', () => {
        it('should set the MCP client', () => {
            provider.setClient(mockClient);
            expect(provider).toBeDefined();
        });
    });

    describe('setProjectFilter', () => {
        it('should set project filter', () => {
            provider.setProjectFilter('test-project');
            expect(provider.getProjectFilter()).toBe('test-project');
        });

        it('should clear project filter when set to null', () => {
            provider.setProjectFilter('test-project');
            provider.setProjectFilter(null);
            expect(provider.getProjectFilter()).toBeNull();
        });
    });

    describe('getProjectFilter', () => {
        it('should return null initially', () => {
            expect(provider.getProjectFilter()).toBeNull();
        });

        it('should return set project filter', () => {
            provider.setProjectFilter('test-project');
            expect(provider.getProjectFilter()).toBe('test-project');
        });
    });

    describe('workspace settings persistence', () => {
        it('should save project filter to workspace state', async () => {
            provider.setClient(mockClient);
            
            // Mock the HTTP request that will be triggered by refresh()
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        contents: [{
                            uri: 'protokoll://transcripts',
                            mimeType: 'application/json',
                            text: JSON.stringify({
                                directory: '/test',
                                transcripts: [],
                                pagination: { total: 0, limit: 100, offset: 0, hasMore: false },
                                filters: {},
                            }),
                        }],
                    },
                }),
            });
            
            provider.setProjectFilter('test-project');
            
            // Wait for async save to complete
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Verify it was saved to workspace state
            const saved = mockContext.workspaceState.get('protokoll.projectFilter');
            expect(saved).toBe('test-project');
        });

        it('should load project filter from workspace state on initialization', () => {
            // Set up workspace state before creating provider
            mockContext.workspaceState.update('protokoll.projectFilter', 'saved-project');
            
            const newProvider = new TranscriptsViewProvider(mockContext);
            expect(newProvider.getProjectFilter()).toBe('saved-project');
        });

        it('should save status filters to workspace state', async () => {
            provider.setClient(mockClient);
            
            // Mock the HTTP request
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        contents: [{
                            uri: 'protokoll://transcripts',
                            mimeType: 'application/json',
                            text: JSON.stringify({
                                directory: '/test',
                                transcripts: [],
                                pagination: { total: 0, limit: 100, offset: 0, hasMore: false },
                                filters: {},
                            }),
                        }],
                    },
                }),
            });
            
            const newFilters = new Set(['initial', 'reviewed']);
            provider.setStatusFilters(newFilters);
            
            // Wait for async save to complete
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Verify it was saved to workspace state
            const saved = mockContext.workspaceState.get('protokoll.statusFilters');
            expect(saved).toEqual(['initial', 'reviewed']);
        });

        it('should load status filters from workspace state on initialization', () => {
            // Set up workspace state before creating provider
            mockContext.workspaceState.update('protokoll.statusFilters', ['closed', 'archived']);
            
            const newProvider = new TranscriptsViewProvider(mockContext);
            const filters = newProvider.getStatusFilters();
            expect(filters).toEqual(new Set(['closed', 'archived']));
        });

        it('should save sort order to workspace state', async () => {
            provider.setClient(mockClient);
            
            // Mock the HTTP request
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        contents: [{
                            uri: 'protokoll://transcripts',
                            mimeType: 'application/json',
                            text: JSON.stringify({
                                directory: '/test',
                                transcripts: [],
                                pagination: { total: 0, limit: 100, offset: 0, hasMore: false },
                                filters: {},
                            }),
                        }],
                    },
                }),
            });
            
            provider.setSortOrder('title-asc');
            
            // Wait for async save to complete
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Verify it was saved to workspace state
            const saved = mockContext.workspaceState.get('protokoll.sortOrder');
            expect(saved).toBe('title-asc');
        });

        it('should load sort order from workspace state on initialization', () => {
            // Set up workspace state before creating provider
            mockContext.workspaceState.update('protokoll.sortOrder', 'date-asc');
            
            const newProvider = new TranscriptsViewProvider(mockContext);
            expect(newProvider.getSortOrder()).toBe('date-asc');
        });
    });

    describe('getTreeItem', () => {
        it('should return the element as tree item', () => {
            const item = new TranscriptItem(
                '2026',
                'year',
                vscode.TreeItemCollapsibleState.Expanded
            );

            const result = provider.getTreeItem(item);
            expect(result).toBe(item);
        });
    });

    describe('getChildren', () => {
        it('should return empty array when no client set', async () => {
            const children = await provider.getChildren();
            expect(children).toEqual([]);
        });

        it('should return empty array when no transcripts loaded', async () => {
            provider.setClient(mockClient);
            const children = await provider.getChildren();
            expect(children).toEqual([]);
        });
    });

    describe('refresh', () => {
        it('should handle refresh when no client', async () => {
            await expect(provider.refresh()).resolves.not.toThrow();
        });

        it('should refresh with directory parameter', async () => {
            provider.setClient(mockClient);
            
            const mockResponse: TranscriptsListResponse = {
                directory: '/test/dir',
                transcripts: [],
                pagination: {
                    total: 0,
                    limit: 100,
                    offset: 0,
                    hasMore: false,
                },
                filters: {},
            };

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        contents: [{
                            uri: 'protokoll://transcripts?directory=/test/dir',
                            mimeType: 'application/json',
                            text: JSON.stringify(mockResponse),
                        }],
                    },
                }),
            });

            await provider.refresh('/test/dir');
            // Should complete without error
            expect(provider).toBeDefined();
        });

        it('should handle errors during refresh', async () => {
            provider.setClient(mockClient);
            
            mockHttpRequest({
                statusCode: 500,
                body: 'Internal Server Error',
            });

            // Mock showErrorMessage
            const showErrorMessage = vi.fn();
            (vscode.window.showErrorMessage as any) = showErrorMessage;

            await provider.refresh('/test/dir');
            
            expect(showErrorMessage).toHaveBeenCalled();
        });

        it('should discover directory from resources', async () => {
            provider.setClient(mockClient);
            
            // Mock listResources to return a transcripts resource
            const listResourcesSpy = vi.spyOn(mockClient, 'listResources').mockResolvedValue({
                resources: [{
                    uri: 'protokoll://transcripts?directory=/auto/discovered',
                    name: 'Transcripts',
                }],
            });

            const mockResponse: TranscriptsListResponse = {
                directory: '/auto/discovered',
                transcripts: [],
                pagination: {
                    total: 0,
                    limit: 100,
                    offset: 0,
                    hasMore: false,
                },
                filters: {},
            };

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        contents: [{
                            uri: 'protokoll://transcripts?directory=/auto/discovered',
                            mimeType: 'application/json',
                            text: JSON.stringify(mockResponse),
                        }],
                    },
                }),
            });

            await provider.refresh();
            expect(listResourcesSpy).toHaveBeenCalled();
        });
    });

    describe('getChildren', () => {
        it('should return day items at root level', async () => {
            provider.setClient(mockClient);
            
            const mockResponse: TranscriptsListResponse = {
                directory: '/test',
                transcripts: [
                    {
                        uri: 'protokoll://transcript/test1.md',
                        path: '/test/test1.md',
                        filename: 'test1.md',
                        date: '2026-01-31',
                    },
                    {
                        uri: 'protokoll://transcript/test2.md',
                        path: '/test/test2.md',
                        filename: 'test2.md',
                        date: '2025-12-31',
                    },
                ],
                pagination: {
                    total: 2,
                    limit: 100,
                    offset: 0,
                    hasMore: false,
                },
                filters: {},
            };

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        contents: [{
                            uri: 'protokoll://transcripts?directory=/test',
                            mimeType: 'application/json',
                            text: JSON.stringify(mockResponse),
                        }],
                    },
                }),
            });

            await provider.refresh('/test');
            const children = await provider.getChildren();
            
            expect(children.length).toBeGreaterThan(0);
            expect(children[0].type).toBe('day');
        });

        it('should return transcript items for day', async () => {
            provider.setClient(mockClient);
            
            const mockResponse: TranscriptsListResponse = {
                directory: '/test',
                transcripts: [
                    {
                        uri: 'protokoll://transcript/test1.md',
                        path: '/test/test1.md',
                        filename: 'test1.md',
                        date: '2026-01-31',
                    },
                    {
                        uri: 'protokoll://transcript/test2.md',
                        path: '/test/test2.md',
                        filename: 'test2.md',
                        date: '2026-01-31',
                    },
                ],
                pagination: {
                    total: 2,
                    limit: 100,
                    offset: 0,
                    hasMore: false,
                },
                filters: {},
            };

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        contents: [{
                            uri: 'protokoll://transcripts?directory=/test',
                            mimeType: 'application/json',
                            text: JSON.stringify(mockResponse),
                        }],
                    },
                }),
            });

            await provider.refresh('/test');
            const dayItems = await provider.getChildren();
            const dayItem = dayItems.find(item => item.uri === 'day:2026-01-31');
            
            if (dayItem) {
                const transcriptItems = await provider.getChildren(dayItem);
                expect(transcriptItems.length).toBeGreaterThan(0);
                expect(transcriptItems[0].type).toBe('transcript');
            }
        });

        it('should filter transcripts by project', async () => {
            provider.setClient(mockClient);
            provider.setProjectFilter('project-1');
            
            // Mock response for the initial refresh() call from setProjectFilter
            const mockResponseAll: TranscriptsListResponse = {
                directory: '/test',
                transcripts: [
                    {
                        uri: 'protokoll://transcript/test1.md',
                        path: '/test/test1.md',
                        filename: 'test1.md',
                        date: '2026-01-31',
                        entities: {
                            projects: [{ id: 'project-1', name: 'Project 1' }],
                        },
                    },
                    {
                        uri: 'protokoll://transcript/test2.md',
                        path: '/test/test2.md',
                        filename: 'test2.md',
                        date: '2026-01-31',
                        entities: {
                            projects: [{ id: 'project-2', name: 'Project 2' }],
                        },
                    },
                ],
                pagination: {
                    total: 2,
                    limit: 100,
                    offset: 0,
                    hasMore: false,
                },
                filters: {},
            };

            // Mock response for the filtered refresh('/test') call - server should filter by projectId
            const mockResponseFiltered: TranscriptsListResponse = {
                directory: '/test',
                transcripts: [
                    {
                        uri: 'protokoll://transcript/test1.md',
                        path: '/test/test1.md',
                        filename: 'test1.md',
                        date: '2026-01-31',
                        entities: {
                            projects: [{ id: 'project-1', name: 'Project 1' }],
                        },
                    },
                ],
                pagination: {
                    total: 1,
                    limit: 100,
                    offset: 0,
                    hasMore: false,
                },
                filters: {},
            };

            // Mock for listResources call (if refresh tries to discover directory)
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        resources: [],
                    },
                }),
            });

            // First call from setProjectFilter's refresh() - may not have directory, so might not call listTranscripts
            // But if it does, it should return filtered results since filter is set
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        contents: [{
                            uri: 'protokoll://transcripts?directory=/test',
                            mimeType: 'application/json',
                            text: JSON.stringify(mockResponseFiltered),
                        }],
                    },
                }),
            });

            // Second call from refresh('/test') with project filter - server should return filtered results
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        contents: [{
                            uri: 'protokoll://transcripts?directory=/test',
                            mimeType: 'application/json',
                            text: JSON.stringify(mockResponseFiltered),
                        }],
                    },
                }),
            });

            await provider.refresh('/test');
            const yearItems = await provider.getChildren();
            const yearItem = yearItems.find(item => item.uri === 'year:2026');
            
            if (yearItem) {
                const monthItems = await provider.getChildren(yearItem);
                if (monthItems.length > 0) {
                    const transcriptItems = await provider.getChildren(monthItems[0]);
                    // Should only show transcripts for project-1
                    expect(transcriptItems.length).toBe(1);
                }
            }
        });
    });
});

describe('TranscriptItem', () => {
    it('should create year item', () => {
        const item = new TranscriptItem(
            '2026',
            'year-uri',
            vscode.TreeItemCollapsibleState.Expanded,
            undefined,
            undefined,
            'year',
            '2026'
        );

        expect(item.label).toBe('2026');
        expect(item.type).toBe('year');
        expect(item.uri).toBe('year-uri');
        expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
    });

    it('should create month item', () => {
        const item = new TranscriptItem(
            'January',
            'month-uri',
            vscode.TreeItemCollapsibleState.Collapsed,
            undefined,
            undefined,
            'month',
            '2026',
            '1'
        );

        expect(item.label).toBe('January');
        expect(item.type).toBe('month');
        expect(item.year).toBe('2026');
        expect(item.month).toBe('1');
    });

    it('should create transcript item', () => {
        const transcript: Transcript = {
            uri: 'protokoll://transcript/test.md',
            path: '/path/to/test.md',
            filename: 'test.md',
            date: '2026-01-31',
            title: 'Test Transcript',
        };

        const item = new TranscriptItem(
            'Test Transcript',
            'protokoll://transcript/test.md',
            vscode.TreeItemCollapsibleState.None,
            undefined,
            transcript,
            'transcript'
        );

        expect(item.label).toBe('Test Transcript');
        expect(item.type).toBe('transcript');
        expect(item.transcript).toBe(transcript);
    });

    it('should set icon for transcript item', () => {
        const transcript: Transcript = {
            uri: 'protokoll://transcript/test.md',
            path: '/path/to/test.md',
            filename: 'test.md',
            date: '2026-01-31',
        };

        const item = new TranscriptItem(
            'Test',
            'protokoll://transcript/test.md',
            vscode.TreeItemCollapsibleState.None,
            undefined,
            transcript,
            'transcript'
        );

        expect(item.iconPath).toBeDefined();
    });
});
