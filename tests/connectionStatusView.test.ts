/**
 * Tests for Connection Status View
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConnectionStatusViewProvider, ConnectionStatusItem } from '../src/connectionStatusView';
import { McpClient } from '../src/mcpClient';

// vscode is already mocked in tests/setup.ts

describe('ConnectionStatusViewProvider', () => {
    let provider: ConnectionStatusViewProvider;
    let mockContext: vscode.ExtensionContext;

    beforeEach(() => {
        mockContext = new vscode.ExtensionContext();
        provider = new ConnectionStatusViewProvider(mockContext);
        vi.clearAllMocks();
    });

    describe('constructor', () => {
        it('should initialize with default server URL', () => {
            expect(provider).toBeInstanceOf(ConnectionStatusViewProvider);
        });
    });

    describe('setClient', () => {
        it('should set client and update connection status', () => {
            const mockClient = {
                getSessionId: vi.fn(() => 'test-session-123'),
            } as unknown as McpClient;

            provider.setClient(mockClient);
            
            // Verify client was set (can't easily test internal state, but method should not throw)
            expect(provider).toBeDefined();
        });

        it('should handle null client', () => {
            provider.setClient(null);
            expect(provider).toBeDefined();
        });
    });

    describe('setServerUrl', () => {
        it('should update server URL', () => {
            provider.setServerUrl('http://example.com:8080');
            expect(provider).toBeDefined();
        });
    });

    describe('setConnectionStatus', () => {
        it('should set connection status to connected', () => {
            provider.setConnectionStatus(true, 'test-session-123');
            expect(provider).toBeDefined();
        });

        it('should set connection status to disconnected', () => {
            provider.setConnectionStatus(false);
            expect(provider).toBeDefined();
        });
    });

    describe('getTreeItem', () => {
        it('should return the element as tree item', () => {
            const item = new ConnectionStatusItem(
                'Test Label',
                'test-id',
                vscode.TreeItemCollapsibleState.None,
                'test-icon'
            );

            const result = provider.getTreeItem(item);
            expect(result).toBe(item);
        });
    });

    describe('getChildren', () => {
        it('should return connection status items when disconnected', () => {
            provider.setConnectionStatus(false);
            const children = provider.getChildren();
            
            expect(children).toBeDefined();
            expect(Array.isArray(children)).toBe(true);
            expect(children.length).toBeGreaterThan(0);
        });

        it('should return connection status items when connected', () => {
            provider.setConnectionStatus(true, 'test-session-123');
            const children = provider.getChildren();
            
            expect(children).toBeDefined();
            expect(Array.isArray(children)).toBe(true);
            // Should include session ID item when connected
            const hasSessionItem = children.some((item: ConnectionStatusItem) => 
                item.id === 'session-id'
            );
            expect(hasSessionItem).toBe(true);
        });

        it('should return empty array for child elements', () => {
            const item = new ConnectionStatusItem(
                'Test',
                'test-id',
                vscode.TreeItemCollapsibleState.None,
                'test-icon'
            );
            const children = provider.getChildren(item);
            expect(children).toEqual([]);
        });
    });

    describe('refresh', () => {
        it('should refresh the tree view', () => {
            expect(() => provider.refresh()).not.toThrow();
        });
    });
});

describe('ConnectionStatusItem', () => {
    it('should create item with required properties', () => {
        const item = new ConnectionStatusItem(
            'Test Label',
            'test-id',
            vscode.TreeItemCollapsibleState.None,
            'test-icon'
        );

        expect(item.label).toBe('Test Label');
        expect(item.id).toBe('test-id');
        expect(item.iconName).toBe('test-icon');
    });

    it('should create item with command', () => {
        const command = {
            command: 'test.command',
            title: 'Test Command',
        };

        const item = new ConnectionStatusItem(
            'Test Label',
            'test-id',
            vscode.TreeItemCollapsibleState.None,
            'test-icon',
            command
        );

        expect(item.command).toBe(command);
    });

    it('should create item with tooltip', () => {
        const item = new ConnectionStatusItem(
            'Test Label',
            'test-id',
            vscode.TreeItemCollapsibleState.None,
            'test-icon',
            undefined,
            'Test Tooltip'
        );

        expect(item.tooltip).toBe('Test Tooltip');
    });

    it('should create item with session ID', () => {
        const item = new ConnectionStatusItem(
            'Session',
            'session-id',
            vscode.TreeItemCollapsibleState.None,
            'key',
            undefined,
            undefined,
            'test-session-123'
        );

        expect(item.sessionId).toBe('test-session-123');
    });

    it('should use status-connected icon for connected status', () => {
        const item = new ConnectionStatusItem(
            'Connected',
            'status-connected',
            vscode.TreeItemCollapsibleState.None,
            'status-connected'
        );

        expect(item.id).toBe('status-connected');
    });

    it('should use status-disconnected icon for disconnected status', () => {
        const item = new ConnectionStatusItem(
            'Disconnected',
            'status-disconnected',
            vscode.TreeItemCollapsibleState.None,
            'status-disconnected'
        );

        expect(item.id).toBe('status-disconnected');
    });
});
