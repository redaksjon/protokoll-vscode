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
    event = {};
    fire = vi.fn();
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
    globalState = {
      get: vi.fn(),
      update: vi.fn(),
    };
    subscriptions = [];
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
vi.mock('http', async () => {
  const { mockHttpRequestFn } = await import('./helpers/httpMock');
  return {
    default: {
      request: mockHttpRequestFn,
    },
    request: mockHttpRequestFn,
  };
});

vi.mock('https', async () => {
  const { mockHttpsRequestFn } = await import('./helpers/httpMock');
  return {
    default: {
      request: mockHttpsRequestFn,
    },
    request: mockHttpsRequestFn,
  };
});
