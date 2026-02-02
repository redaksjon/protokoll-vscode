/**
 * Chats View Provider
 * Shows list of open chat panels in the Activity Bar
 */

import * as vscode from 'vscode';

interface ChatItem {
  id: string;
  title: string;
  transcriptUri?: string;
}

export class ChatsViewProvider implements vscode.TreeDataProvider<ChatTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ChatTreeItem | undefined | null | void> = new vscode.EventEmitter<ChatTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<ChatTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private _chats: Map<string, ChatItem> = new Map();

  constructor() {}

  /**
   * Register a new chat panel
   */
  registerChat(id: string, title: string, transcriptUri?: string): void {
    this._chats.set(id, { id, title, transcriptUri });
    this.refresh();
  }

  /**
   * Unregister a chat panel
   */
  unregisterChat(id: string): void {
    this._chats.delete(id);
    this.refresh();
  }

  /**
   * Get all registered chats
   */
  getChats(): ChatItem[] {
    return Array.from(this._chats.values());
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ChatTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ChatTreeItem): Thenable<ChatTreeItem[]> {
    if (element) {
      return Promise.resolve([]);
    }

    const chats = Array.from(this._chats.values());
    if (chats.length === 0) {
      return Promise.resolve([]);
    }

    return Promise.resolve(
      chats.map(chat => new ChatTreeItem(
        chat.title,
        chat.id,
        chat.transcriptUri,
        vscode.TreeItemCollapsibleState.None
      ))
    );
  }
}

class ChatTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly chatId: string,
    public readonly transcriptUri: string | undefined,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    this.tooltip = `Chat: ${label}`;
    this.description = transcriptUri ? 'Transcript Chat' : 'General Chat';
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.contextValue = 'chat';
    
    // Make it clickable to reveal the chat panel
    this.command = {
      command: 'protokoll.openChatPanel',
      title: 'Open Chat',
      arguments: [chatId]
    };
  }
}
