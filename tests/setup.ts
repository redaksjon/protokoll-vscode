/**
 * Test setup - Mock VS Code API and HTTP modules
 */

import { vi } from 'vitest';

// Mock vscode module
const mockVscode = {
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    createTreeView: vi.fn(() => ({
      onDidChangeSelection: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      reveal: vi.fn(),
      dispose: vi.fn(),
    })),
    createOutputChannel: vi.fn(() => ({
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    })),
    createWebviewPanel: vi.fn(() => ({
      webview: {
        html: '',
        postMessage: vi.fn(),
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
      },
      reveal: vi.fn(),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      title: '',
      dispose: vi.fn(),
    })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue?: unknown) => defaultValue),
      update: vi.fn(),
    })),
    onDidChangeConfiguration: vi.fn(() => ({
      dispose: vi.fn(),
    })),
    onDidSaveTextDocument: vi.fn(() => ({
      dispose: vi.fn(),
    })),
    onDidCloseTextDocument: vi.fn(() => ({
      dispose: vi.fn(),
    })),
    registerTextDocumentContentProvider: vi.fn(() => ({
      dispose: vi.fn(),
    })),
    fs: {
      stat: vi.fn(),
    },
  },
  env: {
    clipboard: {
      writeText: vi.fn(),
    },
  },
  commands: {
    executeCommand: vi.fn(),
    registerCommand: vi.fn((command: string, callback: () => void) => {
      return { dispose: vi.fn() };
    }),
  },
  EventEmitter: class {
    private listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index > -1) {
          this.listeners.splice(index, 1);
        }
      }};
    };
    fire = vi.fn((data?: any) => {
      this.listeners.forEach(listener => listener(data));
    });
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
  ThemeIcon: class {
    constructor(public id: string, public color?: unknown) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  Uri: {
    parse: vi.fn((uri: string) => ({ fsPath: uri, toString: () => uri })),
    file: vi.fn((path: string) => ({ fsPath: path, toString: () => path })),
  },
  ViewColumn: {
    One: 1,
    Two: 2,
    Three: 3,
  },
  ExtensionContext: class {
    private _globalStateData: Map<string, unknown> = new Map();
    private _workspaceStateData: Map<string, unknown> = new Map();
    
    globalState: {
      get: (key: string, defaultValue?: unknown) => unknown;
      update: (key: string, value: unknown) => Promise<void>;
    };
    
    workspaceState: {
      get: (key: string, defaultValue?: unknown) => unknown;
      update: (key: string, value: unknown) => Promise<void>;
    };
    
    subscriptions = [];
    
    constructor() {
      this.globalState = {
        get: (key: string, defaultValue?: unknown) => {
          return this._globalStateData.has(key) ? this._globalStateData.get(key) : defaultValue;
        },
        update: (key: string, value: unknown) => {
          this._globalStateData.set(key, value);
          return Promise.resolve();
        },
      };
      
      this.workspaceState = {
        get: (key: string, defaultValue?: unknown) => {
          return this._workspaceStateData.has(key) ? this._workspaceStateData.get(key) : defaultValue;
        },
        update: (key: string, value: unknown) => {
          this._workspaceStateData.set(key, value);
          return Promise.resolve();
        },
      };
    }
  },
  TreeItem: class {
    constructor(public label: string, public collapsibleState: number) {}
    iconPath?: unknown;
    tooltip?: string;
    contextValue?: string;
    command?: unknown;
    description?: string;
  },
};

vi.mock('vscode', () => {
  return mockVscode;
});

// Mock http and https modules
vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  const { mockHttpRequestFn } = await import('./helpers/httpMock');
  return {
    ...actual,
    default: {
      ...actual.default,
      request: mockHttpRequestFn,
      createServer: actual.createServer, // Use real createServer for mock MCP server
    },
    request: mockHttpRequestFn,
    createServer: actual.createServer, // Use real createServer for mock MCP server
  };
});

vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('https')>();
  const { mockHttpsRequestFn } = await import('./helpers/httpMock');
  return {
    ...actual,
    default: {
      ...actual.default,
      request: mockHttpsRequestFn,
    },
    request: mockHttpsRequestFn,
  };
});
