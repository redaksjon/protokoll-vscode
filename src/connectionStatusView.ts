/**
 * Connection Status View Provider
 * Shows MCP server connection status and allows configuration
 */

import * as vscode from 'vscode';
import { McpClient } from './mcpClient';

export interface ServerConnectionEntry {
  id: string;
  name: string;
  url: string;
  isConnected?: boolean;
  hasApiKey?: boolean;
  sessionId?: string | null;
  lastError?: string;
}

export class ConnectionStatusViewProvider implements vscode.TreeDataProvider<ConnectionStatusItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ConnectionStatusItem | undefined | null | void> = 
    new vscode.EventEmitter<ConnectionStatusItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<ConnectionStatusItem | undefined | null | void> = 
    this._onDidChangeTreeData.event;

  private client: McpClient | null = null;
  private serverUrl: string = '';
  private isConnected: boolean = false;
  private sessionId: string | null = null;
  private connections: ServerConnectionEntry[] = [];
  private activeServerId: string | null = null;

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

  setConnections(connections: ServerConnectionEntry[], activeServerId: string | null): void {
    this.connections = connections;
    this.activeServerId = activeServerId;
    const active = connections.find((connection) => connection.id === activeServerId) ?? connections[0];
    if (active) {
      this.serverUrl = active.url;
      this.isConnected = active.isConnected ?? false;
      this.sessionId = active.sessionId ?? null;
    } else {
      this.isConnected = false;
      this.sessionId = null;
    }
    this._onDidChangeTreeData.fire();
  }

  setConnectionStatus(connected: boolean, sessionId: string | null = null): void {
    this.isConnected = connected;
    this.sessionId = sessionId;
    if (this.connections.length > 0 && this.activeServerId) {
      this.connections = this.connections.map((connection) => connection.id === this.activeServerId
        ? { ...connection, isConnected: connected, sessionId }
        : connection);
    }
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

      if (this.connections.length > 0) {
        items.push(
          ...this.connections.map((connection) => {
            const isActive = connection.id === this.activeServerId;
            const statusIcon = connection.isConnected ? 'circle-filled' : 'warning';
            const statusColor = connection.isConnected ? new vscode.ThemeColor('charts.green') : new vscode.ThemeColor('charts.red');
            const statusLabel = connection.isConnected ? 'Connected' : 'Disconnected';
            const tokenLabel = connection.hasApiKey ? 'Configured' : 'Not configured';
            const label = `${connection.name}: ${statusLabel}`;
            const tooltip = `${connection.name}\n${connection.url}\nStatus: ${statusLabel}\nAPI Token: ${tokenLabel}${connection.lastError ? `\nError: ${connection.lastError}` : ''}`;
            const item = new ConnectionStatusItem(
              label,
              `connection-${connection.id}`,
              vscode.TreeItemCollapsibleState.None,
              statusIcon,
              {
                command: 'protokoll.showServerConnectionDetails',
                title: 'Show Server Connection Details',
                arguments: [connection.id],
              },
              tooltip,
              connection.sessionId ?? undefined
            );
            item.iconPath = new vscode.ThemeIcon(statusIcon, statusColor);
            const tokenSuffix = connection.hasApiKey ? 'key set' : 'no key';
            item.description = isActive
              ? `Active - ${connection.url} - ${tokenSuffix}`
              : `${connection.url} - ${tokenSuffix}`;
            return item;
          })
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
    public readonly sessionId?: string,
    public readonly descriptionText?: string,
    public readonly statusText?: string
  ) {
    super(label, collapsibleState);
    
    this.iconPath = new vscode.ThemeIcon(iconName);
    this.tooltip = tooltip || label;
    this.contextValue = id;
    this.description = descriptionText;

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

    if (statusText) {
      this.description = statusText;
    }
  }
}
