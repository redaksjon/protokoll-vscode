/**
 * Chat View Provider
 * Custom chat interface integrated with Protokoll MCP tools via OpenAI
 */

import * as vscode from 'vscode';
import { McpClient } from './mcpClient';
import { OpenAIClient } from './openaiClient';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { Transcript } from './types';

interface TranscriptContext {
  title: string;
  path: string; // Path to transcript (can be relative or absolute)
  filename: string; // Exact filename (e.g., "02012026073646.md")
  uri: string;
}

export class ChatViewProvider {
  public static readonly viewType = 'protokoll.chat';

  private _panel: vscode.WebviewPanel | null = null;
  private _mcpClient: McpClient | null = null;
  private _openaiClient: OpenAIClient | null = null;
  private _messageHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private _openaiApiKey: string | null = null;
  private _currentTranscript: TranscriptContext | null = null;
  private _chatsViewProvider: any | null = null; // ChatsViewProvider type
  private _transcriptDetailProvider: { 
    getCurrentTranscript: (uri: string) => { uri: string; transcript: Transcript } | undefined;
    getAllOpenTranscripts?: () => Array<{ uri: string; transcript: Transcript }>;
  } | null = null;
  private _panelCounter: number = 0;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  /**
   * Set reference to chats view provider for panel tracking
   */
  setChatsViewProvider(provider: any): void {
    this._chatsViewProvider = provider;
  }

  /**
   * Set reference to transcript detail provider for context fallback
   */
  setTranscriptDetailProvider(provider: { 
    getCurrentTranscript: (uri: string) => { uri: string; transcript: Transcript } | undefined;
    getAllOpenTranscripts?: () => Array<{ uri: string; transcript: Transcript }>;
  }): void {
    this._transcriptDetailProvider = provider;
  }

  setClient(client: McpClient): void {
    this._mcpClient = client;
    if (this._openaiClient) {
      this._openaiClient.setMcpClient(client);
    }
  }

  async initializeOpenAI(): Promise<void> {
    // Get API key from environment
    const apiKey = process.env.OPENAI_API_KEY;
    
    if (!apiKey) {
      await vscode.window.showErrorMessage(
        'OPENAI_API_KEY not found in environment. Please set it to use the chat feature.',
        'OK'
      );
      throw new Error('OPENAI_API_KEY not configured');
    }

    this._openaiApiKey = apiKey;
    this._openaiClient = new OpenAIClient(apiKey);
    
    if (this._mcpClient) {
      this._openaiClient.setMcpClient(this._mcpClient);
    }

    // Discover available tools
    try {
      await this._openaiClient.discoverTools();
      console.log('Protokoll: Discovered tools for OpenAI chat');
    } catch (error) {
      console.warn('Protokoll: Failed to discover tools, using known tools:', error);
    }
  }

  /**
   * Send an inline message for an entity and get the response
   */
  public async sendInlineEntityMessage(
    message: string,
    entityUri: string,
    entityContext: { type: string; id: string; name: string; uri: string }
  ): Promise<string> {
    // Initialize OpenAI if needed
    if (!this._openaiClient) {
      await this.initializeOpenAI();
    }

    if (!this._openaiClient) {
      throw new Error('OpenAI client not initialized');
    }

    // Build system message with entity context
    const systemMessage: ChatCompletionMessageParam = {
      role: 'system',
      content: `You are helping the user edit a Protokoll entity.

=== CURRENT ENTITY (THE ONLY ENTITY FOR THIS CONVERSATION) ===
Type: ${entityContext.type}
ID: ${entityContext.id}
Name: ${entityContext.name}
URI: ${entityContext.uri}

=== MANDATORY RULES - FOLLOW THESE EXACTLY ===
1. This ENTIRE conversation is about ONLY ONE entity: the one listed above.
2. When the user makes ANY request (change name, edit description, update fields, etc.), you MUST use THIS entity.
3. When calling ANY Protokoll MCP tool that requires an entity identifier, you MUST use:
   - For person: personId="${entityContext.id}" or name="${entityContext.name}"
   - For project: projectId="${entityContext.id}" or name="${entityContext.name}"
   - For company: companyId="${entityContext.id}" or name="${entityContext.name}"
   - For term: termId="${entityContext.id}" or name="${entityContext.name}"
   DO NOT ask the user for the entity identifier - use "${entityContext.id}" or "${entityContext.name}" automatically.
4. NEVER ask "which entity" - there is only ONE entity for this conversation.
5. Execute the user's request immediately using the entity identifier above.`,
    };

    // Build messages array
    const openaiMessages: ChatCompletionMessageParam[] = [
      systemMessage,
      { role: 'user', content: message },
    ];

    // Get available tools
    const tools = this._openaiClient.getTools();

    // Stream response from OpenAI
    let assistantResponse = '';
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    for await (const chunk of this._openaiClient.streamChat(
      openaiMessages,
      tools,
      (toolName, args) => {
        toolCalls.push({ name: toolName, args });
        console.log(`Protokoll: [INLINE ENTITY CHAT] Tool called: ${toolName}`, args);
      }
    )) {
      assistantResponse += chunk;
    }

    return assistantResponse;
  }

  /**
   * Send an inline message and get the response (for inline chat in transcript/entity views)
   */
  public async sendInlineMessage(
    message: string,
    transcriptUri: string,
    transcriptContext: TranscriptContext
  ): Promise<string> {
    // Initialize OpenAI if needed
    if (!this._openaiClient) {
      await this.initializeOpenAI();
    }

    if (!this._openaiClient) {
      throw new Error('OpenAI client not initialized');
    }

    // Build system message with transcript context
    const transcriptIdentifier = transcriptContext.filename 
      || (transcriptContext.path && !transcriptContext.path.startsWith('/') && !transcriptContext.path.match(/^[A-Za-z]:/)
        ? transcriptContext.path 
        : null)
      || transcriptContext.title;

    const systemMessage: ChatCompletionMessageParam = {
      role: 'system',
      content: `You are helping the user review and improve a Protokoll transcript.

=== CURRENT TRANSCRIPT (THE ONLY TRANSCRIPT FOR THIS CONVERSATION) ===
Title: ${transcriptContext.title || 'Untitled'}
Filename: ${transcriptContext.filename || 'N/A'}
Path: ${transcriptContext.path || 'N/A'}
URI: ${transcriptContext.uri}

=== MANDATORY RULES - FOLLOW THESE EXACTLY ===
1. This ENTIRE conversation is about ONLY ONE transcript: the one listed above.
2. When the user makes ANY request (change title, edit, add tags, update, rename, etc.), you MUST use THIS transcript.
3. When calling ANY Protokoll MCP tool that requires a transcriptPath parameter, you MUST use:
   transcriptPath: "${transcriptIdentifier}"
   DO NOT ask the user for the transcript path - use "${transcriptIdentifier}" automatically.
4. NEVER ask "which transcript" - there is only ONE transcript for this conversation.
5. NEVER ask for the transcript filename or path - you already have it: "${transcriptIdentifier}"
6. If the user says "change the title" or "rename" or "edit", they mean THIS transcript.
7. Execute the user's request immediately using "${transcriptIdentifier}" as the transcriptPath.

Example: If user says "Change the title to X", immediately call protokoll_edit_transcript with transcriptPath="${transcriptIdentifier}" and title="X". Do NOT ask which transcript.`,
    };

    // Build messages array
    const openaiMessages: ChatCompletionMessageParam[] = [
      systemMessage,
      { role: 'user', content: message },
    ];

    // Get available tools
    const tools = this._openaiClient.getTools();

    // Stream response from OpenAI
    let assistantResponse = '';
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    for await (const chunk of this._openaiClient.streamChat(
      openaiMessages,
      tools,
      (toolName, args) => {
        toolCalls.push({ name: toolName, args });
        console.log(`Protokoll: [INLINE CHAT] Tool called: ${toolName}`, args);
      }
    )) {
      assistantResponse += chunk;
    }

    return assistantResponse;
  }

  public async showChat(initialMessage?: string, transcriptUri?: string, transcriptContext?: TranscriptContext): Promise<void> {
    console.log('Protokoll: [CHAT] showChat called', { 
      hasInitialMessage: !!initialMessage, 
      transcriptUri: transcriptUri || 'none',
      hasTranscriptContext: !!transcriptContext,
      hasPanel: !!this._panel 
    });

    // Initialize OpenAI if not already done
    if (!this._openaiClient) {
      console.log('Protokoll: [CHAT] Initializing OpenAI...');
      try {
        await this.initializeOpenAI();
        console.log('Protokoll: [CHAT] OpenAI initialized successfully');
      } catch (error) {
        console.error('Protokoll: [CHAT] Failed to initialize OpenAI:', error);
        vscode.window.showErrorMessage(
          `Failed to initialize OpenAI: ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }
    }

    // ALWAYS dispose existing panel and create a new one
    // This ensures each "Review Transcription" click opens a fresh chat
    if (this._panel) {
      console.log('Protokoll: [CHAT] Disposing existing panel to create fresh chat');
      this._panel.dispose();
      this._panel = null;
      this._messageHistory = [];
      this._currentTranscript = null;
    }

    // Set current transcript context AFTER disposing old panel
    if (transcriptContext) {
      this._currentTranscript = transcriptContext;
      console.log('Protokoll: [CHAT] Set transcript context for new panel:', {
        title: transcriptContext.title,
        filename: transcriptContext.filename,
        path: transcriptContext.path,
        uri: transcriptContext.uri
      });
    } else {
      console.log('Protokoll: [CHAT] No transcript context provided - chat will be generic');
    }

    console.log('Protokoll: [CHAT] Creating new panel...');

    // Generate unique panel ID
    this._panelCounter++;
    const panelId = `chat-${this._panelCounter}`;

    // Create new panel with transcript-aware title
    // If we have transcript context, use just the transcript title (more prominent)
    // Otherwise use generic "Protokoll Chat"
    const panelTitle = this._currentTranscript 
      ? (this._currentTranscript.title || 'Untitled Transcript')
      : 'Protokoll Chat';
    
    this._panel = vscode.window.createWebviewPanel(
      ChatViewProvider.viewType,
      panelTitle,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
    
    console.log('Protokoll: [CHAT] Created panel with ID:', panelId, 'title:', panelTitle);

    // Register with chats view
    if (this._chatsViewProvider) {
      this._chatsViewProvider.registerChat(panelId, panelTitle, transcriptUri);
      console.log('Protokoll: [CHAT] Registered chat in chats view');
    }

    // Initialize message history with welcome message BEFORE setting HTML
    // This ensures the transcript context is visible immediately when the panel opens
    if (!initialMessage) {
      console.log('Protokoll: [CHAT] Adding welcome message with transcript context');
      let welcomeMessage = 'Hello! I can help you review and improve Protokoll transcripts. I have access to Protokoll MCP tools.';
      if (this._currentTranscript) {
        welcomeMessage += `\n\n**Current Transcript: ${this._currentTranscript.title}**`;
        if (this._currentTranscript.filename) {
          welcomeMessage += `\n**File:** ${this._currentTranscript.filename}`;
        }
        if (this._currentTranscript.path) {
          welcomeMessage += `\n**Path:** ${this._currentTranscript.path}`;
        }
        welcomeMessage += `\n\nI'm ready to help you with this transcript. You can ask me to change the title, update content, add tags, assign projects, or answer questions about it. I'll automatically use this transcript for all operations unless you specify otherwise.`;
      } else {
        welcomeMessage += ' How can I help you today?';
      }
      this._messageHistory.push({
        role: 'assistant',
        content: welcomeMessage,
      });
      console.log('Protokoll: [CHAT] Welcome message added to history');
    }

    // Set initial content (webview will receive history via updateHistory message)
    this._panel.webview.html = this.getWebviewContent();

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        console.log('Protokoll: [CHAT] Received message from webview:', message.command);
        switch (message.command) {
          case 'sendMessage': {
            // Use sendMessage to ensure message is added to history
            // Always use current transcript URI if available
            const uriToUse = message.transcriptUri || this._currentTranscript?.uri;
            await this.sendMessage(message.text, uriToUse);
            break;
          }
          case 'clearHistory':
            console.log('Protokoll: [CHAT] Clearing message history');
            this._messageHistory = [];
            this.updateWebview();
            break;
        }
      },
      null
    );

    // Clean up on dispose
    this._panel.onDidDispose(
      () => {
        console.log('Protokoll: [CHAT] Panel disposed, clearing all state');
        this._panel = null;
        this._messageHistory = [];
        this._currentTranscript = null;
        
        // Unregister from chats view
        if (this._chatsViewProvider) {
          this._chatsViewProvider.unregisterChat(panelId);
          console.log('Protokoll: [CHAT] Unregistered chat from chats view');
        }
      },
      null
    );

    // Update webview immediately to show the welcome message
    // The HTML now includes the transcript context header, and this sends the message history
    this.updateWebview();
    console.log('Protokoll: [CHAT] Updated webview with initial state');

    // Send initial message if provided
    if (initialMessage) {
      console.log('Protokoll: [CHAT] Sending initial message to new panel');
      // Small delay to ensure panel is fully initialized
      await new Promise(resolve => setTimeout(resolve, 500));
      await this.sendMessage(initialMessage, transcriptUri);
    }
  }

  private async sendMessage(message: string, transcriptUri?: string): Promise<void> {
    console.log('Protokoll: [CHAT] sendMessage called');
    console.log('Protokoll: [CHAT] Message:', message.substring(0, 100));
    
    // Use current transcript URI if available, otherwise use provided one
    const uriToUse = transcriptUri || this._currentTranscript?.uri;
    console.log('Protokoll: [CHAT] Transcript URI:', uriToUse || 'none');

    if (!this._openaiClient) {
      console.error('Protokoll: [CHAT] OpenAI client not initialized');
      this.addAssistantMessage('Error: OpenAI client not initialized. Please check your OPENAI_API_KEY.');
      return;
    }

    // Enhance message with transcript context if we have a current transcript
    // Note: We don't need to prefix the message since the system message handles context
    // But we keep this for backward compatibility and visibility in message history
    let enhancedMessage = message;
    if (this._currentTranscript) {
      // Use relative path (sanitized) or filename - never absolute paths
      const transcriptPath = this._currentTranscript.path;
      const transcriptIdentifier = transcriptPath && !transcriptPath.startsWith('/') && !transcriptPath.match(/^[A-Za-z]:/)
        ? transcriptPath 
        : (this._currentTranscript.filename || this._currentTranscript.path || this._currentTranscript.title);
      
      enhancedMessage = `[Transcript: ${this._currentTranscript.title} (${transcriptIdentifier})]\n\n${message}`;
      console.log('Protokoll: [CHAT] Enhanced message with transcript context:', transcriptIdentifier);
    }

    // Add user message to history (store enhanced message so context is visible)
    console.log('Protokoll: [CHAT] Adding message to history. Current history length:', this._messageHistory.length);
    this._messageHistory.push({ role: 'user', content: enhancedMessage });
    console.log('Protokoll: [CHAT] Message added. New history length:', this._messageHistory.length);
    this.updateWebview();

    // Process the enhanced message with OpenAI and Protokoll tools
    await this.handleUserMessage(enhancedMessage, uriToUse);
  }

  private async handleUserMessage(message: string, transcriptUri?: string): Promise<void> {
    console.log('Protokoll: [CHAT] handleUserMessage called', {
      messageLength: message.length,
      messagePreview: message.substring(0, 100),
      historyLength: this._messageHistory.length,
      hasOpenAIClient: !!this._openaiClient,
      hasCurrentTranscript: !!this._currentTranscript,
      transcriptTitle: this._currentTranscript?.title,
      transcriptFilename: this._currentTranscript?.filename,
      transcriptPath: this._currentTranscript?.path,
    });

    if (!this._openaiClient) {
      console.error('Protokoll: [CHAT] OpenAI client not initialized');
      this.addAssistantMessage('Error: OpenAI client not initialized.');
      return;
    }
    
    // Warn if we don't have transcript context but should
    if (!this._currentTranscript && transcriptUri) {
      console.warn('Protokoll: [CHAT] WARNING: No transcript context but URI provided:', transcriptUri);
      console.warn('Protokoll: [CHAT] This may cause the AI to ask which transcript to use');
    }

    // Show thinking indicator
    this.showThinking(true);

    try {
      // Ensure the current message is in history (it should be added by sendMessage, but double-check)
      // Note: message here is already enhanced with transcript context from sendMessage
      const lastMessage = this._messageHistory[this._messageHistory.length - 1];
      if (!lastMessage || lastMessage.role !== 'user' || lastMessage.content !== message) {
        console.warn('Protokoll: [CHAT] Message not in history, adding it now');
        this._messageHistory.push({ role: 'user', content: message });
      }

      // Convert message history to OpenAI format
      // Add system message with transcript context if available
      const openaiMessages: ChatCompletionMessageParam[] = [];
      
      // CRITICAL: ALWAYS add system message with transcript context if we have ANY context
      // This ensures context is maintained even if panel was disposed and recreated
      if (this._currentTranscript) {
        // Prefer filename first (most reliable), then relative path, then fallback to title
        // The MCP tools can accept filename, partial filename, or relative path
        const transcriptIdentifier = this._currentTranscript.filename 
          || (this._currentTranscript.path && !this._currentTranscript.path.startsWith('/') && !this._currentTranscript.path.match(/^[A-Za-z]:/)
            ? this._currentTranscript.path 
            : null)
          || this._currentTranscript.title;
        
        if (!transcriptIdentifier) {
          console.error('Protokoll: [CHAT] ERROR: No transcript identifier available (filename, path, or title)');
          console.error('Protokoll: [CHAT] Transcript context:', JSON.stringify(this._currentTranscript, null, 2));
        } else {
          const systemMessage: ChatCompletionMessageParam = {
            role: 'system',
            content: `You are helping the user review and improve a Protokoll transcript.

=== CURRENT TRANSCRIPT (THE ONLY TRANSCRIPT FOR THIS CONVERSATION) ===
Title: ${this._currentTranscript.title || 'Untitled'}
Filename: ${this._currentTranscript.filename || 'N/A'}
Path: ${this._currentTranscript.path || 'N/A'}
URI: ${this._currentTranscript.uri}

=== MANDATORY RULES - FOLLOW THESE EXACTLY ===
1. This ENTIRE conversation is about ONLY ONE transcript: the one listed above.
2. When the user makes ANY request (change title, edit, add tags, update, rename, etc.), you MUST use THIS transcript.
3. When calling ANY Protokoll MCP tool that requires a transcriptPath parameter, you MUST use:
   transcriptPath: "${transcriptIdentifier}"
   DO NOT ask the user for the transcript path - use "${transcriptIdentifier}" automatically.
4. NEVER ask "which transcript" - there is only ONE transcript for this conversation.
5. NEVER ask for the transcript filename or path - you already have it: "${transcriptIdentifier}"
6. If the user says "change the title" or "rename" or "edit", they mean THIS transcript.
7. Execute the user's request immediately using "${transcriptIdentifier}" as the transcriptPath.

Example: If user says "Change the title to X", immediately call protokoll_edit_transcript with transcriptPath="${transcriptIdentifier}" and title="X". Do NOT ask which transcript.`,
          };
          openaiMessages.push(systemMessage);
          console.log('Protokoll: [CHAT] ✅ Added system message with transcript context');
          console.log('Protokoll: [CHAT] Using transcript identifier:', transcriptIdentifier);
          console.log('Protokoll: [CHAT] Full transcript context:', JSON.stringify(this._currentTranscript, null, 2));
        }
      } else if (transcriptUri) {
        // Fallback: add context if we have URI but no full context
        // Extract filename from URI if possible
        const uriMatch = transcriptUri.match(/transcript\/(.+)$/);
        const extractedFilename = uriMatch ? uriMatch[1] : null;
        const identifierToUse = extractedFilename || transcriptUri;
        
        const systemMessage: ChatCompletionMessageParam = {
          role: 'system',
          content: `You are helping the user with a Protokoll transcript.

=== CURRENT TRANSCRIPT (THE ONLY TRANSCRIPT FOR THIS CONVERSATION) ===
URI: ${transcriptUri}
${extractedFilename ? `Filename: ${extractedFilename}` : ''}

=== MANDATORY RULES - FOLLOW THESE EXACTLY ===
1. This ENTIRE conversation is about ONLY ONE transcript: the one listed above.
2. When the user makes ANY request (change title, edit, add tags, update, rename, etc.), you MUST use THIS transcript.
3. When calling ANY Protokoll MCP tool that requires a transcriptPath parameter, you MUST use:
   transcriptPath: "${identifierToUse}"
   DO NOT ask the user for the transcript path - use "${identifierToUse}" automatically.
4. NEVER ask "which transcript" - there is only ONE transcript for this conversation.
5. Execute the user's request immediately using "${identifierToUse}" as the transcriptPath.`,
        };
        openaiMessages.push(systemMessage);
        console.log('Protokoll: [CHAT] ✅ Added system message with transcript URI');
        console.log('Protokoll: [CHAT] Using transcript identifier from URI:', identifierToUse);
      } else {
        // No context at all - this should not happen if chat was opened from transcript view
        console.error('Protokoll: [CHAT] ⚠️ WARNING: No transcript context available!');
        console.error('Protokoll: [CHAT] _currentTranscript:', this._currentTranscript);
        console.error('Protokoll: [CHAT] transcriptUri:', transcriptUri);
      }
      
      // Convert message history to OpenAI format
      // IMPORTANT: System message is already added first above, so add user/assistant messages after
      this._messageHistory.forEach((msg, index) => {
        const converted: ChatCompletionMessageParam = msg.role === 'user' 
          ? { role: 'user', content: msg.content }
          : { role: 'assistant', content: msg.content };
        console.log(`Protokoll: [CHAT] Message ${index}:`, {
          role: converted.role,
          contentLength: typeof converted.content === 'string' ? converted.content.length : 'non-string',
          contentPreview: typeof converted.content === 'string' ? converted.content.substring(0, 50) : converted.content,
        });
        openaiMessages.push(converted);
      });
      
      // Log final message structure for debugging
      const systemMsg = openaiMessages.find(m => m.role === 'system');
      const systemContent = systemMsg?.content;
      const systemPreview = typeof systemContent === 'string' 
        ? systemContent.substring(0, 200) 
        : (Array.isArray(systemContent) ? `[array with ${systemContent.length} items]` : 'unknown');
      
      // CRITICAL CHECK: Ensure system message is present
      if (!systemMsg) {
        console.error('Protokoll: [CHAT] ❌ CRITICAL ERROR: No system message found in messages!');
        console.error('Protokoll: [CHAT] _currentTranscript:', this._currentTranscript);
        console.error('Protokoll: [CHAT] transcriptUri:', transcriptUri);
        console.error('Protokoll: [CHAT] All messages:', JSON.stringify(openaiMessages.map(m => ({ role: m.role })), null, 2));
      }
      
      console.log('Protokoll: [CHAT] Final OpenAI messages structure:', {
        totalMessages: openaiMessages.length,
        firstMessageRole: openaiMessages[0]?.role,
        hasSystemMessage: !!systemMsg,
        systemMessagePreview: systemPreview,
        systemMessageIncludesTranscript: systemPreview.includes('CURRENT TRANSCRIPT'),
      });

      // Log for debugging
      console.log('Protokoll: [CHAT] Message history length:', this._messageHistory.length);
      console.log('Protokoll: [CHAT] OpenAI messages length:', openaiMessages.length);
      console.log('Protokoll: [CHAT] Full message history:', JSON.stringify(this._messageHistory.map(m => ({
        role: m.role,
        contentLength: m.content.length,
      })), null, 2));
      
      if (openaiMessages.length === 0) {
        console.error('Protokoll: [CHAT] ERROR: Empty messages array! Message history:', JSON.stringify(this._messageHistory, null, 2));
        throw new Error('No messages to send. Message history is empty.');
      }

      // Validate messages have content
      // IMPORTANT: Never filter out system messages, even if they seem empty
      const validMessages = openaiMessages.filter(msg => {
        // Always keep system messages
        if (msg.role === 'system') {
          return true;
        }
        const hasContent = msg.content && (typeof msg.content === 'string' ? msg.content.trim().length > 0 : true);
        if (!hasContent) {
          console.warn('Protokoll: [CHAT] Skipping message with no content:', JSON.stringify(msg, null, 2));
        }
        return hasContent;
      });
      
      // Verify system message survived filtering
      const systemMsgAfterFilter = validMessages.find(m => m.role === 'system');
      if (!systemMsgAfterFilter && openaiMessages.find(m => m.role === 'system')) {
        console.error('Protokoll: [CHAT] ❌ CRITICAL ERROR: System message was filtered out!');
      }

      if (validMessages.length === 0) {
        console.error('Protokoll: [CHAT] ERROR: No valid messages after filtering! Original messages:', JSON.stringify(openaiMessages, null, 2));
        throw new Error('No valid messages to send. All messages are empty.');
      }

      console.log('Protokoll: [CHAT] Valid messages count:', validMessages.length);

      // Get available tools
      const tools = this._openaiClient.getTools();
      console.log('Protokoll: [CHAT] Available tools count:', tools.length);

      // Stream response from OpenAI
      let assistantResponse = '';
      const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

      console.log('Protokoll: [CHAT] Starting OpenAI stream...');
      for await (const chunk of this._openaiClient.streamChat(
        validMessages,
        tools,
        (toolName, args) => {
          // Track tool calls
          toolCalls.push({ name: toolName, args });
          console.log(`Protokoll: [CHAT] Tool called: ${toolName}`, args);
          // Update UI to show tool is being called
          this.updateWebview();
        }
      )) {
        assistantResponse += chunk;
        // Stream the response to the UI
        this.streamAssistantMessage(assistantResponse);
      }

      console.log('Protokoll: [CHAT] Stream completed. Response length:', assistantResponse.length);

      // Finalize the assistant message
      this.addAssistantMessage(assistantResponse);

      // Show tool calls if any were made
      if (toolCalls.length > 0) {
        const toolCallSummary = toolCalls.map(tc => `- Called ${tc.name}`).join('\n');
        console.log(`Protokoll: [CHAT] Tool calls made:\n${toolCallSummary}`);
      }
    } catch (error) {
      console.error('Protokoll: [CHAT] Error in handleUserMessage:', error);
      console.error('Protokoll: [CHAT] Error stack:', error instanceof Error ? error.stack : 'No stack');
      this.addAssistantMessage(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.showThinking(false);
    }
  }

  private streamAssistantMessage(content: string): void {
    // Update the last assistant message in history if it exists, otherwise add new one
    const lastMessage = this._messageHistory[this._messageHistory.length - 1];
    if (lastMessage && lastMessage.role === 'assistant') {
      lastMessage.content = content;
    } else {
      this._messageHistory.push({ role: 'assistant', content });
    }
    this.updateWebview();
  }

  private addAssistantMessage(content: string): void {
    // Check if we already have this content from streaming
    const lastMessage = this._messageHistory[this._messageHistory.length - 1];
    if (lastMessage && lastMessage.role === 'assistant' && lastMessage.content === content) {
      // Already there from streaming, no need to update
      return;
    }
    
    // Add or update assistant message
    if (lastMessage && lastMessage.role === 'assistant') {
      lastMessage.content = content;
    } else {
      this._messageHistory.push({ role: 'assistant', content });
    }
    this.updateWebview();
  }

  private showThinking(show: boolean): void {
    if (this._panel) {
      this._panel.webview.postMessage({
        command: 'showThinking',
        show,
      });
    }
  }

  private updateWebview(): void {
    if (this._panel) {
      this._panel.webview.postMessage({
        command: 'updateHistory',
        history: this._messageHistory,
        transcriptContext: this._currentTranscript,
      });
    }
  }

  private getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Protokoll Chat</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .chat-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        .message {
            display: flex;
            flex-direction: column;
            max-width: 80%;
            word-wrap: break-word;
        }
        .message.user {
            align-self: flex-end;
        }
        .message.assistant {
            align-self: flex-start;
        }
        .message-role {
            font-size: 0.85em;
            font-weight: 600;
            margin-bottom: 4px;
            color: var(--vscode-descriptionForeground);
        }
        .message.user .message-role {
            color: var(--vscode-textLink-foreground);
        }
        .message-content {
            padding: 12px 16px;
            border-radius: 8px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            white-space: pre-wrap;
            line-height: 1.5;
        }
        .message.user .message-content {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-button-background);
        }
        .message.assistant .message-content {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
        }
        .input-container {
            padding: 16px;
            border-top: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 8px;
        }
        .input-field {
            flex: 1;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px 12px;
            border-radius: 4px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
        .input-field:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        .send-button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: var(--vscode-font-size);
        }
        .send-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .send-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .thinking {
            display: none;
            padding: 12px 16px;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .thinking.show {
            display: block;
        }
        .clear-button {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: var(--vscode-font-size);
            margin-left: auto;
        }
        .clear-button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .transcript-context {
            padding: 12px 16px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
        }
        .transcript-context strong {
            color: var(--vscode-foreground);
        }
        .transcript-context .transcript-path {
            margin-top: 4px;
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
        }
        .transcript-context .transcript-path code {
            background-color: transparent;
            padding: 0;
            color: var(--vscode-textLink-foreground);
        }
        code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 4px;
            border-radius: 2px;
            font-family: var(--vscode-editor-font-family);
        }
        pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
        }
    </style>
</head>
<body>
    <div class="chat-container">
        <div class="transcript-context" id="transcriptContext" style="display: ${this._currentTranscript ? 'block' : 'none'};">
            <strong>Current Transcript:</strong> <span id="transcriptTitle">${this._currentTranscript?.title || ''}</span>
            <div class="transcript-path" id="transcriptPath" style="display: ${this._currentTranscript?.filename ? 'block' : 'none'};">
                <code>${this._currentTranscript?.filename || ''}</code>
            </div>
        </div>
        <div class="messages" id="messages">
            <!-- Messages will be populated by updateWebview -->
        </div>
        <div class="thinking" id="thinking">Thinking...</div>
        <div class="input-container">
            <input type="text" class="input-field" id="messageInput" placeholder="Type your message..." />
            <button class="send-button" id="sendButton">Send</button>
            <button class="clear-button" id="clearButton">Clear</button>
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const messagesContainer = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const clearButton = document.getElementById('clearButton');
        const thinking = document.getElementById('thinking');

        function addMessage(role, content) {
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${role}\`;
            
            const roleDiv = document.createElement('div');
            roleDiv.className = 'message-role';
            roleDiv.textContent = role === 'user' ? 'You' : 'Protokoll Assistant';
            
            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            contentDiv.textContent = content;
            
            messageDiv.appendChild(roleDiv);
            messageDiv.appendChild(contentDiv);
            messagesContainer.appendChild(messageDiv);
            
            // Scroll to bottom
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        let currentTranscriptUri = null;

        function sendMessage() {
            const text = messageInput.value.trim();
            if (!text) {
                return;
            }
            
            addMessage('user', text);
            messageInput.value = '';
            
            vscode.postMessage({
                command: 'sendMessage',
                text: text,
                transcriptUri: currentTranscriptUri
            });
        }

        sendButton.addEventListener('click', sendMessage);
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        clearButton.addEventListener('click', () => {
            vscode.postMessage({
                command: 'clearHistory'
            });
        });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'updateHistory':
                    messagesContainer.innerHTML = '';
                    message.history.forEach(msg => {
                        addMessage(msg.role, msg.content);
                    });
                    // Update transcript context display
                    if (message.transcriptContext) {
                        const contextDiv = document.getElementById('transcriptContext');
                        const titleSpan = document.getElementById('transcriptTitle');
                        const pathDiv = document.getElementById('transcriptPath');
                        if (contextDiv && titleSpan) {
                            contextDiv.style.display = 'block';
                            titleSpan.textContent = message.transcriptContext.title;
                            currentTranscriptUri = message.transcriptContext.uri;
                            
                            // Show path if available
                            if (pathDiv && message.transcriptContext.path) {
                                pathDiv.style.display = 'block';
                                pathDiv.innerHTML = \`Path: <code>\${message.transcriptContext.path}</code>\`;
                            } else if (pathDiv) {
                                pathDiv.style.display = 'none';
                            }
                        }
                    } else {
                        const contextDiv = document.getElementById('transcriptContext');
                        const pathDiv = document.getElementById('transcriptPath');
                        if (contextDiv) {
                            contextDiv.style.display = 'none';
                            if (pathDiv) {
                                pathDiv.style.display = 'none';
                            }
                            currentTranscriptUri = null;
                        }
                    }
                    break;
                case 'showThinking':
                    if (message.show) {
                        thinking.classList.add('show');
                    } else {
                        thinking.classList.remove('show');
                    }
                    break;
            }
        });
    </script>
</body>
</html>`;
  }
}
