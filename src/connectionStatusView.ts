/**
 * Connection Status View Provider
 * Shows MCP server connection status and allows configuration
 */

import * as vscode from 'vscode';
import { McpClient } from './mcpClient';

export class ConnectionStatusViewProvider implements vscode.TreeDataProvider<ConnectionStatusItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ConnectionStatusItem | undefined | null | void> = 
    new vscode.EventEmitter<ConnectionStatusItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<ConnectionStatusItem | undefined | null | void> = 
    this._onDidChangeTreeData.event;

  private client: McpClient | null = null;
  private serverUrl: string = '';
  private isConnected: boolean = false;
  private sessionId: string | null = null;

  constructor(private context: vscode.ExtensionContext) {
    // Load initial state from config
    const config = vscode.workspace.getConfiguration('protokoll');
    this.serverUrl = config.get<string>('serverUrl', 'http://127.0.0.1:3001');
  }

  setClient(client: McpClient | null): void {
    this.client = client;
    if (client) {
      this.sessionId = client.getSessionId();
      this.isConnected = this.sessionId !== null;
    } else {
      this.sessionId = null;
      this.isConnected = false;
    }
    this._onDidChangeTreeData.fire();
  }

  setServerUrl(url: string): void {
    this.serverUrl = url;
    this._onDidChangeTreeData.fire();
  }

  setConnectionStatus(connected: boolean, sessionId: string | null = null): void {
    this.isConnected = connected;
    this.sessionId = sessionId;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ConnectionStatusItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ConnectionStatusItem): ConnectionStatusItem[] {
    if (!element) {
      // Root level - show connection status items
      const items: ConnectionStatusItem[] = [
        new ConnectionStatusItem(
          this.isConnected ? 'Connected' : 'Disconnected',
          'status',
          vscode.TreeItemCollapsibleState.None,
          this.isConnected ? 'status-connected' : 'status-disconnected',
          {
            command: 'protokoll.configureServer',
            title: 'Configure Server',
          }
        ),
        new ConnectionStatusItem(
          `Server: ${this.serverUrl || 'Not configured'}`,
          'server-url',
          vscode.TreeItemCollapsibleState.None,
          'server',
          {
            command: 'protokoll.configureServer',
            title: 'Change Server URL',
          }
        ),
      ];

      if (this.isConnected && this.sessionId) {
        items.push(
          new ConnectionStatusItem(
            `Session: ${this.sessionId.substring(0, 8)}...`,
            'session-id',
            vscode.TreeItemCollapsibleState.None,
            'key',
            {
              command: 'protokoll.copySessionId',
              title: 'Copy Session ID',
              arguments: [this.sessionId],
            },
            `Session ID: ${this.sessionId}\n\nClick to copy`,
            this.sessionId
          )
        );
      }

      return items;
    }

    return [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}

export class ConnectionStatusItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly id: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly iconName: string,
    public readonly command?: vscode.Command,
    public readonly tooltip?: string,
    public readonly sessionId?: string
  ) {
    super(label, collapsibleState);
    
    this.iconPath = new vscode.ThemeIcon(iconName);
    this.tooltip = tooltip || label;
    this.contextValue = id;

    // Set different icons based on status
    if (id === 'status-connected') {
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    } else if (id === 'status-disconnected') {
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
    }

    // Add copy action for session ID
    if (sessionId) {
      this.tooltip = `${label}\n\nClick to copy session ID`;
    }
  }
}
