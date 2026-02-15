/**
 * Tests for Chat View Provider
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../src/chatView';
import { McpClient } from '../src/mcpClient';
import { OpenAIClient } from '../src/openaiClient';
import type { Transcript } from '../src/types';

// Mock OpenAI
vi.mock('../src/openaiClient');

describe('ChatViewProvider', () => {
  let provider: ChatViewProvider;
  let mockExtensionUri: vscode.Uri;
  let mockClient: McpClient;
  let mockOpenAIClient: OpenAIClient;

  beforeEach(() => {
    mockExtensionUri = vscode.Uri.file('/test/extension');
    provider = new ChatViewProvider(mockExtensionUri);
    mockClient = new McpClient('http://localhost:3001');
    
    // Setup OpenAI mock
    mockOpenAIClient = {
      setMcpClient: vi.fn(),
      discoverTools: vi.fn().mockResolvedValue(undefined),
      getTools: vi.fn().mockReturnValue([]),
      streamChat: vi.fn().mockImplementation(async function* () {
        yield 'Test response';
      }),
    } as any;
    
    (OpenAIClient as any).mockImplementation(() => mockOpenAIClient);
    
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize provider', () => {
      expect(provider).toBeInstanceOf(ChatViewProvider);
    });

    it('should store extension URI', () => {
      expect(provider).toBeDefined();
    });
  });

  describe('setClient', () => {
    it('should set the MCP client', () => {
      provider.setClient(mockClient);
      expect(provider).toBeDefined();
    });

    it('should update OpenAI client with MCP client if already initialized', async () => {
      // Set up environment
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      try {
        await provider.initializeOpenAI();
        provider.setClient(mockClient);
        
        expect(mockOpenAIClient.setMcpClient).toHaveBeenCalledWith(mockClient);
      } finally {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    });
  });

  describe('setChatsViewProvider', () => {
    it('should set chats view provider reference', () => {
      const mockChatsProvider = {
        registerChat: vi.fn(),
        unregisterChat: vi.fn(),
      };
      
      provider.setChatsViewProvider(mockChatsProvider);
      expect(provider).toBeDefined();
    });
  });

  describe('setTranscriptDetailProvider', () => {
    it('should set transcript detail provider reference', () => {
      const mockTranscriptProvider = {
        getCurrentTranscript: vi.fn(),
        getAllOpenTranscripts: vi.fn(),
      };
      
      provider.setTranscriptDetailProvider(mockTranscriptProvider);
      expect(provider).toBeDefined();
    });
  });

  describe('initializeOpenAI', () => {
    it('should initialize OpenAI client with API key from environment', async () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-api-key';

      try {
        await provider.initializeOpenAI();
        
        expect(OpenAIClient).toHaveBeenCalledWith('test-api-key');
        expect(mockOpenAIClient.discoverTools).toHaveBeenCalled();
      } finally {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    });

    it('should throw error if OPENAI_API_KEY not set', async () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        await expect(provider.initializeOpenAI()).rejects.toThrow('OPENAI_API_KEY not configured');
      } finally {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    });

    it('should set MCP client on OpenAI client if already available', async () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      try {
        provider.setClient(mockClient);
        await provider.initializeOpenAI();
        
        expect(mockOpenAIClient.setMcpClient).toHaveBeenCalledWith(mockClient);
      } finally {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    });

    it('should handle tool discovery failure gracefully', async () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';
      mockOpenAIClient.discoverTools = vi.fn().mockRejectedValue(new Error('Discovery failed'));

      try {
        // Should not throw, just warn
        await provider.initializeOpenAI();
        expect(mockOpenAIClient.discoverTools).toHaveBeenCalled();
      } finally {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    });
  });

  describe('sendInlineMessage', () => {
    beforeEach(async () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';
      await provider.initializeOpenAI();
      process.env.OPENAI_API_KEY = originalEnv;
    });

    it('should send inline message with transcript context', async () => {
      const message = 'Test message';
      const transcriptUri = 'protokoll://transcript/test.md';
      const transcriptContext = {
        title: 'Test Transcript',
        path: 'test.md',
        filename: 'test.md',
        uri: transcriptUri,
      };

      const response = await provider.sendInlineMessage(message, transcriptUri, transcriptContext);
      
      expect(response).toBe('Test response');
      expect(mockOpenAIClient.streamChat).toHaveBeenCalled();
    });

    it('should initialize OpenAI if not already initialized', async () => {
      const newProvider = new ChatViewProvider(mockExtensionUri);
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      try {
        const message = 'Test message';
        const transcriptUri = 'protokoll://transcript/test.md';
        const transcriptContext = {
          title: 'Test Transcript',
          path: 'test.md',
          filename: 'test.md',
          uri: transcriptUri,
        };

        await newProvider.sendInlineMessage(message, transcriptUri, transcriptContext);
        
        expect(OpenAIClient).toHaveBeenCalled();
      } finally {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    });

    it('should throw error if OpenAI client fails to initialize', async () => {
      const newProvider = new ChatViewProvider(mockExtensionUri);
      const originalEnv = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        const message = 'Test message';
        const transcriptUri = 'protokoll://transcript/test.md';
        const transcriptContext = {
          title: 'Test Transcript',
          path: 'test.md',
          filename: 'test.md',
          uri: transcriptUri,
        };

        await expect(newProvider.sendInlineMessage(message, transcriptUri, transcriptContext)).rejects.toThrow();
      } finally {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    });

    it('should use filename as transcript identifier', async () => {
      const message = 'Test message';
      const transcriptUri = 'protokoll://transcript/test.md';
      const transcriptContext = {
        title: 'Test Transcript',
        path: '/absolute/path/test.md',
        filename: 'test.md',
        uri: transcriptUri,
      };

      await provider.sendInlineMessage(message, transcriptUri, transcriptContext);
      
      const callArgs = mockOpenAIClient.streamChat.mock.calls[0];
      const systemMessage = callArgs[0][0];
      expect(systemMessage.content).toContain('test.md');
    });

    it('should use relative path as transcript identifier if no filename', async () => {
      const message = 'Test message';
      const transcriptUri = 'protokoll://transcript/test.md';
      const transcriptContext = {
        title: 'Test Transcript',
        path: 'relative/test.md',
        filename: '',
        uri: transcriptUri,
      };

      await provider.sendInlineMessage(message, transcriptUri, transcriptContext);
      
      const callArgs = mockOpenAIClient.streamChat.mock.calls[0];
      const systemMessage = callArgs[0][0];
      expect(systemMessage.content).toContain('relative/test.md');
    });

    it('should use title as fallback identifier', async () => {
      const message = 'Test message';
      const transcriptUri = 'protokoll://transcript/test.md';
      const transcriptContext = {
        title: 'Test Transcript',
        path: '/absolute/path/test.md',
        filename: '',
        uri: transcriptUri,
      };

      await provider.sendInlineMessage(message, transcriptUri, transcriptContext);
      
      const callArgs = mockOpenAIClient.streamChat.mock.calls[0];
      const systemMessage = callArgs[0][0];
      expect(systemMessage.content).toContain('Test Transcript');
    });
  });

  describe('sendInlineEntityMessage', () => {
    beforeEach(async () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';
      await provider.initializeOpenAI();
      process.env.OPENAI_API_KEY = originalEnv;
    });

    it('should send inline message with entity context', async () => {
      const message = 'Update entity';
      const entityUri = 'redaksjon://person/john-doe';
      const entityContext = {
        type: 'person',
        id: 'john-doe',
        name: 'John Doe',
        uri: entityUri,
      };

      const response = await provider.sendInlineEntityMessage(message, entityUri, entityContext);
      
      expect(response).toBe('Test response');
      expect(mockOpenAIClient.streamChat).toHaveBeenCalled();
    });

    it('should include entity context in system message', async () => {
      const message = 'Update entity';
      const entityUri = 'redaksjon://person/john-doe';
      const entityContext = {
        type: 'person',
        id: 'john-doe',
        name: 'John Doe',
        uri: entityUri,
      };

      await provider.sendInlineEntityMessage(message, entityUri, entityContext);
      
      const callArgs = mockOpenAIClient.streamChat.mock.calls[0];
      const systemMessage = callArgs[0][0];
      expect(systemMessage.content).toContain('john-doe');
      expect(systemMessage.content).toContain('John Doe');
      expect(systemMessage.content).toContain('person');
    });

    it('should initialize OpenAI if not already initialized', async () => {
      const newProvider = new ChatViewProvider(mockExtensionUri);
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      try {
        const message = 'Update entity';
        const entityUri = 'redaksjon://person/john-doe';
        const entityContext = {
          type: 'person',
          id: 'john-doe',
          name: 'John Doe',
          uri: entityUri,
        };

        await newProvider.sendInlineEntityMessage(message, entityUri, entityContext);
        
        expect(OpenAIClient).toHaveBeenCalled();
      } finally {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    });

    it('should throw error if OpenAI client fails to initialize', async () => {
      const newProvider = new ChatViewProvider(mockExtensionUri);
      const originalEnv = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        const message = 'Update entity';
        const entityUri = 'redaksjon://person/john-doe';
        const entityContext = {
          type: 'person',
          id: 'john-doe',
          name: 'John Doe',
          uri: entityUri,
        };

        await expect(newProvider.sendInlineEntityMessage(message, entityUri, entityContext)).rejects.toThrow();
      } finally {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    });

    it('should handle different entity types', async () => {
      const entityTypes = ['person', 'project', 'company', 'term'];
      
      for (const type of entityTypes) {
        const message = `Update ${type}`;
        const entityUri = `redaksjon://${type}/test-id`;
        const entityContext = {
          type,
          id: 'test-id',
          name: 'Test Entity',
          uri: entityUri,
        };

        await provider.sendInlineEntityMessage(message, entityUri, entityContext);
        
        const callArgs = mockOpenAIClient.streamChat.mock.calls[mockOpenAIClient.streamChat.mock.calls.length - 1];
        const systemMessage = callArgs[0][0];
        expect(systemMessage.content).toContain(type);
      }
    });
  });

  describe('showChat', () => {
    it('should be callable without parameters', async () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      try {
        // Should not throw
        await provider.showChat();
      } finally {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    });

    it('should accept initial message parameter', async () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      try {
        await provider.showChat('Initial message');
      } finally {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    });

    it('should accept transcript URI parameter', async () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      try {
        await provider.showChat('Message', 'protokoll://transcript/test.md');
      } finally {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    });

    it('should accept transcript context parameter', async () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      try {
        const transcriptContext = {
          title: 'Test',
          path: 'test.md',
          filename: 'test.md',
          uri: 'protokoll://transcript/test.md',
        };
        await provider.showChat('Message', 'protokoll://transcript/test.md', transcriptContext);
      } finally {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    });
  });
});
