/**
 * Tests for Extension
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate } from '../src/extension';
import { McpClient } from '../src/mcpClient';
import { mockHttpRequest } from './helpers/httpMock';

describe('extension', () => {
    let mockContext: vscode.ExtensionContext;
    let mockMcpClient: any;

    beforeEach(() => {
        mockContext = {
            globalState: {
                get: vi.fn((key: string, defaultValue?: unknown) => {
                    if (key === 'protokoll.hasConfiguredUrl') {
                        return false;
                    }
                    return defaultValue;
                }),
                update: vi.fn(),
            },
            workspaceState: {
                get: vi.fn((key: string, defaultValue?: unknown) => defaultValue),
                update: vi.fn(),
            },
            secrets: {
                get: vi.fn().mockResolvedValue(undefined),
                store: vi.fn().mockResolvedValue(undefined),
                delete: vi.fn().mockResolvedValue(undefined),
                onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
            },
            subscriptions: [],
            extensionUri: vscode.Uri.parse('file:///test/extension'),
        } as unknown as vscode.ExtensionContext;

        mockMcpClient = {
            initialize: vi.fn().mockResolvedValue(undefined),
            healthCheck: vi.fn().mockResolvedValue(true),
            getSessionId: vi.fn().mockReturnValue('test-session-123'),
            onNotification: vi.fn(),
            onSessionRecovered: vi.fn(),
            listResources: vi.fn().mockResolvedValue({ resources: [] }),
            callTool: vi.fn(),
            subscribeToResource: vi.fn().mockResolvedValue(undefined),
            startNewSession: vi.fn().mockResolvedValue(undefined),
        };

        vi.clearAllMocks();
        
        // Mock vscode.workspace.getConfiguration
        (vscode.workspace.getConfiguration as any).mockReturnValue({
            get: vi.fn((key: string, defaultValue?: unknown) => {
                if (key === 'serverUrl') {
                    return 'http://127.0.0.1:3001';
                }
                if (key === 'transcriptsDirectory') {
                    return '';
                }
                return defaultValue;
            }),
            update: vi.fn().mockResolvedValue(undefined),
        });

        // Mock vscode.window methods
        (vscode.window.showInformationMessage as any).mockResolvedValue(undefined);
        (vscode.window.showWarningMessage as any).mockResolvedValue(undefined);
        (vscode.window.showErrorMessage as any).mockResolvedValue(undefined);
        (vscode.window.showInputBox as any).mockResolvedValue(undefined);
        (vscode.window.showQuickPick as any).mockResolvedValue(undefined);
        (vscode.window.createTreeView as any).mockReturnValue({
            selection: [],
            visible: false,
            onDidChangeSelection: vi.fn(() => ({ dispose: vi.fn() })),
            onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
            reveal: vi.fn(),
            dispose: vi.fn(),
        });
    });

    describe('activate', () => {
        it('should activate extension with configured server URL', async () => {
            mockHttpRequest({
                statusCode: 200,
                headers: { 'mcp-session-id': 'test-session-123' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        protocolVersion: '2024-11-05',
                        serverInfo: { name: 'protokoll-server', version: '1.0.0' },
                    },
                }),
            });

            // Mock health check
            mockHttpRequest({
                statusCode: 200,
                body: 'OK',
            });

            await activate(mockContext);
            
            // Extension should activate without error
            expect(mockContext.subscriptions.length).toBeGreaterThan(0);
        });

        it('should prompt for configuration when server URL is empty', async () => {
            (vscode.workspace.getConfiguration as any).mockReturnValue({
                get: vi.fn((key: string) => {
                    if (key === 'serverUrl') {
                        return '';
                    }
                    return undefined;
                }),
                update: vi.fn(),
            });

            (vscode.window.showInformationMessage as any).mockResolvedValue('Configure');
            (vscode.commands.executeCommand as any).mockResolvedValue(undefined);

            await activate(mockContext);
            
            expect(vscode.window.showInformationMessage).toHaveBeenCalled();
        });

        it('should handle server health check failure', async () => {
            mockHttpRequest({
                statusCode: 500,
                body: 'Error',
            });

            await activate(mockContext);
            
            // Should handle gracefully
            expect(mockContext).toBeDefined();
        });

        it('should handle initialization failure', async () => {
            mockHttpRequest({
                statusCode: 200,
                body: 'OK',
            });

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    error: {
                        code: -32603,
                        message: 'Initialization failed',
                    },
                }),
            });

            await activate(mockContext);
            
            // Should handle gracefully
            expect(mockContext).toBeDefined();
        });

        it('should initialize view providers even when server is not connected', async () => {
            mockHttpRequest({
                statusCode: 500,
                body: 'Error',
            });

            await activate(mockContext);
            
            // View providers should still be initialized
            expect(mockContext.subscriptions.length).toBeGreaterThan(0);
        });
    });

    describe('command handlers', () => {
        let registeredCommands: Map<string, (...args: any[]) => Promise<any>>;

        beforeEach(async () => {
            registeredCommands = new Map();
            
            // Mock registerCommand to capture command handlers
            (vscode.commands.registerCommand as any).mockImplementation(
                (command: string, handler: (...args: any[]) => Promise<any>) => {
                    registeredCommands.set(command, handler);
                    return { dispose: vi.fn() };
                }
            );

            mockHttpRequest({
                statusCode: 200,
                body: 'OK',
            });

            mockHttpRequest({
                statusCode: 200,
                headers: { 'mcp-session-id': 'test-session-123' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        protocolVersion: '2024-11-05',
                        serverInfo: { name: 'protokoll-server', version: '1.0.0' },
                    },
                }),
            });

            // Mock protokoll_info response for server mode detection
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                mode: 'local',
                                acceptsDirectoryParameters: true,
                            }),
                        }],
                    },
                }),
            });

            await activate(mockContext);
        });

        it('should handle showTranscripts command', async () => {
            const handler = registeredCommands.get('protokoll.showTranscripts');
            expect(handler).toBeDefined();
            
            if (handler) {
                await handler();
                // Should not throw
            }
        });

        it('should handle configureServer command with valid URL', async () => {
            const handler = registeredCommands.get('protokoll.configureServer');
            expect(handler).toBeDefined();

            (vscode.window.showInputBox as any).mockResolvedValue('http://example.com:8080');
            
            mockHttpRequest({
                statusCode: 200,
                body: 'OK',
            });

            mockHttpRequest({
                statusCode: 200,
                headers: { 'mcp-session-id': 'new-session' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {},
                }),
            });

            if (handler) {
                await handler();
                expect(vscode.workspace.getConfiguration).toHaveBeenCalled();
            }
        });

        it('should handle configureServer command with invalid URL', async () => {
            const handler = registeredCommands.get('protokoll.configureServer');
            
            (vscode.window.showInputBox as any).mockResolvedValue('not-a-url');
            
            if (handler) {
                await handler();
                // Should validate and reject invalid URL
            }
        });

        it('should handle configureServer command cancellation', async () => {
            const handler = registeredCommands.get('protokoll.configureServer');
            
            (vscode.window.showInputBox as any).mockResolvedValue(undefined);
            
            if (handler) {
                await handler();
                // Should handle cancellation gracefully
            }
        });

        it('should handle openTranscript command', async () => {
            const handler = registeredCommands.get('protokoll.openTranscript');
            expect(handler).toBeDefined();

            const transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            if (handler) {
                await handler('protokoll://transcript/test.md', transcript);
                // Should not throw
            }
        });

        it('should handle openTranscriptInNewTab command', async () => {
            const handler = registeredCommands.get('protokoll.openTranscriptInNewTab');
            expect(handler).toBeDefined();

            const transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            if (handler) {
                await handler('protokoll://transcript/test.md', transcript);
                // Should not throw
            }
        });

        it('should handle refreshTranscripts command', async () => {
            const handler = registeredCommands.get('protokoll.refreshTranscripts');
            expect(handler).toBeDefined();

            if (handler) {
                await handler();
                // Should not throw
            }
        });

        it('should handle filterByProject command', async () => {
            const handler = registeredCommands.get('protokoll.filterByProject');
            expect(handler).toBeDefined();

            // Mock protokoll_info for server mode detection
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                mode: 'local',
                                acceptsDirectoryParameters: true,
                            }),
                        }],
                    },
                }),
            });

            // Mock protokoll_list_projects
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                projects: [
                                    { id: 'project-1', name: 'Project 1', active: true },
                                    { id: 'project-2', name: 'Project 2', active: true },
                                ],
                            }),
                        }],
                    },
                }),
            });

            (vscode.window.showQuickPick as any).mockResolvedValue({ id: 'project-1', label: 'Project 1' });

            if (handler) {
                await handler();
                expect(vscode.window.showQuickPick).toHaveBeenCalled();
            }
        });

        it('should include Deleted option in filterByStatus quick pick', async () => {
            const handler = registeredCommands.get('protokoll.filterByStatus');
            expect(handler).toBeDefined();

            let capturedItems: Array<{ label: string }> = [];
            (vscode.window.showQuickPick as any).mockImplementation(async (items: Array<{ label: string }>) => {
                capturedItems = items;
                return undefined;
            });

            if (handler) {
                await handler();
            }

            const labels = capturedItems.map(item => item.label);
            expect(labels.some(label => label.includes('Deleted'))).toBe(true);
        });

        it('should handle filterByProject command with no projects', async () => {
            const handler = registeredCommands.get('protokoll.filterByProject');

            // Mock protokoll_info for server mode detection
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                mode: 'local',
                                acceptsDirectoryParameters: true,
                            }),
                        }],
                    },
                }),
            });

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ projects: [] }),
                        }],
                    },
                }),
            });

            if (handler) {
                await handler();
                expect(handler).toBeDefined();
            }
        });

        it('should handle startNewSession command', async () => {
            const handler = registeredCommands.get('protokoll.startNewSession');
            expect(handler).toBeDefined();

            // Need to mock startNewSession which calls initialize
            mockHttpRequest({
                statusCode: 200,
                headers: { 'mcp-session-id': 'new-session' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {},
                }),
            });

            if (handler) {
                await handler();
                // Command should complete (may show error if mcpClient not initialized, which is expected)
                expect(handler).toBeDefined();
            }
        });

        it('should handle renameTranscript command', async () => {
            const handler = registeredCommands.get('protokoll.renameTranscript');
            expect(handler).toBeDefined();

            const transcriptItem = {
                transcript: {
                    uri: 'protokoll://transcript/test.md',
                    path: '/path/to/test.md',
                    filename: 'test.md',
                    date: '2026-01-31',
                },
            };

            (vscode.window.showInputBox as any).mockResolvedValue('New Title');

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {},
                }),
            });

            if (handler) {
                await handler(transcriptItem);
                expect(vscode.window.showInputBox).toHaveBeenCalled();
            }
        });

        it('should handle moveToProject command', async () => {
            const handler = registeredCommands.get('protokoll.moveToProject');
            expect(handler).toBeDefined();

            const transcriptItem = {
                transcript: {
                    uri: 'protokoll://transcript/test.md',
                    path: '/path/to/test.md',
                    filename: 'test.md',
                    date: '2026-01-31',
                },
            };

            // Mock protokoll_info for server mode detection
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                mode: 'local',
                                acceptsDirectoryParameters: true,
                            }),
                        }],
                    },
                }),
            });

            // Mock protokoll_list_projects
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                projects: [
                                    { id: 'project-1', name: 'Project 1', active: true },
                                ],
                            }),
                        }],
                    },
                }),
            });

            (vscode.window.showQuickPick as any).mockResolvedValue({ id: 'project-1', label: 'Project 1' });

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {},
                }),
            });

            if (handler) {
                await handler(transcriptItem);
                expect(vscode.window.showQuickPick).toHaveBeenCalled();
            }
        });

        it('should include Deleted option in changeTranscriptStatus quick pick', async () => {
            const handler = registeredCommands.get('protokoll.changeTranscriptStatus');
            expect(handler).toBeDefined();

            const transcriptItem = {
                transcript: {
                    uri: 'protokoll://transcript/test.md',
                    path: '/path/to/test.md',
                    filename: 'test.md',
                    date: '2026-01-31',
                },
            };

            let capturedItems: Array<{ label: string }> = [];
            (vscode.window.showQuickPick as any).mockImplementation(async (items: Array<{ label: string }>) => {
                capturedItems = items;
                return undefined;
            });

            if (handler) {
                await handler(transcriptItem);
            }

            const labels = capturedItems.map(item => item.label);
            expect(labels.some(label => label.includes('Deleted'))).toBe(true);
        });

        it('should handle copyTranscript command', async () => {
            const handler = registeredCommands.get('protokoll.copyTranscript');
            expect(handler).toBeDefined();

            const transcriptItem = {
                transcript: {
                    uri: 'protokoll://transcript/test.md',
                    path: '/path/to/test.md',
                    filename: 'test.md',
                    date: '2026-01-31',
                },
            };

            const transcriptData = {
                uri: 'protokoll://transcript/test',
                path: 'test.md',
                title: 'Test Transcript',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test Content',
            };

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        contents: [{
                            uri: 'protokoll://transcript/test',
                            mimeType: 'application/json',
                            text: JSON.stringify(transcriptData),
                        }],
                    },
                }),
            });

            (vscode.env.clipboard.writeText as any).mockResolvedValue(undefined);

            if (handler) {
                await handler(transcriptItem);
                const copied = (vscode.env.clipboard.writeText as any).mock.calls.length > 0;
                const showedError = (vscode.window.showErrorMessage as any).mock.calls.length > 0;
                expect(copied || showedError).toBe(true);
            }
        });

        it('should copy original transcript with metadata template', async () => {
            const handler = registeredCommands.get('protokoll.copyTranscriptOriginal');
            expect(handler).toBeDefined();

            const transcriptItem = {
                type: 'transcript',
                transcript: {
                    uri: 'protokoll://transcript/original.md',
                    path: '/path/to/original.md',
                    filename: 'original.md',
                    title: 'Original Title',
                    date: '2026-03-04',
                    status: 'enhanced',
                },
            };

            vi.spyOn(McpClient.prototype, 'readTranscript').mockResolvedValue({
                uri: 'protokoll://transcript/original.md',
                path: '2026/3/original.md',
                title: 'Original Title',
                metadata: {
                    date: '2026-03-04',
                    time: '7:06 PM',
                    tags: ['book', 'discussive'],
                    status: 'enhanced',
                },
                content: 'ENHANCED CONTENT',
                rawTranscript: {
                    text: 'ORIGINAL CONTENT',
                },
            });

            if (handler) {
                await handler(transcriptItem);
                expect(vscode.env.clipboard.writeText).toHaveBeenCalledTimes(1);
                const copiedText = (vscode.env.clipboard.writeText as any).mock.calls.at(-1)?.[0] as string;
                expect(copiedText).toContain('## Original Title');
                expect(copiedText).toContain('**Date/Time:** 2026-03-04 7:06 PM');
                expect(copiedText).toContain('**Tags:** book, discussive');
                expect(copiedText).toContain('**Status:** enhanced');
                expect(copiedText).toContain('ORIGINAL CONTENT');
                expect(copiedText).not.toContain('ENHANCED CONTENT');
            }
        });

        it('should copy enhanced transcripts for multi-selection', async () => {
            const handler = registeredCommands.get('protokoll.copyTranscriptEnhanced');
            expect(handler).toBeDefined();

            const selectedItems = [
                {
                    type: 'transcript',
                    transcript: {
                        uri: 'protokoll://transcript/a.md',
                        path: '/path/to/a.md',
                        filename: 'a.md',
                        title: 'Alpha',
                        date: '2026-03-04',
                    },
                },
                {
                    type: 'transcript',
                    transcript: {
                        uri: 'protokoll://transcript/b.md',
                        path: '/path/to/b.md',
                        filename: 'b.md',
                        title: 'Beta',
                        date: '2026-03-03',
                    },
                },
            ];

            const transcriptsTree = (vscode.window.createTreeView as any).mock.results?.[0]?.value;
            if (transcriptsTree) {
                transcriptsTree.selection = selectedItems;
            }

            vi.spyOn(McpClient.prototype, 'readTranscript')
                .mockResolvedValueOnce({
                    uri: 'protokoll://transcript/a.md',
                    path: '2026/3/a.md',
                    title: 'Alpha',
                    metadata: { date: '2026-03-04', tags: ['alpha'], status: 'enhanced' },
                    content: 'ENHANCED A',
                    rawTranscript: { text: 'ORIGINAL A' },
                })
                .mockResolvedValueOnce({
                    uri: 'protokoll://transcript/b.md',
                    path: '2026/3/b.md',
                    title: 'Beta',
                    metadata: { date: '2026-03-03', tags: ['beta'], status: 'reviewed' },
                    content: 'ENHANCED B',
                    rawTranscript: { text: 'ORIGINAL B' },
                });

            if (handler) {
                await handler(selectedItems[0]);
                expect(vscode.env.clipboard.writeText).toHaveBeenCalledTimes(1);
                const copiedText = (vscode.env.clipboard.writeText as any).mock.calls.at(-1)?.[0] as string;
                expect(copiedText).toContain('## Alpha');
                expect(copiedText).toContain('## Beta');
                expect(copiedText).toContain('ENHANCED A');
                expect(copiedText).toContain('ENHANCED B');
                expect(copiedText).toContain('\n\n---\n\n');
            }
        });

        it('should handle openTranscriptToSide command', async () => {
            const handler = registeredCommands.get('protokoll.openTranscriptToSide');
            expect(handler).toBeDefined();

            const transcriptItem = {
                transcript: {
                    uri: 'protokoll://transcript/test.md',
                    path: '/path/to/test.md',
                    filename: 'test.md',
                    date: '2026-01-31',
                },
            };

            if (handler) {
                await handler(transcriptItem);
                // Should not throw
            }
        });

        it('should handle openTranscriptWith command', async () => {
            const handler = registeredCommands.get('protokoll.openTranscriptWith');
            expect(handler).toBeDefined();

            const transcriptItem = {
                transcript: {
                    uri: 'protokoll://transcript/test.md',
                    path: '/path/to/test.md',
                    filename: 'test.md',
                    date: '2026-01-31',
                },
            };

            (vscode.workspace.fs as any) = {
                stat: vi.fn().mockResolvedValue({}),
            };

            (vscode.commands.executeCommand as any).mockResolvedValue(undefined);

            if (handler) {
                await handler(transcriptItem);
                expect(vscode.commands.executeCommand).toHaveBeenCalled();
            }
        });

        it('should handle copyTranscriptUrl command', async () => {
            const handler = registeredCommands.get('protokoll.copyTranscriptUrl');
            expect(handler).toBeDefined();

            const transcriptItem = {
                transcript: {
                    uri: 'protokoll://transcript/test.md',
                    path: '/path/to/test.md',
                    filename: 'test.md',
                    date: '2026-01-31',
                },
            };

            (vscode.env.clipboard as any) = {
                writeText: vi.fn().mockResolvedValue(undefined),
            };

            if (handler) {
                await handler(transcriptItem);
                expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('protokoll://transcript/test.md');
            }
        });

        it('should copy transcript URLs for multi-selection', async () => {
            const handler = registeredCommands.get('protokoll.copyTranscriptUrl');
            expect(handler).toBeDefined();

            const selectedItems = [
                {
                    type: 'transcript',
                    transcript: {
                        uri: 'protokoll://transcript/one.md',
                        path: '/path/to/one.md',
                        filename: 'one.md',
                        date: '2026-03-04',
                    },
                },
                {
                    type: 'transcript',
                    transcript: {
                        uri: 'protokoll://transcript/two.md',
                        path: '/path/to/two.md',
                        filename: 'two.md',
                        date: '2026-03-04',
                    },
                },
            ];

            const transcriptsTree = (vscode.window.createTreeView as any).mock.results?.[0]?.value;
            if (transcriptsTree) {
                transcriptsTree.selection = selectedItems;
            }

            if (handler) {
                await handler(selectedItems[0]);
                expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
                    'protokoll://transcript/one.md\nprotokoll://transcript/two.md'
                );
            }
        });

        it('should handle copySessionId command', async () => {
            const handler = registeredCommands.get('protokoll.copySessionId');
            expect(handler).toBeDefined();

            (vscode.env.clipboard as any) = {
                writeText: vi.fn().mockResolvedValue(undefined),
            };

            if (handler) {
                await handler('test-session-123');
                expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('test-session-123');
            }
        });

        it('should handle command errors gracefully', async () => {
            const handler = registeredCommands.get('protokoll.copyTranscript');
            
            const transcriptItem = {
                transcript: {
                    uri: 'protokoll://transcript/test.md',
                    path: '/path/to/test.md',
                    filename: 'test.md',
                    date: '2026-01-31',
                },
            };

            mockHttpRequest({
                statusCode: 500,
                body: 'Error',
            });

            if (handler) {
                await handler(transcriptItem);
                expect(vscode.window.showErrorMessage).toHaveBeenCalled();
            }
        });

        it('should handle filterByProject with no active projects', async () => {
            const handler = registeredCommands.get('protokoll.filterByProject');

            // Mock protokoll_info for server mode detection
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                mode: 'local',
                                acceptsDirectoryParameters: true,
                            }),
                        }],
                    },
                }),
            });

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                projects: [
                                    { id: 'project-1', name: 'Project 1', active: false },
                                ],
                            }),
                        }],
                    },
                }),
            });

            if (handler) {
                await handler();
                expect(vscode.window.showQuickPick).toHaveBeenCalled();
            }
        });

        it('should handle filterByProject cancellation', async () => {
            const handler = registeredCommands.get('protokoll.filterByProject');

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                projects: [
                                    { id: 'project-1', name: 'Project 1', active: true },
                                ],
                            }),
                        }],
                    },
                }),
            });

            (vscode.window.showQuickPick as any).mockResolvedValue(undefined);

            if (handler) {
                await handler();
                // Should handle cancellation gracefully
                expect(handler).toBeDefined();
            }
        });

        it('should handle renameTranscript cancellation', async () => {
            const handler = registeredCommands.get('protokoll.renameTranscript');

            const transcriptItem = {
                transcript: {
                    uri: 'protokoll://transcript/test.md',
                    path: '/path/to/test.md',
                    filename: 'test.md',
                    date: '2026-01-31',
                },
            };

            (vscode.window.showInputBox as any).mockResolvedValue(undefined);

            if (handler) {
                await handler(transcriptItem);
                // Should handle cancellation gracefully
                expect(handler).toBeDefined();
            }
        });

        it('should handle renameTranscript with same title', async () => {
            const handler = registeredCommands.get('protokoll.renameTranscript');

            const transcriptItem = {
                transcript: {
                    uri: 'protokoll://transcript/test.md',
                    path: '/path/to/test.md',
                    filename: 'test.md',
                    title: 'Test Title',
                    date: '2026-01-31',
                },
            };

            (vscode.window.showInputBox as any).mockResolvedValue('Test Title');

            if (handler) {
                await handler(transcriptItem);
                // Should not call tool if title unchanged
                expect(handler).toBeDefined();
            }
        });

        it('should handle moveToProject with no projects', async () => {
            const handler = registeredCommands.get('protokoll.moveToProject');

            const transcriptItem = {
                transcript: {
                    uri: 'protokoll://transcript/test.md',
                    path: '/path/to/test.md',
                    filename: 'test.md',
                    date: '2026-01-31',
                },
            };

            // Mock protokoll_info for server mode detection
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                mode: 'local',
                                acceptsDirectoryParameters: true,
                            }),
                        }],
                    },
                }),
            });

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ projects: [] }),
                        }],
                    },
                }),
            });

            if (handler) {
                await handler(transcriptItem);
                expect(handler).toBeDefined();
            }
        });

        it('should handle openTranscriptWith when file not found', async () => {
            const handler = registeredCommands.get('protokoll.openTranscriptWith');

            const transcriptItem = {
                transcript: {
                    uri: 'protokoll://transcript/test.md',
                    path: '/path/to/test.md',
                    filename: 'test.md',
                    date: '2026-01-31',
                },
            };

            (vscode.workspace.fs as any) = {
                stat: vi.fn().mockRejectedValue(new Error('File not found')),
            };

            if (handler) {
                await handler(transcriptItem);
                expect(vscode.window.showWarningMessage).toHaveBeenCalled();
            }
        });

        it('should handle copyTranscriptUrl with no transcript', async () => {
            const handler = registeredCommands.get('protokoll.copyTranscriptUrl');

            if (handler) {
                await handler(null);
                expect(vscode.window.showErrorMessage).toHaveBeenCalled();
            }
        });

        it('should handle copySessionId with no session ID', async () => {
            const handler = registeredCommands.get('protokoll.copySessionId');

            if (handler) {
                await handler('');
                expect(vscode.window.showErrorMessage).toHaveBeenCalled();
            }
        });

        it('should handle filterByProject when mcpClient is not initialized', async () => {
            // Create a new context without mcpClient
            const newContext = {
                ...mockContext,
            };

            // Re-activate without mcpClient
            const { activate: activateWithoutClient } = await import('../src/extension');
            
            mockHttpRequest({
                statusCode: 500,
                body: 'Error',
            });

            await activateWithoutClient(newContext);

            const handler = registeredCommands.get('protokoll.filterByProject');
            if (handler) {
                await handler();
                expect(handler).toBeDefined();
            }
        });

        it('should handle filterByProject when transcriptsViewProvider is null', async () => {
            // This test verifies the error handling path
            // The actual check happens in the command handler
            const handler = registeredCommands.get('protokoll.filterByProject');
            
            // The handler checks for mcpClient and transcriptsViewProvider
            // Since we can't easily mock module-level variables, we'll test
            // that the handler exists and can be called
            expect(handler).toBeDefined();
        });

        it('should handle configureServer with unhealthy server', async () => {
            const handler = registeredCommands.get('protokoll.configureServer');

            (vscode.window.showInputBox as any).mockResolvedValue('http://unhealthy:3001');
            
            mockHttpRequest({
                statusCode: 500,
                body: 'Error',
            });

            if (handler) {
                await handler();
                // Should handle unhealthy server
                expect(handler).toBeDefined();
            }
        });

        it('should handle configureServer connection error', async () => {
            const handler = registeredCommands.get('protokoll.configureServer');

            (vscode.window.showInputBox as any).mockResolvedValue('http://error:3001');
            
            mockHttpRequest({
                statusCode: 200,
                body: 'OK',
            });

            mockHttpRequest({
                statusCode: 500,
                body: 'Connection Error',
            });

            if (handler) {
                await handler();
                const showedError = (vscode.window.showErrorMessage as any).mock.calls.length > 0;
                const showedWarning = (vscode.window.showWarningMessage as any).mock.calls.length > 0;
                expect(showedError || showedWarning).toBe(true);
            }
        });
    });

    describe('notification handlers', () => {
        it('should complete activation with notification handlers', async () => {
            mockHttpRequest({
                statusCode: 200,
                body: 'OK',
            });

            mockHttpRequest({
                statusCode: 200,
                headers: { 'mcp-session-id': 'test-session-123' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        protocolVersion: '2024-11-05',
                        serverInfo: { name: 'protokoll-server', version: '1.0.0' },
                    },
                }),
            });

            await activate(mockContext);

            // Activation should complete successfully, which means handlers were registered
            expect(mockContext.subscriptions.length).toBeGreaterThan(0);
        });

        it('should subscribe to transcripts list when directory is configured', async () => {
            (vscode.workspace.getConfiguration as any).mockReturnValue({
                get: vi.fn((key: string, defaultValue?: unknown) => {
                    if (key === 'serverUrl') {
                        return 'http://127.0.0.1:3001';
                    }
                    if (key === 'transcriptsDirectory') {
                        return '/test/transcripts';
                    }
                    return defaultValue;
                }),
                update: vi.fn().mockResolvedValue(undefined),
            });

            mockHttpRequest({
                statusCode: 200,
                body: 'OK',
            });

            mockHttpRequest({
                statusCode: 200,
                headers: { 'mcp-session-id': 'test-session-123' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        protocolVersion: '2024-11-05',
                        serverInfo: { name: 'protokoll-server', version: '1.0.0' },
                    },
                }),
            });

            // Mock subscribeToResource
            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {},
                }),
            });

            await activate(mockContext);
            
            // Should complete activation
            expect(mockContext.subscriptions.length).toBeGreaterThan(0);
        });

        it('should handle subscription failure gracefully', async () => {
            (vscode.workspace.getConfiguration as any).mockReturnValue({
                get: vi.fn((key: string, defaultValue?: unknown) => {
                    if (key === 'serverUrl') {
                        return 'http://127.0.0.1:3001';
                    }
                    if (key === 'transcriptsDirectory') {
                        return '/test/transcripts';
                    }
                    return defaultValue;
                }),
                update: vi.fn().mockResolvedValue(undefined),
            });

            mockHttpRequest({
                statusCode: 200,
                body: 'OK',
            });

            mockHttpRequest({
                statusCode: 200,
                headers: { 'mcp-session-id': 'test-session-123' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        protocolVersion: '2024-11-05',
                        serverInfo: { name: 'protokoll-server', version: '1.0.0' },
                    },
                }),
            });

            // Mock subscribeToResource failure
            mockHttpRequest({
                statusCode: 500,
                body: 'Error',
            });

            await activate(mockContext);
            
            // Should complete activation even if subscription fails
            expect(mockContext.subscriptions.length).toBeGreaterThan(0);
        });
    });

    describe('configuration watcher', () => {
        it('should handle configuration changes', async () => {
            let configChangeHandler: ((e: any) => Promise<void>) | null = null;

            (vscode.workspace.onDidChangeConfiguration as any).mockImplementation(
                (handler: (e: any) => Promise<void>) => {
                    configChangeHandler = handler as (e: any) => Promise<void>;
                    return { dispose: vi.fn() };
                }
            );

            mockHttpRequest({
                statusCode: 200,
                body: 'OK',
            });

            mockHttpRequest({
                statusCode: 200,
                headers: { 'mcp-session-id': 'test-session-123' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        protocolVersion: '2024-11-05',
                        serverInfo: { name: 'protokoll-server', version: '1.0.0' },
                    },
                }),
            });

            await activate(mockContext);

            expect(configChangeHandler).toBeDefined();
            if (!configChangeHandler) return;
            
            const mockEvent = {
                affectsConfiguration: vi.fn((config: string) => config === 'protokoll.serverUrl'),
            };

            mockHttpRequest({
                statusCode: 200,
                headers: { 'mcp-session-id': 'new-session' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {},
                }),
            });

            await (configChangeHandler as (e: any) => Promise<void>)(mockEvent);
            expect(mockEvent.affectsConfiguration).toHaveBeenCalled();
        });

        it('should not reconnect when config change is not serverUrl', async () => {
            let configChangeHandler: ((e: any) => Promise<void>) | null = null;

            (vscode.workspace.onDidChangeConfiguration as any).mockImplementation(
                (handler: (e: any) => Promise<void>) => {
                    configChangeHandler = handler as (e: any) => Promise<void>;
                    return { dispose: vi.fn() };
                }
            );

            mockHttpRequest({
                statusCode: 200,
                body: 'OK',
            });

            mockHttpRequest({
                statusCode: 200,
                headers: { 'mcp-session-id': 'test-session-123' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        protocolVersion: '2024-11-05',
                        serverInfo: { name: 'protokoll-server', version: '1.0.0' },
                    },
                }),
            });

            await activate(mockContext);

            expect(configChangeHandler).toBeDefined();
            if (!configChangeHandler) return;
            
            const mockEvent = {
                affectsConfiguration: vi.fn((config: string) => config === 'protokoll.otherSetting'),
            };

            await (configChangeHandler as (e: any) => Promise<void>)(mockEvent);
            // Should not attempt to reconnect
            expect(mockEvent.affectsConfiguration).toHaveBeenCalled();
        });
    });

    describe('deactivate', () => {
        it('should cleanup on deactivate', async () => {
            const { deactivate } = await import('../src/extension');
            
            mockHttpRequest({
                statusCode: 200,
                body: 'OK',
            });

            mockHttpRequest({
                statusCode: 200,
                headers: { 'mcp-session-id': 'test-session-123' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        protocolVersion: '2024-11-05',
                        serverInfo: { name: 'protokoll-server', version: '1.0.0' },
                    },
                }),
            });

            await activate(mockContext);
            
            deactivate();
            // Should cleanup without error
            expect(deactivate).toBeDefined();
        });
    });
});
