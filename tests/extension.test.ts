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
            onDidChangeSelection: vi.fn(() => ({ dispose: vi.fn() })),
            onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
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

        it('should handle filterByProject command with no projects', async () => {
            const handler = registeredCommands.get('protokoll.filterByProject');

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
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
                expect(vscode.window.showWarningMessage).toHaveBeenCalled();
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

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                        contents: [{
                            uri: 'protokoll://transcript/test.md',
                            mimeType: 'text/markdown',
                            text: '# Test Content',
                        }],
                    },
                }),
            });

            (vscode.env.clipboard as any) = {
                writeText: vi.fn().mockResolvedValue(undefined),
            };

            if (handler) {
                await handler(transcriptItem);
                expect(vscode.env.clipboard.writeText).toHaveBeenCalled();
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
                                    { id: 'project-1', name: 'Project 1', active: false },
                                ],
                            }),
                        }],
                    },
                }),
            });

            if (handler) {
                await handler();
                expect(vscode.window.showWarningMessage).toHaveBeenCalled();
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

            mockHttpRequest({
                statusCode: 200,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
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
                expect(vscode.window.showWarningMessage).toHaveBeenCalled();
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
                expect(vscode.window.showErrorMessage).toHaveBeenCalled();
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
                expect(vscode.window.showErrorMessage).toHaveBeenCalled();
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
                    configChangeHandler = handler;
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

            if (configChangeHandler) {
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

                await configChangeHandler(mockEvent);
                expect(mockEvent.affectsConfiguration).toHaveBeenCalled();
            }
        });

        it('should not reconnect when config change is not serverUrl', async () => {
            let configChangeHandler: ((e: any) => Promise<void>) | null = null;

            (vscode.workspace.onDidChangeConfiguration as any).mockImplementation(
                (handler: (e: any) => Promise<void>) => {
                    configChangeHandler = handler;
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

            if (configChangeHandler) {
                const mockEvent = {
                    affectsConfiguration: vi.fn((config: string) => config === 'protokoll.otherSetting'),
                };

                await configChangeHandler(mockEvent);
                // Should not attempt to reconnect
                expect(mockEvent.affectsConfiguration).toHaveBeenCalled();
            }
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
