/**
 * Tests for Chats View Provider
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatsViewProvider } from '../src/chatsView';

describe('ChatsViewProvider', () => {
  let provider: ChatsViewProvider;

  beforeEach(() => {
    provider = new ChatsViewProvider();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize provider', () => {
      expect(provider).toBeInstanceOf(ChatsViewProvider);
    });

    it('should have empty chats initially', () => {
      const chats = provider.getChats();
      expect(chats).toEqual([]);
    });
  });

  describe('registerChat', () => {
    it('should register a new chat', () => {
      provider.registerChat('chat-1', 'Test Chat');
      
      const chats = provider.getChats();
      expect(chats).toHaveLength(1);
      expect(chats[0]).toEqual({
        id: 'chat-1',
        title: 'Test Chat',
        transcriptUri: undefined,
      });
    });

    it('should register a chat with transcript URI', () => {
      provider.registerChat('chat-1', 'Transcript Chat', 'protokoll://transcript/test.md');
      
      const chats = provider.getChats();
      expect(chats).toHaveLength(1);
      expect(chats[0]).toEqual({
        id: 'chat-1',
        title: 'Transcript Chat',
        transcriptUri: 'protokoll://transcript/test.md',
      });
    });

    it('should register multiple chats', () => {
      provider.registerChat('chat-1', 'Chat 1');
      provider.registerChat('chat-2', 'Chat 2');
      provider.registerChat('chat-3', 'Chat 3');
      
      const chats = provider.getChats();
      expect(chats).toHaveLength(3);
    });

    it('should update existing chat if same ID is registered', () => {
      provider.registerChat('chat-1', 'Original Title');
      provider.registerChat('chat-1', 'Updated Title');
      
      const chats = provider.getChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].title).toBe('Updated Title');
    });
  });

  describe('unregisterChat', () => {
    it('should remove a registered chat', () => {
      provider.registerChat('chat-1', 'Test Chat');
      provider.unregisterChat('chat-1');
      
      const chats = provider.getChats();
      expect(chats).toHaveLength(0);
    });

    it('should not error when unregistering non-existent chat', () => {
      expect(() => provider.unregisterChat('non-existent')).not.toThrow();
    });

    it('should only remove specified chat', () => {
      provider.registerChat('chat-1', 'Chat 1');
      provider.registerChat('chat-2', 'Chat 2');
      provider.registerChat('chat-3', 'Chat 3');
      
      provider.unregisterChat('chat-2');
      
      const chats = provider.getChats();
      expect(chats).toHaveLength(2);
      expect(chats.find(c => c.id === 'chat-1')).toBeDefined();
      expect(chats.find(c => c.id === 'chat-3')).toBeDefined();
      expect(chats.find(c => c.id === 'chat-2')).toBeUndefined();
    });
  });

  describe('getChats', () => {
    it('should return empty array initially', () => {
      const chats = provider.getChats();
      expect(chats).toEqual([]);
    });

    it('should return all registered chats', () => {
      provider.registerChat('chat-1', 'Chat 1');
      provider.registerChat('chat-2', 'Chat 2');
      
      const chats = provider.getChats();
      expect(chats).toHaveLength(2);
    });

    it('should return a copy of chats array', () => {
      provider.registerChat('chat-1', 'Chat 1');
      
      const chats1 = provider.getChats();
      const chats2 = provider.getChats();
      
      expect(chats1).not.toBe(chats2);
      expect(chats1).toEqual(chats2);
    });
  });

  describe('refresh', () => {
    it('should fire tree data change event', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      
      provider.refresh();
      
      expect(listener).toHaveBeenCalled();
    });

    it('should be called when registering a chat', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      
      provider.registerChat('chat-1', 'Test Chat');
      
      expect(listener).toHaveBeenCalled();
    });

    it('should be called when unregistering a chat', () => {
      provider.registerChat('chat-1', 'Test Chat');
      
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      
      provider.unregisterChat('chat-1');
      
      expect(listener).toHaveBeenCalled();
    });
  });

  describe('getTreeItem', () => {
    it('should return the tree item as-is', () => {
      const treeItem = new vscode.TreeItem('Test');
      const result = provider.getTreeItem(treeItem as any);
      expect(result).toBe(treeItem);
    });
  });

  describe('getChildren', () => {
    it('should return empty array when no chats registered', async () => {
      const children = await provider.getChildren();
      expect(children).toEqual([]);
    });

    it('should return empty array when element is provided', async () => {
      provider.registerChat('chat-1', 'Test Chat');
      const treeItem = new vscode.TreeItem('Test');
      
      const children = await provider.getChildren(treeItem as any);
      expect(children).toEqual([]);
    });

    it('should return chat tree items for all registered chats', async () => {
      provider.registerChat('chat-1', 'Chat 1');
      provider.registerChat('chat-2', 'Chat 2');
      
      const children = await provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children[0].label).toBe('Chat 1');
      expect(children[1].label).toBe('Chat 2');
    });

    it('should create tree items with correct properties', async () => {
      provider.registerChat('chat-1', 'Test Chat', 'protokoll://transcript/test.md');
      
      const children = await provider.getChildren();
      expect(children).toHaveLength(1);
      
      const item = children[0];
      expect(item.label).toBe('Test Chat');
      expect(item.tooltip).toBe('Chat: Test Chat');
      expect(item.description).toBe('Transcript Chat');
      expect(item.contextValue).toBe('chat');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    });

    it('should set description to "General Chat" when no transcript URI', async () => {
      provider.registerChat('chat-1', 'General Chat');
      
      const children = await provider.getChildren();
      const item = children[0];
      
      expect(item.description).toBe('General Chat');
    });

    it('should set description to "Transcript Chat" when transcript URI provided', async () => {
      provider.registerChat('chat-1', 'Transcript Chat', 'protokoll://transcript/test.md');
      
      const children = await provider.getChildren();
      const item = children[0];
      
      expect(item.description).toBe('Transcript Chat');
    });

    it('should set command to open chat panel', async () => {
      provider.registerChat('chat-1', 'Test Chat');
      
      const children = await provider.getChildren();
      const item = children[0];
      
      expect(item.command).toBeDefined();
      expect(item.command?.command).toBe('protokoll.openChatPanel');
      expect(item.command?.title).toBe('Open Chat');
      expect(item.command?.arguments).toEqual(['chat-1']);
    });

    it('should have comment-discussion icon', async () => {
      provider.registerChat('chat-1', 'Test Chat');
      
      const children = await provider.getChildren();
      const item = children[0];
      
      expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('comment-discussion');
    });
  });

  describe('onDidChangeTreeData', () => {
    it('should be an event emitter', () => {
      expect(provider.onDidChangeTreeData).toBeDefined();
      expect(typeof provider.onDidChangeTreeData).toBe('function');
    });

    it('should notify listeners when tree data changes', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      
      provider.refresh();
      
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should notify multiple listeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      
      provider.onDidChangeTreeData(listener1);
      provider.onDidChangeTreeData(listener2);
      
      provider.refresh();
      
      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });
  });
});
