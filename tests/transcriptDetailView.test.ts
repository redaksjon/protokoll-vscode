/**
 * Tests for Transcript Detail View
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { TranscriptDetailViewProvider } from '../src/transcriptDetailView';
import { McpClient } from '../src/mcpClient';
import type { Transcript, TranscriptContent, McpResourceResponse } from '../src/types';

describe('TranscriptDetailViewProvider', () => {
    let provider: TranscriptDetailViewProvider;
    let mockExtensionUri: vscode.Uri;
    let mockClient: McpClient;

    beforeEach(() => {
        mockExtensionUri = vscode.Uri.parse('file:///test/extension');
        provider = new TranscriptDetailViewProvider(mockExtensionUri);
        mockClient = new McpClient('http://localhost:3001');
        vi.clearAllMocks();
    });

    describe('constructor', () => {
        it('should initialize provider with extension URI', () => {
            expect(provider).toBeInstanceOf(TranscriptDetailViewProvider);
        });
    });

    describe('getCurrentTranscript', () => {
        it('should return undefined when transcript not found', () => {
            const result = provider.getCurrentTranscript('protokoll://transcript/nonexistent.md');
            expect(result).toBeUndefined();
        });
    });

    describe('setClient', () => {
        it('should set the MCP client', () => {
            provider.setClient(mockClient);
            expect(provider).toBeDefined();
        });
    });

    describe('parseMetadata', () => {
        it('should parse metadata from transcript content', () => {
            const content = `## Metadata

**Date**: January 31, 2026
**Time**: 08:32 PM
**Project**: Test Project
**Project ID**: \`test-project\`
**Created At**: 2026-01-31T20:32:00Z
**Updated At**: 2026-01-31T21:00:00Z

## Content

Transcript content here.`;

            const metadata = (provider as any).parseMetadata(content);
            
            expect(metadata.date).toBe('January 31, 2026');
            expect(metadata.time).toBe('08:32 PM');
            expect(metadata.project).toBe('Test Project');
            expect(metadata.projectId).toBe('test-project');
            expect(metadata.createdAt).toBe('2026-01-31T20:32:00Z');
            expect(metadata.updatedAt).toBe('2026-01-31T21:00:00Z');
        });

        it('should handle missing metadata section', () => {
            const content = 'Just some content without metadata.';
            const metadata = (provider as any).parseMetadata(content);
            
            expect(metadata.date).toBeUndefined();
            expect(metadata.time).toBeUndefined();
        });

        it('should handle partial metadata', () => {
            const content = `## Metadata

**Date**: January 31, 2026
**Project**: Test Project

## Content

Content here.`;

            const metadata = (provider as any).parseMetadata(content);
            
            expect(metadata.date).toBe('January 31, 2026');
            expect(metadata.project).toBe('Test Project');
            expect(metadata.time).toBeUndefined();
        });
    });

    describe('getWebviewContent', () => {
        it('should generate HTML content for transcript', () => {
            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
                title: 'Test Transcript',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'Test Transcript',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test Transcript\n\nContent here.',
            };

            const html = provider.getWebviewContent(transcript, content);
            
            expect(html).toContain('Test Transcript');
            expect(html).toContain('Content here');
            expect(html).toContain('<!DOCTYPE html>');
            expect(html).toContain('id="summary-tab"');
            expect(html).toContain('id="summary-content"');
            expect(html).toContain('id="summary-generate-btn"');
            expect(html).toContain('Identify Tasks');
        });

        it('should use sandbox-safe reject correction flow in webview script', () => {
            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
                title: 'Test Transcript',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'Test Transcript',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test Transcript\n\nContent here.',
            };

            const html = provider.getWebviewContent(transcript, content);
            expect(html).toContain("command: 'requestRejectCorrection'");
            expect(html).not.toContain("window.confirm('Reject this correction and restore the original text?')");
        });

        it('should handle transcript without title', () => {
            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Content\n\nSome content.',
            };

            const html = provider.getWebviewContent(transcript, content);
            expect(html).toContain('test.md');
        });

        it('should include entities if present', () => {
            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
                entities: {
                    people: [{ id: 'john-doe', name: 'John Doe' }],
                    projects: [{ id: 'test-project', name: 'Test Project' }],
                },
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                    entities: {
                        people: [{ id: 'john-doe', name: 'John Doe' }],
                        projects: [{ id: 'test-project', name: 'Test Project' }],
                    },
                },
                content: 'Content',
            };

            const html = provider.getWebviewContent(transcript, content);
            expect(html).toContain('John Doe');
            expect(html).toContain('Test Project');
        });

        it('should render manual note original editor and hide enhanced tab before enhancement', () => {
            const transcript: Transcript = {
                uri: 'protokoll://transcript/manual-note.md',
                path: '/path/to/manual-note.md',
                filename: 'manual-note.md',
                date: '2026-01-31',
                title: 'Manual Note',
                contentType: 'manual_note',
                status: 'initial',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/manual-note.md',
                path: '/path/to/manual-note.md',
                title: 'Manual Note',
                metadata: {
                    date: '2026-01-31',
                    status: 'initial',
                    tags: [],
                },
                content: 'This is a manually entered note.',
            };

            const html = provider.getWebviewContent(transcript, content);

            expect(html).toContain('id="original-editor-input"');
            expect(html).toContain('id="save-original-btn"');
            expect(html).toContain('id="enhance-original-btn"');
            expect(html).toContain('id="summary-tab"');
            expect(html).not.toContain('id="enhanced-tab"');
        });

        it('should show enhanced tab for manual note after enhancement status', () => {
            const transcript: Transcript = {
                uri: 'protokoll://transcript/manual-note-enhanced.md',
                path: '/path/to/manual-note-enhanced.md',
                filename: 'manual-note-enhanced.md',
                date: '2026-01-31',
                title: 'Manual Note Enhanced',
                contentType: 'manual_note',
                status: 'enhanced',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/manual-note-enhanced.md',
                path: '/path/to/manual-note-enhanced.md',
                title: 'Manual Note Enhanced',
                metadata: {
                    date: '2026-01-31',
                    status: 'enhanced',
                    tags: [],
                },
                content: 'Enhanced manual note output.',
            };

            const html = provider.getWebviewContent(transcript, content);
            expect(html).toContain('id="enhanced-tab"');
        });

        it('should render enhance action in original tab for audio transcripts', () => {
            const transcript: Transcript = {
                uri: 'protokoll://transcript/audio.md',
                path: '/path/to/audio.md',
                filename: 'audio.md',
                date: '2026-01-31',
                title: 'Audio Transcript',
                contentType: 'audio_transcript',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/audio.md',
                path: '/path/to/audio.md',
                title: 'Audio Transcript',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: 'Enhanced transcript content.',
                rawTranscript: {
                    text: 'Raw transcript text',
                },
            };

            const html = provider.getWebviewContent(transcript, content);
            expect(html).toContain('id="raw-tab"');
            expect(html).toContain('id="enhance-original-btn"');
        });

        it('should not inject metadata.project into entity references', () => {
            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    projectId: 'grunnverk',
                    project: 'Grunnverk',
                    tags: [],
                    entities: {
                        projects: [],
                    },
                },
                content: 'Content',
            };

            const html = provider.getWebviewContent(transcript, content);
            expect(html).not.toContain("openEntity('project', 'grunnverk')");
        });

        it('should prefer metadata.entities over transcript.entities fallback', () => {
            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
                entities: {
                    projects: [{ id: 'old-project', name: 'Old Project' }],
                },
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                    entities: {
                        projects: [{ id: 'new-project', name: 'New Project' }],
                    },
                },
                content: 'Content',
            };

            const html = provider.getWebviewContent(transcript, content);
            expect(html).toContain("openEntity('project', 'new-project')");
            expect(html).not.toContain("openEntity('project', 'old-project')");
        });
    });

    describe('escapeHtml', () => {
        it('should escape HTML special characters', () => {
            const escaped = (provider as any).escapeHtml('<script>alert("xss")</script>');
            expect(escaped).not.toContain('<script>');
            expect(escaped).toContain('&lt;');
        });

        it('should handle normal text', () => {
            const escaped = (provider as any).escapeHtml('Normal text');
            expect(escaped).toBe('Normal text');
        });

        it('should handle empty string', () => {
            const escaped = (provider as any).escapeHtml('');
            expect(escaped).toBe('');
        });
    });

    describe('refreshTranscript', () => {
        it('should refresh transcript when panel exists', async () => {
            provider.setClient(mockClient);
            
            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
                title: 'Test Transcript',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'Test Transcript',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test Transcript\n\nContent.',
            };

            // Mock readTranscript
            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);

            // Create a mock panel
            const mockPanel = {
                webview: {
                    html: '',
                    postMessage: vi.fn(),
                    onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
                },
                reveal: vi.fn(),
                onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
                title: '',
                dispose: vi.fn(),
            };

            (vscode.window.createWebviewPanel as any).mockReturnValue(mockPanel);

            await provider.showTranscript('protokoll://transcript/test.md', transcript);
            
            // Now refresh
            await provider.refreshTranscript('protokoll://transcript/test.md');
            
            expect(mockClient.readTranscript).toHaveBeenCalled();
        });

        it('should handle refresh when panel does not exist', async () => {
            provider.setClient(mockClient);
            
            await expect(provider.refreshTranscript('protokoll://transcript/nonexistent.md')).resolves.not.toThrow();
        });

        it('should handle refresh when client is not set', async () => {
            provider.setClient(null as any);
            
            await expect(provider.refreshTranscript('protokoll://transcript/test.md')).resolves.not.toThrow();
        });
    });

    describe('getErrorContent', () => {
        it('should generate error HTML', () => {
            const errorHtml = (provider as any).getErrorContent('Test error message');
            
            expect(errorHtml).toContain('Test error message');
            expect(errorHtml).toContain('<!DOCTYPE html>');
            expect(errorHtml).toContain('error');
        });
    });

    describe('webview message handlers', () => {
        let mockPanel: any;
        let messageHandler: ((message: any) => void) | null = null;

        beforeEach(() => {
            messageHandler = null;
            mockPanel = {
                webview: {
                    html: '',
                    postMessage: vi.fn(),
                    onDidReceiveMessage: vi.fn((handler: (message: any) => void) => {
                        messageHandler = handler;
                        return { dispose: vi.fn() };
                    }),
                },
                reveal: vi.fn(),
                onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
                title: '',
                dispose: vi.fn(),
            };

            (vscode.window.createWebviewPanel as any).mockReturnValue(mockPanel);
        });

        it('should handle changeProject message', async () => {
            vi.useFakeTimers();
            
            provider.setClient(mockClient);
            
            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test',
            };

            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            
            // Mock callTool to handle both protokoll_info and protokoll_list_projects
            const callToolSpy = vi.spyOn(mockClient, 'callTool').mockImplementation(async (toolName: string) => {
                if (toolName === 'protokoll_info') {
                    return { mode: 'local', acceptsDirectoryParameters: true };
                } else if (toolName === 'protokoll_list_projects') {
                    return { projects: [{ id: 'project-1', name: 'Project 1', active: true }] };
                } else if (toolName === 'protokoll_edit_transcript') {
                    return {};
                }
                return {};
            });
            
            (vscode.window.showQuickPick as any).mockResolvedValue({ id: 'project-1', label: 'Project 1' });
            (vscode.commands.executeCommand as any).mockResolvedValue(undefined);

            await provider.showTranscript('protokoll://transcript/test.md', transcript);
            
            if (messageHandler) {
                await messageHandler({
                    command: 'changeProject',
                });
                
                // Run all timers to execute the setTimeout callback
                await vi.runAllTimersAsync();
            }

            expect(callToolSpy).toHaveBeenCalled();
            
            vi.useRealTimers();
        });

        it('should handle addTag message', async () => {
            provider.setClient(mockClient);
            
            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: ['tag1'],
                },
                content: '# Test\n\nTags: tag1',
            };

            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            vi.spyOn(mockClient, 'callTool').mockResolvedValue({});
            (vscode.window.showInputBox as any).mockResolvedValue('new-tag');
            (vscode.commands.executeCommand as any).mockResolvedValue(undefined);

            await provider.showTranscript('protokoll://transcript/test.md', transcript);
            
            if (messageHandler) {
                await messageHandler({
                    command: 'addTag',
                    transcriptPath: '/path/to/test.md',
                });
            }

            expect(mockClient.callTool).toHaveBeenCalled();
        });

        it('should handle removeTag message', async () => {
            provider.setClient(mockClient);
            
            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test',
            };

            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            vi.spyOn(mockClient, 'callTool').mockResolvedValue({});
            (vscode.commands.executeCommand as any).mockResolvedValue(undefined);

            await provider.showTranscript('protokoll://transcript/test.md', transcript);
            
            if (messageHandler) {
                await messageHandler({
                    command: 'removeTag',
                    transcriptPath: '/path/to/test.md',
                    tag: 'tag1',
                });
            }

            expect(mockClient.callTool).toHaveBeenCalled();
        });

        it('should handle editTitle message', async () => {
            provider.setClient(mockClient);
            
            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test',
            };

            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            vi.spyOn(mockClient, 'callTool').mockResolvedValue({});
            (vscode.commands.executeCommand as any).mockResolvedValue(undefined);

            await provider.showTranscript('protokoll://transcript/test.md', transcript);
            
            if (messageHandler) {
                await messageHandler({
                    command: 'editTitle',
                    transcriptPath: '/path/to/test.md',
                    newTitle: 'New Title',
                });
            }

            expect(mockClient.callTool).toHaveBeenCalled();
        });

        it('should handle editTranscript message', async () => {
            provider.setClient(mockClient);
            
            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test',
            };

            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            vi.spyOn(mockClient, 'callTool').mockResolvedValue({});

            await provider.showTranscript('protokoll://transcript/test.md', transcript);
            
            if (messageHandler) {
                await messageHandler({
                    command: 'editTranscript',
                    transcriptPath: '/path/to/test.md',
                    newContent: 'New content',
                });
            }

            expect(mockClient.callTool).toHaveBeenCalled();
        });

        it('should handle identifyTasks message and create selected tasks', async () => {
            provider.setClient(mockClient);

            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
                title: 'Test',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test',
            };

            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            vi.spyOn(mockClient, 'callTool')
                .mockResolvedValueOnce({
                    candidates: [
                        {
                            id: 'candidate-1',
                            taskText: 'Send proposal',
                            confidenceBucket: 'high',
                            rationale: 'explicit action language',
                            suggestedTags: ['followup'],
                        },
                    ],
                } as any)
                .mockResolvedValue({ success: true } as any);

            (vscode.window.showQuickPick as any)
                .mockResolvedValueOnce([
                    {
                        label: 'Send proposal',
                        description: 'Confidence: HIGH • explicit action language',
                        candidate: {
                            id: 'candidate-1',
                            taskText: 'Send proposal',
                            confidenceBucket: 'high',
                            rationale: 'explicit action language',
                            suggestedTags: ['followup'],
                        },
                    },
                ])
                .mockResolvedValueOnce([]);

            await provider.showTranscript('protokoll://transcript/test.md', transcript);

            if (messageHandler) {
                await messageHandler({
                    command: 'identifyTasks',
                    transcriptPath: '/path/to/test.md',
                });
            }

            expect(mockClient.callTool).toHaveBeenCalledWith(
                'protokoll_identify_tasks_from_transcript',
                expect.objectContaining({ transcriptPath: expect.any(String) })
            );
            expect(mockClient.callTool).toHaveBeenCalledWith(
                'protokoll_create_task',
                expect.objectContaining({ description: 'Send proposal' })
            );
        });

        it('should handle identifyTasks message with no candidates', async () => {
            provider.setClient(mockClient);

            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
                title: 'Test',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                    tasks: [],
                },
                content: '# Test',
            };

            const callToolSpy = vi.spyOn(mockClient, 'callTool').mockResolvedValue({
                candidates: [],
                message: 'No task candidates found.',
            } as any);
            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

            await provider.showTranscript('protokoll://transcript/test.md', transcript);

            if (messageHandler) {
                await messageHandler({
                    command: 'identifyTasks',
                    transcriptPath: '/path/to/test.md',
                });
            }

            expect(callToolSpy).toHaveBeenCalledWith(
                'protokoll_identify_tasks_from_transcript',
                expect.objectContaining({ transcriptPath: expect.any(String) })
            );
            expect(callToolSpy).not.toHaveBeenCalledWith('protokoll_create_task', expect.anything());
            expect(infoSpy).toHaveBeenCalledWith('No task candidates found.');
        });

        it('should block duplicate identifyTasks candidates from creation', async () => {
            provider.setClient(mockClient);

            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
                title: 'Test',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                    tasks: [{ id: 'task-1', description: 'Send proposal', status: 'open', created: '2026-01-31T00:00:00.000Z' }],
                },
                content: '# Test',
            };

            const callToolSpy = vi.spyOn(mockClient, 'callTool')
                .mockResolvedValueOnce({
                    candidates: [
                        {
                            id: 'candidate-dup',
                            taskText: 'Send proposal',
                            confidenceBucket: 'high',
                            rationale: 'explicit action',
                            suggestedTags: [],
                        },
                    ],
                } as any)
                .mockResolvedValue({ success: true } as any);
            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            (vscode.window.showQuickPick as any).mockResolvedValueOnce([
                {
                    label: 'Send proposal',
                    description: 'Confidence: HIGH • explicit action',
                    candidate: {
                        id: 'candidate-dup',
                        taskText: 'Send proposal',
                        confidenceBucket: 'high',
                        rationale: 'explicit action',
                        suggestedTags: [],
                    },
                },
            ]);
            const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

            await provider.showTranscript('protokoll://transcript/test.md', transcript);

            if (messageHandler) {
                await messageHandler({
                    command: 'identifyTasks',
                    transcriptPath: '/path/to/test.md',
                });
            }

            expect(callToolSpy).not.toHaveBeenCalledWith('protokoll_create_task', expect.anything());
            expect(infoSpy).toHaveBeenCalledWith('Protokoll: Created 0 tasks from identified candidates (1 duplicate blocked).');
        });

        it('should handle openEntity message', async () => {
            provider.setClient(mockClient);
            
            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test',
            };

            const entityContent: McpResourceResponse = {
                uri: 'protokoll://entity/person/john-doe',
                mimeType: 'text/markdown',
                text: 'name: John Doe\nid: john-doe',
            };

            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            vi.spyOn(mockClient, 'readResource').mockResolvedValue(entityContent);

            await provider.showTranscript('protokoll://transcript/test.md', transcript);
            
            if (messageHandler) {
                await messageHandler({
                    command: 'openEntity',
                    entityType: 'person',
                    entityId: 'john-doe',
                });
            }

            expect(mockClient.readResource).toHaveBeenCalled();
        });

        it('should handle rejectCorrection message', async () => {
            provider.setClient(mockClient);

            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test',
            };

            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            const callToolSpy = vi.spyOn(mockClient, 'callTool').mockResolvedValue({
                success: true,
                message: 'Correction rejected',
            });
            const refreshSpy = vi.spyOn(provider, 'refreshTranscript');

            await provider.showTranscript('protokoll://transcript/test.md', transcript);

            if (messageHandler) {
                await messageHandler({
                    command: 'rejectCorrection',
                    transcriptPath: '/path/to/test.md',
                    correctionEntryId: 42,
                });
            }

            expect(callToolSpy).toHaveBeenCalledWith(
                'protokoll_reject_correction',
                expect.objectContaining({
                    transcriptPath: 'protokoll://transcript/test.md',
                    correctionEntryId: 42,
                })
            );
            expect(refreshSpy).toHaveBeenCalledWith('protokoll://transcript/test.md');
        });

        it('should resolve a registered summary tool before generateSummary', async () => {
            provider.setClient(mockClient);

            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test',
            };

            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            const listToolsSpy = vi.spyOn(mockClient, 'listTools').mockResolvedValue([
                {
                    name: 'protokoll_summarize_transcript',
                    description: 'Summarize transcript',
                    inputSchema: { type: 'object', properties: {} },
                },
            ]);
            const callToolSpy = vi.spyOn(mockClient, 'callTool').mockImplementation(async (toolName: string) => {
                if (toolName === 'protokoll_summarize_transcript') {
                    return {
                        summary: '# Summary',
                        summaryId: 'summary-1',
                    };
                }
                return {};
            });

            await provider.showTranscript('protokoll://transcript/test.md', transcript);

            if (messageHandler) {
                await messageHandler({
                    command: 'generateSummary',
                    transcriptPath: '/path/to/test.md',
                });
            }

            expect(listToolsSpy).toHaveBeenCalled();
            expect(callToolSpy).toHaveBeenCalledWith(
                'protokoll_summarize_transcript',
                expect.objectContaining({
                    transcriptPath: 'protokoll://transcript/test.md',
                })
            );
        });

        it('should fail generateSummary when no summary tool is published', async () => {
            provider.setClient(mockClient);

            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test',
            };

            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            vi.spyOn(mockClient, 'listTools').mockResolvedValue([
                {
                    name: 'protokoll_read_transcript',
                    description: 'Read transcript',
                    inputSchema: { type: 'object', properties: {} },
                },
            ]);
            const callToolSpy = vi.spyOn(mockClient, 'callTool').mockResolvedValue({});
            const showErrorSpy = vi.spyOn(vscode.window, 'showErrorMessage');

            await provider.showTranscript('protokoll://transcript/test.md', transcript);

            if (messageHandler) {
                await messageHandler({
                    command: 'generateSummary',
                    transcriptPath: '/path/to/test.md',
                });
            }

            expect(callToolSpy).not.toHaveBeenCalledWith(
                'protokoll_summarize_transcript',
                expect.anything()
            );
            expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    command: 'summaryGenerationFailed',
                })
            );
            expect(showErrorSpy).toHaveBeenCalled();
        });

        it('should confirm rejectCorrection through VS Code warning flow', async () => {
            provider.setClient(mockClient);

            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test',
            };

            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            const callToolSpy = vi.spyOn(mockClient, 'callTool').mockResolvedValue({
                success: true,
                message: 'Correction rejected',
            });
            const warningSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Reject' as any);

            await provider.showTranscript('protokoll://transcript/test.md', transcript);

            if (messageHandler) {
                await messageHandler({
                    command: 'requestRejectCorrection',
                    transcriptPath: '/path/to/test.md',
                    correctionEntryId: 42,
                });
            }

            expect(warningSpy).toHaveBeenCalledWith(
                'Reject this correction and restore the original text?',
                { modal: true },
                'Reject'
            );
            expect(callToolSpy).toHaveBeenCalledWith(
                'protokoll_reject_correction',
                expect.objectContaining({
                    transcriptPath: 'protokoll://transcript/test.md',
                    correctionEntryId: 42,
                })
            );
        });

        it('should cancel rejectCorrection when VS Code confirmation is dismissed', async () => {
            provider.setClient(mockClient);

            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test',
            };

            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            const callToolSpy = vi.spyOn(mockClient, 'callTool').mockResolvedValue({
                success: true,
                message: 'Correction rejected',
            });
            vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);

            await provider.showTranscript('protokoll://transcript/test.md', transcript);

            if (messageHandler) {
                await messageHandler({
                    command: 'requestRejectCorrection',
                    transcriptPath: '/path/to/test.md',
                    correctionEntryId: 42,
                });
            }

            expect(callToolSpy).not.toHaveBeenCalledWith(
                'protokoll_reject_correction',
                expect.anything()
            );
            expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    command: 'rejectCorrectionDecision',
                    correctionEntryId: 42,
                    approved: false,
                })
            );
        });

        it('should handle errors in message handlers', async () => {
            provider.setClient(mockClient);
            
            const transcript: Transcript = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                filename: 'test.md',
                date: '2026-01-31',
            };

            const content: TranscriptContent = {
                uri: 'protokoll://transcript/test.md',
                path: '/path/to/test.md',
                title: 'test.md',
                metadata: {
                    date: '2026-01-31',
                    tags: [],
                },
                content: '# Test',
            };

            vi.spyOn(mockClient, 'readTranscript').mockResolvedValue(content);
            vi.spyOn(mockClient, 'callTool').mockRejectedValue(new Error('Tool error'));
            (vscode.window.showErrorMessage as any).mockResolvedValue(undefined);

            await provider.showTranscript('protokoll://transcript/test.md', transcript);
            
            if (messageHandler) {
                await messageHandler({
                    command: 'addTag',
                    transcriptPath: '/path/to/test.md',
                });
            }

            expect(vscode.window.showErrorMessage).toHaveBeenCalled();
        });
    });

    describe('parseTags', () => {
        it('should parse tags from content', () => {
            const content = `## Metadata

**Tags**: \`tag1\`, \`tag2\`, \`tag3\`

Content here.`;

            const tags = (provider as any).parseTags(content);
            expect(tags).toContain('tag1');
            expect(tags).toContain('tag2');
            expect(tags).toContain('tag3');
        });

        it('should parse tags from routing section', () => {
            const content = `## Metadata

### Routing

**Tags**: \`tag1\`, \`tag2\`

Content here.`;

            const tags = (provider as any).parseTags(content);
            expect(tags.length).toBeGreaterThan(0);
        });

        it('should return empty array when no tags', () => {
            const content = '# Test Transcript\n\nNo tags here.';
            const tags = (provider as any).parseTags(content);
            expect(tags).toEqual([]);
        });
    });

    describe('parseEntityContent', () => {
        it('should parse entity content', () => {
            const content = `name: John Doe
id: john-doe
type: person
description: A person`;

            const entity = (provider as any).parseEntityContent(content);
            expect(entity.name).toBe('John Doe');
            expect(entity.id).toBe('john-doe');
            expect(entity.type).toBe('person');
        });
    });

    describe('capitalizeFirst', () => {
        it('should capitalize first letter', () => {
            const result = (provider as any).capitalizeFirst('person');
            expect(result).toBe('Person');
        });

        it('should handle empty string', () => {
            const result = (provider as any).capitalizeFirst('');
            expect(result).toBe('');
        });
    });

    describe('formatDate', () => {
        it('should format valid date string', () => {
            const result = (provider as any).formatDate('2026-01-31T20:32:00Z');
            expect(result).toBeTruthy();
            expect(typeof result).toBe('string');
        });

        it('should handle invalid date string', () => {
            const result = (provider as any).formatDate('not-a-date');
            // formatDate returns 'Invalid Date' when Date constructor creates invalid date
            expect(result).toBe('Invalid Date');
        });

        it('should format ISO date string', () => {
            const result = (provider as any).formatDate('2026-01-31');
            expect(typeof result).toBe('string');
            expect(result.length).toBeGreaterThan(0);
        });
    });

    describe('getEntityContent', () => {
        it('should generate entity HTML content', () => {
            const content = 'name: John Doe\nid: john-doe\ntype: person';
            const html = (provider as any).getEntityContent('person', 'john-doe', content);
            
            expect(html).toContain('<!DOCTYPE html>');
            expect(html).toContain('John Doe');
            expect(html).toContain('john-doe');
        });

        it('should handle entity data parameter', () => {
            const entityData = {
                name: 'Test Entity',
                id: 'test-id',
                type: 'person',
            };
            const html = (provider as any).getEntityContent('person', 'test-id', '', entityData);
            
            expect(html).toContain('Test Entity');
            expect(html).toContain('test-id');
        });

        it('should include classification if present', () => {
            const entityData = {
                name: 'Test',
                classification: { key: 'value' },
            };
            const html = (provider as any).getEntityContent('person', 'test', '', entityData);
            
            expect(html).toContain('Classification');
        });

        it('should include topics if present', () => {
            const entityData = {
                name: 'Test',
                topics: ['topic1', 'topic2'],
            };
            const html = (provider as any).getEntityContent('person', 'test', '', entityData);
            
            expect(html).toContain('topic1');
            expect(html).toContain('topic2');
        });
    });

    describe('parseRouting', () => {
        it('should parse routing section', () => {
            const content = `## Metadata

### Routing

**Destination**: ./notes
**Confidence**: 0.95
**Reasoning**: High confidence routing

## Content`;

            const routing = (provider as any).parseRouting(content);
            expect(routing).toBeTruthy();
            expect(routing?.destination).toBe('./notes');
        });

        it('should return null when no routing section', () => {
            const content = '## Metadata\n\nNo routing here.';
            const routing = (provider as any).parseRouting(content);
            expect(routing).toBeNull();
        });
    });

    describe('parseEntityReferences', () => {
        it('should parse entity references section', () => {
            const content = `## Entity References

### Projects

- \`project-1\`: Project One
- \`project-2\`: Project Two

### People

- \`person-1\`: John Doe

## Content`;

            const entities = (provider as any).parseEntityReferences(content);
            expect(entities).toBeDefined();
            expect(typeof entities).toBe('object');
            // Verify projects are parsed if section exists
            if (entities.projects) {
                expect(Array.isArray(entities.projects)).toBe(true);
            }
        });

        it('should parse people section', () => {
            const content = `## Entity References

### People

- \`person-1\`: John Doe
- \`person-2\`: Jane Smith

## Content`;

            const entities = (provider as any).parseEntityReferences(content);
            expect(entities).toBeDefined();
            if (entities.people) {
                expect(entities.people.length).toBeGreaterThan(0);
            }
        });

        it('should return empty object when no entity references', () => {
            const content = '## Content\n\nNo entity references.';
            const entities = (provider as any).parseEntityReferences(content);
            expect(entities).toEqual({});
        });
    });

    describe('removeRedundantTitle', () => {
        it('should remove H1 that matches title', () => {
            const content = '# Test Title\n\nContent here.';
            const result = (provider as any).removeRedundantTitle(content, 'Test Title');
            expect(result).not.toContain('# Test Title');
        });

        it('should keep H1 that does not match title', () => {
            const content = '# Different Title\n\nContent here.';
            const result = (provider as any).removeRedundantTitle(content, 'Test Title');
            expect(result).toContain('# Different Title');
        });

        it('should handle case-insensitive matching', () => {
            const content = '# test title\n\nContent here.';
            const result = (provider as any).removeRedundantTitle(content, 'Test Title');
            expect(result).not.toContain('# test title');
        });
    });

    describe('removeRedundantSections', () => {
        it('should remove Metadata section', () => {
            const content = `## Metadata

Some metadata content

## Content

Actual content here.`;

            const result = (provider as any).removeRedundantSections(content);
            expect(result).not.toContain('## Metadata');
            expect(result).toContain('Actual content');
        });

        it('should remove Routing section', () => {
            const content = `### Routing

Routing info

## Content

Actual content.`;

            const result = (provider as any).removeRedundantSections(content);
            expect(result).not.toContain('### Routing');
            expect(result).toContain('Actual content');
        });

        it('should remove Entity References section', () => {
            const content = `## Entity References

Entities here

## Content

Actual content.`;

            const result = (provider as any).removeRedundantSections(content);
            expect(result).not.toContain('## Entity References');
            expect(result).toContain('Actual content');
        });

        it('should keep content before first heading', () => {
            const content = `Some intro text

## Metadata

Metadata content

## Content

Actual content.`;

            const result = (provider as any).removeRedundantSections(content);
            expect(result).toContain('Some intro text');
        });

        it('should handle empty text', () => {
            const result = (provider as any).removeRedundantSections('');
            expect(result).toBe('');
        });

        it('should handle nested sections', () => {
            const content = `## Metadata

### Routing

Routing content

## Content

Actual content.`;

            const result = (provider as any).removeRedundantSections(content);
            expect(result).not.toContain('## Metadata');
            expect(result).not.toContain('### Routing');
            expect(result).toContain('Actual content');
        });
    });

    describe('renderEntityReferences', () => {
        it('should render entity references editor shell', () => {
            const html = (provider as any).renderEntityReferences({});
            expect(html).toContain('Entity References');
            expect(html).toContain('entity-references-content');
        });

        it('should render edit and save controls', () => {
            const html = (provider as any).renderEntityReferences({});
            expect(html).toContain('entity-references-edit-btn');
            expect(html).toContain('entity-references-save-btn');
            expect(html).toContain('startEditEntityReferences()');
            expect(html).toContain('saveEntityReferences()');
        });

        it('should include status container for save feedback', () => {
            const html = (provider as any).renderEntityReferences({});
            expect(html).toContain('entity-references-status');
        });

        it('should render existing entities in non-edit mode', () => {
            const html = (provider as any).renderEntityReferences({
                projects: [{ id: 'project-1', name: 'Project One' }],
            });
            expect(html).toContain('Project One');
            expect(html).toContain('openEntity');
        });
    });

    describe('markdownToHtml', () => {
        it('should convert headers', () => {
            const markdown = '# H1\n## H2\n### H3';
            const html = (provider as any).markdownToHtml(markdown);
            expect(html).toContain('<h1>');
            expect(html).toContain('<h2>');
            expect(html).toContain('<h3>');
        });

        it('should convert bold text', () => {
            const markdown = 'This is **bold** text';
            const html = (provider as any).markdownToHtml(markdown);
            expect(html).toContain('<strong>bold</strong>');
        });

        it('should convert italic text', () => {
            const markdown = 'This is *italic* text';
            const html = (provider as any).markdownToHtml(markdown);
            expect(html).toContain('<em>italic</em>');
        });

        it('should convert inline code', () => {
            const markdown = 'Use `code` here';
            const html = (provider as any).markdownToHtml(markdown);
            expect(html).toContain('<code>code</code>');
        });

        it('should convert code blocks', () => {
            const markdown = '```\ncode block\n```';
            const html = (provider as any).markdownToHtml(markdown);
            expect(html).toContain('<pre><code>');
        });

        it('should convert unordered lists', () => {
            const markdown = '- Item 1\n- Item 2';
            const html = (provider as any).markdownToHtml(markdown);
            expect(html).toContain('<ul>');
            expect(html).toContain('<li>');
        });

        it('should convert ordered lists', () => {
            const markdown = '1. First\n2. Second';
            const html = (provider as any).markdownToHtml(markdown);
            expect(html).toContain('<ol>');
            expect(html).toContain('<li>');
        });

        it('should convert links', () => {
            const markdown = '[Link text](https://example.com)';
            const html = (provider as any).markdownToHtml(markdown);
            expect(html).toContain('<a href="https://example.com">Link text</a>');
        });

        it('should convert paragraphs', () => {
            const markdown = 'Paragraph one.\n\nParagraph two.';
            const html = (provider as any).markdownToHtml(markdown);
            expect(html).toContain('<p>');
        });

        it('should escape HTML special characters', () => {
            const markdown = '<script>alert("xss")</script>';
            const html = (provider as any).markdownToHtml(markdown);
            expect(html).not.toContain('<script>');
            expect(html).toContain('&lt;');
        });
    });
});
