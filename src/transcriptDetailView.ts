/**
 * Transcript Detail View Provider
 * Shows transcript metadata and text in a webview
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { McpClient } from './mcpClient';
import { ChatViewProvider } from './chatView';
import type { Transcript, TranscriptContent, TranscriptStatus } from './types';
import { shouldPassContextDirectory } from './serverMode';

/**
 * Track temp files opened for editing, mapping file path -> transcript info
 * Used by extension.ts to sync saves back to MCP
 */
export interface EditableTranscriptInfo {
  transcriptPath: string;
  transcriptUri: string;
  editTarget: 'enhanced' | 'original';
  originalContent: string;
  /** The header/metadata section (everything before and including the --- separator) */
  header: string;
  /** The original body content (for change detection) */
  originalBody: string;
}

interface SummaryConfig {
  title: string;
  audience: string;
  guidance: string;
  stylePreset: 'quick_bullets' | 'detailed' | 'attendee_facing';
  styleLabel: string;
}

interface GeneratedSummary {
  id: string;
  title: string;
  audience: string;
  guidance: string;
  stylePreset: SummaryConfig['stylePreset'];
  styleLabel: string;
  content: string;
  generatedAt: string;
}

interface TranscriptComment {
  id: string;
  text: string;
  createdAt: string;
  updatedAt?: string;
}

interface TaskCandidate {
  id: string;
  taskText: string;
  confidenceBucket: 'high' | 'medium' | 'low';
  rationale: string;
  suggestedDueDate?: string | null;
  suggestedProject?: { id?: string | null; name?: string | null };
  suggestedEntities?: Array<{ id: string; name: string; type: 'person' | 'project' | 'term' | 'company' }>;
  suggestedTags?: string[];
}

interface IdentifyTasksResult {
  candidates?: TaskCandidate[];
  totalCandidates?: number;
  message?: string;
}

const SUMMARY_TOOL_CANDIDATES = [
  'protokoll_summarize_transcript',
];

// Global map of temp file paths -> transcript info for save syncing
const editableTranscriptFiles: Map<string, EditableTranscriptInfo> = new Map();

export function getEditableTranscriptFiles(): Map<string, EditableTranscriptInfo> {
  return editableTranscriptFiles;
}

/**
 * Text Document Content Provider for transcript content
 * Provides transcript text content for virtual documents
 */
class TranscriptContentProvider implements vscode.TextDocumentContentProvider {
  private _contentCache: Map<string, string> = new Map();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();

  onDidChange?: vscode.Event<vscode.Uri> = this._onDidChange.event;

  setContentForUri(virtualUri: vscode.Uri, content: string): void {
    console.log(`Protokoll: [CONTENT PROVIDER] Setting content for URI: ${virtualUri.toString()}, path: ${virtualUri.path}`);
    // Store content by the virtual URI's path
    this._contentCache.set(virtualUri.path, content);
    // Also store by the full URI string for lookup
    this._contentCache.set(virtualUri.toString(), content);
    // Store normalized path (without trailing slash)
    const normalizedPath = virtualUri.path.replace(/\/$/, '');
    this._contentCache.set(normalizedPath, content);
    console.log(`Protokoll: [CONTENT PROVIDER] Content cached with keys: path=${virtualUri.path}, full=${virtualUri.toString()}, normalized=${normalizedPath}`);
    // Notify VS Code that the content has changed
    this._onDidChange.fire(virtualUri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    console.log(`Protokoll: [CONTENT PROVIDER] Requested URI: ${uri.toString()}, path: ${uri.path}`);
    console.log(`Protokoll: [CONTENT PROVIDER] Cache keys:`, Array.from(this._contentCache.keys()));
    
    // Try to get content by URI path first
    let content = this._contentCache.get(uri.path);
    if (content !== undefined) {
      console.log(`Protokoll: [CONTENT PROVIDER] Found content by path`);
      return content;
    }
    
    // Try by full URI string
    content = this._contentCache.get(uri.toString());
    if (content !== undefined) {
      console.log(`Protokoll: [CONTENT PROVIDER] Found content by full URI`);
      return content;
    }
    
    // Try normalized versions (with/without trailing slashes, etc.)
    const normalizedPath = uri.path.replace(/\/$/, '');
    content = this._contentCache.get(normalizedPath);
    if (content !== undefined) {
      console.log(`Protokoll: [CONTENT PROVIDER] Found content by normalized path`);
      return content;
    }
    
    // Try to extract transcript URI from path and look it up
    // URI format: protokoll-transcript://transcript/{encoded-transcript-uri}/{filename} (read only)
    const pathMatch = uri.path.match(/^\/transcript\/([^/]+)/);
    if (pathMatch) {
      const encodedUri = pathMatch[1];
      console.log(`Protokoll: [CONTENT PROVIDER] Extracted encoded URI: ${encodedUri}`);
      // Try to find content that was stored with this encoded URI
      for (const [key, value] of this._contentCache.entries()) {
        if (key.includes(encodedUri) || encodedUri.includes(key)) {
          console.log(`Protokoll: [CONTENT PROVIDER] Found content by partial match with key: ${key}`);
          return value;
        }
      }
    }
    
    console.warn(`Protokoll: [CONTENT PROVIDER] No content found for URI: ${uri.toString()}`);
    return '// Loading transcript content...';
  }
}

// Global content provider instance (will be registered in extension.ts)
let transcriptContentProvider: TranscriptContentProvider | null = null;

export function getTranscriptContentProvider(): TranscriptContentProvider {
  if (!transcriptContentProvider) {
    transcriptContentProvider = new TranscriptContentProvider();
  }
  return transcriptContentProvider;
}

export class TranscriptDetailViewProvider {
  public static readonly viewType = 'protokoll.transcriptDetail';
  private static readonly ENHANCE_TOOL_TIMEOUT_MS = 5 * 60 * 1000;

  private _panels: Map<string, vscode.WebviewPanel> = new Map();
  private _entityPanels: Map<string, vscode.WebviewPanel> = new Map(); // Track entity panels
  private _pendingEntityActions: Set<string> = new Set();
  private _client: McpClient | null = null;
  private getDefaultContextDirectory(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }
  private _chatProvider: ChatViewProvider | null = null;
  private _currentTranscripts: Map<string, { uri: string; transcript: Transcript }> = new Map();
  private _updatingTranscripts: Set<string> = new Set(); // Track transcripts being updated
  private _entityLastFetched: Map<string, Date> = new Map(); // Track when entities were last fetched
  private _transcriptLastFetched: Map<string, Date> = new Map(); // Track when transcripts were last fetched
  private _summaryConfigByTranscript: Map<string, SummaryConfig> = new Map();
  private _activeSummaryIdByTranscript: Map<string, string> = new Map();
  private _resolvedSummaryToolName: string | null = null;
  private _onTranscriptChanged?: (transcriptUri?: string, updates?: Partial<Transcript>) => void | Promise<void>;
  private _onEntityListChanged?: () => void | Promise<void>;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  /**
   * Called when a transcript's metadata changes (e.g. status) to update the list view.
   * When transcriptUri and updates are provided, enables in-place list updates
   * without a full re-fetch.
   */
  setOnTranscriptChanged(callback: (transcriptUri?: string, updates?: Partial<Transcript>) => void | Promise<void>): void {
    this._onTranscriptChanged = callback;
  }

  setOnEntityListChanged(callback: () => void | Promise<void>): void {
    this._onEntityListChanged = callback;
  }

  setChatProvider(chatProvider: ChatViewProvider): void {
    this._chatProvider = chatProvider;
  }

  private formatTranscriptPanelTitle(transcript: Transcript): string {
    const baseTitle = transcript.title || transcript.filename;
    if (transcript.serverName && transcript.serverName.trim().length > 0) {
      return `${baseTitle} [${transcript.serverName}]`;
    }
    return baseTitle;
  }

  private normalizeComment(raw: unknown): TranscriptComment | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const candidate = raw as Record<string, unknown>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
    const createdAt = typeof candidate.createdAt === 'string' ? candidate.createdAt : '';
    const updatedAt = typeof candidate.updatedAt === 'string' ? candidate.updatedAt : undefined;

    if (!id || !text || !createdAt) {
      return null;
    }

    return { id, text, createdAt, updatedAt };
  }

  private getCommentsFromMetadata(content: TranscriptContent): TranscriptComment[] {
    const comments = content.metadata?.comments ?? [];
    return comments
      .map((entry) => this.normalizeComment(entry))
      .filter((entry): entry is TranscriptComment => !!entry)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async getLatestComments(transcriptUri: string): Promise<TranscriptComment[]> {
    if (!this._client) {
      return [];
    }
    const latestContent = await this._client.readTranscript(transcriptUri);
    return this.getCommentsFromMetadata(latestContent);
  }

  private async saveCommentsForTranscript(
    panel: vscode.WebviewPanel,
    transcript: Transcript,
    transcriptUri: string,
    comments: TranscriptComment[],
    statusMessage: string
  ): Promise<void> {
    if (!this._client) {
      panel.webview.postMessage({ command: 'commentOperationFailed', message: 'MCP client not initialized.' });
      return;
    }

    try {
      const transcriptRef = this.getToolTranscriptPath(transcriptUri || transcript.uri || transcript.path, transcriptUri);
      const normalized = comments
        .map((entry) => this.normalizeComment(entry))
        .filter((entry): entry is TranscriptComment => !!entry)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      await this._client.callTool('protokoll_edit_transcript', {
        transcriptPath: transcriptRef,
        comments: normalized,
      });

      const commentsForUi = normalized.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      panel.webview.postMessage({
        command: 'commentsUpdated',
        comments: commentsForUi,
        statusMessage,
      });
      await this.refreshTranscript(transcriptUri);
      await vscode.commands.executeCommand('protokoll.refreshTranscripts');
    } catch (error) {
      panel.webview.postMessage({
        command: 'commentOperationFailed',
        message: `Failed to persist comments: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async handleAddComment(
    panel: vscode.WebviewPanel,
    transcript: Transcript,
    transcriptUri: string,
    existingComments: TranscriptComment[],
    rawText: unknown
  ): Promise<void> {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) {
      panel.webview.postMessage({ command: 'commentOperationFailed', message: 'Comment text cannot be empty.' });
      return;
    }
    const now = new Date().toISOString();
    const next = existingComments.concat([{
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      text,
      createdAt: now,
    }]);
    await this.saveCommentsForTranscript(panel, transcript, transcriptUri, next, 'Comment added.');
  }

  private async handleEditComment(
    panel: vscode.WebviewPanel,
    transcript: Transcript,
    transcriptUri: string,
    existingComments: TranscriptComment[],
    commentId: unknown,
    rawText: unknown
  ): Promise<void> {
    const id = typeof commentId === 'string' ? commentId.trim() : '';
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!id) {
      panel.webview.postMessage({ command: 'commentOperationFailed', message: 'Comment id is missing.' });
      return;
    }
    if (!text) {
      panel.webview.postMessage({ command: 'commentOperationFailed', message: 'Comment text cannot be empty.' });
      return;
    }

    let updated = false;
    const next = existingComments.map((comment) => {
      if (comment.id !== id) {
        return comment;
      }
      updated = true;
      return { ...comment, text, updatedAt: new Date().toISOString() };
    });
    if (!updated) {
      panel.webview.postMessage({ command: 'commentOperationFailed', message: 'Comment not found.' });
      return;
    }
    await this.saveCommentsForTranscript(panel, transcript, transcriptUri, next, 'Comment updated.');
  }

  private async handleDeleteComment(
    panel: vscode.WebviewPanel,
    transcript: Transcript,
    transcriptUri: string,
    existingComments: TranscriptComment[],
    commentId: unknown
  ): Promise<void> {
    const id = typeof commentId === 'string' ? commentId.trim() : '';
    if (!id) {
      panel.webview.postMessage({ command: 'commentOperationFailed', message: 'Comment id is missing.' });
      return;
    }
    const next = existingComments.filter((comment) => comment.id !== id);
    if (next.length === existingComments.length) {
      panel.webview.postMessage({ command: 'commentOperationFailed', message: 'Comment not found.' });
      return;
    }
    await this.saveCommentsForTranscript(panel, transcript, transcriptUri, next, 'Comment deleted.');
  }

  /**
   * Get current transcript for a URI (for external access)
   */
  getCurrentTranscript(uri: string): { uri: string; transcript: Transcript } | undefined {
    return this._currentTranscripts.get(uri);
  }

  /**
   * Get all currently open transcripts (for context fallback)
   */
  getAllOpenTranscripts(): Array<{ uri: string; transcript: Transcript }> {
    return Array.from(this._currentTranscripts.values());
  }

  /**
   * Refresh a specific transcript view
   */
  async refreshTranscript(transcriptUri: string): Promise<void> {
    const currentTranscript = this._currentTranscripts.get(transcriptUri);
    if (!currentTranscript || !this._client) {
      return;
    }

    const panel = this._panels.get(transcriptUri);
    if (!panel) {
      return;
    }

    // Check if panel is disposed
    try {
      // Try to access the panel - this will throw if disposed
      panel.title;
    } catch (error) {
      // Panel is disposed, clean up and return
      console.log(`Protokoll: Panel for ${transcriptUri} is disposed during refresh, cleaning up`);
      this._panels.delete(transcriptUri);
      this._currentTranscripts.delete(transcriptUri);
      return;
    }

    // Show update indicator
    this._updatingTranscripts.add(transcriptUri);
    this.showUpdateIndicator(panel, true);

    try {
      // Re-read the transcript to get updated data
      const content: TranscriptContent = await this._client.readTranscript(transcriptUri);
      
      // Track when transcript was fetched
      this._transcriptLastFetched.set(transcriptUri, new Date());
      
      // Update the stored transcript with fresh data from structured response
      const updatedTranscript = { ...currentTranscript.transcript };
      
      // Use structured metadata from server - no parsing needed
      if (content.metadata.entities) {
        updatedTranscript.entities = {
          ...updatedTranscript.entities,
          ...content.metadata.entities,
        };
      }
      
      // Update stored transcript
      this._currentTranscripts.set(transcriptUri, {
        uri: transcriptUri,
        transcript: updatedTranscript,
      });
      
      // Update the panel with fresh content
      const lastFetched = this._transcriptLastFetched.get(transcriptUri);
      panel.webview.html = this.getWebviewContent(updatedTranscript, content, lastFetched);
    } catch (error) {
      console.error(`Protokoll: Error refreshing transcript ${transcriptUri}:`, error);
      
      // If the error suggests the resource doesn't exist (e.g., 404 or "not found"),
      // the transcript might have been renamed. Try to find it in the transcripts list.
      const errorMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (errorMessage.includes('not found') || errorMessage.includes('404') || errorMessage.includes('does not exist')) {
        console.log(`Protokoll: [TRANSCRIPT VIEW] Transcript might have been renamed, searching for new URI...`);
        try {
          // Try to find the transcript by matching date/time or other metadata
          if (this._client) {
            const transcriptsList = await this._client.listTranscripts({ limit: 100 });
            
            // Try to find a matching transcript by date/time
            const matchingTranscript = transcriptsList.transcripts.find(t => {
              // Match by date and time if available
              if (currentTranscript.transcript.date && t.date === currentTranscript.transcript.date) {
                if (currentTranscript.transcript.time && t.time) {
                  return t.time === currentTranscript.transcript.time;
                }
                return true; // Date matches, time might not be available
              }
              return false;
            });
            
            if (matchingTranscript) {
              console.log(`Protokoll: [TRANSCRIPT VIEW] ✅ Found renamed transcript: ${matchingTranscript.uri}`);
              
              // Update tracking with new URI
              this._currentTranscripts.delete(transcriptUri);
              this._panels.delete(transcriptUri);
              
              this._currentTranscripts.set(matchingTranscript.uri, {
                uri: matchingTranscript.uri,
                transcript: matchingTranscript,
              });
              this._panels.set(matchingTranscript.uri, panel);
              
              // Update panel title
              panel.title = this.formatTranscriptPanelTitle(matchingTranscript);
              
              // Unsubscribe from old URI and subscribe to new URI
              try {
                await this._client.unsubscribeFromResource(transcriptUri);
                await this._client.subscribeToResource(matchingTranscript.uri);
              } catch (subError) {
                console.warn(`Protokoll: [TRANSCRIPT VIEW] ⚠️ Error updating subscriptions:`, subError);
              }
              
              // Refresh with new URI
              const newContent = await this._client.readTranscript(matchingTranscript.uri);
              panel.webview.html = this.getWebviewContent(matchingTranscript, newContent);
              return;
            } else {
              console.warn(`Protokoll: [TRANSCRIPT VIEW] ⚠️ Could not find renamed transcript in list`);
            }
          }
        } catch (searchError) {
          console.error(`Protokoll: [TRANSCRIPT VIEW] Error searching for renamed transcript:`, searchError);
        }
      }
    } finally {
      // Hide update indicator after a short delay
      setTimeout(() => {
        this._updatingTranscripts.delete(transcriptUri);
        this.showUpdateIndicator(panel, false);
      }, 500);
    }
  }

  /**
   * Show or hide update indicator in the webview
   */
  private showUpdateIndicator(panel: vscode.WebviewPanel, show: boolean): void {
    panel.webview.postMessage({
      command: 'showUpdateIndicator',
      show: show,
    });
  }

  private getPanelTranscriptUri(panel: vscode.WebviewPanel, fallbackUri: string): string {
    for (const [uri, existingPanel] of this._panels.entries()) {
      if (existingPanel === panel) {
        return uri;
      }
    }
    return fallbackUri;
  }

  setClient(client: McpClient): void {
    this._client = client;
    
    // Register callback to re-subscribe to all open transcripts after session recovery
    if (client) {
      client.onSessionRecovered(async () => {
        console.log('Protokoll: [TRANSCRIPT VIEW] Session recovered, re-subscribing to open transcripts...');
        const openTranscriptUris = Array.from(this._currentTranscripts.keys());
        console.log(`Protokoll: [TRANSCRIPT VIEW] Found ${openTranscriptUris.length} open transcript(s) to re-subscribe`);
        
        for (const transcriptUri of openTranscriptUris) {
          try {
            await client.subscribeToResource(transcriptUri);
            console.log(`Protokoll: [TRANSCRIPT VIEW] ✅ Re-subscribed to transcript: ${transcriptUri}`);
          } catch (error) {
            console.warn(`Protokoll: [TRANSCRIPT VIEW] ⚠️ Failed to re-subscribe to ${transcriptUri}:`, error);
          }
        }
      });
    }
  }

  public async showTranscript(transcriptUri: string, transcript: Transcript, viewColumn?: vscode.ViewColumn, openInNewTab: boolean = false): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    const targetColumn = viewColumn || vscode.ViewColumn.One;

    // Check if a panel already exists for this transcript
    let panel = this._panels.get(transcriptUri);

    // Check if panel exists and is not disposed
    if (panel && !openInNewTab) {
      try {
        // Try to access the panel - this will throw if disposed
        panel.title = this.formatTranscriptPanelTitle(transcript);
        panel.reveal(targetColumn);
        // Refresh the content in case it changed
        try {
          const content: TranscriptContent = await this._client.readTranscript(transcriptUri);
          panel.webview.html = this.getWebviewContent(transcript, content);
        } catch (error) {
          console.error(`Protokoll: Error refreshing transcript ${transcriptUri}:`, error);
          panel.webview.html = this.getErrorContent(
            error instanceof Error ? error.message : String(error)
          );
        }
        return;
      } catch (error) {
        // Panel is disposed, remove it from the map and create a new one
        console.log(`Protokoll: Panel for ${transcriptUri} is disposed, creating new one`);
        this._panels.delete(transcriptUri);
        this._currentTranscripts.delete(transcriptUri);
        panel = undefined;
      }
    }

    // Create a new panel (either because one doesn't exist or openInNewTab is true)
    panel = vscode.window.createWebviewPanel(
      TranscriptDetailViewProvider.viewType,
      this.formatTranscriptPanelTitle(transcript),
      targetColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    // Store the panel
    this._panels.set(transcriptUri, panel);

    // Store current transcript for refresh after changes
    this._currentTranscripts.set(transcriptUri, { uri: transcriptUri, transcript });

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
      async (message) => {
        if (!this._client) {
          vscode.window.showErrorMessage('MCP client not initialized');
          return;
        }

        const activeTranscriptUri = this.getPanelTranscriptUri(panel, transcriptUri);
        const currentTranscript = this._currentTranscripts.get(activeTranscriptUri);
        if (!currentTranscript) {
          return;
        }

        switch (message.command) {
          case 'changeProject':
            // Defer to next tick so QuickPick can receive focus (webview focus workaround)
            setTimeout(() => {
              this.handleChangeProject(currentTranscript.transcript, activeTranscriptUri);
            }, 0);
            break;
          case 'changeDate':
            await this.handleChangeDate(
              currentTranscript.transcript,
              message.transcriptPath,
              activeTranscriptUri,
              message.newDate,
            );
            break;
          case 'addTag':
            await this.handleAddTag(currentTranscript.transcript, message.transcriptPath, activeTranscriptUri);
            break;
          case 'removeTag':
            await this.handleRemoveTag(currentTranscript.transcript, message.transcriptPath, message.tag, activeTranscriptUri);
            break;
          case 'editTitle':
            await this.handleEditTitle(currentTranscript.transcript, message.transcriptPath, message.newTitle, activeTranscriptUri);
            break;
          case 'editTranscript':
            await this.handleEditTranscript(
              currentTranscript.transcript,
              message.transcriptPath,
              message.newContent,
              activeTranscriptUri,
              'enhanced'
            );
            break;
          case 'saveOriginalContent':
            await this.handleEditTranscript(
              currentTranscript.transcript,
              message.transcriptPath,
              message.newContent,
              activeTranscriptUri,
              'original'
            );
            break;
          case 'enhanceFromOriginal':
            await this.handleEnhanceFromOriginal(
              currentTranscript.transcript,
              message.transcriptPath,
              message.originalText,
              message.hasExistingEnhanced,
              activeTranscriptUri
            );
            break;
          case 'openEntity':
            await this.handleOpenEntity(message.entityType, message.entityId);
            break;
          case 'pickEntityReference':
            await this.handlePickEntityReference(panel, currentTranscript.transcript, message.entityType);
            break;
          case 'saveEntityReferences':
            await this.handleSaveEntityReferences(
              panel,
              currentTranscript.transcript,
              activeTranscriptUri,
              message.entities
            );
            break;
          case 'showUpdateIndicator':
            // This is handled by the webview itself, but we can acknowledge it
            break;
          case 'reviewTranscription':
            await this.handleReviewTranscription(currentTranscript.transcript, message.transcriptUri || activeTranscriptUri);
            break;
          case 'startChatFromInput':
            await this.handleStartChatFromInput(currentTranscript.transcript, message.message, message.transcriptUri || activeTranscriptUri);
            break;
          case 'openSource':
            await this.handleOpenSource(currentTranscript.transcript, message.transcriptPath, message.transcriptUri || activeTranscriptUri);
            break;
          case 'editInEditor':
            await this.handleEditInEditor(
              currentTranscript.transcript,
              message.transcriptPath,
              message.transcriptUri || activeTranscriptUri,
              message.editTarget === 'original' ? 'original' : 'enhanced'
            );
            break;
          case 'createEntityFromSelection':
            await this.handleCreateEntityFromSelection(message.selectedText, message.transcriptUri || activeTranscriptUri);
            break;
          case 'loadEnhancementLog':
            await this.handleLoadEnhancementLog(panel, message.transcriptPath, activeTranscriptUri);
            break;
          case 'rejectCorrection': {
            const correctionEntryId = Number(message.correctionEntryId);
            if (!Number.isInteger(correctionEntryId) || correctionEntryId < 1) {
              vscode.window.showErrorMessage('Invalid correction entry id');
              break;
            }
            const activeTranscriptPathCandidate = currentTranscript.transcript.uri
              || message.transcriptPath
              || currentTranscript.transcript.path;
            if (!activeTranscriptPathCandidate) {
              vscode.window.showErrorMessage('Transcript reference is missing');
              break;
            }
            const activeTranscriptPath = this.getToolTranscriptPath(
              activeTranscriptPathCandidate,
              currentTranscript.transcript.uri || activeTranscriptUri
            );
            await this.handleRejectCorrection(activeTranscriptPath, correctionEntryId, activeTranscriptUri);
            break;
          }
          case 'requestRejectCorrection': {
            const correctionEntryId = Number(message.correctionEntryId);
            if (!Number.isInteger(correctionEntryId) || correctionEntryId < 1) {
              vscode.window.showErrorMessage('Invalid correction entry id');
              break;
            }
            const activeTranscriptPathCandidate = currentTranscript.transcript.uri
              || message.transcriptPath
              || currentTranscript.transcript.path;
            if (!activeTranscriptPathCandidate) {
              vscode.window.showErrorMessage('Transcript reference is missing');
              break;
            }
            const activeTranscriptPath = this.getToolTranscriptPath(
              activeTranscriptPathCandidate,
              currentTranscript.transcript.uri || activeTranscriptUri
            );
            await this.handleRejectCorrectionWithConfirmation(
              panel,
              activeTranscriptPath,
              correctionEntryId,
              activeTranscriptUri
            );
            break;
          }
          case 'refreshTranscript': {
            await this.refreshTranscript(activeTranscriptUri);
            const refreshPanel = this._panels.get(activeTranscriptUri);
            if (refreshPanel) {
              refreshPanel.webview.postMessage({ command: 'refreshComplete' });
            }
            break;
          }
          case 'changeStatus':
            await this.handleChangeStatus(currentTranscript.transcript, message.transcriptPath, activeTranscriptUri);
            break;
          case 'addTask':
            await this.handleAddTask(currentTranscript.transcript, message.transcriptPath, activeTranscriptUri);
            break;
          case 'identifyTasks':
            await this.handleIdentifyTasks(currentTranscript.transcript, message.transcriptPath, activeTranscriptUri);
            break;
          case 'completeTask':
            await this.handleCompleteTask(currentTranscript.transcript, message.transcriptPath, message.taskId, activeTranscriptUri);
            break;
          case 'deleteTask':
            await this.handleDeleteTask(currentTranscript.transcript, message.transcriptPath, message.taskId, activeTranscriptUri);
            break;
          case 'startSummarySetup':
            await this.handleStartSummarySetup(currentTranscript.transcript, activeTranscriptUri);
            break;
          case 'generateSummary':
            await this.handleGenerateSummary(message.transcriptPath, activeTranscriptUri);
            break;
          case 'deleteSummary':
            await this.handleDeleteSummary(message.transcriptPath, activeTranscriptUri, message.summaryId);
            break;
          case 'addComment': {
            const existingComments = await this.getLatestComments(activeTranscriptUri);
            await this.handleAddComment(panel, currentTranscript.transcript, activeTranscriptUri, existingComments, message.text);
            break;
          }
          case 'editComment': {
            const existingComments = await this.getLatestComments(activeTranscriptUri);
            await this.handleEditComment(
              panel,
              currentTranscript.transcript,
              activeTranscriptUri,
              existingComments,
              message.commentId,
              message.text
            );
            break;
          }
          case 'deleteComment': {
            const existingComments = await this.getLatestComments(activeTranscriptUri);
            await this.handleDeleteComment(panel, currentTranscript.transcript, activeTranscriptUri, existingComments, message.commentId);
            break;
          }
        }
      },
      null
    );

    panel.onDidDispose(async () => {
      const activeTranscriptUri = this.getPanelTranscriptUri(panel, transcriptUri);
      // Unsubscribe from this transcript when panel is closed
      console.log(`Protokoll: [TRANSCRIPT VIEW] Panel disposed, unsubscribing from: ${activeTranscriptUri}`);
      if (this._client) {
        try {
          await this._client.unsubscribeFromResource(activeTranscriptUri);
          console.log(`Protokoll: [TRANSCRIPT VIEW] ✅ Unsubscribed from transcript: ${activeTranscriptUri}`);
        } catch (error) {
          console.error(`Protokoll: [TRANSCRIPT VIEW] ❌ Failed to unsubscribe from transcript:`, error);
        }
      } else {
        console.warn(`Protokoll: [TRANSCRIPT VIEW] ⚠️ No client available to unsubscribe`);
      }
      
      this._panels.delete(activeTranscriptUri);
      this._currentTranscripts.delete(activeTranscriptUri);
    }, null);

    // Subscribe to this transcript for change notifications
    console.log(`Protokoll: [TRANSCRIPT VIEW] Subscribing to transcript for change notifications: ${transcriptUri}`);
    try {
      await this._client.subscribeToResource(transcriptUri);
      console.log(`Protokoll: [TRANSCRIPT VIEW] ✅ Successfully subscribed to transcript: ${transcriptUri}`);
    } catch (error) {
      console.warn(`Protokoll: [TRANSCRIPT VIEW] ⚠️ Failed to subscribe to transcript ${transcriptUri}:`, error);
      // Continue anyway - subscription failure shouldn't prevent viewing
    }

    // Load transcript content
    try {
      const content: TranscriptContent = await this._client.readTranscript(transcriptUri);
      
      // Track when transcript was fetched
      this._transcriptLastFetched.set(transcriptUri, new Date());
      
      // Debug: Log if content is empty
      if (!content.content || content.content.trim().length === 0) {
        console.warn(`Protokoll: Empty content for transcript ${transcriptUri}`);
      }
      
      const lastFetched = this._transcriptLastFetched.get(transcriptUri);
      panel.webview.html = this.getWebviewContent(transcript, content, lastFetched);
    } catch (error) {
      console.error(`Protokoll: Error loading transcript ${transcriptUri}:`, error);
      panel.webview.html = this.getErrorContent(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async handleStartSummarySetup(transcript: Transcript, transcriptUri: string): Promise<void> {
    const panel = this._panels.get(transcriptUri);
    if (!panel) {
      return;
    }

    const existingConfig = this.getSummaryConfig(transcriptUri) || this.getDefaultSummaryConfig();
    const defaultTitle = existingConfig.title || 'Summary';
    const titleInput = await vscode.window.showInputBox({
      title: 'Summary Setup',
      prompt: 'Summary title (optional)',
      placeHolder: defaultTitle,
      value: defaultTitle,
      ignoreFocusOut: true,
    });
    if (titleInput === undefined) {
      return;
    }

    const audienceInput = await vscode.window.showInputBox({
      title: 'Summary Setup',
      prompt: 'Who is the summary for? (optional)',
      placeHolder: 'e.g., Gerald Corson, Internal team, Project attendees',
      value: existingConfig.audience,
      ignoreFocusOut: true,
    });
    if (audienceInput === undefined) {
      return;
    }

    const noteInput = await vscode.window.showInputBox({
      title: 'Summary Setup',
      prompt: 'Guidance note (optional)',
      placeHolder: 'e.g., Exclude internal reflections and sensitive personal notes',
      value: existingConfig.guidance,
      ignoreFocusOut: true,
    });
    if (noteInput === undefined) {
      return;
    }

    const stylePick = await vscode.window.showQuickPick([
      {
        label: 'Quick paragraph + bullet points',
        description: 'Concise overview with key bullets',
        value: 'quick_bullets',
      },
      {
        label: 'Detailed summary',
        description: 'More context and nuance',
        value: 'detailed',
      },
      {
        label: 'Attendee-facing summary',
        description: 'External/shareable wording',
        value: 'attendee_facing',
      },
    ], {
      title: 'Summary Setup',
      placeHolder: 'Choose summary style',
      ignoreFocusOut: true,
    });
    if (!stylePick) {
      return;
    }

    const summaryConfig: SummaryConfig = {
      title: (titleInput || '').trim() || existingConfig.title || defaultTitle,
      audience: (audienceInput || '').trim() || existingConfig.audience,
      guidance: (noteInput || '').trim(),
      stylePreset: stylePick.value as SummaryConfig['stylePreset'],
      styleLabel: stylePick.label,
    };
    this.setSummaryConfig(transcriptUri, summaryConfig);

    panel.webview.postMessage({
      command: 'summarySetupReady',
      summaryConfig,
    });

    vscode.window.showInformationMessage('Summary setup captured.');
  }

  private async handleGenerateSummary(
    transcriptPath: string,
    transcriptUri: string
  ): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    const summaryConfig = this.getSummaryConfig(transcriptUri) || this.getDefaultSummaryConfig();
    this.setSummaryConfig(transcriptUri, summaryConfig);

    const panel = this._panels.get(transcriptUri);
    if (panel) {
      this._updatingTranscripts.add(transcriptUri);
      this.showUpdateIndicator(panel, true);
    }

    try {
      const summaryToolName = await this.resolveSummaryToolName();
      const result = await this._client.callTool(summaryToolName, {
        transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
        audience: summaryConfig.audience,
        guidance: summaryConfig.guidance,
        stylePreset: summaryConfig.stylePreset,
        summaryTitle: summaryConfig.title,
      }) as {
        summary?: string;
        content?: string;
        text?: string;
        summaryId?: string;
        generatedAt?: string;
      } | string;

      const summaryContent = typeof result === 'string'
        ? result
        : (result.summary || result.content || result.text || '').trim();

      if (!summaryContent) {
        throw new Error(`No summary text returned by ${summaryToolName}`);
      }

      if (typeof result !== 'string' && result.summaryId) {
        this.setActiveSummaryId(transcriptUri, result.summaryId);
      }

      await this.refreshTranscript(transcriptUri);
      vscode.window.showInformationMessage('Summary generated.');
    } catch (error) {
      if (panel) {
        panel.webview.postMessage({
          command: 'summaryGenerationFailed',
        });
      }
      vscode.window.showErrorMessage(
        `Failed to generate summary: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (panel) {
        this._updatingTranscripts.delete(transcriptUri);
        this.showUpdateIndicator(panel, false);
      }
    }
  }

  private async handleDeleteSummary(
    transcriptPath: string,
    transcriptUri: string,
    summaryId: string
  ): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    if (!summaryId) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      'Delete this summary?',
      { modal: false },
      'Delete'
    );
    if (confirm !== 'Delete') {
      return;
    }

    const panel = this._panels.get(transcriptUri);
    if (panel) {
      this._updatingTranscripts.add(transcriptUri);
      this.showUpdateIndicator(panel, true);
    }
    try {
      await this._client.callTool('protokoll_delete_transcript_summary', {
        transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
        summaryId,
      });
      await this.refreshTranscript(transcriptUri);
      vscode.window.showInformationMessage('Summary deleted.');
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to delete summary: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (panel) {
        this._updatingTranscripts.delete(transcriptUri);
        this.showUpdateIndicator(panel, false);
      }
    }
  }

  /**
   * Convert an absolute path to a relative path for the server
   * Extracts the relative portion after '/notes/' or returns the path as-is if already relative
   */
  private convertToRelativePath(absolutePath: string): string {
    if (!absolutePath || absolutePath.trim().length === 0) {
      throw new Error('Transcript reference is missing');
    }

    // If it's already a relative path (doesn't start with / and no drive letter), return as-is
    if (!absolutePath.startsWith('/') && !absolutePath.match(/^[A-Za-z]:/)) {
      return absolutePath;
    }

    // Try to extract the relative portion after '/notes/'
    const notesIndex = absolutePath.indexOf('/notes/');
    if (notesIndex >= 0) {
      const relativePath = absolutePath.substring(notesIndex + '/notes/'.length);
      // Remove leading slashes
      return relativePath.replace(/^[/\\]+/, '');
    }

    // If no '/notes/' found, try to extract just the filename or last few path segments
    // Look for patterns like "2026/2/file.md" in the path
    const pathParts = absolutePath.split(/[/\\]/);
    // Try to find a year pattern (4 digits) and extract from there
    const yearIndex = pathParts.findIndex(part => /^\d{4}$/.test(part));
    if (yearIndex >= 0 && yearIndex < pathParts.length - 1) {
      return pathParts.slice(yearIndex).join('/');
    }

    // Keep absolute path as-is instead of degrading to filename-only fallback.
    return absolutePath;
  }

  private getToolTranscriptPath(transcriptPath: string, transcriptUri?: string): string {
    if (transcriptUri && transcriptUri.startsWith('protokoll://transcript/')) {
      return this.canonicalizeTranscriptUri(transcriptUri);
    }
    if (transcriptPath && transcriptPath.startsWith('protokoll://transcript/')) {
      return this.canonicalizeTranscriptUri(transcriptPath);
    }
    if (!transcriptPath || transcriptPath.trim().length === 0) {
      throw new Error('Transcript reference is missing');
    }
    return this.convertToRelativePath(transcriptPath);
  }

  private canonicalizeTranscriptUri(uri: string): string {
    if (!uri) {
      return uri;
    }
    return uri.replace(/^protokoll:\/\/transcript\/\.\.\//, 'protokoll://transcript/');
  }

  private getDefaultSummaryConfig(): SummaryConfig {
    return {
      title: 'Summary',
      audience: 'General audience',
      guidance: '',
      stylePreset: 'detailed',
      styleLabel: 'Detailed summary',
    };
  }

  private getSummaryConfig(transcriptUri: string): SummaryConfig | undefined {
    return this._summaryConfigByTranscript.get(transcriptUri)
      || this._summaryConfigByTranscript.get(this.canonicalizeTranscriptUri(transcriptUri));
  }

  private setSummaryConfig(transcriptUri: string, config: SummaryConfig): void {
    const canonical = this.canonicalizeTranscriptUri(transcriptUri);
    this._summaryConfigByTranscript.set(transcriptUri, config);
    this._summaryConfigByTranscript.set(canonical, config);
  }

  private getActiveSummaryId(transcriptUri: string): string | undefined {
    return this._activeSummaryIdByTranscript.get(transcriptUri)
      || this._activeSummaryIdByTranscript.get(this.canonicalizeTranscriptUri(transcriptUri));
  }

  private async resolveSummaryToolName(): Promise<string> {
    if (!this._client) {
      throw new Error('MCP client not initialized');
    }
    if (this._resolvedSummaryToolName) {
      return this._resolvedSummaryToolName;
    }

    const tools = await this._client.listTools();
    const availableNames = new Set(tools.map((tool) => tool.name));
    const resolved = SUMMARY_TOOL_CANDIDATES.find((candidate) => availableNames.has(candidate));
    if (!resolved) {
      const summaryLikeTools = tools
        .map((tool) => tool.name)
        .filter((name) => name.includes('summary') || name.includes('summarize'));
      const discoveryHint = summaryLikeTools.length > 0
        ? `Available summary-like tools: ${summaryLikeTools.join(', ')}`
        : 'No summary-like tools were published by this MCP server.';
      throw new Error(
        `Missing summary tool. Expected one of: ${SUMMARY_TOOL_CANDIDATES.join(', ')}. ${discoveryHint}`
      );
    }

    this._resolvedSummaryToolName = resolved;
    return resolved;
  }

  private setActiveSummaryId(transcriptUri: string, summaryId: string): void {
    const canonical = this.canonicalizeTranscriptUri(transcriptUri);
    this._activeSummaryIdByTranscript.set(transcriptUri, summaryId);
    this._activeSummaryIdByTranscript.set(canonical, summaryId);
  }

  private normalizePersistedSummaries(summaries: TranscriptContent['summaries']): GeneratedSummary[] {
    if (!Array.isArray(summaries)) {
      return [];
    }
    return summaries
      .map((summary) => {
        if (!summary || typeof summary !== 'object') {
          return null;
        }
        const id = String(summary.id || '').trim();
        const content = String(summary.content || '').trim();
        if (!id || !content) {
          return null;
        }
        return {
          id,
          title: String(summary.title || '').trim(),
          audience: String(summary.audience || '').trim(),
          guidance: String(summary.guidance || '').trim(),
          stylePreset: (summary.stylePreset || 'detailed') as SummaryConfig['stylePreset'],
          styleLabel: String(summary.styleLabel || '').trim() || 'Detailed summary',
          content,
          generatedAt: String(summary.generatedAt || '').trim() || new Date().toISOString(),
        } satisfies GeneratedSummary;
      })
      .filter((summary): summary is GeneratedSummary => summary !== null)
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  private async handleChangeProject(transcript: Transcript, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    let rollbackTranscript: Transcript | undefined;

    try {
      // List available projects
      // Only pass contextDirectory if server is in local mode
      const shouldPass = await shouldPassContextDirectory(this._client);
      const contextDirectory = shouldPass ? this.getDefaultContextDirectory() : undefined;
      const toolContextArgs = contextDirectory ? { contextDirectory } : {};
      const projectsResult = await this._client.callTool(
        'protokoll_list_projects',
        toolContextArgs
      ) as {
        projects?: Array<{ id: string; name: string; active?: boolean }>;
      };

      const allProjects = projectsResult.projects || [];

      // In the detail view "Assign Project" flow, show ALL projects (active + inactive).
      // Users may still want to assign to an inactive project, and hiding them makes it
      // look like the server isn't returning projects at all.
      const createDescription =
        allProjects.length === 0
          ? 'No projects returned from server — create one and assign this transcript'
          : 'Add a new project and assign this transcript to it';

      // Build quick pick items - always include "Create new project" option
      const projectItems: Array<vscode.QuickPickItem & { id: string | null; isCreateNew?: boolean; active?: boolean }> = [
        {
          label: '$(add) Create new project...',
          description: createDescription,
          id: '',
          isCreateNew: true,
        },
        ...(allProjects.length > 0
          ? ([
              {
                label: '',
                kind: vscode.QuickPickItemKind.Separator,
                id: null,
                isCreateNew: false,
              },
            ] as Array<vscode.QuickPickItem & { id: string | null; isCreateNew?: boolean; active?: boolean }>)
          : []),
        ...[...allProjects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).map(p => ({
          label: p.active === false ? `$(circle-slash) ${p.name}` : p.name,
          description: p.active === false ? `${p.id} (inactive)` : p.id,
          id: p.id,
          isCreateNew: false,
          active: p.active,
        })),
      ];

      const selected = await vscode.window.showQuickPick(projectItems, {
        placeHolder: 'Select a project for this transcript',
        title: 'Assign Project',
        ignoreFocusOut: true,
        matchOnDescription: true,
      });

      if (!selected) {
        return; // User cancelled
      }

      let projectId: string;
      let projectName: string;

      if (selected.isCreateNew) {
        // Create new project
        const projectNameInput = await vscode.window.showInputBox({
          prompt: 'Enter name for the new project',
          placeHolder: 'Project name',
          title: 'Create Project',
          ignoreFocusOut: true,
          validateInput: (value) => {
            if (!value || value.trim() === '') {
              return 'Project name cannot be empty';
            }
            return null;
          },
        });

        if (!projectNameInput || !projectNameInput.trim()) {
          return;
        }

        const addResult = await this._client.callTool('protokoll_add_project', {
          name: projectNameInput.trim(),
          ...toolContextArgs,
        }) as { id?: string; name?: string; entity?: { id: string; name: string } };

        // Support both { id, name } and { entity: { id, name } } response formats
        const createdId = addResult.entity?.id ?? addResult.id;
        const createdName = addResult.entity?.name ?? addResult.name ?? projectNameInput.trim();

        if (!createdId) {
          vscode.window.showErrorMessage('Failed to create project: No ID returned');
          return;
        }

        projectId = createdId;
        projectName = createdName;
      } else {
        projectId = selected.id ?? '';
        projectName = selected.label;
      }

      if (!projectId) {
        vscode.window.showErrorMessage('No project selected');
        return;
      }

      // Update transcript - convert absolute path to relative path
      const rawPath = transcript.uri || transcript.path;
      const transcriptPath = this.getToolTranscriptPath(rawPath, transcriptUri);
      const previousTranscriptState = this._currentTranscripts.get(transcriptUri)?.transcript;
      const optimisticProjects = [{ id: projectId, name: projectName }];
      if (previousTranscriptState) {
        rollbackTranscript = previousTranscriptState;
        const optimisticTranscript: Transcript = {
          ...previousTranscriptState,
          entities: {
            ...previousTranscriptState.entities,
            projects: optimisticProjects,
          },
        };

        this._currentTranscripts.set(transcriptUri, {
          uri: transcriptUri,
          transcript: optimisticTranscript,
        });

        // Update UI immediately to avoid waiting on server-side propagation.
        await this._onTranscriptChanged?.(transcriptUri, {
          entities: optimisticTranscript.entities,
        });
        await this.showTranscript(transcriptUri, optimisticTranscript);
      }
      
      // Log for debugging
      console.log(`Protokoll: Updating transcript with path: ${transcriptPath}, projectId: ${projectId}`);
      
      let editResult: {
        success?: boolean;
        originalPath?: string;
        outputPath?: string;
        renamed?: boolean;
        message?: string;
      } | undefined;
      try {
        editResult = await this._client.callTool('protokoll_edit_transcript', {
          transcriptPath: transcriptPath,
          projectId: projectId,
          projectName: projectName,
          ...toolContextArgs,
        }) as {
          success?: boolean;
          originalPath?: string;
          outputPath?: string;
          renamed?: boolean;
          message?: string;
        };
        
        console.log(`Protokoll: Edit transcript result:`, editResult);
        vscode.window.showInformationMessage(`Protokoll: Transcript assigned to project "${projectName}"`);
      } catch (toolError) {
        console.error(`Protokoll: Error calling protokoll_edit_transcript:`, toolError);
        throw toolError; // Re-throw to be caught by outer catch
      }

      // Project routing may move/rename the transcript path. In that case we cannot
      // safely do an in-place update by the old URI, so request a full list refresh.
      const movedTranscript = !!editResult?.renamed
        || (editResult?.originalPath && editResult?.outputPath && editResult.originalPath !== editResult.outputPath);
      if (movedTranscript) {
        await this._onTranscriptChanged?.();
        return;
      }

      // Reconcile persisted server state in the background so UI stays responsive.
      void this.reconcileProjectAssignment(transcriptUri, projectId, projectName);
    } catch (error) {
      // Roll back optimistic state when server-side edit fails.
      if (rollbackTranscript) {
        this._currentTranscripts.set(transcriptUri, {
          uri: transcriptUri,
          transcript: rollbackTranscript,
        });
        await this._onTranscriptChanged?.(transcriptUri, {
          entities: rollbackTranscript.entities,
        });
        await this.showTranscript(transcriptUri, rollbackTranscript);
      }
      vscode.window.showErrorMessage(
        `Failed to change project: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async reconcileProjectAssignment(transcriptUri: string, projectId: string, projectName: string): Promise<void> {
    if (!this._client) {
      return;
    }

    let latestContent: TranscriptContent | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        latestContent = await this._client.readTranscript(transcriptUri);
        const persistedProjects = latestContent.metadata.entities?.projects ?? [];
        const hasPersistedProject = persistedProjects.some(project =>
          project.id === projectId || project.name === projectName
        );
        if (hasPersistedProject || attempt === 3) {
          break;
        }
      } catch (readError) {
        console.warn('Protokoll: Could not re-read transcript after project change', readError);
      }

      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }

    const currentTranscript = this._currentTranscripts.get(transcriptUri);
    if (!currentTranscript) {
      return;
    }

    const persistedProjects = latestContent?.metadata.entities?.projects;
    const nextProjects = persistedProjects && persistedProjects.length > 0
      ? persistedProjects
      : [{ id: projectId, name: projectName }];
    const updatedTranscript: Transcript = {
      ...currentTranscript.transcript,
      title: latestContent?.title || currentTranscript.transcript.title,
      status: latestContent?.metadata.status || currentTranscript.transcript.status,
      entities: {
        ...currentTranscript.transcript.entities,
        ...(latestContent?.metadata.entities || {}),
        projects: nextProjects,
      },
    };

    this._currentTranscripts.set(transcriptUri, {
      uri: transcriptUri,
      transcript: updatedTranscript,
    });

    const listUpdates: Partial<Transcript> = {
      entities: updatedTranscript.entities,
    };
    if (updatedTranscript.title !== undefined) {
      listUpdates.title = updatedTranscript.title;
    }
    if (updatedTranscript.status !== undefined) {
      listUpdates.status = updatedTranscript.status;
    }
    await this._onTranscriptChanged?.(transcriptUri, listUpdates);
    await this.showTranscript(transcriptUri, updatedTranscript);
  }

  private async handleChangeDate(
    transcript: Transcript,
    transcriptPath: string,
    transcriptUri: string,
    presetDate?: string,
  ): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      const validateDateInput = (value: string): string | null => {
        if (!value) {
          return 'Date is required';
        }
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(value)) {
          return 'Invalid date format. Use YYYY-MM-DD (e.g., 2026-01-15)';
        }
        const parsedDate = new Date(`${value}T12:00:00`);
        if (isNaN(parsedDate.getTime())) {
          return 'Invalid date';
        }
        return null;
      };

      let dateInput = presetDate?.trim();
      if (dateInput) {
        const validationError = validateDateInput(dateInput);
        if (validationError) {
          vscode.window.showErrorMessage(validationError);
          return;
        }
      } else {
        // Fallback for callers that still trigger changeDate without a preset value.
        dateInput = await vscode.window.showInputBox({
          prompt: 'Enter new date for transcript (YYYY-MM-DD)',
          placeHolder: '2026-01-15',
          validateInput: validateDateInput,
        }) ?? undefined;
      }

      if (!dateInput) {
        return;
      }

      const currentDateValue = this.formatDateInputValue(transcript.date || '');
      if (currentDateValue && currentDateValue === dateInput) {
        return;
      }

      // Convert absolute path to relative path
      const rawPath = transcript.uri || transcript.path;
      const transcriptTarget = this.getToolTranscriptPath(rawPath, transcriptUri);
      
      // Log for debugging
      console.log(`Protokoll: Changing transcript date with path: ${transcriptTarget}, newDate: ${dateInput}`);
      
      // Show progress
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Changing transcript date...',
        cancellable: false,
      }, async () => {
        try {
          const result = await this._client!.callTool('protokoll_change_transcript_date', {
            transcriptPath: transcriptTarget,
            newDate: dateInput,
          }) as { success?: boolean; moved?: boolean; outputPath?: string; message?: string };
          
          console.log(`Protokoll: Change date result:`, result);
          
          if (result.moved) {
            vscode.window.showInformationMessage(
              `Protokoll: Transcript moved to ${result.outputPath}. The transcript may no longer appear in the current view.`
            );
          } else {
            vscode.window.showInformationMessage(
              result.message || 'Transcript date updated'
            );
          }
        } catch (toolError) {
          console.error(`Protokoll: Error calling protokoll_change_transcript_date:`, toolError);
          throw toolError;
        }
      });

      // Refresh the transcripts list view
      await vscode.commands.executeCommand('protokoll.refreshTranscripts');

      // Close the current detail view since the transcript may have moved
      const panel = this._panels.get(transcriptUri);
      if (panel) {
        panel.dispose();
        this._panels.delete(transcriptUri);
        this._currentTranscripts.delete(transcriptUri);
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to change transcript date: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleAddTag(transcript: Transcript, transcriptPath: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    const newTag = await vscode.window.showInputBox({
      prompt: 'Enter a new tag',
      placeHolder: 'Tag name',
      validateInput: (value) => {
        if (!value || value.trim() === '') {
          return 'Tag name cannot be empty';
        }
        return null;
      },
    });

    if (!newTag) {
      return; // User cancelled
    }

    try {
      // Get current tags from the structured response
      const content: TranscriptContent = await this._client.readTranscript(transcript.uri);
      const currentTags = content.metadata.tags || [];
      
      // Check if tag already exists
      if (currentTags.includes(newTag.trim())) {
        vscode.window.showWarningMessage(`Tag "${newTag.trim()}" already exists`);
        return;
      }

      // Use edit_transcript tool to add the tag
      await this._client.callTool('protokoll_edit_transcript', {
        transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
        tagsToAdd: [newTag.trim()],
      });

      vscode.window.showInformationMessage(`Protokoll: Added tag "${newTag.trim()}"`);

      // Refresh the transcripts list view
      await vscode.commands.executeCommand('protokoll.refreshTranscripts');

      // The resource change notification should automatically refresh the detail view
      // since we're subscribed to this transcript resource. However, if subscriptions
      // aren't working, we'll refresh manually as a fallback after a short delay.
      setTimeout(async () => {
        console.log(`Protokoll: [TRANSCRIPT VIEW] Fallback refresh after tag addition: ${transcriptUri}`);
        await this.refreshTranscript(transcriptUri);
      }, 1000);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to add tag: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleRemoveTag(transcript: Transcript, transcriptPath: string, tag: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      // Use edit_transcript tool to remove the tag
      await this._client.callTool('protokoll_edit_transcript', {
        transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
        tagsToRemove: [tag],
      });

      vscode.window.showInformationMessage(`Protokoll: Removed tag "${tag}"`);

      // Refresh the transcripts list view
      await vscode.commands.executeCommand('protokoll.refreshTranscripts');

      // The resource change notification should automatically refresh the detail view
      // since we're subscribed to this transcript resource. However, if subscriptions
      // aren't working, we'll refresh manually as a fallback after a short delay.
      setTimeout(async () => {
        console.log(`Protokoll: [TRANSCRIPT VIEW] Fallback refresh after tag removal: ${transcriptUri}`);
        await this.refreshTranscript(transcriptUri);
      }, 1000);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to remove tag: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleChangeStatus(transcript: Transcript, transcriptPath: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    const statuses = ['initial', 'enhanced', 'reviewed', 'in_progress', 'closed', 'archived', 'deleted'];
    const statusLabels: Record<string, string> = {
      initial: 'Initial',
      enhanced: 'Enhanced',
      reviewed: 'Reviewed',
      'in_progress': 'In Progress',
      closed: 'Closed',
      archived: 'Archived',
      deleted: 'Deleted',
    };

    const selected = await vscode.window.showQuickPick(
      statuses.map(s => ({ label: statusLabels[s], value: s })),
      { placeHolder: 'Select new status' }
    );

    if (!selected) {
      return;
    }

    let rollbackTranscript: Transcript | undefined;
    const selectedStatus = selected.value as TranscriptStatus;

    try {
      const currentTranscript = this._currentTranscripts.get(transcriptUri)?.transcript ?? transcript;
      rollbackTranscript = currentTranscript;
      const optimisticTranscript: Transcript = {
        ...currentTranscript,
        status: selectedStatus,
      };
      this._currentTranscripts.set(transcriptUri, {
        uri: transcriptUri,
        transcript: optimisticTranscript,
      });
      await this._onTranscriptChanged?.(transcriptUri, { status: selectedStatus });
      await this.showTranscript(transcriptUri, optimisticTranscript);

      await this._client.callTool('protokoll_edit_transcript', {
        transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
        status: selectedStatus,
      });

      vscode.window.showInformationMessage(`Protokoll: Status changed to "${selected.label}"`);

      // Reconcile persisted state without blocking user interaction.
      void this.reconcileStatusChange(transcriptUri, selectedStatus);
    } catch (error) {
      if (rollbackTranscript) {
        this._currentTranscripts.set(transcriptUri, {
          uri: transcriptUri,
          transcript: rollbackTranscript,
        });
        await this._onTranscriptChanged?.(transcriptUri, { status: rollbackTranscript.status });
        await this.showTranscript(transcriptUri, rollbackTranscript);
      }
      vscode.window.showErrorMessage(
        `Failed to change status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleAddTask(transcript: Transcript, transcriptPath: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    const description = await vscode.window.showInputBox({
      prompt: 'Enter task description',
      placeHolder: 'Follow up on...',
    });

    if (!description || !description.trim()) {
      return;
    }

    try {
      await this._client.callTool('protokoll_create_task', {
        transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
        description: description.trim(),
      });

      vscode.window.showInformationMessage('Protokoll: Task added');

      // Refresh the transcript view
      setTimeout(async () => {
        await this.refreshTranscript(transcriptUri);
      }, 500);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to add task: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleIdentifyTasks(_transcript: Transcript, transcriptPath: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      const result = await this._client.callTool('protokoll_identify_tasks_from_transcript', {
        transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
        maxCandidates: 25,
        includeTagSuggestions: true,
      }) as IdentifyTasksResult;

      const candidates = result.candidates || [];
      if (candidates.length === 0) {
        vscode.window.showInformationMessage(
          result.message || 'Protokoll: No task candidates found in this transcript.'
        );
        return;
      }
      console.log('Protokoll: [TASK IDENTIFY] Candidates found', { transcriptUri, candidateCount: candidates.length });

      const quickPickItems = candidates.map((candidate) => {
        const detailParts = [
          `Confidence: ${candidate.confidenceBucket.toUpperCase()}`,
          candidate.rationale,
          candidate.suggestedDueDate ? `Due: ${candidate.suggestedDueDate}` : '',
        ].filter(Boolean);

        return {
          label: candidate.taskText,
          description: detailParts.join(' • '),
          candidate,
          picked: false, // Default to none selected (review-first constraint)
        };
      });

      const selected = await vscode.window.showQuickPick(quickPickItems, {
        canPickMany: true,
        title: 'Identify Tasks in Transcript',
        placeHolder: 'Select which identified tasks to create',
        ignoreFocusOut: true,
      });

      if (!selected || selected.length === 0) {
        vscode.window.showInformationMessage('Protokoll: No tasks selected.');
        return;
      }

      const normalize = (text: string): string[] => text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(token => token.length > 2);
      const similarity = (a: string, b: string): number => {
        const aTokens = new Set(normalize(a));
        const bTokens = new Set(normalize(b));
        if (aTokens.size === 0 || bTokens.size === 0) {
          return 0;
        }
        const overlap = Array.from(aTokens).filter(token => bTokens.has(token)).length;
        return overlap / Math.max(aTokens.size, bTokens.size);
      };

      // Read current transcript metadata so duplicate checks include existing tasks.
      const latest = await this._client.readTranscript(transcriptUri);
      const existingTasks = latest.metadata?.tasks || [];
      const existingDescriptions = existingTasks.map(task => task.description);
      const createdInThisRun: string[] = [];

      let createdCount = 0;
      let blockedDuplicates = 0;
      for (const item of selected) {
        const candidateText = item.candidate.taskText;
        const isDuplicate = [...existingDescriptions, ...createdInThisRun].some(existing => {
          return similarity(candidateText, existing) >= 0.75;
        });

        if (isDuplicate) {
          blockedDuplicates += 1;
          continue;
        }

        await this._client.callTool('protokoll_create_task', {
          transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
          description: candidateText,
        });
        createdCount += 1;
        createdInThisRun.push(candidateText);
      }

      // Optional tags: collect from selected candidates and ask before applying.
      const suggestedTags = Array.from(new Set(
        selected.flatMap(item => item.candidate.suggestedTags || [])
      ));
      if (suggestedTags.length > 0) {
        const chosenTags = await vscode.window.showQuickPick(
          suggestedTags.map(tag => ({ label: tag })),
          {
            canPickMany: true,
            title: 'Apply Suggested Tags',
            placeHolder: 'Optional: select tags to add to this transcript',
            ignoreFocusOut: true,
          }
        );

        if (chosenTags && chosenTags.length > 0) {
          await this._client.callTool('protokoll_edit_transcript', {
            transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
            tagsToAdd: chosenTags.map(tag => tag.label),
          });
        }
      }

      vscode.window.showInformationMessage(
        `Protokoll: Created ${createdCount} task${createdCount === 1 ? '' : 's'} from identified candidates` +
        `${blockedDuplicates > 0 ? ` (${blockedDuplicates} duplicate${blockedDuplicates === 1 ? '' : 's'} blocked)` : ''}.`
      );
      console.log('Protokoll: [TASK IDENTIFY] Create summary', {
        transcriptUri,
        selectedCount: selected.length,
        createdCount,
        blockedDuplicates,
      });

      setTimeout(async () => {
        await this.refreshTranscript(transcriptUri);
      }, 500);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to identify tasks: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleCompleteTask(transcript: Transcript, transcriptPath: string, taskId: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      await this._client.callTool('protokoll_complete_task', {
        transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
        taskId,
      });

      // Refresh the transcript view
      setTimeout(async () => {
        await this.refreshTranscript(transcriptUri);
      }, 500);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to complete task: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleDeleteTask(transcript: Transcript, transcriptPath: string, taskId: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      'Are you sure you want to delete this task?',
      'Delete',
      'Cancel'
    );

    if (confirm !== 'Delete') {
      return;
    }

    try {
      await this._client.callTool('protokoll_delete_task', {
        transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
        taskId,
      });

      vscode.window.showInformationMessage('Protokoll: Task deleted');

      // Refresh the transcript view
      setTimeout(async () => {
        await this.refreshTranscript(transcriptUri);
      }, 500);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to delete task: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleEditTitle(transcript: Transcript, transcriptPath: string, newTitle: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    const trimmedTitle = newTitle.trim();
    let rollbackTranscript: Transcript | undefined;

    try {
      const currentTranscript = this._currentTranscripts.get(transcriptUri)?.transcript;
      if (currentTranscript) {
        rollbackTranscript = currentTranscript;
        const optimisticTranscript: Transcript = {
          ...currentTranscript,
          title: trimmedTitle,
        };
        this._currentTranscripts.set(transcriptUri, {
          uri: transcriptUri,
          transcript: optimisticTranscript,
        });
        await this._onTranscriptChanged?.(transcriptUri, { title: trimmedTitle });
        await this.showTranscript(transcriptUri, optimisticTranscript);
      }

      const result = await this._client.callTool('protokoll_edit_transcript', {
        transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
        title: trimmedTitle,
      }) as {
        success?: boolean;
        originalPath?: string;
        outputPath?: string;
        renamed?: boolean;
        message?: string;
      };

      vscode.window.showInformationMessage(`Protokoll: Title updated to "${trimmedTitle}"`);

      // Refresh the transcripts list view
      await vscode.commands.executeCommand('protokoll.refreshTranscripts');

      // If the file was renamed, update the URI tracking
      if (result.renamed && result.outputPath) {
        // Construct the new URI from the output path
        const newTranscriptUri = `protokoll://transcript/${result.outputPath}`;
        
        console.log(`Protokoll: [TRANSCRIPT VIEW] Transcript renamed, updating URI tracking`);
        console.log(`Protokoll: [TRANSCRIPT VIEW] Old URI: ${transcriptUri}`);
        console.log(`Protokoll: [TRANSCRIPT VIEW] New URI: ${newTranscriptUri}`);

        // Get the current transcript data
        const currentTranscript = this._currentTranscripts.get(transcriptUri);
        const panel = this._panels.get(transcriptUri);

        if (currentTranscript && panel) {
          // Update transcript with new title
          const updatedTranscript: Transcript = {
            ...currentTranscript.transcript,
            title: trimmedTitle,
            path: result.outputPath,
            filename: result.outputPath.split('/').pop() || result.outputPath,
            uri: newTranscriptUri,
          };

          // Unsubscribe from old URI
          try {
            await this._client.unsubscribeFromResource(transcriptUri);
            console.log(`Protokoll: [TRANSCRIPT VIEW] ✅ Unsubscribed from old URI: ${transcriptUri}`);
          } catch (error) {
            console.warn(`Protokoll: [TRANSCRIPT VIEW] ⚠️ Failed to unsubscribe from old URI:`, error);
          }

          // Update internal maps with new URI
          this._currentTranscripts.delete(transcriptUri);
          this._panels.delete(transcriptUri);
          
          this._currentTranscripts.set(newTranscriptUri, {
            uri: newTranscriptUri,
            transcript: updatedTranscript,
          });
          this._panels.set(newTranscriptUri, panel);

          // Update panel title
          panel.title = this.formatTranscriptPanelTitle(updatedTranscript);

          // Subscribe to new URI
          try {
            await this._client.subscribeToResource(newTranscriptUri);
            console.log(`Protokoll: [TRANSCRIPT VIEW] ✅ Subscribed to new URI: ${newTranscriptUri}`);
          } catch (error) {
            console.warn(`Protokoll: [TRANSCRIPT VIEW] ⚠️ Failed to subscribe to new URI:`, error);
          }

          // Refresh the view with new URI and updated transcript
          await this.showTranscript(newTranscriptUri, updatedTranscript);
          void this.reconcileTitleEdit(newTranscriptUri, trimmedTitle);
        } else {
          // Fallback: if we don't have current transcript data, refresh after delay
          console.warn(`Protokoll: [TRANSCRIPT VIEW] ⚠️ No current transcript data found, using fallback refresh`);
          setTimeout(async () => {
            // Try to get updated transcript from list
            await vscode.commands.executeCommand('protokoll.refreshTranscripts');
            // The notification handler should pick up the change
          }, 1000);
        }
      } else {
        // Reconcile persisted state without blocking UI.
        void this.reconcileTitleEdit(transcriptUri, trimmedTitle);
      }
    } catch (error) {
      if (rollbackTranscript) {
        this._currentTranscripts.set(transcriptUri, {
          uri: transcriptUri,
          transcript: rollbackTranscript,
        });
        await this._onTranscriptChanged?.(transcriptUri, { title: rollbackTranscript.title });
        await this.showTranscript(transcriptUri, rollbackTranscript);
      }
      vscode.window.showErrorMessage(
        `Failed to update title: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async reconcileTitleEdit(transcriptUri: string, expectedTitle: string): Promise<void> {
    if (!this._client) {
      return;
    }

    let latestContent: TranscriptContent | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        latestContent = await this._client.readTranscript(transcriptUri);
        if (latestContent.title === expectedTitle || attempt === 3) {
          break;
        }
      } catch (readError) {
        console.warn('Protokoll: Could not re-read transcript after title edit', readError);
      }
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }

    const currentTranscript = this._currentTranscripts.get(transcriptUri);
    if (!currentTranscript) {
      return;
    }

    const updatedTranscript: Transcript = {
      ...currentTranscript.transcript,
      title: latestContent?.title || expectedTitle,
      status: latestContent?.metadata.status || currentTranscript.transcript.status,
      entities: {
        ...currentTranscript.transcript.entities,
        ...(latestContent?.metadata.entities || {}),
      },
    };
    this._currentTranscripts.set(transcriptUri, {
      uri: transcriptUri,
      transcript: updatedTranscript,
    });
    await this._onTranscriptChanged?.(transcriptUri, {
      title: updatedTranscript.title,
      status: updatedTranscript.status,
      entities: updatedTranscript.entities,
    });
    await this.showTranscript(transcriptUri, updatedTranscript);
  }

  private async reconcileStatusChange(transcriptUri: string, expectedStatus: TranscriptStatus): Promise<void> {
    if (!this._client) {
      return;
    }

    let latestContent: TranscriptContent | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        latestContent = await this._client.readTranscript(transcriptUri);
        if (latestContent.metadata.status === expectedStatus || attempt === 3) {
          break;
        }
      } catch (readError) {
        console.warn('Protokoll: Could not re-read transcript after status change', readError);
      }
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }

    const currentTranscript = this._currentTranscripts.get(transcriptUri);
    if (!currentTranscript) {
      return;
    }

    const updatedTranscript: Transcript = {
      ...currentTranscript.transcript,
      title: latestContent?.title || currentTranscript.transcript.title,
      status: (latestContent?.metadata.status as TranscriptStatus) || expectedStatus,
      entities: {
        ...currentTranscript.transcript.entities,
        ...(latestContent?.metadata.entities || {}),
      },
    };
    this._currentTranscripts.set(transcriptUri, {
      uri: transcriptUri,
      transcript: updatedTranscript,
    });
    await this._onTranscriptChanged?.(transcriptUri, {
      title: updatedTranscript.title,
      status: updatedTranscript.status,
      entities: updatedTranscript.entities,
    });
    await this.showTranscript(transcriptUri, updatedTranscript);
  }

  private async handleEditTranscript(
    transcript: Transcript,
    transcriptPath: string,
    newContent: string,
    transcriptUri: string,
    contentTarget: 'enhanced' | 'original' = 'enhanced'
  ): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      // Use the new update_transcript_content tool to directly update the content
      await this._client.callTool('protokoll_update_transcript_content', {
        transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
        content: newContent,
        contentTarget,
      });

      vscode.window.showInformationMessage(
        contentTarget === 'original'
          ? 'Protokoll: Original transcript content updated'
          : 'Protokoll: Enhanced transcript content updated'
      );

      // Refresh the detail view immediately to show the updated content
      const currentTranscript = this._currentTranscripts.get(transcriptUri);
      if (currentTranscript) {
        await this.showTranscript(currentTranscript.uri, currentTranscript.transcript);
      }

      const panel = this._panels.get(transcriptUri);
      if (panel) {
        panel.webview.postMessage({
          command: 'saveSucceeded',
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to update transcript: ${error instanceof Error ? error.message : String(error)}`
      );
      // Notify the webview that save failed so it can re-enable the button
      const panel = this._panels.get(transcriptUri);
      if (panel) {
        panel.webview.postMessage({
          command: 'saveFailed'
        });
      }
    }
  }

  private async handleEnhanceFromOriginal(
    transcript: Transcript,
    transcriptPath: string,
    originalText: string,
    hasExistingEnhanced: boolean,
    transcriptUri: string
  ): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    const normalizedOriginal = (originalText || '').trim();
    if (!normalizedOriginal) {
      vscode.window.showWarningMessage('Original content is empty. Add content before running Enhance.');
      return;
    }

    const panel = this._panels.get(transcriptUri);

    if (hasExistingEnhanced) {
      const decision = await vscode.window.showWarningMessage(
        'Enhanced content already exists. Replace it with a new enhancement?',
        { modal: true },
        'Replace'
      );
      if (decision !== 'Replace') {
        if (panel) {
          panel.webview.postMessage({
            command: 'enhanceCancelled',
          });
        }
        return;
      }
    }

    // Give immediate visual feedback before any server roundtrips.
    if (panel) {
      panel.webview.postMessage({
        command: 'enhanceStarted',
      });
    }

    if (hasExistingEnhanced) {
      vscode.window.showInformationMessage('Re-enhancing from Original (running in background)...');
    } else {
      vscode.window.showInformationMessage('Enhancing from Original (running in background)...');
    }

    const toolTranscriptPath = this.getToolTranscriptPath(transcriptPath, transcriptUri);

    void (async () => {
      try {
        // For manual notes, persist the current Original draft first so enhancement
        // always runs against what the user just wrote.
        if (transcript.contentType === 'manual_note') {
          await this._client!.callTool('protokoll_update_transcript_content', {
            transcriptPath: toolTranscriptPath,
            content: originalText,
            contentTarget: 'original',
          });
        }

        await this._client!.callTool('protokoll_edit_transcript', {
          transcriptPath: toolTranscriptPath,
          status: 'in_progress',
        });

        if (this._onTranscriptChanged) {
          await this._onTranscriptChanged(transcriptUri, { status: 'in_progress' as TranscriptStatus });
        }

        await this._client!.callTool(
          'protokoll_enhance_transcript',
          {
            transcriptPath: toolTranscriptPath,
            originalText,
          },
          {
            timeoutMs: TranscriptDetailViewProvider.ENHANCE_TOOL_TIMEOUT_MS,
          }
        );

        // Fallback refresh path: keep SSE-driven updates as primary, but also
        // refresh explicitly so users still see results if notifications lag.
        await vscode.commands.executeCommand('protokoll.refreshTranscripts');
        await this.refreshTranscript(transcriptUri);

        const activePanel = this._panels.get(transcriptUri);
        if (activePanel) {
          activePanel.webview.postMessage({
            command: 'enhanceCompleted',
          });
        }
      } catch (error) {
        if (this.isRequestTimeoutError(error)) {
          const timeoutSeconds = Math.round(TranscriptDetailViewProvider.ENHANCE_TOOL_TIMEOUT_MS / 1000);
          vscode.window.showWarningMessage(
            `Enhancement is still running on the server. The extension request timed out after ${timeoutSeconds}s, but no failure was reported by MCP yet. Keeping the transcript in progress and watching for completion.`
          );
          const activePanel = this._panels.get(transcriptUri);
          if (activePanel) {
            activePanel.webview.postMessage({
              command: 'enhanceDeferred',
            });
          }
          this.monitorEnhancementAfterTimeout(transcriptUri);
          return;
        }

        const activePanel = this._panels.get(transcriptUri);
        if (activePanel) {
          activePanel.webview.postMessage({
            command: 'enhanceFailed',
          });
        }
        vscode.window.showErrorMessage(
          `Enhancement failed. Existing enhanced content was kept. ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();
  }

  private isRequestTimeoutError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    return message.includes('timed out') || message.includes('etimedout');
  }

  private monitorEnhancementAfterTimeout(transcriptUri: string): void {
    void (async () => {
      const maxAttempts = 18; // ~3 minutes at 10s intervals
      const intervalMs = 10_000;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        if (!this._client) {
          return;
        }

        try {
          const content = await this._client.readTranscript(transcriptUri);
          const status = content.metadata.status;
          if (status && status !== 'in_progress') {
            await vscode.commands.executeCommand('protokoll.refreshTranscripts');
            await this.refreshTranscript(transcriptUri);
            const activePanel = this._panels.get(transcriptUri);
            if (activePanel) {
              activePanel.webview.postMessage({
                command: 'enhanceCompleted',
              });
            }
            return;
          }
        } catch (pollError) {
          console.warn('Protokoll: Enhancement status polling after timeout failed', pollError);
        }
      }
    })();
  }

  public async handleOpenEntity(entityType: string, entityId: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      const entityUri = `protokoll://entity/${entityType}/${encodeURIComponent(entityId)}`;
      const content = await this._client.readResource(entityUri);
      this._entityLastFetched.set(entityUri, new Date());

      const entityData = this.parseEntityContent(content.text);
      const entityName = entityData.name || entityId;
      const panelTitle = `${this.capitalizeFirst(entityType)}: ${entityName}`;
      const projectNameMap = await this.fetchProjectNameMap();
      const lastFetched = this._entityLastFetched.get(entityUri);
      const panelHtml = this.getEntityContent(
        entityType,
        entityId,
        content.text,
        entityData,
        lastFetched,
        projectNameMap
      );

      this.pruneDisposedEntityPanels();

      const existingPanel = this._entityPanels.get(entityUri);
      if (existingPanel) {
        existingPanel.title = panelTitle;
        existingPanel.webview.html = panelHtml;
        existingPanel.reveal(this.getEntityViewColumn(), false);
        return;
      }

      const panel = vscode.window.createWebviewPanel(
        'protokoll.entity',
        panelTitle,
        this.getEntityViewColumn(),
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      panel.webview.html = panelHtml;
      this._entityPanels.set(entityUri, panel);

      panel.webview.onDidReceiveMessage(
        async (message) => {
          switch (message.command) {
            case 'startChatFromInputEntity':
              await this.handleStartChatFromInputEntity(entityType, entityId, entityUri, message.message);
              break;
            case 'refreshEntity':
              await this.refreshEntity(entityUri);
              break;
            case 'editEntity':
              await this.handleEditEntity(entityType, entityId, entityUri, message.fields, panel);
              break;
            case 'loadRelatedTranscripts':
              await this.handleLoadRelatedTranscripts(panel, message.entityType, message.entityId);
              break;
            case 'loadProjectPlans':
              await this.handleLoadProjectPlans(
                panel,
                typeof message.projectId === 'string' ? message.projectId : entityId,
                typeof message.page === 'number' && message.page >= 1 ? message.page : 1,
                typeof message.pageSize === 'number' && message.pageSize >= 1 ? message.pageSize : 25
              );
              break;
            case 'openTranscript':
              await this.handleOpenTranscriptFromEntity(message.path);
              break;
            case 'addProjectRelationship':
              await this.handleAddProjectRelationship(entityType, entityId, entityUri);
              break;
            case 'removeProjectRelationship':
              await this.handleRemoveProjectRelationship(entityType, entityId, entityUri, message.targetUri, message.relationship);
              break;
            case 'deleteEntity':
              await this.handleDeleteEntity(entityType, entityId, entityUri, panel, message.entityName);
              break;
            case 'convertEntityType':
              await this.handleConvertEntityType(
                message.fromType,
                message.toType,
                entityId,
                entityUri,
                panel,
                message.entityName
              );
              break;
          }
        },
        null
      );

      panel.onDidDispose(async () => {
        this._entityPanels.delete(entityUri);
        if (this._client) {
          try {
            await this._client.unsubscribeFromResource(entityUri);
            console.log(`Protokoll: [ENTITY VIEW] ✅ Unsubscribed from entity: ${entityUri}`);
          } catch (error) {
            console.warn(`Protokoll: [ENTITY VIEW] ⚠️ Failed to unsubscribe from entity:`, error);
          }
        }
      }, null);

      console.log(`Protokoll: [ENTITY VIEW] Subscribing to entity for change notifications: ${entityUri}`);
      try {
        await this._client.subscribeToResource(entityUri);
        console.log(`Protokoll: [ENTITY VIEW] ✅ Successfully subscribed to entity: ${entityUri}`);
      } catch (error) {
        console.warn(`Protokoll: [ENTITY VIEW] ⚠️ Failed to subscribe to entity ${entityUri}:`, error);
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open entity: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private pruneDisposedEntityPanels(): void {
    for (const [entityUri, panel] of this._entityPanels.entries()) {
      try {
        void panel.title;
      } catch {
        this._entityPanels.delete(entityUri);
      }
    }
  }

  private getEntityViewColumn(): vscode.ViewColumn {
    this.pruneDisposedEntityPanels();
    for (const panel of this._entityPanels.values()) {
      if (panel.viewColumn !== undefined) {
        return panel.viewColumn;
      }
    }
    return vscode.ViewColumn.Active;
  }

  /**
   * Load enhancement log for a transcript and send to webview
   */
  private async handleLoadEnhancementLog(
    panel: vscode.WebviewPanel,
    transcriptPath: string,
    transcriptUri: string
  ): Promise<void> {
    if (!this._client) {
      return;
    }

    try {
      // Call protokoll_get_enhancement_log
      const response = await this._client.callTool('protokoll_get_enhancement_log', {
        transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
        limit: 100,
      }) as {
        entries?: Array<{
          id: number;
          timestamp: string;
          phase: string;
          action: string;
          details?: Record<string, unknown>;
          entities?: Array<{ id: string; name: string; type: string }>;
        }>;
        total?: number;
      };

      // Send enhancement log to webview
      panel.webview.postMessage({
        command: 'enhancementLog',
        data: response,
      });
    } catch (error) {
      console.error('Protokoll: Failed to load enhancement log', error);
      // Send empty data on error
      panel.webview.postMessage({
        command: 'enhancementLog',
        data: { entries: [], total: 0 },
      });
    }
  }

  /**
   * Reject a previously applied correction and refresh transcript content
   */
  private async handleRejectCorrectionWithConfirmation(
    panel: vscode.WebviewPanel,
    transcriptPath: string,
    correctionEntryId: number,
    transcriptUri: string
  ): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      'Reject this correction and restore the original text?',
      { modal: true },
      'Reject'
    );
    if (confirmed !== 'Reject') {
      panel.webview.postMessage({
        command: 'rejectCorrectionDecision',
        correctionEntryId,
        approved: false,
      });
      return;
    }

    panel.webview.postMessage({
      command: 'rejectCorrectionDecision',
      correctionEntryId,
      approved: true,
    });

    const success = await this.handleRejectCorrection(transcriptPath, correctionEntryId, transcriptUri);
    if (!success) {
      panel.webview.postMessage({
        command: 'rejectCorrectionFailed',
        correctionEntryId,
      });
    }
  }

  private async handleRejectCorrection(
    transcriptPath: string,
    correctionEntryId: number,
    transcriptUri: string
  ): Promise<boolean> {
    if (!this._client) {
      return false;
    }

    try {
      const toolTranscriptPath = this.getToolTranscriptPath(transcriptPath, transcriptUri);
      const response = await this._client.callTool('protokoll_reject_correction', {
        transcriptPath: toolTranscriptPath,
        correctionEntryId,
      }) as {
        success?: boolean;
        alreadyRejected?: boolean;
        message?: string;
      } | string;

      if (typeof response === 'string') {
        throw new Error(response);
      }
      if (!response.success) {
        throw new Error(response.message || 'Failed to reject correction');
      }

      vscode.window.showInformationMessage(
        response.message || 'Correction rejected and transcript updated'
      );

      await this.refreshTranscript(transcriptUri);
      const refreshPanel = this._panels.get(transcriptUri);
      if (refreshPanel) {
        refreshPanel.webview.postMessage({ command: 'refreshComplete' });
      }
      return true;
    } catch (error) {
      console.error('Protokoll: Failed to reject correction', error);
      vscode.window.showErrorMessage(
        `Failed to reject correction: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Load related transcripts for an entity and send to webview
   */
  private async handleLoadRelatedTranscripts(
    panel: vscode.WebviewPanel,
    entityType: string,
    entityId: string
  ): Promise<void> {
    if (!this._client) {
      return;
    }

    try {
      // Call protokoll_list_transcripts with entity filter
      const response = await this._client.callTool('protokoll_list_transcripts', {
        entityId,
        entityType,
        limit: 100, // Load up to 100 related transcripts
      }) as {
        transcripts?: Array<{
          path: string;
          title: string;
          date: string | null;
          project: string | null;
        }>;
      };

      // Send transcripts to webview
      panel.webview.postMessage({
        command: 'relatedTranscripts',
        transcripts: response.transcripts || [],
      });
    } catch (error) {
      console.error('Protokoll Entity: Failed to load related transcripts', error);
      // Send empty array on error
      panel.webview.postMessage({
        command: 'relatedTranscripts',
        transcripts: [],
      });
    }
  }

  private async handleLoadProjectPlans(
    panel: vscode.WebviewPanel,
    projectId: string,
    page: number,
    pageSize: number
  ): Promise<void> {
    if (!this._client) {
      return;
    }
    const limit = Math.min(100, Math.max(1, pageSize));
    const offset = (Math.max(1, page) - 1) * limit;
    try {
      const response = (await this._client.callTool('protokoll_list_project_plans', {
        projectId,
        limit,
        offset,
      })) as {
        total?: number;
        limit?: number;
        offset?: number;
        count?: number;
        plans?: Array<{ id: string; title: string; stage: string; createdAt: string | null }>;
      };
      panel.webview.postMessage({
        command: 'projectPlansPage',
        total: response.total ?? 0,
        limit: response.limit ?? limit,
        offset: response.offset ?? offset,
        count: response.count ?? (response.plans?.length ?? 0),
        plans: response.plans ?? [],
        page,
        pageSize: limit,
      });
    } catch (error) {
      console.error('Protokoll Entity: Failed to load project plans', error);
      panel.webview.postMessage({
        command: 'projectPlansError',
        message: error instanceof Error ? error.message : String(error),
        page,
        pageSize: limit,
      });
    }
  }

  /**
   * Open a transcript from entity view
   */
  private async handleOpenTranscriptFromEntity(transcriptPath: string): Promise<void> {
    if (!this._client) {
      return;
    }

    try {
      const transcriptRef = transcriptPath.startsWith('protokoll://transcript/')
        ? transcriptPath
        : this.getToolTranscriptPath(transcriptPath, undefined);
      // Read the transcript
      const transcriptContent = await this._client.callTool('protokoll_read_transcript', {
        transcriptPath: transcriptRef,
      }) as TranscriptContent;

      // Build URI
      const uri = transcriptRef.startsWith('protokoll://transcript/')
        ? transcriptRef.replace(/\.pkl$/i, '')
        : `protokoll://transcript/${transcriptPath.replace(/\.pkl$/, '')}`;

      // Construct a Transcript object from TranscriptContent
      const transcript: Transcript = {
        uri,
        path: transcriptContent.path,
        filename: transcriptPath.split('/').pop() || transcriptPath,
        date: transcriptContent.metadata.date || new Date().toISOString(),
        time: transcriptContent.metadata.time,
        title: transcriptContent.title,
        status: transcriptContent.metadata.status,
        entities: transcriptContent.metadata.entities,
      };

      // Show transcript in detail view
      await this.showTranscript(uri, transcript, vscode.ViewColumn.One, false);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open transcript: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Refresh a specific entity view (public method for external access)
   */
  public async refreshEntity(entityUri: string): Promise<void> {
    if (!this._client) {
      return;
    }

    const panel = this._entityPanels.get(entityUri);
    if (!panel) {
      return;
    }

    try {
      // Extract entity type and ID from URI
      const uriMatch = entityUri.match(/protokoll:\/\/entity\/([^/]+)\/(.+)$/);
      if (!uriMatch) {
        console.warn(`Protokoll: [ENTITY VIEW] Invalid entity URI: ${entityUri}`);
        return;
      }

      const entityType = uriMatch[1];
      const entityId = decodeURIComponent(uriMatch[2]);

      // Read the entity resource
      const content = await this._client.readResource(entityUri);
      
      // Update last fetched time
      this._entityLastFetched.set(entityUri, new Date());
      
      // Parse entity content
      const entityData = this.parseEntityContent(content.text);
      
      // Resolve project names for relationship display
      const projectNameMap = await this.fetchProjectNameMap();

      // Update panel HTML with fresh content
      const lastFetched = this._entityLastFetched.get(entityUri);
      panel.webview.html = this.getEntityContent(entityType, entityId, content.text, entityData, lastFetched, projectNameMap);

      // Update panel tab title in case the entity name changed
      const refreshedName = entityData.name || entityId;
      panel.title = `${this.capitalizeFirst(entityType)}: ${refreshedName}`;
      
      // Notify webview that refresh is complete
      panel.webview.postMessage({ command: 'refreshComplete' });
      
      console.log(`Protokoll: [ENTITY VIEW] ✅ Refreshed entity: ${entityUri}`);
    } catch (error) {
      console.error(`Protokoll: [ENTITY VIEW] ❌ Failed to refresh entity ${entityUri}:`, error);
      vscode.window.showErrorMessage(
        `Failed to refresh entity: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleEditEntity(
    entityType: string,
    entityId: string,
    entityUri: string,
    fields: Record<string, unknown>,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      panel.webview.postMessage({ command: 'editResult', success: false, error: 'MCP client not initialized' });
      return;
    }

    try {
      const toolMap: Record<string, string> = {
        person: 'protokoll_edit_person',
        project: 'protokoll_edit_project',
        term: 'protokoll_edit_term',
        company: 'protokoll_edit_company',
      };

      const toolName = toolMap[entityType];
      if (!toolName) {
        throw new Error(`Editing not supported for entity type: ${entityType}`);
      }

      const args: Record<string, unknown> = { id: entityId };

      if (fields.name !== undefined) {
        args.name = fields.name;
      }
      if (fields.description !== undefined) {
        // Person uses "context" field, other entity types use "description"
        if (entityType === 'person') {
          args.context = fields.description;
        } else {
          args.description = fields.description;
        }
      }

      // Entity-specific fields pass through directly
      const directFields = [
        'role', 'company', 'firstName', 'lastName',       // person
        'expansion', 'domain',                              // term
        'fullName', 'industry',                             // company
      ];
      for (const key of directFields) {
        if (fields[key] !== undefined) {
          args[key] = fields[key];
        }
      }

      // sounds_like manipulation
      if (fields.add_sounds_like !== undefined) {
        args.add_sounds_like = fields.add_sounds_like;
      }
      if (fields.remove_sounds_like !== undefined) {
        args.remove_sounds_like = fields.remove_sounds_like;
      }

      if (entityType === 'project') {
        if (fields.add_urls !== undefined) {
          args.add_urls = fields.add_urls;
        }
        if (fields.remove_urls !== undefined) {
          args.remove_urls = fields.remove_urls;
        }
      }

      await this._client.callTool(toolName, args);

      panel.webview.postMessage({ command: 'editResult', success: true });

      // Refresh the entity view with updated data
      await this.refreshEntity(entityUri);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Protokoll: [ENTITY VIEW] ❌ Failed to edit entity ${entityUri}:`, error);
      vscode.window.showErrorMessage(`Failed to update entity: ${errorMsg}`);
      panel.webview.postMessage({ command: 'editResult', success: false, error: errorMsg });
    }
  }

  private async handleAddProjectRelationship(
    entityType: string,
    entityId: string,
    entityUri: string,
  ): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      const projectResult = await this._client.callTool('protokoll_list_projects', { limit: 100 }) as {
        projects?: Array<{ id: string; name: string }>;
      };

      if (typeof projectResult === 'string' || !projectResult.projects || projectResult.projects.length === 0) {
        vscode.window.showInformationMessage('No projects available to associate with.');
        return;
      }

      const projectItems: vscode.QuickPickItem[] = projectResult.projects
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(p => ({
          label: p.name,
          description: p.id,
        }));

      const placeHolder = entityType === 'term'
        ? 'Select a project to associate this term with'
        : 'Select a project to associate this person with';

      const selected = await vscode.window.showQuickPick(projectItems, {
        title: 'Associate with Project',
        placeHolder,
      });

      if (!selected || !selected.description) {
        return;
      }

      const relationship = entityType === 'term' ? 'used_in' : 'works_on';

      await this._client.callTool('protokoll_add_relationship', {
        entityType,
        entityId,
        targetType: 'project',
        targetId: selected.description,
        relationship,
      });

      await this.refreshEntity(entityUri);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Protokoll: [ENTITY VIEW] ❌ Failed to add project relationship:`, error);
      vscode.window.showErrorMessage(`Failed to associate project: ${errorMsg}`);
    }
  }

  private async handleRemoveProjectRelationship(
    entityType: string,
    entityId: string,
    entityUri: string,
    targetUri: string,
    relationship: string,
  ): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      await this._client.callTool('protokoll_remove_relationship', {
        entityType,
        entityId,
        targetUri,
        relationship,
      });

      await this.refreshEntity(entityUri);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Protokoll: [ENTITY VIEW] ❌ Failed to remove project relationship:`, error);
      vscode.window.showErrorMessage(`Failed to remove project association: ${errorMsg}`);
    }
  }

  private async notifyEntityListChanged(): Promise<void> {
    if (this._onEntityListChanged) {
      await this._onEntityListChanged();
    }
  }

  private async handleDeleteEntity(
    entityType: string,
    entityId: string,
    entityUri: string,
    panel: vscode.WebviewPanel,
    entityName?: string
  ): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    const actionKey = `delete:${entityUri}`;
    if (this._pendingEntityActions.has(actionKey)) {
      return;
    }
    this._pendingEntityActions.add(actionKey);

    const displayName = entityName?.trim() || entityId;
    try {
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${entityType} "${displayName}"? This removes it from context permanently.`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') {
        return;
      }

      await this._client.callTool('protokoll_delete_entity', {
        entityType,
        entityId,
      });

      this._entityPanels.delete(entityUri);
      panel.dispose();
      await this.notifyEntityListChanged();
      vscode.window.showInformationMessage(`${this.capitalizeFirst(entityType)} "${displayName}" deleted`);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to delete ${entityType}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this._pendingEntityActions.delete(actionKey);
    }
  }

  private async handleConvertEntityType(
    fromType: 'company' | 'person',
    toType: 'company' | 'person',
    entityId: string,
    entityUri: string,
    panel: vscode.WebviewPanel,
    entityName?: string
  ): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    const actionKey = `convert:${entityUri}:${fromType}:${toType}`;
    if (this._pendingEntityActions.has(actionKey)) {
      return;
    }
    this._pendingEntityActions.add(actionKey);

    const displayName = entityName?.trim() || entityId;
    try {
      const confirm = await vscode.window.showWarningMessage(
        `Convert ${fromType} "${displayName}" to a ${toType}? Related transcript references will be updated.`,
        { modal: true },
        'Convert'
      );
      if (confirm !== 'Convert') {
        return;
      }

      const result = await this._client.callTool('protokoll_convert_entity_type', {
        entityId,
        fromType,
        toType,
      }) as { migratedTranscripts?: number; message?: string };

      this._entityPanels.delete(entityUri);
      panel.dispose();
      await this.notifyEntityListChanged();
      await this.handleOpenEntity(toType, entityId);

      const migratedCount = result.migratedTranscripts ?? 0;
      const migrationNote = migratedCount > 0
        ? ` Updated ${migratedCount} transcript reference${migratedCount === 1 ? '' : 's'}.`
        : '';
      vscode.window.showInformationMessage(
        `${result.message || `Converted to ${toType}`}.${migrationNote}`
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to convert ${fromType} to ${toType}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this._pendingEntityActions.delete(actionKey);
    }
  }

  private async handleStartChatFromInputEntity(
    entityType: string,
    entityId: string,
    entityUri: string,
    message: string
  ): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      // Start a new chat with the message already sent
      // For entities, we'll need to adapt the chat provider to handle entity context
      // For now, let's use a simplified approach - open chat and send message
      if (this._chatProvider) {
        // We'll need to add entity support to showChat, but for now let's use a workaround
        await this._chatProvider.showChat(message, entityUri);
      } else {
        // Fallback: open chat command
        await vscode.commands.executeCommand('protokoll.openChat');
      }
      
    } catch (error) {
      console.error('Protokoll: [ENTITY VIEW] Error starting chat:', error);
      vscode.window.showErrorMessage(
        `Failed to start chat: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleOpenSource(transcript: Transcript, transcriptPath: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      // Fetch transcript content from MCP server
      const content: TranscriptContent = await this._client.readTranscript(transcriptUri);
      
      // Create a virtual document URI for the transcript
      // Include "(read only)" in the path so it shows in the tab title
      const filename = transcript.filename || transcriptPath.split('/').pop() || 'transcript';
      const virtualUri = vscode.Uri.parse(`protokoll-transcript://transcript/${encodeURIComponent(transcriptUri)}/${encodeURIComponent(filename)} (read only)`);
      
      // Get the global content provider and set the content BEFORE opening the document
      const provider = getTranscriptContentProvider();
      provider.setContentForUri(virtualUri, content.content);
      
      // Small delay to ensure content is set before VS Code requests it
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Open the virtual document
      const document = await vscode.workspace.openTextDocument(virtualUri);
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      });

      // Make the document read-only in this session
      await vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');
      
      console.log(`Protokoll: Opened transcript content in editor: ${transcriptUri}`);
    } catch (error) {
      console.error('Protokoll: Error opening transcript content:', error);
      vscode.window.showErrorMessage(
        `Failed to open transcript content: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Open transcript in a real VS Code editor for editing.
   * This enables VS Code Speech extension dictation support.
   * Only the body content is shown - metadata is preserved separately.
   * Saves are synced back to the MCP server.
   */
  private async handleEditInEditor(
    transcript: Transcript,
    transcriptPath: string,
    transcriptUri: string,
    editTarget: 'enhanced' | 'original' = 'enhanced'
  ): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      // Fetch transcript content from MCP server - returns structured JSON
      const content: TranscriptContent = await this._client.readTranscript(transcriptUri);
      
      const body = editTarget === 'original'
        ? (content.rawTranscript?.text ?? content.content)
        : content.content;
      
      // Create a temp file with title in filename for clear tab title
      const title = transcript.title || transcript.filename || 'Transcript';
      const safeTitle = title.replace(/[^a-zA-Z0-9_ -]/g, '').substring(0, 50);
      const tempDir = os.tmpdir();
      const tempFilePath = path.join(tempDir, `Editing - ${safeTitle}.md`);
      
      // Write only the body content to temp file (metadata is stored on server)
      fs.writeFileSync(tempFilePath, body, 'utf8');
      
      // Track this file for save syncing
      // Note: With PKL format, metadata is stored separately - no header needed
      editableTranscriptFiles.set(tempFilePath, {
        // Use canonical transcript URI for save-back to avoid brittle path guessing.
        // Server-side resolveTranscriptPath supports Protokoll URIs directly.
        transcriptPath: transcriptUri,
        transcriptUri: transcriptUri,
        editTarget,
        originalContent: content.content,
        header: '', // No header with PKL format - metadata is separate
        originalBody: body,
      });
      
      // Open the temp file in VS Code editor
      const document = await vscode.workspace.openTextDocument(tempFilePath);
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      });
      
      // Show Save & Close action
      vscode.window.showInformationMessage(
        `Editing ${editTarget === 'original' ? 'Original' : 'Enhanced'}: ${title}`,
        'Save & Close'
      ).then(async (action) => {
        if (action === 'Save & Close') {
          // Save the document
          await document.save();
          // Close the editor
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
      });
      
      console.log(`Protokoll: Opened transcript body for editing: ${tempFilePath}`);
    } catch (error) {
      console.error('Protokoll: Error opening transcript for editing:', error);
      vscode.window.showErrorMessage(
        `Failed to open transcript for editing: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleReviewTranscription(transcript: Transcript, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      // Get transcript info for context
      const transcriptPath = transcript.path || transcript.filename;
      const transcriptTitle = transcript.title || transcript.filename;
      
      console.log('Protokoll: [TRANSCRIPT VIEW] Review Transcription clicked', {
        transcriptTitle,
        transcriptPath,
        transcriptUri,
        transcriptFilename: transcript.filename
      });
      
      // Open chat directly with transcript context - reset context to clear history
      if (this._chatProvider) {
        const transcriptContext = {
          title: transcriptTitle,
          path: transcriptPath,
          filename: transcript.filename,
          uri: transcriptUri,
        };
        
        console.log('Protokoll: [TRANSCRIPT VIEW] Opening chat with context:', transcriptContext);
        
        // Always creates a new chat panel (old panel is disposed automatically)
        await this._chatProvider.showChat(undefined, transcriptUri, transcriptContext);
      } else {
        // Fallback: open chat command
        await vscode.commands.executeCommand('protokoll.openChat');
      }
      
    } catch (error) {
      console.error('Protokoll: [TRANSCRIPT VIEW] Error opening chat:', error);
      vscode.window.showErrorMessage(
        `Failed to open chat: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleStartChatFromInput(transcript: Transcript, message: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      // Get transcript info for context
      const transcriptPath = transcript.path || transcript.filename;
      const transcriptTitle = transcript.title || transcript.filename;
      
      const transcriptContext = {
        title: transcriptTitle,
        path: transcriptPath,
        filename: transcript.filename,
        uri: transcriptUri,
      };

      // Start a new chat with the message already sent
      if (this._chatProvider) {
        await this._chatProvider.showChat(message, transcriptUri, transcriptContext);
      } else {
        // Fallback: open chat command
        await vscode.commands.executeCommand('protokoll.openChat');
      }
      
    } catch (error) {
      console.error('Protokoll: [TRANSCRIPT VIEW] Error starting chat:', error);
      vscode.window.showErrorMessage(
        `Failed to start chat: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async getEntityDetails(entityType: string, entityId: string): Promise<{ id: string; name: string; type: string } | null> {
    try {
      const entityUri = `protokoll://entity/${entityType}/${encodeURIComponent(entityId)}`;
      const entityContent = await this._client!.readResource(entityUri);
      const entityData = this.parseEntityContent(entityContent.text);
      return {
        id: entityId,
        name: entityData.name || entityId,
        type: entityType
      };
    } catch (error) {
      console.warn('Could not read entity:', entityType, entityId, error);
      return null;
    }
  }

  private getEntitySectionKey(entityType: string): 'projects' | 'people' | 'terms' | 'companies' | undefined {
    switch (entityType) {
      case 'project':
        return 'projects';
      case 'person':
        return 'people';
      case 'term':
        return 'terms';
      case 'company':
        return 'companies';
      default:
        return undefined;
    }
  }

  private async listEntitiesByType(entityType: string, search: string, limit = 100): Promise<Array<{ id: string; name: string }>> {
    if (!this._client) {
      return [];
    }

    const sectionKey = this.getEntitySectionKey(entityType);
    if (!sectionKey) {
      return [];
    }

    const listResult = await this._client.callTool(`protokoll_list_${sectionKey}`, {
      search,
      limit,
    }) as Record<string, unknown>;

    const entities = listResult[sectionKey] as Array<{ id: string; name: string }> | undefined;
    if (!Array.isArray(entities)) {
      return [];
    }

    return entities
      .filter((entity) => entity?.id && entity?.name)
      .map((entity) => ({ id: entity.id, name: entity.name }));
  }

  private async createEntityByType(entityType: string, rawName: string): Promise<{ id: string; name: string } | undefined> {
    if (!this._client) {
      return undefined;
    }

    const name = rawName.trim();
    if (!name) {
      return undefined;
    }

    let toolName = '';
    let args: Record<string, unknown> = {};

    switch (entityType) {
      case 'person':
        toolName = 'protokoll_add_person';
        args = { name };
        break;
      case 'project':
        toolName = 'protokoll_add_project';
        args = { name };
        break;
      case 'term':
        toolName = 'protokoll_add_term';
        args = { term: name };
        break;
      case 'company':
        toolName = 'protokoll_add_company';
        args = { name };
        break;
      default:
        return undefined;
    }

    const createResult = await this._client.callTool(toolName, args) as
      | { id?: string; name?: string; entity?: { id?: string; name?: string } }
      | string;

    if (typeof createResult === 'string') {
      throw new Error(createResult);
    }

    const createdId = createResult.entity?.id ?? createResult.id;
    const createdName = createResult.entity?.name ?? createResult.name ?? name;
    if (!createdId) {
      throw new Error(`Failed to create ${entityType}: no ID returned`);
    }

    return {
      id: createdId,
      name: createdName,
    };
  }

  private async showEntityReferencePickerForType(entityType: string): Promise<{ id: string; name: string; type: string } | undefined> {
    if (!this._client) {
      return undefined;
    }

    interface PickerItem extends vscode.QuickPickItem {
      id?: string;
      name?: string;
      type?: string;
      source?: 'existing' | 'create';
    }

    const typeLabel = this.capitalizeFirst(entityType);
    const picker = vscode.window.createQuickPick<PickerItem>();
    picker.title = `Add ${typeLabel} Entity Reference`;
    picker.placeholder = `Search ${typeLabel.toLowerCase()} entities or create a new one`;
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.canSelectMany = false;

    const buildItems = (query: string, entities: Array<{ id: string; name: string }>): PickerItem[] => {
      const createName = query.trim();
      const items: PickerItem[] = [];

      if (createName.length > 0) {
        items.push({
          label: `$(add) Create new ${entityType}: "${createName}"`,
          description: 'Create and add this entity',
          name: createName,
          type: entityType,
          source: 'create',
          alwaysShow: true,
        });
      }

      if (entities.length > 0) {
        if (items.length > 0) {
          items.push({
            label: '',
            kind: vscode.QuickPickItemKind.Separator,
          });
        }
        items.push(...entities.map((entity) => ({
          label: entity.name,
          description: entity.id,
          id: entity.id,
          name: entity.name,
          type: entityType,
          source: 'existing' as const,
        })));
      }

      if (items.length === 0) {
        items.push({
          label: 'No matches yet',
          description: 'Type to search or create',
          alwaysShow: true,
        });
      }

      return items;
    };

    let latestQuery = '';
    let searchTimeout: NodeJS.Timeout | undefined;

    const refreshItems = async (query: string): Promise<void> => {
      latestQuery = query;
      const entities = await this.listEntitiesByType(entityType, query, 100);
      if (latestQuery !== query) {
        return;
      }
      picker.items = buildItems(query, entities);
    };

    await refreshItems('');

    picker.onDidChangeValue((value) => {
      if (searchTimeout) {
        clearTimeout(searchTimeout);
      }
      searchTimeout = setTimeout(() => {
        refreshItems(value).catch((error) => {
          console.warn(`Failed to search ${entityType} entities:`, error);
        });
      }, 200);
    });

    return new Promise((resolve) => {
      picker.onDidAccept(async () => {
        const selected = picker.selectedItems[0];
        if (!selected || !selected.type || !selected.source) {
          resolve(undefined);
          picker.dispose();
          return;
        }

        try {
          if (selected.source === 'create') {
            if (!selected.name) {
              resolve(undefined);
            } else {
              const created = await this.createEntityByType(selected.type, selected.name);
              resolve(created ? { ...created, type: selected.type } : undefined);
            }
          } else if (selected.id && selected.name) {
            resolve({
              id: selected.id,
              name: selected.name,
              type: selected.type,
            });
          } else {
            resolve(undefined);
          }
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to add ${entityType}: ${error instanceof Error ? error.message : String(error)}`
          );
          resolve(undefined);
        } finally {
          picker.dispose();
        }
      });

      picker.onDidHide(() => {
        resolve(undefined);
        picker.dispose();
      });

      picker.show();
    });
  }

  private normalizeEntityReferencesForSave(input: unknown): {
    projects: Array<{ id: string; name: string }>;
    people: Array<{ id: string; name: string }>;
    terms: Array<{ id: string; name: string }>;
    companies: Array<{ id: string; name: string }>;
  } {
    const empty = {
      projects: [] as Array<{ id: string; name: string }>,
      people: [] as Array<{ id: string; name: string }>,
      terms: [] as Array<{ id: string; name: string }>,
      companies: [] as Array<{ id: string; name: string }>,
    };

    if (!input || typeof input !== 'object') {
      return empty;
    }

    const payload = input as Record<string, unknown>;

    const sanitize = (value: unknown): Array<{ id: string; name: string }> => {
      if (!Array.isArray(value)) {
        return [];
      }
      const deduped = new Map<string, { id: string; name: string }>();
      for (const item of value) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const id = String((item as { id?: unknown }).id ?? '').trim();
        const name = String((item as { name?: unknown }).name ?? '').trim();
        if (!id || !name) {
          continue;
        }
        deduped.set(id, { id, name });
      }
      return Array.from(deduped.values());
    };

    return {
      projects: sanitize(payload.projects),
      people: sanitize(payload.people),
      terms: sanitize(payload.terms),
      companies: sanitize(payload.companies),
    };
  }

  private async handlePickEntityReference(
    panel: vscode.WebviewPanel,
    transcript: Transcript,
    entityType: string
  ): Promise<void> {
    const selected = await this.showEntityReferencePickerForType(entityType);
    if (!selected) {
      panel.webview.postMessage({
        command: 'entityReferencePickCancelled',
      });
      return;
    }

    const sectionKey = this.getEntitySectionKey(entityType);
    if (!sectionKey) {
      return;
    }

    panel.webview.postMessage({
      command: 'entityReferencePicked',
      section: sectionKey,
      entity: {
        id: selected.id,
        name: selected.name,
      },
      transcriptUri: transcript.uri,
    });
  }

  private async handleSaveEntityReferences(
    panel: vscode.WebviewPanel,
    transcript: Transcript,
    transcriptUri: string,
    entitiesPayload: unknown
  ): Promise<void> {
    if (!this._client) {
      panel.webview.postMessage({
        command: 'entityReferencesSaved',
        success: false,
        message: 'MCP client not initialized',
      });
      return;
    }

    try {
      const entities = this.normalizeEntityReferencesForSave(entitiesPayload);
      const transcriptPath = this.getToolTranscriptPath(
        transcript.uri || transcript.path,
        transcriptUri
      );

      await this._client.callTool('protokoll_update_transcript_entity_references', {
        transcriptPath,
        entities,
      });

      const current = this._currentTranscripts.get(transcriptUri);
      if (current) {
        this._currentTranscripts.set(transcriptUri, {
          uri: current.uri,
          transcript: {
            ...current.transcript,
            entities,
          },
        });
      }

      panel.webview.postMessage({
        command: 'entityReferencesSaved',
        success: true,
      });

      await this.refreshTranscript(transcriptUri);
      vscode.window.showInformationMessage('Entity references updated');
    } catch (error) {
      panel.webview.postMessage({
        command: 'entityReferencesSaved',
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
      vscode.window.showErrorMessage(
        `Failed to update entity references: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async showEntityPicker(
    selectedText: string,
    transcriptPath: string,
    transcriptUri?: string
  ): Promise<{ id: string; name: string; type: string; source: 'suggestion' | 'search' | 'create-new' } | undefined> {
    interface EntityPickerItem extends vscode.QuickPickItem {
      id?: string;
      name?: string;
      type?: string;
      source?: 'suggestion' | 'search' | 'create-new';
      score?: number;
    }

    const items: EntityPickerItem[] = [];
    
    // Step 1: Get weight model suggestions
    try {
      const predictions = await this._client!.callTool('protokoll_predict_entities', {
        transcriptPath: this.getToolTranscriptPath(transcriptPath, transcriptUri),
        maxPredictions: 5
      }) as { success?: boolean; predictions?: Array<{ entityId: string; score: number; source: string }> };
      
      if (predictions.success && predictions.predictions && predictions.predictions.length > 0) {
        // Add separator for suggestions
        items.push({
          label: '$(sparkle) Suggested Entities',
          kind: vscode.QuickPickItemKind.Separator
        });
        
        // Add suggestion items
        for (const pred of predictions.predictions) {
          const entity = await this.getEntityDetails('person', pred.entityId) || 
                         await this.getEntityDetails('project', pred.entityId) ||
                         await this.getEntityDetails('term', pred.entityId) ||
                         await this.getEntityDetails('company', pred.entityId);
          if (entity) {
            items.push({
              id: entity.id,
              name: entity.name,
              type: entity.type,
              source: 'suggestion',
              score: pred.score,
              label: `$(star) ${entity.name}`,
              description: `${entity.type} • score: ${pred.score.toFixed(1)}`,
              detail: 'Suggested based on transcript context'
            });
          }
        }
      }
    } catch (error) {
      console.warn('Could not load entity suggestions:', error);
    }
    
    // Step 2: Add entity type sections with create-new and existing entities
    const entityTypes = [
      { value: 'person', label: 'People', plural: 'people', icon: 'person' },
      { value: 'project', label: 'Projects', plural: 'projects', icon: 'project' },
      { value: 'company', label: 'Companies', plural: 'companies', icon: 'organization' },
      { value: 'term', label: 'Terms', plural: 'terms', icon: 'symbol-key' }
    ];
    
    for (const type of entityTypes) {
      items.push({
        label: `$(${type.icon}) ${type.label}`,
        kind: vscode.QuickPickItemKind.Separator
      });
      
      // Add 'Create New' option
      items.push({
        id: `create-${type.value}`,
        name: selectedText,
        type: type.value,
        source: 'create-new',
        label: `$(plus) Create new ${type.value}: "${selectedText}"`,
        description: 'Create and map to new entity',
        alwaysShow: true
      });
      
      // Add existing entities matching the selected text (via name or sounds_like)
      try {
        const listResult = await this._client!.callTool(`protokoll_list_${type.plural}`, {
          search: selectedText,
          limit: 5
        }) as { [key: string]: unknown };
        
        const entityKey = type.plural;
        const entityList = listResult[entityKey] as Array<{ id: string; name: string }> | undefined;
        if (Array.isArray(entityList)) {
          for (const entity of entityList) {
            items.push({
              id: entity.id,
              name: entity.name,
              type: type.value,
              source: 'search',
              label: entity.name,
              description: type.value
            });
          }
        }
      } catch (error) {
        console.warn(`Could not load ${type.plural} entities:`, error);
      }
    }
    
    const picker = vscode.window.createQuickPick<EntityPickerItem>();
    picker.items = items;
    picker.placeholder = `Correct "${selectedText}" to... (type to search)`;
    picker.canSelectMany = false;
    picker.title = 'Entity Correction';
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    
    // Enable dynamic search
    let searchTimeout: NodeJS.Timeout | undefined;
    picker.onDidChangeValue(async (value) => {
      if (searchTimeout) {
        clearTimeout(searchTimeout);
      }

      // Rebuild create-new items using typed value (or fall back to selectedText)
      const createNewName = value.trim() || selectedText;
      const updatedItems: EntityPickerItem[] = items.map(item => {
        if (item.source === 'create-new' && item.type) {
          return {
            ...item,
            name: createNewName,
            label: `$(plus) Create new ${item.type}: "${createNewName}"`,
            alwaysShow: true
          };
        }
        return item;
      });

      if (value.length > 2) {
        searchTimeout = setTimeout(async () => {
          // Search across all entity types
          const searchItems: EntityPickerItem[] = [...updatedItems.filter(i => i.kind === vscode.QuickPickItemKind.Separator || i.source === 'create-new' || i.source === 'suggestion')];
          
          for (const type of entityTypes) {
            try {
              const searchResult = await this._client!.callTool(`protokoll_list_${type.plural}`, {
                search: value,
                limit: 10
              }) as { [key: string]: unknown };
              
              const entityKey = type.plural;
              const entityList = searchResult[entityKey] as Array<{ id: string; name: string }> | undefined;
              if (Array.isArray(entityList)) {
                for (const entity of entityList) {
                  // Don't duplicate if already in suggestions
                  if (!searchItems.some(i => i.id === entity.id)) {
                    searchItems.push({
                      id: entity.id,
                      name: entity.name,
                      type: type.value,
                      source: 'search',
                      label: entity.name,
                      description: `${type.value} (search result)`
                    });
                  }
                }
              }
            } catch (error) {
              console.warn(`Search failed for ${type.plural}:`, error);
            }
          }
          
          picker.items = searchItems;
        }, 300); // Debounce search
        // Show updated create-new labels immediately while waiting for search results
        picker.items = updatedItems;
      } else if (value.length === 0) {
        // Reset to original items
        picker.items = items;
      } else {
        // 1-2 chars: show updated create-new labels (VS Code filter handles the rest)
        picker.items = updatedItems;
      }
    });
    
    return new Promise((resolve) => {
      picker.onDidAccept(() => {
        const selected = picker.selectedItems[0];
        if (selected && selected.id && selected.name && selected.type && selected.source) {
          resolve({ 
            id: selected.id, 
            name: selected.name, 
            type: selected.type, 
            source: selected.source 
          });
        } else {
          resolve(undefined);
        }
        picker.dispose();
      });
      
      picker.onDidHide(() => {
        resolve(undefined);
        picker.dispose();
      });
      
      picker.show();
    });
  }

  private async handleCorrectSelection(selectedText: string, transcriptUri: string): Promise<void> {
    if (!this._client || !selectedText?.trim()) {
      vscode.window.showWarningMessage('No text selected');
      return;
    }
    
    try {
      const currentTranscript = this._currentTranscripts.get(transcriptUri);
      if (!currentTranscript) {
        vscode.window.showErrorMessage('No transcript loaded');
        return;
      }
      
      const transcriptRef = this.getToolTranscriptPath(
        currentTranscript.transcript.uri || currentTranscript.transcript.path,
        transcriptUri
      );
      const selectedEntity = await this.showEntityPicker(selectedText, transcriptRef, transcriptUri);
      
      if (!selectedEntity) {
        return;
      }
      
      const correctionArgs: Record<string, unknown> = {
        transcriptPath: transcriptRef,
        selectedText: selectedText.trim(),
        entityType: selectedEntity.type
      };
      
      if (selectedEntity.source === 'create-new') {
        if (selectedEntity.type === 'person') {
          const personDetails = await this.promptForPersonDetails(selectedText.trim());
          if (!personDetails) {
            return;
          }
          correctionArgs.entityName = personDetails.fullName;
          if (personDetails.firstName) { correctionArgs.firstName = personDetails.firstName; }
          if (personDetails.lastName) { correctionArgs.lastName = personDetails.lastName; }
          if (personDetails.description) { correctionArgs.description = personDetails.description; }
          if (personDetails.projectId) { correctionArgs.projectId = personDetails.projectId; }
        } else {
          correctionArgs.entityName = selectedEntity.name;
        }
      } else {
        correctionArgs.entityId = selectedEntity.id;
      }
      
      const rawResult = await this._client.callTool('protokoll_correct_to_entity', correctionArgs);
      
      if (typeof rawResult === 'string') {
        vscode.window.showErrorMessage(`Correction failed: ${rawResult}`);
        return;
      }
      
      const result = rawResult as {
        success?: boolean;
        message?: string;
        entity?: { id: string; name: string; type: string };
        isNewEntity?: boolean;
      };
      
      if (result.success && result.entity) {
        const action = result.isNewEntity ? 'Created' : 'Mapped to existing';
        vscode.window.showInformationMessage(
          `${action} ${selectedEntity.type}: ${result.entity.name}`
        );
        
        await this.handleOpenEntity(selectedEntity.type, result.entity.id);
        await this.refreshTranscript(transcriptUri);
      } else {
        vscode.window.showErrorMessage(
          `Correction failed: ${result.message || 'Unknown error'}`
        );
      }
    } catch (error) {
      console.error('Protokoll: [TRANSCRIPT VIEW] Error correcting selection:', error);
      vscode.window.showErrorMessage(
        `Correction failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async promptForPersonDetails(selectedText: string): Promise<{
    fullName: string;
    firstName?: string;
    lastName?: string;
    description?: string;
    projectId?: string;
  } | undefined> {
    const fullName = await vscode.window.showInputBox({
      title: 'New Person: Full Name',
      prompt: 'Enter the full name for this person',
      value: selectedText,
      placeHolder: 'e.g. Gerald Smith',
      validateInput: (value) => value.trim() ? null : 'Name is required',
    });
    
    if (!fullName) {
      return undefined;
    }
    
    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts.length > 1 ? nameParts[0] : undefined;
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;
    
    let projectId: string | undefined;
    try {
      const projectResult = await this._client!.callTool('protokoll_list_projects', { limit: 50 }) as {
        success?: boolean;
        projects?: Array<{ id: string; name: string }>;
      };
      
      if (typeof projectResult !== 'string' && projectResult.success && projectResult.projects && projectResult.projects.length > 0) {
        const projectItems: vscode.QuickPickItem[] = [
          { label: '$(dash) None', description: 'No project association' },
          ...[...projectResult.projects].sort((a, b) => a.name.localeCompare(b.name)).map(p => ({
            label: p.name,
            description: p.id,
          }))
        ];
        
        const selectedProject = await vscode.window.showQuickPick(projectItems, {
          title: 'New Person: Project Association (optional)',
          placeHolder: 'Associate this person with a project?',
        });
        
        if (selectedProject && selectedProject.description && selectedProject.description !== 'No project association') {
          projectId = selectedProject.description;
        }
      }
    } catch {
      // Projects not available, skip
    }
    
    const description = await vscode.window.showInputBox({
      title: 'New Person: Description (optional)',
      prompt: 'Add a brief description or context for this person',
      placeHolder: 'e.g. VP of Engineering at Acme Corp',
    });
    
    return {
      fullName: fullName.trim(),
      firstName,
      lastName,
      description: description?.trim() || undefined,
      projectId,
    };
  }

  private async handleCreateEntityFromSelection(selectedText: string, transcriptUri: string): Promise<void> {
    // Delegate to unified correction handler
    return this.handleCorrectSelection(selectedText, transcriptUri);
  }

  private slugify(text: string): string {
    // Match the server's slugify function: uses hyphens, not underscores
    return text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/--+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private parseEntityContent(content: string): {
    name?: string;
    id?: string;
    type?: string;
    updatedAt?: string;
    source?: string;
    description?: string;
    classification?: Record<string, unknown>;
    topics?: string[];
    [key: string]: unknown;
  } {
    try {
      const parsed = yaml.load(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to empty object if content is not valid YAML
    }
    return {};
  }


  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  private formatDate(dateString: string): string {
    const parsed = this.parseClientLocalDate(dateString);
    if (!parsed) {
      return 'Invalid Date';
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(dateString.trim())) {
      return parsed.toLocaleDateString();
    }

    return parsed.toLocaleString();
  }

  private formatTranscriptDateTime(dateString: string, timeString?: string): string {
    const parsed = this.parseClientLocalDate(dateString, timeString);
    if (!parsed) {
      return timeString ? `${dateString} ${timeString}` : dateString;
    }

    if (timeString) {
      return parsed.toLocaleString();
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(dateString.trim())) {
      return parsed.toLocaleDateString();
    }

    return parsed.toLocaleString();
  }

  private formatDateInputValue(dateString: string): string {
    const trimmed = dateString.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }

    const parsed = this.parseClientLocalDate(trimmed);
    if (!parsed) {
      return '';
    }

    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private parseClientLocalDate(dateString: string, timeString?: string): Date | null {
    const trimmedDate = dateString.trim();
    const dateOnlyMatch = trimmedDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    // Treat date-only values as local calendar dates so day grouping/display
    // stays consistent with the user's timezone.
    if (dateOnlyMatch) {
      const year = Number(dateOnlyMatch[1]);
      const month = Number(dateOnlyMatch[2]);
      const day = Number(dateOnlyMatch[3]);

      let hours = 0;
      let minutes = 0;
      let seconds = 0;
      if (timeString) {
        const timeMatch = timeString.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (timeMatch) {
          hours = Number(timeMatch[1]);
          minutes = Number(timeMatch[2]);
          seconds = Number(timeMatch[3] ?? 0);
        }
      }

      const localDate = new Date(year, month - 1, day, hours, minutes, seconds);
      if (!isNaN(localDate.getTime())) {
        return localDate;
      }
      return null;
    }

    const parsed = new Date(trimmedDate);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }

    return null;
  }

  private isLikelyUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
  }

  private async fetchProjectNameMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!this._client) { return map; }
    try {
      const result = await this._client.callTool('protokoll_list_projects', { limit: 200 }) as {
        projects?: Array<{ id: string; name: string }>;
      };
      if (typeof result !== 'string' && result.projects) {
        for (const p of result.projects) {
          map.set(p.id, p.name);
        }
      }
    } catch {
      // Non-critical -- fall back to showing IDs
    }
    return map;
  }

  /** Inner HTML for one project link label (http/https only become anchors). */
  private projectUrlLabelInnerHtml(url: string): string {
    const t = url.trim();
    if (/^https?:\/\//i.test(t)) {
      return `<a href="${this.escapeHtml(t)}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(t)}</a>`;
    }
    return this.escapeHtml(t);
  }

  private getEntityContent(entityType: string, entityId: string, content: string, entityData?: {
    name?: string;
    id?: string;
    type?: string;
    updatedAt?: string;
    source?: string;
    description?: string;
    classification?: Record<string, unknown>;
    topics?: string[];
    [key: string]: unknown;
  }, lastFetched?: Date, projectNameMap?: Map<string, string>): string {
    // Parse entity data if not provided
    if (!entityData) {
      entityData = this.parseEntityContent(content);
    }

    const entityName = entityData.name || entityId;
    const entityIdDisplay = entityData.id || entityId;
    const data = entityData as Record<string, unknown>;
    
    // Extract description - person entities use "context" field, others use "description"
    const description = entityData.description || data.context as string || '';
    const topics = entityData.topics || [];
    const relatedPlansTotal =
      typeof data.related_plans_total === 'number' && Number.isFinite(data.related_plans_total)
        ? data.related_plans_total
        : null;

    // Extract entity-specific fields
    const soundsLike: string[] = Array.isArray(data.sounds_like) ? data.sounds_like as string[] : [];
    const projectUrls: string[] =
      entityType === 'project' && Array.isArray(data.urls)
        ? (data.urls as unknown[])
            .filter((u): u is string => typeof u === 'string')
            .map((u) => u.trim())
            .filter((u) => u.length > 0)
        : [];
    const role = (data.role as string) || '';
    const company = (data.company as string) || '';

    // Extract project relationships for person entities
    const relationships: Array<{uri: string; relationship: string; notes?: string}> =
        Array.isArray(data.relationships) ? data.relationships as Array<{uri: string; relationship: string; notes?: string}> : [];
    const projectRelationships = relationships.filter(r => r.uri?.startsWith('redaksjon://project/'));
    const projectIds = projectRelationships.map(r => {
      const match = r.uri.match(/^redaksjon:\/\/project\/(.+)$/);
      return { id: match ? match[1] : r.uri, relationship: r.relationship, uri: r.uri };
    });
    const expansion = (data.expansion as string) || '';
    const domain = (data.domain as string) || '';
    const fullName = (data.fullName as string) || '';
    const industry = (data.industry as string) || '';
    
    // Remove already-parsed fields from content to get remaining content
    let remainingContent = content;
    if (description) {
      remainingContent = remainingContent.replace(
        new RegExp(`description:\\s*[>|-]?\\s*${description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 's'),
        ''
      );
    }

    // Build editable fields config based on entity type
    type FieldDef = { key: string; label: string; value: string; editParam: string };
    const editableFields: FieldDef[] = [];
    if (entityType === 'person') {
      editableFields.push(
        { key: 'role', label: 'Role', value: role, editParam: 'role' },
        { key: 'company', label: 'Company', value: company, editParam: 'company' },
      );
    } else if (entityType === 'term') {
      editableFields.push(
        { key: 'expansion', label: 'Expansion', value: expansion, editParam: 'expansion' },
        { key: 'domain', label: 'Domain', value: domain, editParam: 'domain' },
      );
    } else if (entityType === 'company') {
      editableFields.push(
        { key: 'fullName', label: 'Full Name', value: fullName, editParam: 'fullName' },
        { key: 'industry', label: 'Industry', value: industry, editParam: 'industry' },
      );
    }

    // Format metadata section
    const metadataRows: string[] = [];
    
    if (entityData.type) {
      metadataRows.push(`
        <div class="metadata-row">
          <div class="metadata-label">Type:</div>
          <div class="metadata-value">${this.escapeHtml(String(entityData.type))}</div>
        </div>
      `);
    }
    
    if (entityData.updatedAt) {
      metadataRows.push(`
        <div class="metadata-row">
          <div class="metadata-label">Updated:</div>
          <div class="metadata-value">${this.escapeHtml(this.formatDate(String(entityData.updatedAt)))}</div>
        </div>
      `);
    }
    
    // Source field intentionally hidden from client view

    if (entityData.classification) {
      const classificationStr = JSON.stringify(entityData.classification, null, 2);
      metadataRows.push(`
        <div class="metadata-row">
          <div class="metadata-label">Classification:</div>
          <div class="metadata-value"><pre>${this.escapeHtml(classificationStr)}</pre></div>
        </div>
      `);
    }

    const descriptionSectionHtml = `
    <div class="description" id="description-section">
        <h2>Description</h2>
        <div class="entity-content" id="description-display">
            ${description ? this.markdownToHtml(description) : '<span class="empty-state">No description</span>'}
        </div>
        <textarea class="edit-description-area hidden" id="edit-description-input">${this.escapeHtml(description)}</textarea>
    </div>`;

    const projectUrlsSectionHtml =
      entityType === 'project'
        ? `
    <div class="urls-section" id="project-urls-section">
        <h2>Links</h2>
        <div class="urls-tags" id="project-urls-tags">
            ${
              projectUrls.length > 0
                ? projectUrls
                    .map(
                      (u) => `
            <span class="project-url-tag" data-value="${this.escapeHtml(u)}">
                <span class="project-url-tag-label">${this.projectUrlLabelInnerHtml(u)}</span>
                <button type="button" class="remove-url" title="Remove">&times;</button>
            </span>`
                    )
                    .join('')
                : '<span class="empty-urls" id="empty-project-urls">No links yet</span>'
            }
        </div>
        <div class="urls-add">
            <input type="text" class="urls-add-input" id="project-urls-add-input" placeholder="https://..." />
            <button type="button" class="urls-add-btn" id="project-urls-add-btn">Add link</button>
        </div>
    </div>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.escapeHtml(entityName)}</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            line-height: 1.6;
        }
        .entity-header {
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .entity-header h1 {
            margin-top: 8px;
            margin-bottom: 4px;
            color: var(--vscode-textLink-foreground);
            font-size: 1.8em;
        }
        .entity-id {
            font-size: 0.75em;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
            opacity: 0.7;
            margin-bottom: 12px;
        }
        .entity-type {
            display: inline-block;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 0.9em;
            text-transform: capitalize;
            margin-bottom: 8px;
        }
        .metadata {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 16px;
            margin-bottom: 24px;
        }
        .metadata-row {
            display: flex;
            margin-bottom: 8px;
            align-items: flex-start;
        }
        .metadata-row:last-child {
            margin-bottom: 0;
        }
        .metadata-label {
            font-weight: 600;
            min-width: 100px;
            color: var(--vscode-descriptionForeground);
        }
        .metadata-value {
            flex: 1;
            color: var(--vscode-foreground);
        }
        .metadata-value code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }
        .metadata-value pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 0;
            font-size: 0.9em;
        }
        .entity-content {
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .entity-content h1,
        .entity-content h2,
        .entity-content h3 {
            color: var(--vscode-textLink-foreground);
            margin-top: 24px;
            margin-bottom: 12px;
        }
        .entity-content code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 4px;
            border-radius: 2px;
            font-family: var(--vscode-editor-font-family);
        }
        .entity-content pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 4px;
            overflow-x: auto;
        }
        .topics-list {
            margin-top: 8px;
        }
        .topics-list ul {
            margin: 0;
            padding-left: 1.5em;
        }
        .topics-list li {
            margin: 0.25em 0;
        }
        .description {
            margin-top: 24px;
        }
        .description h2 {
            color: var(--vscode-textLink-foreground);
            margin-top: 0;
            margin-bottom: 12px;
        }
        .inline-chat-container {
            margin-top: 24px;
            margin-bottom: 24px;
            padding: 16px 0;
            border-top: 1px solid var(--vscode-panel-border);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .inline-chat-input-wrapper {
            display: flex;
            gap: 8px;
            align-items: flex-end;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 8px;
            padding: 8px 12px;
        }
        .inline-chat-input-wrapper:focus-within {
            border-color: var(--vscode-focusBorder);
        }
        .inline-chat-input {
            flex: 1;
            background: transparent;
            border: none;
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            resize: none;
            min-height: 24px;
            max-height: 200px;
            overflow-y: auto;
            outline: none;
            padding: 4px 0;
        }
        .inline-chat-input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        .inline-chat-send {
            background: transparent;
            border: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            padding: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.7;
            transition: opacity 0.2s;
        }
        .inline-chat-send:hover {
            opacity: 1;
        }
        .inline-chat-send:disabled {
            opacity: 0.3;
            cursor: not-allowed;
        }
        .entity-header {
            position: relative;
        }
        .refresh-button {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: background-color 0.2s;
        }
        .refresh-button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .refresh-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .last-fetched {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            margin-top: 8px;
            font-style: italic;
        }
        .related-transcripts h2 {
            color: var(--vscode-textLink-foreground);
            margin-top: 0;
            margin-bottom: 12px;
        }
        .related-transcripts-table {
            width: 100%;
            border-collapse: collapse;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            overflow: hidden;
        }
        .related-transcripts-table th {
            text-align: left;
            padding: 8px 12px;
            font-weight: 600;
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .related-transcripts-table td {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .related-transcripts-table tr:last-child td {
            border-bottom: none;
        }
        .related-transcripts-table tr.related-transcript-row {
            cursor: pointer;
            transition: background-color 0.15s;
        }
        .related-transcripts-table tr.related-transcript-row:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .related-transcript-title {
            font-weight: 500;
            color: var(--vscode-textLink-foreground);
        }
        .related-transcript-date,
        .related-transcript-project {
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
        }
        .related-plans {
            margin-top: 24px;
            margin-bottom: 24px;
        }
        .related-plans h2 {
            color: var(--vscode-textLink-foreground);
            margin-top: 0;
            margin-bottom: 12px;
        }
        .related-plans-table {
            width: 100%;
            border-collapse: collapse;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            overflow: hidden;
        }
        .related-plans-table th {
            text-align: left;
            padding: 8px 12px;
            font-weight: 600;
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .related-plans-table td {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            vertical-align: top;
        }
        .related-plans-table tr:last-child td {
            border-bottom: none;
        }
        .related-plans-table .plan-title {
            font-weight: 500;
            color: var(--vscode-foreground);
        }
        .related-plans-table .plan-id {
            font-size: 0.8em;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
            margin-top: 2px;
        }
        .related-plans-pagination {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-top: 12px;
            flex-wrap: wrap;
        }
        .related-plans-pagination button {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 4px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.85em;
        }
        .related-plans-pagination button:disabled {
            opacity: 0.45;
            cursor: not-allowed;
        }
        .related-plans-page-label {
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
        }
        .loading {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .empty-state {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .edit-button {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: background-color 0.2s;
        }
        .edit-button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .convert-button {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: background-color 0.2s;
        }
        .convert-button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .delete-button {
            background-color: var(--vscode-inputValidation-errorBackground, #5a1d1d);
            color: var(--vscode-inputValidation-errorForeground, #f48771);
            border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: background-color 0.2s;
        }
        .delete-button:hover {
            filter: brightness(1.08);
        }
        .header-buttons {
            position: absolute;
            top: 0;
            right: 0;
            display: flex;
            gap: 8px;
        }
        .edit-name-input {
            font-size: 1.8em;
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 4px 8px;
            width: 100%;
            box-sizing: border-box;
            font-family: var(--vscode-font-family);
            outline: none;
            margin-top: 8px;
            margin-bottom: 4px;
        }
        .edit-name-input:focus {
            border-color: var(--vscode-focusBorder);
        }
        .edit-description-area {
            width: 100%;
            min-height: 120px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 12px;
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            line-height: 1.6;
            resize: vertical;
            outline: none;
            box-sizing: border-box;
        }
        .edit-description-area:focus {
            border-color: var(--vscode-focusBorder);
        }
        .edit-actions {
            display: flex;
            gap: 8px;
            margin-top: 12px;
        }
        .save-button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
            transition: background-color 0.2s;
        }
        .save-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .save-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .cancel-button {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 6px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
            transition: background-color 0.2s;
        }
        .cancel-button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .edit-status {
            font-size: 0.85em;
            margin-left: 12px;
            display: flex;
            align-items: center;
        }
        .edit-status.saving {
            color: var(--vscode-descriptionForeground);
        }
        .edit-status.error {
            color: var(--vscode-errorForeground);
        }
        .edit-status.success {
            color: var(--vscode-testing-iconPassed);
        }
        .hidden { display: none !important; }
        .entity-fields {
            margin-bottom: 24px;
        }
        .entity-fields h2 {
            color: var(--vscode-textLink-foreground);
            margin-top: 0;
            margin-bottom: 12px;
        }
        .field-row {
            display: flex;
            align-items: center;
            margin-bottom: 8px;
            gap: 12px;
        }
        .field-label {
            font-weight: 600;
            min-width: 100px;
            color: var(--vscode-descriptionForeground);
            flex-shrink: 0;
        }
        .field-value {
            color: var(--vscode-foreground);
            flex: 1;
        }
        .field-value.empty {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .field-input {
            flex: 1;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 4px 8px;
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            outline: none;
        }
        .field-input:focus {
            border-color: var(--vscode-focusBorder);
        }
        .sounds-like-section {
            margin-bottom: 24px;
        }
        .sounds-like-section h2 {
            color: var(--vscode-textLink-foreground);
            margin-top: 0;
            margin-bottom: 12px;
        }
        .sounds-like-tags {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 8px;
        }
        .sounds-like-tag {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 3px 8px;
            border-radius: 12px;
            font-size: 0.85em;
        }
        .sounds-like-tag .remove-tag {
            display: none;
            cursor: pointer;
            opacity: 0.7;
            font-size: 1.1em;
            line-height: 1;
            padding: 0 2px;
            border: none;
            background: none;
            color: inherit;
        }
        .sounds-like-tag .remove-tag:hover {
            opacity: 1;
        }
        .editing .sounds-like-tag .remove-tag {
            display: inline-flex;
        }
        .sounds-like-add {
            display: none;
            gap: 6px;
            align-items: center;
            margin-top: 8px;
        }
        .editing .sounds-like-add {
            display: flex;
        }
        .sounds-like-add-input {
            flex: 1;
            max-width: 300px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 4px 8px;
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            outline: none;
        }
        .sounds-like-add-input:focus {
            border-color: var(--vscode-focusBorder);
        }
        .sounds-like-add-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.85em;
        }
        .sounds-like-add-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .empty-sounds {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .projects-section {
            margin-bottom: 24px;
        }
        .projects-section h2 {
            color: var(--vscode-textLink-foreground);
            margin-top: 0;
            margin-bottom: 12px;
        }
        .project-tags {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 8px;
        }
        .project-tag {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 3px 8px;
            border-radius: 12px;
            font-size: 0.85em;
        }
        .project-tag .relationship-type {
            opacity: 0.7;
            font-size: 0.9em;
        }
        .project-tag .remove-project {
            display: inline-flex;
            cursor: pointer;
            opacity: 0.7;
            font-size: 1.1em;
            line-height: 1;
            padding: 0 2px;
            border: none;
            background: none;
            color: inherit;
        }
        .project-tag .remove-project:hover {
            opacity: 1;
        }
        .empty-projects {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .add-project-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.85em;
            margin-top: 8px;
        }
        .add-project-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .urls-section {
            margin-bottom: 24px;
        }
        .urls-section h2 {
            color: var(--vscode-textLink-foreground);
            margin-top: 0;
            margin-bottom: 12px;
        }
        .urls-tags {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 8px;
        }
        .project-url-tag {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px 10px;
            font-size: 0.95em;
        }
        .project-url-tag-label {
            flex: 1;
            min-width: 0;
            word-break: break-all;
        }
        .project-url-tag-label a {
            color: var(--vscode-textLink-foreground);
        }
        .project-url-tag .remove-url {
            display: none;
            cursor: pointer;
            opacity: 0.7;
            font-size: 1.1em;
            line-height: 1;
            padding: 0 4px;
            border: none;
            background: none;
            color: inherit;
            flex-shrink: 0;
        }
        .project-url-tag .remove-url:hover {
            opacity: 1;
        }
        .editing .project-url-tag .remove-url {
            display: inline-flex;
        }
        .urls-add {
            display: none;
            gap: 8px;
            align-items: center;
            margin-top: 8px;
        }
        .editing .urls-add {
            display: flex;
        }
        .urls-add-input {
            flex: 1;
            min-width: 120px;
            max-width: 480px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 4px 8px;
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            outline: none;
        }
        .urls-add-input:focus {
            border-color: var(--vscode-focusBorder);
        }
        .urls-add-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.85em;
        }
        .urls-add-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .empty-urls {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
    </style>
</head>
<body>
    <div class="entity-header">
        <div class="header-buttons">
            <button class="edit-button" id="edit-button" title="Edit entity">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M11.5 1.5L14.5 4.5L5 14H2V11L11.5 1.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M9.5 3.5L12.5 6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
                Edit
            </button>
            <button class="refresh-button" id="refresh-button" title="Refresh entity data">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M8 2V6L10 4M8 14V10L6 12M2 8H6L4 10M14 8H10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" fill="none"/>
                </svg>
                Refresh
            </button>
            ${entityType === 'company' ? `
            <button class="convert-button" id="convert-to-person-button" title="Convert this company to a person">
                Convert to Person
            </button>` : ''}
            ${entityType === 'person' ? `
            <button class="convert-button" id="convert-to-company-button" title="Convert this person to a company">
                Convert to Company
            </button>` : ''}
            ${entityType === 'person' || entityType === 'company' || entityType === 'term' ? `
            <button class="delete-button" id="delete-entity-button" title="Delete this entity">
                Delete
            </button>` : ''}
        </div>
        <div class="entity-type">${this.escapeHtml(entityType)}</div>
        <h1 id="entity-name-display">${this.escapeHtml(entityName)}</h1>
        <input type="text" class="edit-name-input hidden" id="edit-name-input" value="${this.escapeHtml(entityName)}" />
        ${entityIdDisplay ? `<div class="entity-id">${this.escapeHtml(String(entityIdDisplay))}</div>` : ''}
        ${lastFetched ? `<div class="last-fetched">Last fetched: ${this.escapeHtml(this.formatDate(lastFetched.toISOString()))}</div>` : ''}
    </div>
    ${metadataRows.length > 0 || topics.length > 0 ? `
    <div class="metadata">
        ${metadataRows.join('')}
        ${topics.length > 0 ? `
        <div class="metadata-row">
            <div class="metadata-label">Topics:</div>
            <div class="metadata-value">
                <div class="topics-list">
                    <ul>
                        ${topics.map(topic => `<li>${this.escapeHtml(String(topic))}</li>`).join('')}
                    </ul>
                </div>
            </div>
        </div>
        ` : ''}
    </div>
    ` : ''}
    ${entityType === 'project' ? descriptionSectionHtml : ''}
    ${projectUrlsSectionHtml}
    ${entityType === 'project' ? `
    <div class="related-plans" id="related-plans-section">
        <h2 id="related-plans-heading">Related Plans${relatedPlansTotal !== null ? ` (${relatedPlansTotal})` : ''}</h2>
        <div id="related-plans-content">
            <div class="loading" id="related-plans-loading">Loading plans…</div>
            <table class="related-plans-table hidden" id="related-plans-table">
                <thead>
                    <tr>
                        <th>Title</th>
                        <th>Stage</th>
                        <th>Created</th>
                    </tr>
                </thead>
                <tbody id="related-plans-tbody"></tbody>
            </table>
            <div class="empty-state hidden" id="related-plans-empty">No related plans.</div>
            <div class="related-plans-pagination hidden" id="related-plans-pagination">
                <button type="button" id="related-plans-prev">Previous</button>
                <span class="related-plans-page-label" id="related-plans-page-label"></span>
                <button type="button" id="related-plans-next">Next</button>
            </div>
        </div>
    </div>
    ` : ''}
    ${editableFields.length > 0 ? `
    <div class="entity-fields" id="entity-fields-section">
        <h2>Details</h2>
        ${editableFields.map(f => `
        <div class="field-row">
            <div class="field-label">${this.escapeHtml(f.label)}:</div>
            <div class="field-value${f.value ? '' : ' empty'}" id="field-display-${f.key}">${f.value ? this.escapeHtml(f.value) : 'Not set'}</div>
            <input type="text" class="field-input hidden" id="field-input-${f.key}" value="${this.escapeHtml(f.value)}" placeholder="${this.escapeHtml(f.label)}" data-field-key="${f.key}" data-edit-param="${f.editParam}" />
        </div>
        `).join('')}
    </div>
    ` : ''}
    <div class="sounds-like-section" id="sounds-like-section">
        <h2>Sounds Like</h2>
        <div class="sounds-like-tags" id="sounds-like-tags">
            ${soundsLike.length > 0 ? soundsLike.map(s => `
            <span class="sounds-like-tag" data-value="${this.escapeHtml(s)}">
                ${this.escapeHtml(s)}
                <button class="remove-tag" title="Remove">&times;</button>
            </span>
            `).join('') : '<span class="empty-sounds" id="empty-sounds">No sounds_like variants</span>'}
        </div>
        <div class="sounds-like-add">
            <input type="text" class="sounds-like-add-input" id="sounds-like-add-input" placeholder="Add variant..." />
            <button class="sounds-like-add-btn" id="sounds-like-add-btn">Add</button>
        </div>
    </div>
    ${(entityType === 'person' || entityType === 'term') ? `
    <div class="projects-section" id="projects-section">
        <h2>Projects</h2>
        <div class="project-tags" id="project-tags">
            ${projectIds.length > 0 ? projectIds.map(p => {
              const displayName = projectNameMap?.get(p.id) || p.id;
              return `
            <span class="project-tag" data-uri="${this.escapeHtml(p.uri)}" data-relationship="${this.escapeHtml(p.relationship)}" data-id="${this.escapeHtml(p.id)}">
                ${this.escapeHtml(displayName)}
                <span class="relationship-type">(${this.escapeHtml(p.relationship)})</span>
                <button class="remove-project" title="Remove association">&times;</button>
            </span>`;
            }).join('') : '<span class="empty-projects" id="empty-projects">No project associations</span>'}
        </div>
        <button class="add-project-btn" id="add-project-btn">Associate Project...</button>
    </div>
    ` : ''}
    ${entityType !== 'project' ? descriptionSectionHtml : ''}
    <div class="edit-actions hidden" id="edit-actions">
        <button class="save-button" id="save-edit-button">Save</button>
        <button class="cancel-button" id="cancel-edit-button">Cancel</button>
        <span class="edit-status hidden" id="edit-status"></span>
    </div>
    ${remainingContent.trim() && remainingContent !== content ? `
    <div class="entity-content" style="margin-top: 24px;">
        ${this.markdownToHtml(remainingContent)}
    </div>
    ` : ''}
    <div class="related-transcripts" id="related-transcripts" style="margin-top: 24px;">
        <h2>Related Transcripts</h2>
        <div id="related-transcripts-content">
            <div class="loading">Loading related transcripts...</div>
        </div>
    </div>
    <div class="inline-chat-container" id="inline-chat-container">
        <div class="inline-chat-input-wrapper">
            <textarea 
                class="inline-chat-input" 
                id="inline-chat-input" 
                placeholder="Type a message to make changes... (e.g., Change the name to &quot;John Doe&quot;)"
                rows="1"
            ></textarea>
            <button type="button" class="inline-chat-send" id="inline-chat-send">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1.5 1.5L14.5 8L1.5 14.5L3.5 8L1.5 1.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </button>
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const entityType = ${JSON.stringify(entityType)};
        const entityId = ${JSON.stringify(entityId)};
        const entityName = ${JSON.stringify(entityName)};
        const entityUri = \`protokoll://entity/\${entityType}/\${encodeURIComponent(entityId)}\`;

        function startChatFromInput() {
            console.log('Protokoll Entity: startChatFromInput called');
            const input = document.getElementById('inline-chat-input');
            if (!input) {
                console.error('Protokoll Entity: inline-chat-input not found');
                return;
            }
            const message = input.value.trim();
            if (!message) {
                console.log('Protokoll Entity: No message to send');
                return;
            }
            
            console.log('Protokoll Entity: Sending message:', message);
            
            // Clear input
            input.value = '';
            adjustTextareaHeight(input);
            
            // Send message to extension to start a new chat
            vscode.postMessage({
                command: 'startChatFromInputEntity',
                message: message,
                entityType: entityType,
                entityId: entityId,
                entityUri: entityUri
            });
            console.log('Protokoll Entity: Message sent to extension');
        }
        
        function adjustTextareaHeight(textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
        }
        
        // Set up inline chat event listeners
        function setupInlineChatListeners() {
            console.log('Protokoll Entity: Setting up inline chat listeners');
            const chatInput = document.getElementById('inline-chat-input');
            const sendButton = document.getElementById('inline-chat-send');
            
            console.log('Protokoll Entity: chatInput found:', !!chatInput);
            console.log('Protokoll Entity: sendButton found:', !!sendButton);
            
            if (chatInput) {
                chatInput.addEventListener('input', function() {
                    adjustTextareaHeight(this);
                });
                
                chatInput.addEventListener('keydown', function(e) {
                    console.log('Protokoll Entity: keydown event, key:', e.key);
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log('Protokoll Entity: Enter pressed, calling startChatFromInput');
                        startChatFromInput();
                    }
                });
                console.log('Protokoll Entity: chatInput listeners attached');
            } else {
                console.error('Protokoll Entity: inline-chat-input element not found!');
            }
            
            if (sendButton) {
                sendButton.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log('Protokoll Entity: Send button clicked');
                    startChatFromInput();
                });
                console.log('Protokoll Entity: sendButton listener attached');
            } else {
                console.error('Protokoll Entity: inline-chat-send element not found!');
            }
        }
        
        // Set up refresh button listener
        function setupRefreshButton() {
            const refreshButton = document.getElementById('refresh-button');
            if (refreshButton) {
                refreshButton.addEventListener('click', function() {
                    console.log('Protokoll Entity: Refresh button clicked');
                    refreshButton.disabled = true;
                    vscode.postMessage({
                        command: 'refreshEntity'
                    });
                });
            }
        }

        let isEditing = false;
        const originalName = ${JSON.stringify(entityName)};
        const originalDescription = ${JSON.stringify(description)};
        const editableFieldDefs = ${JSON.stringify(editableFields)};
        const originalFieldValues = {};
        editableFieldDefs.forEach(f => { originalFieldValues[f.key] = f.value; });
        let currentSoundsLike = ${JSON.stringify(soundsLike)};
        let soundsLikeAdded = [];
        let soundsLikeRemoved = [];

        const isProject = entityType === 'project';
        const originalProjectUrls = isProject ? ${JSON.stringify(projectUrls)} : [];
        let urlsAdded = [];
        let urlsRemoved = [];

        function projectUrlLinkHtml(u) {
            var t = (u || '').trim();
            if (/^https?:\\/\\//i.test(t)) {
                return '<a href="' + escapeHtml(t) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(t) + '</a>';
            }
            return escapeHtml(t);
        }

        function getWorkingProjectUrls() {
            return originalProjectUrls.filter(function(u) { return urlsRemoved.indexOf(u) === -1; }).concat(urlsAdded);
        }

        function renderProjectUrlTags(urlList) {
            var container = document.getElementById('project-urls-tags');
            if (!container || !isProject) return;
            if (!urlList || urlList.length === 0) {
                container.innerHTML = '<span class="empty-urls" id="empty-project-urls">No links yet</span>';
                return;
            }
            container.innerHTML = urlList.map(function(u) {
                return '<span class="project-url-tag" data-value="' + escapeHtml(u) + '">' +
                    '<span class="project-url-tag-label">' + projectUrlLinkHtml(u) + '</span>' +
                    '<button type="button" class="remove-url" title="Remove">&times;</button>' +
                    '</span>';
            }).join('');
        }

        function addProjectUrlFromInput() {
            if (!isProject) return;
            var input = document.getElementById('project-urls-add-input');
            if (!input) return;
            var value = input.value.trim();
            if (!value) return;
            var working = getWorkingProjectUrls();
            if (working.indexOf(value) !== -1) {
                input.value = '';
                return;
            }
            urlsAdded.push(value);
            input.value = '';
            renderProjectUrlTags(working.concat([value]));
        }

        function removeProjectUrlTag(value) {
            if (!isEditing || !isProject) return;
            var idxAdded = urlsAdded.indexOf(value);
            if (idxAdded !== -1) {
                urlsAdded.splice(idxAdded, 1);
            } else {
                urlsRemoved.push(value);
            }
            renderProjectUrlTags(getWorkingProjectUrls());
        }

        function setupProjectUrlsListeners() {
            if (!isProject) return;
            var addBtn = document.getElementById('project-urls-add-btn');
            var addInput = document.getElementById('project-urls-add-input');
            if (addBtn) {
                addBtn.addEventListener('click', function() { addProjectUrlFromInput(); });
            }
            if (addInput) {
                addInput.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter') { e.preventDefault(); addProjectUrlFromInput(); }
                });
            }
            var urlTags = document.getElementById('project-urls-tags');
            if (urlTags) {
                urlTags.addEventListener('click', function(e) {
                    var btn = e.target.closest('.remove-url');
                    if (btn) {
                        var tag = btn.closest('.project-url-tag');
                        if (tag && tag.dataset.value) removeProjectUrlTag(tag.dataset.value);
                    }
                });
            }
        }

        function setupEditButton() {
            const editButton = document.getElementById('edit-button');
            if (editButton) {
                editButton.addEventListener('click', function() {
                    if (!isEditing) enterEditMode();
                });
            }

            const saveButton = document.getElementById('save-edit-button');
            if (saveButton) {
                saveButton.addEventListener('click', function() { saveEdit(); });
            }

            const cancelButton = document.getElementById('cancel-edit-button');
            if (cancelButton) {
                cancelButton.addEventListener('click', function() { cancelEdit(); });
            }

            // Sounds-like add button
            const addSlBtn = document.getElementById('sounds-like-add-btn');
            const addSlInput = document.getElementById('sounds-like-add-input');
            if (addSlBtn) {
                addSlBtn.addEventListener('click', function() { addSoundsLikeFromInput(); });
            }
            if (addSlInput) {
                addSlInput.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter') { e.preventDefault(); addSoundsLikeFromInput(); }
                });
            }

            // Sounds-like remove buttons (via delegation)
            const tagsContainer = document.getElementById('sounds-like-tags');
            if (tagsContainer) {
                tagsContainer.addEventListener('click', function(e) {
                    const btn = e.target.closest('.remove-tag');
                    if (btn) {
                        const tag = btn.closest('.sounds-like-tag');
                        if (tag) removeSoundsLikeTag(tag.dataset.value);
                    }
                });
            }
        }

        function enterEditMode() {
            isEditing = true;
            document.body.classList.add('editing');
            const nameDisplay = document.getElementById('entity-name-display');
            const nameInput = document.getElementById('edit-name-input');
            const descDisplay = document.getElementById('description-display');
            const descInput = document.getElementById('edit-description-input');
            const editActions = document.getElementById('edit-actions');
            const editButton = document.getElementById('edit-button');
            const editStatus = document.getElementById('edit-status');

            if (nameDisplay) nameDisplay.classList.add('hidden');
            if (nameInput) { nameInput.classList.remove('hidden'); nameInput.focus(); }
            if (descDisplay) descDisplay.classList.add('hidden');
            if (descInput) descInput.classList.remove('hidden');
            if (editActions) editActions.classList.remove('hidden');
            if (editButton) editButton.classList.add('hidden');
            if (editStatus) { editStatus.classList.add('hidden'); editStatus.textContent = ''; }

            // Show field inputs, hide display values
            editableFieldDefs.forEach(f => {
                const display = document.getElementById('field-display-' + f.key);
                const input = document.getElementById('field-input-' + f.key);
                if (display) display.classList.add('hidden');
                if (input) input.classList.remove('hidden');
            });

            // Reset sounds-like tracking
            soundsLikeAdded = [];
            soundsLikeRemoved = [];
            urlsAdded = [];
            urlsRemoved = [];
        }

        function cancelEdit() {
            isEditing = false;
            document.body.classList.remove('editing');
            const nameDisplay = document.getElementById('entity-name-display');
            const nameInput = document.getElementById('edit-name-input');
            const descDisplay = document.getElementById('description-display');
            const descInput = document.getElementById('edit-description-input');
            const editActions = document.getElementById('edit-actions');
            const editButton = document.getElementById('edit-button');

            if (nameInput) nameInput.value = originalName;
            if (descInput) descInput.value = originalDescription;
            if (nameDisplay) nameDisplay.classList.remove('hidden');
            if (nameInput) nameInput.classList.add('hidden');
            if (descDisplay) descDisplay.classList.remove('hidden');
            if (descInput) descInput.classList.add('hidden');
            if (editActions) editActions.classList.add('hidden');
            if (editButton) editButton.classList.remove('hidden');

            // Restore field inputs
            editableFieldDefs.forEach(f => {
                const display = document.getElementById('field-display-' + f.key);
                const input = document.getElementById('field-input-' + f.key);
                if (input) input.value = originalFieldValues[f.key] || '';
                if (display) display.classList.remove('hidden');
                if (input) input.classList.add('hidden');
            });

            // Restore sounds-like tags
            soundsLikeAdded = [];
            soundsLikeRemoved = [];
            renderSoundsLikeTags(currentSoundsLike);
            urlsAdded = [];
            urlsRemoved = [];
            if (isProject) renderProjectUrlTags(originalProjectUrls);
        }

        function saveEdit() {
            const nameInput = document.getElementById('edit-name-input');
            const descInput = document.getElementById('edit-description-input');
            const saveButton = document.getElementById('save-edit-button');
            const cancelButton = document.getElementById('cancel-edit-button');
            const editStatus = document.getElementById('edit-status');

            const newName = nameInput ? nameInput.value.trim() : '';
            const newDescription = descInput ? descInput.value.trim() : '';

            if (!newName) {
                if (editStatus) {
                    editStatus.textContent = 'Name cannot be empty';
                    editStatus.className = 'edit-status error';
                    editStatus.classList.remove('hidden');
                }
                return;
            }

            const fields = {};
            if (newName !== originalName) fields.name = newName;
            if (newDescription !== originalDescription) fields.description = newDescription;

            // Collect entity-specific field changes
            editableFieldDefs.forEach(f => {
                const input = document.getElementById('field-input-' + f.key);
                if (input) {
                    const newVal = input.value.trim();
                    if (newVal !== (originalFieldValues[f.key] || '')) {
                        fields[f.editParam] = newVal;
                    }
                }
            });

            // Collect sounds_like changes
            if (soundsLikeAdded.length > 0) fields.add_sounds_like = soundsLikeAdded;
            if (soundsLikeRemoved.length > 0) fields.remove_sounds_like = soundsLikeRemoved;

            if (isProject) {
                if (urlsAdded.length > 0) fields.add_urls = urlsAdded;
                if (urlsRemoved.length > 0) fields.remove_urls = urlsRemoved;
            }

            if (Object.keys(fields).length === 0) {
                cancelEdit();
                return;
            }

            if (saveButton) saveButton.disabled = true;
            if (cancelButton) cancelButton.disabled = true;
            if (editStatus) {
                editStatus.textContent = 'Saving...';
                editStatus.className = 'edit-status saving';
                editStatus.classList.remove('hidden');
            }

            vscode.postMessage({
                command: 'editEntity',
                entityType: entityType,
                entityId: entityId,
                fields: fields
            });
        }

        function addSoundsLikeFromInput() {
            const input = document.getElementById('sounds-like-add-input');
            if (!input) return;
            const value = input.value.trim();
            if (!value) return;

            // Check for duplicates in current working set
            const workingSet = currentSoundsLike
                .filter(s => !soundsLikeRemoved.includes(s))
                .concat(soundsLikeAdded);
            if (workingSet.includes(value)) {
                input.value = '';
                return;
            }

            soundsLikeAdded.push(value);
            input.value = '';
            renderSoundsLikeTags(workingSet.concat([value]));
        }

        function removeSoundsLikeTag(value) {
            if (!isEditing) return;
            if (soundsLikeAdded.includes(value)) {
                soundsLikeAdded = soundsLikeAdded.filter(s => s !== value);
            } else {
                soundsLikeRemoved.push(value);
            }
            const workingSet = currentSoundsLike
                .filter(s => !soundsLikeRemoved.includes(s))
                .concat(soundsLikeAdded);
            renderSoundsLikeTags(workingSet);
        }

        function renderSoundsLikeTags(tags) {
            const container = document.getElementById('sounds-like-tags');
            if (!container) return;
            if (tags.length === 0) {
                container.innerHTML = '<span class="empty-sounds" id="empty-sounds">No sounds_like variants</span>';
                return;
            }
            container.innerHTML = tags.map(s =>
                '<span class="sounds-like-tag" data-value="' + escapeHtml(s) + '">' +
                    escapeHtml(s) +
                    '<button class="remove-tag" title="Remove">&times;</button>' +
                '</span>'
            ).join('');
        }
        
        // Load related transcripts
        function loadRelatedTranscripts() {
            console.log('Protokoll Entity: Loading related transcripts for', entityType, entityId);
            vscode.postMessage({
                command: 'loadRelatedTranscripts',
                entityType: entityType,
                entityId: entityId
            });
        }

        const PROJECT_PLANS_PAGE_SIZE = 25;

        function requestProjectPlansPage(page) {
            if (entityType !== 'project') {
                return;
            }
            const loading = document.getElementById('related-plans-loading');
            if (loading) {
                loading.classList.remove('hidden');
                loading.classList.add('loading');
                loading.textContent = 'Loading plans…';
            }
            vscode.postMessage({
                command: 'loadProjectPlans',
                projectId: entityId,
                page: page,
                pageSize: PROJECT_PLANS_PAGE_SIZE
            });
        }

        function formatPlanCreated(value) {
            if (!value || typeof value !== 'string') {
                return '—';
            }
            const d = Date.parse(value);
            if (Number.isNaN(d)) {
                return value;
            }
            return new Date(d).toLocaleString();
        }

        function renderProjectPlansPage(message) {
            const loading = document.getElementById('related-plans-loading');
            const table = document.getElementById('related-plans-table');
            const tbody = document.getElementById('related-plans-tbody');
            const empty = document.getElementById('related-plans-empty');
            const pag = document.getElementById('related-plans-pagination');
            const prev = document.getElementById('related-plans-prev');
            const next = document.getElementById('related-plans-next');
            const label = document.getElementById('related-plans-page-label');
            const heading = document.getElementById('related-plans-heading');
            if (loading) {
                loading.classList.add('hidden');
            }
            const total = typeof message.total === 'number' ? message.total : 0;
            if (heading) {
                heading.textContent = total > 0 ? 'Related Plans (' + total + ')' : 'Related Plans';
            }
            if (!tbody || !table || !empty || !pag) {
                return;
            }
            tbody.innerHTML = '';
            const plans = message.plans || [];
            if (plans.length === 0 && total === 0) {
                empty.classList.remove('hidden');
                table.classList.add('hidden');
                pag.classList.add('hidden');
                return;
            }
            empty.classList.add('hidden');
            table.classList.remove('hidden');
            for (let i = 0; i < plans.length; i++) {
                const p = plans[i];
                const tr = document.createElement('tr');
                const tdTitle = document.createElement('td');
                const titleDiv = document.createElement('div');
                titleDiv.className = 'plan-title';
                titleDiv.textContent = p.title || '';
                tdTitle.appendChild(titleDiv);
                if (p.id && p.id !== p.title) {
                    const idDiv = document.createElement('div');
                    idDiv.className = 'plan-id';
                    idDiv.textContent = p.id;
                    tdTitle.appendChild(idDiv);
                }
                const tdStage = document.createElement('td');
                tdStage.textContent = p.stage && String(p.stage).trim().length > 0 ? p.stage : '—';
                const tdCreated = document.createElement('td');
                tdCreated.textContent = formatPlanCreated(p.createdAt);
                tr.appendChild(tdTitle);
                tr.appendChild(tdStage);
                tr.appendChild(tdCreated);
                tbody.appendChild(tr);
            }
            const page = typeof message.page === 'number' && message.page >= 1 ? message.page : 1;
            const pageSize = typeof message.pageSize === 'number' && message.pageSize >= 1
                ? message.pageSize
                : PROJECT_PLANS_PAGE_SIZE;
            const pageCount = Math.max(1, Math.ceil(total / pageSize));
            if (total <= pageSize) {
                pag.classList.add('hidden');
            } else {
                pag.classList.remove('hidden');
                if (label) {
                    label.textContent = 'Page ' + page + ' of ' + pageCount;
                }
                if (prev) {
                    prev.disabled = page <= 1;
                    prev.onclick = function() {
                        if (page > 1) {
                            requestProjectPlansPage(page - 1);
                        }
                    };
                }
                if (next) {
                    next.disabled = page >= pageCount;
                    next.onclick = function() {
                        if (page < pageCount) {
                            requestProjectPlansPage(page + 1);
                        }
                    };
                }
            }
        }

        function setupProjectPlansSection() {
            if (entityType !== 'project') {
                return;
            }
            requestProjectPlansPage(1);
        }
        
        // Handle messages from extension (e.g., related transcripts data, edit results)
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'relatedTranscripts':
                    console.log('Protokoll Entity: Received related transcripts', message.transcripts);
                    renderRelatedTranscripts(message.transcripts);
                    break;
                case 'projectPlansPage':
                    renderProjectPlansPage(message);
                    break;
                case 'projectPlansError': {
                    const loading = document.getElementById('related-plans-loading');
                    if (loading) {
                        loading.classList.remove('hidden');
                        loading.classList.remove('loading');
                        loading.textContent = 'Could not load plans. ' + (message.message || 'Unknown error');
                    }
                    break;
                }
                case 'refreshComplete': {
                    const refreshButton = document.getElementById('refresh-button');
                    if (refreshButton) {
                        refreshButton.disabled = false;
                    }
                    break;
                }
                case 'editResult': {
                    const editStatus = document.getElementById('edit-status');
                    const saveButton = document.getElementById('save-edit-button');
                    const cancelButton = document.getElementById('cancel-edit-button');
                    if (message.success) {
                        if (editStatus) {
                            editStatus.textContent = 'Saved';
                            editStatus.className = 'edit-status success';
                            editStatus.classList.remove('hidden');
                        }
                    } else {
                        if (editStatus) {
                            editStatus.textContent = message.error || 'Save failed';
                            editStatus.className = 'edit-status error';
                            editStatus.classList.remove('hidden');
                        }
                        if (saveButton) saveButton.disabled = false;
                        if (cancelButton) cancelButton.disabled = false;
                    }
                    break;
                }
            }
        });
        
        function renderRelatedTranscripts(transcripts) {
            const container = document.getElementById('related-transcripts-content');
            if (!container) return;
            
            if (!transcripts || transcripts.length === 0) {
                container.innerHTML = '<div class="empty-state">No transcripts reference this entity</div>';
                return;
            }
            
            const tableHtml = '<table class="related-transcripts-table">' +
                '<thead><tr><th>Title</th><th>Date</th><th>Project</th></tr></thead>' +
                '<tbody>' +
                transcripts.map(t => {
                    let date = '';
                    if (t.date) {
                        const dateOnlyMatch = t.date.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
                        if (dateOnlyMatch) {
                            const localDate = new Date(
                                Number(dateOnlyMatch[1]),
                                Number(dateOnlyMatch[2]) - 1,
                                Number(dateOnlyMatch[3])
                            );
                            date = localDate.toLocaleDateString();
                        } else {
                            const parsedDate = new Date(t.date);
                            date = Number.isNaN(parsedDate.getTime()) ? String(t.date) : parsedDate.toLocaleDateString();
                        }
                    }
                    const project = t.project ? escapeHtml(t.project) : '';
                    return \`
                        <tr class="related-transcript-row" data-path="\${t.path}">
                            <td class="related-transcript-title">\${escapeHtml(t.title)}</td>
                            <td class="related-transcript-date">\${date}</td>
                            <td class="related-transcript-project">\${project}</td>
                        </tr>
                    \`;
                }).join('') +
                '</tbody></table>';
            
            container.innerHTML = tableHtml;
            
            const rows = container.querySelectorAll('.related-transcript-row');
            rows.forEach(row => {
                row.addEventListener('click', () => {
                    const path = row.getAttribute('data-path');
                    if (path) {
                        vscode.postMessage({
                            command: 'openTranscript',
                            path: path
                        });
                    }
                });
            });
        }
        
        function setupEntityActionButtons() {
            const deleteButton = document.getElementById('delete-entity-button');
            if (deleteButton) {
                deleteButton.onclick = function() {
                    vscode.postMessage({
                        command: 'deleteEntity',
                        entityName: entityName,
                    });
                };
            }

            const convertToPersonButton = document.getElementById('convert-to-person-button');
            if (convertToPersonButton) {
                convertToPersonButton.onclick = function() {
                    vscode.postMessage({
                        command: 'convertEntityType',
                        fromType: 'company',
                        toType: 'person',
                        entityName: entityName,
                    });
                };
            }

            const convertToCompanyButton = document.getElementById('convert-to-company-button');
            if (convertToCompanyButton) {
                convertToCompanyButton.onclick = function() {
                    vscode.postMessage({
                        command: 'convertEntityType',
                        fromType: 'person',
                        toType: 'company',
                        entityName: entityName,
                    });
                };
            }
        }

        function setupProjectAssociation() {
            const addBtn = document.getElementById('add-project-btn');
            if (addBtn) {
                addBtn.addEventListener('click', function() {
                    vscode.postMessage({ command: 'addProjectRelationship' });
                });
            }

            const tagsContainer = document.getElementById('project-tags');
            if (tagsContainer) {
                tagsContainer.addEventListener('click', function(e) {
                    const btn = e.target.closest('.remove-project');
                    if (btn) {
                        const tag = btn.closest('.project-tag');
                        if (tag) {
                            vscode.postMessage({
                                command: 'removeProjectRelationship',
                                targetUri: tag.dataset.uri,
                                relationship: tag.dataset.relationship,
                            });
                        }
                    }
                });
            }
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        // Run setup immediately (script is at end of body, DOM should be ready)
        setupInlineChatListeners();
        setupRefreshButton();
        setupEditButton();
        setupEntityActionButtons();
        setupProjectUrlsListeners();
        setupProjectAssociation();
        loadRelatedTranscripts();
        setupProjectPlansSection();
        
        // Also run on DOMContentLoaded as backup
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() {
                setupInlineChatListeners();
                setupRefreshButton();
                setupEditButton();
                setupProjectUrlsListeners();
                setupProjectAssociation();
            });
        }
    </script>
</body>
</html>`;
  }

  public getWebviewContent(
    transcript: Transcript,
    content: TranscriptContent,
    lastFetched?: Date,
    projectNameMap?: Map<string, string>
  ): string {
    // Normalize content: handle legacy/raw format (uri, mimeType, text) vs structured (metadata, content)
    const metadata = content.metadata ?? {};
    const transcriptText = content.content ?? (content as { text?: string }).text ?? '*No content available*';
    const tags = metadata.tags ?? [];

    // Prefer canonical structured entities from readTranscript metadata.
    // Only fall back to transcript.entities if structured metadata is unavailable.
    const hasStructuredEntities = !!metadata.entities;
    const entityReferences: {
      projects?: Array<{ id: string; name: string }>;
      people?: Array<{ id: string; name: string }>;
      terms?: Array<{ id: string; name: string }>;
      companies?: Array<{ id: string; name: string }>;
    } = hasStructuredEntities
      ? {
          projects: metadata.entities?.projects ?? [],
          people: metadata.entities?.people ?? [],
          terms: metadata.entities?.terms ?? [],
          companies: metadata.entities?.companies ?? [],
        }
      : {
          projects: transcript.entities?.projects ?? [],
          people: transcript.entities?.people ?? [],
          terms: transcript.entities?.terms ?? [],
          companies: transcript.entities?.companies ?? [],
        };

    // Format date/time - use structured metadata from server
    const date = metadata.date ?? transcript.date ?? '';
    const time = metadata.time ?? transcript.time ?? '';
    const dateTime = date ? this.formatTranscriptDateTime(date, time) : 'Unknown date';
    const dateInputValue = this.formatDateInputValue(date);

    // Get createdAt and updatedAt from transcript object (not in content.metadata)
    const createdAt = transcript.createdAt;
    const updatedAt = transcript.updatedAt;

    // Get status and tasks from structured metadata
    const status = metadata.status ?? transcript.status ?? 'initial';
    const tasks = metadata.tasks ?? transcript.tasks ?? [];
    const openTasks = tasks.filter((t: { status: string }) => t.status === 'open');

    // Get project info from structured metadata
    const projectId = metadata.entities?.projects?.[0]?.id ?? metadata.projectId ?? transcript.entities?.projects?.[0]?.id ?? '';
    const rawProjectName = metadata.entities?.projects?.[0]?.name ?? metadata.project ?? transcript.entities?.projects?.[0]?.name ?? '';
    const mappedProjectName = projectId ? projectNameMap?.get(projectId) : undefined;
    const projectName = mappedProjectName
      ?? (rawProjectName && !this.isLikelyUuid(rawProjectName) ? rawProjectName : '');
    const transcriptPath = transcript.uri;
    const isManualNote = transcript.contentType === 'manual_note' || (!content.rawTranscript && !transcript.hasRawTranscript);
    const hasManualEnhancedContent = !isManualNote
      ? true
      : (['enhanced', 'reviewed', 'closed', 'archived', 'deleted'].includes(status) && transcriptText.trim().length > 0);
    const showEnhancedTab = !isManualNote || hasManualEnhancedContent;
    const hasOriginalTab = !!content.rawTranscript || isManualNote;
    const summaryConfig = this.getSummaryConfig(transcript.uri) || this.getDefaultSummaryConfig();
    const summaries = this.normalizePersistedSummaries(content.summaries);
    const hasSummary = summaries.length > 0;
    const comments = this.getCommentsFromMetadata(content);
    const preferredSummaryId = this.getActiveSummaryId(transcript.uri);
    const activeSummary = summaries.find(summary => summary.id === preferredSummaryId) || summaries[0];
    const summaryFeatureEnabled = vscode.workspace.getConfiguration('protokoll').get<boolean>('features.summaryEnabled', true);
    const initialTab: 'enhanced' | 'raw' | 'summary' | 'comments' = hasSummary
      ? 'summary'
      : (showEnhancedTab ? (isManualNote ? 'raw' : 'enhanced') : 'raw');
    const originalEditorText = isManualNote
      ? transcriptText
      : (content.rawTranscript?.text ?? '');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${transcript.title || transcript.filename}</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            line-height: 1.6;
            position: relative;
        }
        .header {
            position: relative;
            margin-bottom: 32px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .title-header {
            font-size: 2.5em;
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
            margin: 0;
            padding-right: 200px;
            line-height: 1.2;
            position: relative;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .update-indicator {
            display: none;
            align-items: center;
            gap: 6px;
            font-size: 0.4em;
            font-weight: normal;
            color: var(--vscode-descriptionForeground);
            opacity: 0;
            transition: opacity 0.3s ease;
        }
        .update-indicator.show {
            display: flex;
            opacity: 1;
        }
        .update-indicator .spinner {
            width: 12px;
            height: 12px;
            border: 2px solid var(--vscode-descriptionForeground);
            border-top-color: var(--vscode-textLink-foreground);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .title-header .editable-title {
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 3px;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            min-width: 200px;
        }
        .title-header .editable-title:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .title-header .editable-title:hover .edit-icon {
            opacity: 0.5;
        }
        .title-header .editable-title.editing {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            padding: 4px 8px;
        }
        .edit-icon {
            color: var(--vscode-descriptionForeground);
            opacity: 0.3;
            flex-shrink: 0;
            transition: opacity 0.2s;
        }
        .edit-icon-small {
            color: var(--vscode-descriptionForeground);
            opacity: 0.3;
            margin-left: 6px;
            vertical-align: middle;
            transition: opacity 0.2s;
        }
        .editable-date {
            cursor: pointer;
            padding: 2px 4px;
            border-radius: 3px;
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }
        .date-picker-row {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }
        .transcript-date-input {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 4px 8px;
            font-family: inherit;
            font-size: inherit;
            line-height: 1.4;
            min-height: 28px;
            box-sizing: border-box;
        }
        .transcript-date-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }
        .transcript-date-input::-webkit-calendar-picker-indicator {
            cursor: pointer;
            opacity: 0.85;
            filter: invert(0.85);
        }
        .date-time-suffix {
            color: var(--vscode-descriptionForeground);
        }
        .editable-date:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .editable-date:hover .edit-icon-small {
            opacity: 0.6;
        }
        .title-header .title-input,
        #transcript-textarea {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            width: 100%;
            box-sizing: border-box;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.5;
            resize: vertical;
        }
        #transcript-textarea {
            min-height: 400px;
            max-width: 120ch;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
            overflow-y: auto;
        }
        .title-header .title-input {
            padding: 8px 12px;
            border-radius: 4px;
            font-size: inherit;
            font-weight: 600;
            font-family: inherit;
            width: calc(100% - 220px);
            min-width: 700px;
            line-height: 1.2;
            resize: vertical;
            overflow: hidden;
            min-height: 60px;
            display: block;
        }
        .project-section {
            margin-bottom: 8px;
            margin-top: 4px;
        }
        .project-section .project-info {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }
        .project-section .project-name {
            font-weight: 600;
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
        }
        .project-section .project-name.clickable {
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 3px;
            display: inline-block;
        }
        .project-section .project-name.clickable:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .project-section .button {
            margin-left: 0;
        }
        .info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            margin-bottom: 16px;
        }
        @media (max-width: 900px) {
            .info-grid {
                grid-template-columns: 1fr;
            }
        }
        .metadata {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 12px 16px;
        }
        .metadata h2 {
            margin: 0 0 8px 0;
            color: var(--vscode-textLink-foreground);
            font-size: 0.95em;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .metadata h2:hover {
            opacity: 0.8;
        }
        .metadata-toggle-icon {
            font-size: 0.8em;
            transition: transform 0.2s;
        }
        .metadata.collapsed .metadata-toggle-icon {
            transform: rotate(-90deg);
        }
        .metadata-content {
            margin-top: 8px;
        }
        .metadata.collapsed .metadata-content {
            display: none;
        }
        .metadata-row {
            display: flex;
            margin-bottom: 6px;
            align-items: flex-start;
        }
        .metadata-label {
            font-weight: 600;
            min-width: 100px;
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
        }
        .metadata-value {
            flex: 1;
            color: var(--vscode-foreground);
            font-size: 0.9em;
        }
        .metadata-value-with-actions {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }
        .transcript-content {
            background-color: var(--vscode-editor-background);
            padding: 16px;
            border-radius: 4px;
            margin: 0;
            text-align: left;
            line-height: 1.6;
            max-width: 120ch;
            word-wrap: break-word;
            overflow-wrap: break-word;
            font-family: var(--vscode-editor-font-family);
            position: relative;
            user-select: text;
        }
        .create-entity-button {
            position: absolute;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
            z-index: 1000;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            display: none;
            margin-top: 4px;
        }
        .create-entity-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .create-entity-button.show {
            display: block;
        }
        .transcript-content p {
            margin: 0 0 1em 0;
            padding: 0;
        }
        .transcript-content p:last-child {
            margin-bottom: 0;
        }
        .transcript-content ul,
        .transcript-content ol {
            margin: 0 0 1em 0;
            padding-left: 1.5em;
        }
        .transcript-content li {
            margin: 0.5em 0;
            padding: 0;
        }
        .transcript-content br {
            display: block;
            content: "";
            margin: 0;
        }
        .transcript-content-wrapper {
            margin-top: 16px;
            position: relative;
        }
        .content-tabs {
            display: flex;
            gap: 4px;
            margin-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .content-tab {
            background: transparent;
            border: none;
            padding: 8px 16px;
            cursor: pointer;
            color: var(--vscode-descriptionForeground);
            font-size: 0.95em;
            border-bottom: 2px solid transparent;
            transition: all 0.2s;
        }
        .content-tab:hover {
            color: var(--vscode-foreground);
            background-color: var(--vscode-list-hoverBackground);
        }
        .content-tab.active {
            color: var(--vscode-textLink-foreground);
            border-bottom-color: var(--vscode-textLink-foreground);
            font-weight: 600;
        }
        .content-tab.disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        .tab-content {
            display: none;
        }
        .tab-content.active {
            display: block;
        }
        .tab-toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            flex-wrap: nowrap;
            margin-bottom: 12px;
            width: 100%;
            box-sizing: border-box;
        }
        .tab-toolbar-left {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
            min-width: 0;
            flex: 1 1 auto;
        }
        .tab-toolbar-right {
            display: flex;
            align-items: center;
            margin-left: auto;
        }
        .tab-toolbar-right .button,
        .tab-toolbar-right .edit-button {
            margin-left: 0;
        }
        .comments-toolbar {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 14px;
        }
        .comments-status {
            display: none;
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
        }
        .comments-status.error {
            display: block;
            color: var(--vscode-errorForeground);
        }
        .comments-status.success {
            display: block;
            color: var(--vscode-testing-iconPassed);
        }
        .comments-input {
            width: 100%;
            min-height: 90px;
            resize: vertical;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            padding: 10px;
            box-sizing: border-box;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.5;
        }
        .comments-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-top: 8px;
        }
        .comment-card {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            padding: 10px 12px;
        }
        .comment-meta {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            color: var(--vscode-descriptionForeground);
            font-size: 0.8em;
            margin-bottom: 8px;
        }
        .comment-text {
            white-space: pre-wrap;
            word-break: break-word;
            line-height: 1.5;
        }
        .comment-actions {
            display: flex;
            gap: 8px;
            margin-top: 10px;
        }
        .comment-edit-textarea {
            width: 100%;
            min-height: 90px;
            resize: vertical;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            padding: 10px;
            box-sizing: border-box;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.5;
        }
        .comment-empty-state {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            padding: 8px 0;
        }
        .original-editor-actions {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 12px;
        }
        .original-editor-status {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
        }
        .original-editor-status.dirty {
            color: var(--vscode-editorWarning-foreground);
        }
        .original-editor-status.saved {
            color: var(--vscode-testing-iconPassed);
        }
        .original-enhance-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 12px;
        }
        .original-editor-textarea {
            width: 100%;
            min-height: 340px;
            box-sizing: border-box;
            resize: vertical;
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 12px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.5;
        }
        .original-editor-textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 0;
        }
        .enhance-button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.9em;
            line-height: 1.2;
            min-height: 36px;
            box-sizing: border-box;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
        .enhance-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .enhance-button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .enhancement-timeline {
            margin-top: 16px;
        }
        .enhancement-phase {
            margin-bottom: 24px;
        }
        .enhancement-phase-header {
            font-weight: 600;
            font-size: 1.1em;
            color: var(--vscode-textLink-foreground);
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .enhancement-step {
            margin-bottom: 12px;
            padding: 12px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-left: 3px solid var(--vscode-textLink-foreground);
            border-radius: 4px;
        }
        .enhancement-step-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
            user-select: none;
        }
        .enhancement-step-action {
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        .enhancement-step-timestamp {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
        }
        .enhancement-step-controls {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-left: 12px;
        }
        .enhancement-reject-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            border-radius: 3px;
            font-size: 0.8em;
            padding: 3px 8px;
            cursor: pointer;
        }
        .enhancement-reject-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .enhancement-reject-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .enhancement-status-pill {
            font-size: 0.75em;
            font-weight: 600;
            color: var(--vscode-testing-iconFailed);
            border: 1px solid var(--vscode-testing-iconFailed);
            border-radius: 999px;
            padding: 2px 8px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }
        .enhancement-step-details {
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid var(--vscode-panel-border);
            display: none;
        }
        .enhancement-step-details.expanded {
            display: block;
        }
        .enhancement-step-details pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 3px;
            font-size: 0.85em;
            overflow-x: auto;
        }
        .summary-empty-state {
            border: 1px dashed var(--vscode-panel-border);
            border-radius: 6px;
            padding: 16px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            max-width: 100ch;
        }
        .summary-empty-state h3 {
            margin: 0 0 8px 0;
            color: var(--vscode-textLink-foreground);
            font-size: 1.05em;
        }
        .summary-empty-state p {
            margin: 0 0 12px 0;
            color: var(--vscode-descriptionForeground);
        }
        .summary-content-text {
            background-color: var(--vscode-editor-background);
            border-radius: 4px;
            padding: 12px;
            max-width: 100ch;
        }
        .summary-setup-preview {
            margin-top: 12px;
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-editor-background);
            padding: 10px 12px;
            max-width: 100ch;
            font-size: 0.9em;
        }
        .summary-setup-row {
            margin-bottom: 6px;
        }
        .summary-setup-row:last-child {
            margin-bottom: 0;
        }
        .summary-setup-label {
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            margin-right: 6px;
        }
        .edit-button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.9em;
            line-height: 1.2;
            min-height: 36px;
            box-sizing: border-box;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
        .edit-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .title-actions {
            display: inline-flex;
            gap: 8px;
            margin-left: 8px;
            margin-top: 8px;
        }
        .entity-references {
            margin-top: 32px;
            padding-top: 24px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .entity-references h3 {
            color: var(--vscode-textLink-foreground);
            margin-top: 0;
            margin-bottom: 12px;
            font-size: 1.1em;
        }
        .entity-references-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 12px;
        }
        .entity-references-actions {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .entity-references-status {
            margin-bottom: 12px;
            padding: 8px 10px;
            border-radius: 4px;
            font-size: 0.9em;
        }
        .entity-references-status.success {
            color: var(--vscode-testing-iconPassed);
            background-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent);
            border: 1px solid color-mix(in srgb, var(--vscode-testing-iconPassed) 25%, transparent);
        }
        .entity-references-status.error {
            color: var(--vscode-errorForeground);
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
        }
        .entity-empty {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            margin-bottom: 12px;
        }
        .entity-item-editable {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 4px;
            padding: 3px 6px 3px 10px;
        }
        .entity-item-link {
            background: transparent;
            border: none;
            color: inherit;
            font-size: 0.9em;
            cursor: pointer;
            padding: 3px 0;
        }
        .entity-remove-btn {
            border: none;
            background: transparent;
            color: inherit;
            cursor: pointer;
            font-weight: 700;
            line-height: 1;
            opacity: 0.8;
            padding: 2px 4px;
            border-radius: 3px;
        }
        .entity-remove-btn:hover {
            opacity: 1;
            background-color: color-mix(in srgb, var(--vscode-errorForeground) 20%, transparent);
            color: var(--vscode-errorForeground);
        }
        .entity-add-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px dashed var(--vscode-button-border);
            border-radius: 4px;
            padding: 6px 10px;
            cursor: pointer;
            font-size: 0.9em;
        }
        .entity-add-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .entity-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 16px;
        }
        .entity-item {
            display: inline-flex;
            align-items: center;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 0.9em;
            cursor: pointer;
            text-decoration: none;
        }
        .entity-item:hover {
            background-color: var(--vscode-button-hoverBackground);
            color: var(--vscode-button-foreground);
        }
        /* Status badge styles */
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 0.85em;
            font-weight: 500;
            cursor: pointer;
        }
        .status-badge:hover {
            opacity: 0.9;
        }
        .status-badge.initial { background-color: #17a2b8; color: white; }
        .status-badge.enhanced { background-color: #007bff; color: white; }
        .status-badge.reviewed { background-color: #28a745; color: white; }
        .status-badge.in_progress { background-color: #fd7e14; color: white; }
        .status-badge.open { background-color: #fd7e14; color: white; }
        .status-badge.closed { background-color: #6f42c1; color: white; }
        .status-badge.archived { background-color: #343a40; color: white; }
        .status-badge.deleted { background-color: #dc3545; color: white; }
        /* Tasks section styles */
        .tasks-section {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 12px 16px;
        }
        .tasks-section h3 {
            margin: 0 0 8px 0;
            color: var(--vscode-textLink-foreground);
            font-size: 0.95em;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .tasks-section h3:hover {
            opacity: 0.8;
        }
        .tasks-toggle-icon {
            font-size: 0.8em;
            transition: transform 0.2s;
        }
        .tasks-section.collapsed .tasks-toggle-icon {
            transform: rotate(-90deg);
        }
        .tasks-content {
            margin-top: 8px;
        }
        .tasks-section.collapsed .tasks-content {
            display: none;
        }
        .task-item {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            padding: 8px;
            border-radius: 4px;
            margin-bottom: 8px;
            background-color: var(--vscode-editor-background);
        }
        .task-item:last-child {
            margin-bottom: 0;
        }
        .task-item.done {
            opacity: 0.7;
        }
        .task-item.done .task-description {
            text-decoration: line-through;
        }
        .task-checkbox {
            width: 18px;
            height: 18px;
            margin-top: 2px;
            cursor: pointer;
        }
        .task-description {
            flex: 1;
            font-size: 0.95em;
        }
        .task-delete-btn {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            font-size: 1.2em;
            padding: 0 4px;
            opacity: 0.6;
        }
        .task-delete-btn:hover {
            opacity: 1;
            color: var(--vscode-errorForeground);
        }
        .task-add-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 6px 12px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.9em;
            margin-top: 8px;
        }
        .task-add-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .task-actions-row {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 8px;
        }
        .task-actions-row .task-add-btn {
            margin-top: 0;
        }
        .empty-tasks {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            margin-bottom: 8px;
        }
        .entity-type-label {
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            margin-right: 4px;
            text-transform: capitalize;
        }
        .transcript-content h1,
        .transcript-content h2,
        .transcript-content h3 {
            color: var(--vscode-textLink-foreground);
            margin-top: 24px;
            margin-bottom: 12px;
        }
        .transcript-content code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 4px;
            border-radius: 2px;
            font-family: var(--vscode-editor-font-family);
        }
        .transcript-content pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 4px;
            overflow-x: auto;
        }
        .tag {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 0.9em;
            font-weight: 500;
            margin-right: 4px;
            margin-bottom: 4px;
        }
        .tag-remove {
            background: none;
            border: none;
            color: var(--vscode-badge-foreground);
            cursor: pointer;
            padding: 2px 4px;
            margin-left: 6px;
            font-size: 1em;
            font-weight: bold;
            line-height: 1;
            opacity: 0.7;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 18px;
            min-height: 18px;
        }
        .tag-remove:hover {
            opacity: 1;
            background-color: rgba(255, 255, 255, 0.2);
            border-radius: 2px;
        }
        .tag-add {
            display: inline-flex;
            align-items: center;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 0.9em;
            cursor: pointer;
            margin-right: 4px;
        }
        .tag-add:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .confidence {
            color: var(--vscode-textLink-foreground);
            font-weight: 600;
        }
        .kbd-hint {
            display: inline-block;
            font-size: 0.65em;
            padding: 1px 5px;
            margin-left: 6px;
            background-color: rgba(0, 0, 0, 0.15);
            border: 1px solid rgba(0, 0, 0, 0.3);
            border-radius: 2px;
            font-family: var(--vscode-font-family);
            font-weight: 600;
            color: #000000;
            opacity: 0.7;
            vertical-align: middle;
            letter-spacing: 0.5px;
        }
        .button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 4px 12px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.9em;
            margin-left: 8px;
        }
        .button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .button-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
        }
        .button-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .original-enhance-row .button,
        .original-enhance-row .enhance-button {
            padding: 8px 16px;
            line-height: 1.2;
            min-height: 36px;
            box-sizing: border-box;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-left: 0;
        }
        .summary-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .summary-layout {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-top: 10px;
        }
        .summary-list-panel {
            min-width: 0;
        }
        .summary-detail-panel {
            min-width: 0;
        }
        @media (min-width: 1100px) {
            .summary-layout {
                flex-direction: row;
                align-items: flex-start;
            }
            .summary-list-panel {
                width: 320px;
                flex: 0 0 320px;
            }
            .summary-detail-panel {
                flex: 1 1 auto;
            }
        }
        .summary-item {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px 34px 8px 10px;
            cursor: pointer;
            text-align: left;
            width: 100%;
            box-sizing: border-box;
            position: relative;
        }
        .summary-item:hover {
            border-color: var(--vscode-focusBorder);
        }
        .summary-item.active {
            border-color: var(--vscode-textLink-foreground);
            background-color: color-mix(in srgb, var(--vscode-textLink-foreground) 12%, var(--vscode-editor-inactiveSelectionBackground));
        }
        .summary-item-title {
            font-weight: 600;
            margin-bottom: 4px;
        }
        .summary-item-meta {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        .summary-item-guidance {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            margin-top: 6px;
        }
        .summary-item-delete {
            position: absolute;
            top: 6px;
            right: 6px;
            border: none;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            font-size: 1.05em;
            line-height: 1;
            border-radius: 3px;
            padding: 2px 5px;
            opacity: 0.7;
        }
        .summary-item-delete:hover {
            opacity: 1;
            color: var(--vscode-errorForeground);
            background-color: var(--vscode-inputValidation-errorBackground);
        }
        .summary-detail {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 12px;
        }
        .summary-detail.hidden {
            display: none;
        }
        .summary-detail-meta {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 10px;
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
        }
        .error {
            color: var(--vscode-errorForeground);
            padding: 16px;
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            border-radius: 4px;
        }
        .inline-chat-container {
            margin-top: 24px;
            margin-bottom: 24px;
            padding: 16px 0;
            border-top: 1px solid var(--vscode-panel-border);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .inline-chat-input-wrapper {
            display: flex;
            gap: 8px;
            align-items: flex-end;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 8px;
            padding: 8px 12px;
        }
        .inline-chat-input-wrapper:focus-within {
            border-color: var(--vscode-focusBorder);
        }
        .inline-chat-input {
            flex: 1;
            background: transparent;
            border: none;
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            resize: none;
            min-height: 24px;
            max-height: 200px;
            overflow-y: auto;
            outline: none;
            padding: 4px 0;
        }
        .inline-chat-input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        .inline-chat-send {
            background: transparent;
            border: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            padding: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.7;
            transition: opacity 0.2s;
        }
        .inline-chat-send:hover {
            opacity: 1;
        }
        .inline-chat-send:disabled {
            opacity: 0.3;
            cursor: not-allowed;
        }
        .refresh-button {
            position: absolute;
            top: 0;
            right: 0;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: background-color 0.2s;
            z-index: 10;
        }
        .refresh-button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .refresh-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .last-fetched {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            margin-top: 8px;
            font-style: italic;
        }
    </style>
</head>
<body>
    <div class="header">
        <button class="refresh-button" id="refresh-button" title="Refresh transcript data">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 2V6L10 4M8 14V10L6 12M2 8H6L4 10M14 8H10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" fill="none"/>
            </svg>
            Refresh
        </button>
        <div class="project-section">
            ${projectName ? `
                <div class="project-info">
                    <span class="project-name clickable" onclick="changeProject()">${this.escapeHtml(projectName)}</span>
                    <span class="kbd-hint">P</span>
                </div>
            ` : `
                <div class="project-info">
                    <span style="color: var(--vscode-descriptionForeground); font-style: italic;">No project assigned</span>
                    <button type="button" class="button button-secondary" onclick="changeProject()">Assign Project <span class="kbd-hint">P</span></button>
                </div>
            `}
        </div>
        <h1 class="title-header">
            <span class="editable-title" id="title-display" onclick="startEditTitle()">
                ${this.escapeHtml(transcript.title || transcript.filename)}
                <svg class="edit-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M11.5 1.5L14.5 4.5L5 14H2V11L11.5 1.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M10 3L13 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <span class="kbd-hint">T</span>
            </span>
            <span id="update-indicator" class="update-indicator">
                <span class="spinner"></span>
                <span>Updating...</span>
            </span>
        </h1>
        ${lastFetched ? `<div class="last-fetched">Last fetched: ${this.escapeHtml(this.formatDate(lastFetched.toISOString()))}</div>` : ''}
        <div class="title-actions" id="title-actions" style="display: none;">
            <button class="button" onclick="saveTitle()">Save (Ctrl+Enter)</button>
            <button class="button button-secondary" onclick="cancelEditTitle()">Cancel (Esc)</button>
        </div>
    </div>
    <div class="info-grid">
        <div class="metadata" id="metadata-section">
            <h2 onclick="toggleMetadata()">
                <span class="metadata-toggle-icon">▼</span>
                Metadata
            </h2>
            <div class="metadata-content">
                <div class="metadata-row">
                    <div class="metadata-label">Date/Time:</div>
                    <div class="metadata-value date-picker-row">
                        <input
                            type="date"
                            class="transcript-date-input"
                            id="transcript-date-input"
                            value="${this.escapeHtml(dateInputValue)}"
                            onchange="submitDateChange(this.value)"
                            title="Pick transcript date"
                        />
                        ${time ? `<span class="date-time-suffix">${this.escapeHtml(time)}</span>` : ''}
                        ${!dateInputValue && dateTime !== 'Unknown date' ? `<span class="date-time-suffix">${this.escapeHtml(dateTime)}</span>` : ''}
                    </div>
                </div>
                ${createdAt ? `
                <div class="metadata-row">
                    <div class="metadata-label">Created:</div>
                    <div class="metadata-value">${this.escapeHtml(this.formatDate(createdAt))}</div>
                </div>
                ` : ''}
                ${updatedAt ? `
                <div class="metadata-row">
                    <div class="metadata-label">Updated:</div>
                    <div class="metadata-value">${this.escapeHtml(this.formatDate(updatedAt))}</div>
                </div>
                ` : ''}
                <div class="metadata-row">
                    <div class="metadata-label">Status:</div>
                    <div class="metadata-value">
                        <span class="status-badge ${this.escapeHtml(status)}" onclick="changeStatus()" title="Click to change status">
                            ${this.getStatusIcon(status)} ${this.getStatusLabel(status)}
                        </span>
                    </div>
                </div>
                <div class="metadata-row">
                    <div class="metadata-label">Tags:</div>
                    <div class="metadata-value">
                        ${tags.map(tag => `
                            <span class="tag">
                                ${this.escapeHtml(tag)}
                                <button class="tag-remove" onclick="event.stopPropagation(); removeTag('${this.escapeHtml(tag)}'); return false;" title="Remove tag">×</button>
                            </span>
                        `).join('')}
                        <button class="tag-add" onclick="addTag()" title="Add tag">+ Add Tag <span class="kbd-hint">G</span></button>
                    </div>
                </div>
            </div>
        </div>
        <div class="tasks-section" id="tasks-section">
            <h3 onclick="toggleTasks()">
                <span class="tasks-toggle-icon">▼</span>
                Tasks ${openTasks.length > 0 ? `(${openTasks.length} open)` : ''}
            </h3>
            <div class="tasks-content">
                ${tasks.length === 0 ? `
                    <div class="empty-tasks">No tasks</div>
                ` : tasks.map((task: { id: string; description: string; status: string }) => `
                    <div class="task-item ${task.status}">
                        <input type="checkbox" class="task-checkbox" ${task.status === 'done' ? 'checked' : ''} 
                            onchange="toggleTask('${this.escapeHtml(task.id)}')" />
                        <span class="task-description">${this.escapeHtml(task.description)}</span>
                        <button class="task-delete-btn" onclick="deleteTask('${this.escapeHtml(task.id)}')" title="Delete task">×</button>
                    </div>
                `).join('')}
                <div class="task-actions-row">
                    <button class="task-add-btn" onclick="addTask()">+ Add Task <span class="kbd-hint">K</span></button>
                    <button class="task-add-btn" onclick="identifyTasks()">Identify Tasks</button>
                </div>
            </div>
        </div>
    </div>
    <div class="inline-chat-container" id="inline-chat-container">
        <div class="inline-chat-input-wrapper">
            <textarea 
                class="inline-chat-input" 
                id="inline-chat-input" 
                placeholder="Type a message to make changes... (e.g., Change the title to &quot;Hello World&quot;) Press C to focus"
                rows="1"
            ></textarea>
            <button type="button" class="inline-chat-send" id="inline-chat-send">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1.5 1.5L14.5 8L1.5 14.5L3.5 8L1.5 1.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </button>
        </div>
    </div>
    <div class="transcript-content-wrapper">
        <div class="content-tabs">
            <button class="content-tab ${hasOriginalTab ? (initialTab === 'raw' ? 'active' : '') : 'disabled'}" id="raw-tab" onclick="switchTab('raw')" ${hasOriginalTab ? '' : 'disabled'}>Original</button>
            ${showEnhancedTab ? `<button class="content-tab ${initialTab === 'enhanced' ? 'active' : ''}" id="enhanced-tab" onclick="switchTab('enhanced')">Enhanced</button>` : ''}
            ${summaryFeatureEnabled ? `<button class="content-tab ${initialTab === 'summary' ? 'active' : ''}" id="summary-tab" onclick="switchTab('summary')">Summary (${summaries.length})</button>` : ''}
            <button class="content-tab ${(initialTab as string) === 'comments' ? 'active' : ''}" id="comments-tab" onclick="switchTab('comments')">Comments (${comments.length})</button>
        </div>
        ${showEnhancedTab ? `
        <div class="tab-content ${initialTab === 'enhanced' ? 'active' : ''}" id="enhanced-content">
            <div class="tab-toolbar" style="margin-bottom: 16px;">
                <div class="tab-toolbar-left">
                    <button class="edit-button" onclick="editInEditor('enhanced')" id="edit-in-editor-btn" title="Edit Enhanced content in VS Code editor (supports voice dictation).">Edit Enhanced <span class="kbd-hint">E</span></button>
                    <button class="edit-button" onclick="openSource()" id="open-source-btn" title="View source (read-only)" style="opacity: 0.7;">View Source <span class="kbd-hint">S</span></button>
                </div>
                <div class="tab-toolbar-right">
                    <button class="button button-secondary" onclick="copyTabContent('enhanced', this)" title="Copy enhanced text">Copy Enhanced</button>
                </div>
            </div>
            <div class="transcript-content" id="transcript-content-display">
                ${this.markdownToHtml(transcriptText)}
            </div>
            <button class="create-entity-button" id="create-entity-btn" onclick="createEntityFromSelection()" title="Correct this text by creating new entity or mapping to existing">Correct Text</button>
            <div style="margin-top: 18px;">
                <div class="last-fetched">Enhancement history</div>
                <div id="enhancement-log-container">
                    <div class="loading">Loading enhancement log...</div>
                </div>
            </div>
        </div>
        ` : ''}
        ${hasOriginalTab ? `
        <div class="tab-content ${initialTab === 'raw' ? 'active' : ''}" id="raw-content">
            ${isManualNote ? `
            <div class="tab-toolbar">
                <div class="tab-toolbar-left">
                    <button class="button button-secondary" id="edit-original-in-editor-btn" onclick="editInEditor('original')">Edit Original in Editor</button>
                    <button class="button" id="save-original-btn" onclick="saveOriginalContent()" disabled>Save Original</button>
                    <button class="enhance-button" id="enhance-original-btn" onclick="enhanceFromOriginal()">Enhance</button>
                    <span class="original-editor-status" id="original-editor-status">No changes</span>
                </div>
                <div class="tab-toolbar-right">
                    <button class="button button-secondary" onclick="copyTabContent('original', this)">Copy Original</button>
                </div>
            </div>
            <textarea id="original-editor-input" class="original-editor-textarea" placeholder="Type or paste original note content...">${this.escapeHtml(originalEditorText)}</textarea>
            ` : `
            <div class="tab-toolbar">
                <div class="tab-toolbar-left">
                    <button class="edit-button" onclick="editInEditor('original')" title="Edit Original transcript text in VS Code editor.">Edit Original in Editor</button>
                    <button class="enhance-button" id="enhance-original-btn" onclick="enhanceFromOriginal()">Enhance</button>
                </div>
                <div class="tab-toolbar-right">
                    <button class="button button-secondary" onclick="copyTabContent('original', this)">Copy Original</button>
                </div>
            </div>
            <div class="transcript-content" style="white-space: pre-wrap; font-family: var(--vscode-editor-font-family);">
                ${this.escapeHtml(content.rawTranscript?.text ?? '')}
            </div>
            ${content.rawTranscript?.model || content.rawTranscript?.transcribedAt ? `
            <div style="margin-top: 16px; padding: 12px; background-color: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; font-size: 0.85em; color: var(--vscode-descriptionForeground);">
                ${content.rawTranscript?.model ? `Model: ${this.escapeHtml(content.rawTranscript.model)}` : ''}
                ${content.rawTranscript?.model && content.rawTranscript?.transcribedAt ? ' • ' : ''}
                ${content.rawTranscript?.transcribedAt ? `Transcribed: ${this.escapeHtml(this.formatDate(content.rawTranscript.transcribedAt))}` : ''}
            </div>
            ` : ''}
            `}
        </div>
        ` : ''}
        ${summaryFeatureEnabled ? `<div class="tab-content ${initialTab === 'summary' ? 'active' : ''}" id="summary-content">
            ${hasSummary ? `
            <div class="tab-toolbar">
                <div class="tab-toolbar-left">
                    <button class="button button-secondary" id="summary-configure-btn" onclick="startSummarySetup()">Reconfigure</button>
                    <button class="button" id="summary-regenerate-btn" onclick="generateSummary()">Generate New Summary</button>
                </div>
                <div class="tab-toolbar-right">
                    <button class="button button-secondary" onclick="copyTabContent('summary', this)">Copy Summary</button>
                </div>
            </div>
            <div class="last-fetched">Saved summaries: ${summaries.length}</div>
            <div class="summary-layout">
                <div class="summary-list-panel">
                    <div class="summary-list" id="summary-list">
                        ${summaries.map((summary) => `
                            <div class="summary-item ${activeSummary && summary.id === activeSummary.id ? 'active' : ''}" data-summary-id="${this.escapeHtml(summary.id)}" onclick="selectSummary('${this.escapeHtml(summary.id)}')">
                                <button type="button" class="summary-item-delete" title="Delete summary" onclick="deleteSummary('${this.escapeHtml(summary.id)}', event)">×</button>
                                <div class="summary-item-title">${this.escapeHtml(summary.title || 'Untitled summary')}</div>
                                <div class="summary-item-meta">
                                    <span>Audience: ${this.escapeHtml(summary.audience || '(none)')}</span>
                                    <span>Style: ${this.escapeHtml(summary.styleLabel || summary.stylePreset || 'detailed')}</span>
                                    <span>Generated: ${this.escapeHtml(this.formatDate(summary.generatedAt))}</span>
                                </div>
                                <div class="summary-item-guidance">Guidance: ${this.escapeHtml(summary.guidance || '(none)')}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="summary-detail-panel">
                    ${summaries.map((summary) => `
                        <div class="summary-detail ${activeSummary && summary.id === activeSummary.id ? '' : 'hidden'}" data-summary-detail-id="${this.escapeHtml(summary.id)}">
                            <div class="summary-detail-meta">
                                <span><strong>Title:</strong> ${this.escapeHtml(summary.title || 'Untitled summary')}</span>
                                <span><strong>Audience:</strong> ${this.escapeHtml(summary.audience || '(none)')}</span>
                                <span><strong>Generated:</strong> ${this.escapeHtml(this.formatDate(summary.generatedAt))}</span>
                                <span><strong>Guidance:</strong> ${this.escapeHtml(summary.guidance || '(none)')}</span>
                            </div>
                            <div class="summary-content-text">${this.markdownToHtml(summary.content || '')}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
            ` : `
            <div class="summary-empty-state" id="summary-empty-state">
                <h3>No summary yet</h3>
                <p id="summary-setup-description">Generate a summary to create a short, audience-aware overview of this note.</p>
                <div class="summary-setup-preview" id="summary-setup-preview">
                    <div class="summary-setup-row"><span class="summary-setup-label">Title:</span><span id="summary-setup-title">${this.escapeHtml(summaryConfig?.title || '')}</span></div>
                    <div class="summary-setup-row"><span class="summary-setup-label">Audience:</span><span id="summary-setup-audience">${this.escapeHtml(summaryConfig?.audience || '')}</span></div>
                    <div class="summary-setup-row"><span class="summary-setup-label">Style:</span><span id="summary-setup-style">${this.escapeHtml(summaryConfig?.styleLabel || '')}</span></div>
                    <div class="summary-setup-row"><span class="summary-setup-label">Guidance:</span><span id="summary-setup-guidance">${this.escapeHtml(summaryConfig?.guidance || '(none)')}</span></div>
                </div>
                <div style="display: flex; gap: 8px; margin-top: 8px;">
                    <button class="button button-secondary" id="summary-configure-btn" onclick="startSummarySetup()">Configure Summary</button>
                    <button class="button" id="summary-generate-btn" onclick="generateSummary()">Generate Summary</button>
                </div>
            </div>
            `}
        </div>` : ''}
        <div class="tab-content ${(initialTab as string) === 'comments' ? 'active' : ''}" id="comments-content">
            <div class="comments-toolbar">
                <div class="tab-toolbar">
                    <div class="tab-toolbar-left">
                        <button class="button" id="add-comment-btn" onclick="submitComment()">Add Comment</button>
                    </div>
                </div>
                <textarea id="new-comment-input" class="comments-input" placeholder="Add background/context notes for this transcript..."></textarea>
                <div id="comments-status" class="comments-status"></div>
            </div>
            <div class="comments-list" id="comments-list"></div>
        </div>
    </div>
    ${this.renderEntityReferences(entityReferences)}
    <script>
        const vscode = acquireVsCodeApi();
        const transcriptPath = ${JSON.stringify(transcriptPath)};
        const transcriptUri = ${JSON.stringify(transcript.uri)};
        const projectId = ${JSON.stringify(projectId)};
        const currentTags = ${JSON.stringify(tags)};
        const isManualNote = ${JSON.stringify(isManualNote)};
        const showEnhancedTab = ${JSON.stringify(showEnhancedTab)};
        const hasManualEnhancedContent = ${JSON.stringify(hasManualEnhancedContent)};
        const originalRawText = ${JSON.stringify(content.rawTranscript?.text ?? '')};
        const originalTranscriptText = ${JSON.stringify(transcriptText)};
        const summaryEntries = ${JSON.stringify(summaries.map(summary => ({ id: summary.id, content: summary.content || '' })))};
        const initialComments = ${JSON.stringify(comments)};
        const originalEditorInitialText = ${JSON.stringify(originalEditorText)};
        const initialEntityReferences = ${JSON.stringify(entityReferences)};
        const entitySectionConfig = [
            { key: 'projects', title: 'Projects', type: 'project', label: 'Project' },
            { key: 'people', title: 'People', type: 'person', label: 'Person' },
            { key: 'terms', title: 'Terms', type: 'term', label: 'Term' },
            { key: 'companies', title: 'Companies', type: 'company', label: 'Company' }
        ];
        let isEditingEntityReferences = false;
        let isSavingEntityReferences = false;
        let entityReferencesState = normalizeEntityReferences(initialEntityReferences);
        const persistedViewState = vscode.getState() || {};
        const persistedTabName = typeof persistedViewState.activeTabName === 'string'
            ? persistedViewState.activeTabName
            : '';
        let activeTabName = ${JSON.stringify(initialTab)};
        let commentsState = normalizeComments(initialComments);
        let editingCommentId = '';
        let originalDraft = originalEditorInitialText;
        let lastSavedOriginal = originalEditorInitialText;
        let hasUnsavedOriginalChanges = false;

        function normalizeComments(raw) {
            if (!Array.isArray(raw)) {
                return [];
            }
            return raw
                .filter(item => item && typeof item === 'object')
                .map(item => ({
                    id: String(item.id || '').trim(),
                    text: String(item.text || ''),
                    createdAt: String(item.createdAt || ''),
                    updatedAt: item.updatedAt ? String(item.updatedAt) : ''
                }))
                .filter(item => item.id && item.text.trim() && item.createdAt)
                .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        }

        function formatCommentTimestamp(isoDate) {
            if (!isoDate) {
                return '';
            }
            const parsed = new Date(isoDate);
            if (Number.isNaN(parsed.getTime())) {
                return isoDate;
            }
            return parsed.toLocaleString();
        }

        function showCommentsStatus(message, type) {
            const statusEl = document.getElementById('comments-status');
            if (!statusEl) {
                return;
            }
            statusEl.textContent = message || '';
            statusEl.className = 'comments-status ' + (type || '');
            statusEl.style.display = message ? 'block' : 'none';
        }

        function updateCommentsTabLabel() {
            const tab = document.getElementById('comments-tab');
            if (!tab) {
                return;
            }
            tab.textContent = 'Comments (' + commentsState.length + ')';
        }

        function renderCommentsList() {
            const container = document.getElementById('comments-list');
            if (!container) {
                return;
            }

            if (!commentsState.length) {
                container.innerHTML = '<div class="comment-empty-state">No comments yet.</div>';
                updateCommentsTabLabel();
                return;
            }

            const html = commentsState.map(comment => {
                const isEditing = editingCommentId && editingCommentId === comment.id;
                const text = escapeHtml(comment.text || '');
                const createdLabel = escapeHtml(formatCommentTimestamp(comment.createdAt));
                const updatedLabel = comment.updatedAt
                    ? escapeHtml(formatCommentTimestamp(comment.updatedAt))
                    : '';
                const escapedId = escapeHtml(comment.id);

                if (isEditing) {
                    return '<div class="comment-card">' +
                        '<div class="comment-meta"><span>Created ' + createdLabel + '</span>' +
                        (updatedLabel ? '<span>Updated ' + updatedLabel + '</span>' : '<span></span>') +
                        '</div>' +
                        '<textarea class="comment-edit-textarea" id="edit-comment-' + escapedId + '">' + text + '</textarea>' +
                        '<div class="comment-actions">' +
                        '<button class="button" data-comment-action="save" data-comment-id="' + escapedId + '">Save</button>' +
                        '<button class="button button-secondary" data-comment-action="cancel">Cancel</button>' +
                        '</div>' +
                        '</div>';
                }

                return '<div class="comment-card">' +
                    '<div class="comment-meta"><span>Created ' + createdLabel + '</span>' +
                    (updatedLabel ? '<span>Updated ' + updatedLabel + '</span>' : '<span></span>') +
                    '</div>' +
                    '<div class="comment-text">' + text + '</div>' +
                    '<div class="comment-actions">' +
                    '<button class="button button-secondary" data-comment-action="edit" data-comment-id="' + escapedId + '">Edit</button>' +
                    '<button class="button button-secondary" data-comment-action="delete" data-comment-id="' + escapedId + '">Delete</button>' +
                    '</div>' +
                    '</div>';
            }).join('');

            container.innerHTML = html;
            updateCommentsTabLabel();
        }

        function submitComment() {
            const input = document.getElementById('new-comment-input');
            const addBtn = document.getElementById('add-comment-btn');
            if (!input || !addBtn) {
                return;
            }
            const text = input.value.trim();
            if (!text) {
                showCommentsStatus('Comment text cannot be empty.', 'error');
                return;
            }
            addBtn.disabled = true;
            addBtn.textContent = 'Adding...';
            showCommentsStatus('', '');
            vscode.postMessage({
                command: 'addComment',
                transcriptUri: transcriptUri,
                text: text,
                comments: commentsState
            });
        }

        function startEditComment(commentId) {
            if (!commentId) {
                return;
            }
            editingCommentId = commentId;
            renderCommentsList();
        }

        function cancelEditComment() {
            editingCommentId = '';
            renderCommentsList();
        }

        function saveEditedComment(commentId) {
            if (!commentId) {
                return;
            }
            const input = document.getElementById('edit-comment-' + commentId);
            if (!input) {
                return;
            }
            const text = input.value.trim();
            if (!text) {
                showCommentsStatus('Comment text cannot be empty.', 'error');
                return;
            }
            showCommentsStatus('', '');
            vscode.postMessage({
                command: 'editComment',
                transcriptUri: transcriptUri,
                commentId: commentId,
                text: text,
                comments: commentsState
            });
        }

        function deleteComment(commentId) {
            if (!commentId) {
                return;
            }
            const confirmed = window.confirm('Delete this comment?');
            if (!confirmed) {
                return;
            }
            showCommentsStatus('', '');
            vscode.postMessage({
                command: 'deleteComment',
                transcriptUri: transcriptUri,
                commentId: commentId,
                comments: commentsState
            });
        }

        function setupCommentsEventHandlers() {
            const container = document.getElementById('comments-list');
            if (!container || container.dataset.bound === 'true') {
                return;
            }
            container.dataset.bound = 'true';
            container.addEventListener('click', (event) => {
                const target = event.target && event.target.closest
                    ? event.target.closest('[data-comment-action]')
                    : null;
                if (!target) {
                    return;
                }
                const action = target.getAttribute('data-comment-action');
                const commentId = target.getAttribute('data-comment-id') || '';
                if (action === 'edit') {
                    startEditComment(commentId);
                } else if (action === 'delete') {
                    deleteComment(commentId);
                } else if (action === 'save') {
                    saveEditedComment(commentId);
                } else if (action === 'cancel') {
                    cancelEditComment();
                }
            });
        }

        function normalizeEntityReferences(raw) {
            const result = { projects: [], people: [], terms: [], companies: [] };
            if (!raw || typeof raw !== 'object') {
                return result;
            }

            for (const key of Object.keys(result)) {
                const value = raw[key];
                if (!Array.isArray(value)) {
                    continue;
                }
                const dedupe = new Map();
                value.forEach(item => {
                    if (!item || typeof item !== 'object') { return; }
                    const id = String(item.id || '').trim();
                    const name = String(item.name || '').trim();
                    if (!id || !name) { return; }
                    dedupe.set(id, { id, name });
                });
                result[key] = Array.from(dedupe.values());
            }
            return result;
        }

        function showEntityReferenceStatus(message, type) {
            const statusEl = document.getElementById('entity-references-status');
            if (!statusEl) {
                return;
            }
            statusEl.textContent = message;
            statusEl.className = 'entity-references-status ' + type;
            statusEl.style.display = 'block';
        }

        function clearEntityReferenceStatus() {
            const statusEl = document.getElementById('entity-references-status');
            if (!statusEl) {
                return;
            }
            statusEl.textContent = '';
            statusEl.className = 'entity-references-status';
            statusEl.style.display = 'none';
        }

        function renderEntityReferencesContent() {
            const container = document.getElementById('entity-references-content');
            const editBtn = document.getElementById('entity-references-edit-btn');
            const saveBtn = document.getElementById('entity-references-save-btn');
            if (!container || !editBtn || !saveBtn) {
                return;
            }

            editBtn.style.display = isEditingEntityReferences ? 'none' : 'inline-flex';
            saveBtn.style.display = isEditingEntityReferences ? 'inline-flex' : 'none';
            saveBtn.disabled = isSavingEntityReferences;
            saveBtn.textContent = isSavingEntityReferences ? 'Saving...' : 'Save';

            let hasAnyEntities = false;
            let html = '';

            entitySectionConfig.forEach(section => {
                const items = entityReferencesState[section.key] || [];
                if (!isEditingEntityReferences && items.length === 0) {
                    return;
                }
                if (items.length > 0) {
                    hasAnyEntities = true;
                }

                html += '<div class="entity-section"><h3>' + escapeHtml(section.title) + '</h3><div class="entity-list">';
                if (items.length === 0) {
                    html += '<span class="entity-empty">No entities</span>';
                } else {
                    items.forEach(item => {
                        const escapedId = escapeHtml(item.id);
                        const escapedName = escapeHtml(item.name);
                        if (isEditingEntityReferences) {
                            html += '<span class="entity-item-editable">';
                            html += '<button class="entity-item-link" onclick="openEntity(&#39;' + section.type + '&#39;, &#39;' + escapedId + '&#39;)">';
                            html += '<span class="entity-type-label">' + escapeHtml(section.label) + ':</span> ' + escapedName;
                            html += '</button>';
                            html += '<button class="entity-remove-btn" onclick="removeEntityReference(&#39;' + section.key + '&#39;, &#39;' + escapedId + '&#39;)" title="Remove ' + escapeHtml(section.label) + '">×</button>';
                            html += '</span>';
                        } else {
                            html += '<a href="#" class="entity-item" onclick="openEntity(&#39;' + section.type + '&#39;, &#39;' + escapedId + '&#39;); return false;">';
                            html += '<span class="entity-type-label">' + escapeHtml(section.label) + ':</span> ' + escapedName;
                            html += '</a>';
                        }
                    });
                }
                if (isEditingEntityReferences) {
                    html += '<button class="entity-add-btn" onclick="pickEntityReference(&#39;' + section.type + '&#39;)">+ Add New Entity</button>';
                }
                html += '</div></div>';
            });

            if (!isEditingEntityReferences && !hasAnyEntities) {
                html = '<div class="entity-empty">No entity references yet.</div>';
            }

            container.innerHTML = html;
        }

        function startEditEntityReferences() {
            isEditingEntityReferences = true;
            clearEntityReferenceStatus();
            renderEntityReferencesContent();
        }

        function removeEntityReference(sectionKey, entityId) {
            const list = entityReferencesState[sectionKey] || [];
            entityReferencesState[sectionKey] = list.filter(entity => entity.id !== entityId);
            renderEntityReferencesContent();
        }

        function pickEntityReference(entityType) {
            if (isSavingEntityReferences) {
                return;
            }
            vscode.postMessage({
                command: 'pickEntityReference',
                transcriptPath: transcriptPath,
                entityType: entityType
            });
        }

        function saveEntityReferences() {
            if (!isEditingEntityReferences || isSavingEntityReferences) {
                return;
            }
            isSavingEntityReferences = true;
            clearEntityReferenceStatus();
            renderEntityReferencesContent();
            vscode.postMessage({
                command: 'saveEntityReferences',
                transcriptPath: transcriptPath,
                entities: entityReferencesState
            });
        }

        function addPickedEntityReference(sectionKey, entity) {
            if (!entity || !entity.id || !entity.name) {
                return;
            }
            const current = entityReferencesState[sectionKey] || [];
            if (current.some(item => item.id === entity.id)) {
                showEntityReferenceStatus('Entity already added.', 'error');
                return;
            }
            entityReferencesState[sectionKey] = current.concat([{ id: entity.id, name: entity.name }]);
            clearEntityReferenceStatus();
            renderEntityReferencesContent();
        }

        function toggleMetadata() {
            const section = document.getElementById('metadata-section');
            if (section) {
                section.classList.toggle('collapsed');
            }
        }

        function toggleTasks() {
            const section = document.getElementById('tasks-section');
            if (section) {
                section.classList.toggle('collapsed');
            }
        }

        let enhancementLogLoaded = false;

        function setEnhancementTabInProgress(inProgress) {
            const enhancedTab = document.getElementById('enhanced-tab');
            if (!enhancedTab) {
                return;
            }
            enhancedTab.textContent = inProgress ? 'Enhanced (In Progress)' : 'Enhanced';
        }
        
        function setOriginalSaveStatus(message, state) {
            const statusEl = document.getElementById('original-editor-status');
            if (!statusEl) {
                return;
            }
            statusEl.textContent = message;
            statusEl.classList.remove('dirty', 'saved');
            if (state) {
                statusEl.classList.add(state);
            }
        }

        function updateOriginalDirtyState() {
            if (!isManualNote) {
                return;
            }
            const saveBtn = document.getElementById('save-original-btn');
            const editor = document.getElementById('original-editor-input');
            if (!editor || !saveBtn) {
                return;
            }
            originalDraft = editor.value;
            hasUnsavedOriginalChanges = originalDraft !== lastSavedOriginal;
            saveBtn.disabled = !hasUnsavedOriginalChanges;
            if (hasUnsavedOriginalChanges) {
                setOriginalSaveStatus('Unsaved changes', 'dirty');
            } else {
                setOriginalSaveStatus('No changes', '');
            }
        }

        function getCurrentOriginalText() {
            if (isManualNote) {
                const editor = document.getElementById('original-editor-input');
                return editor ? editor.value : '';
            }
            return originalRawText;
        }

        function getCurrentSummaryText() {
            const activeSummaryItem = document.querySelector('.summary-item.active');
            const activeSummaryId = activeSummaryItem ? activeSummaryItem.getAttribute('data-summary-id') : '';
            if (!activeSummaryId) {
                return '';
            }
            const activeSummary = summaryEntries.find(summary => summary.id === activeSummaryId);
            return activeSummary ? activeSummary.content : '';
        }

        function fallbackCopyText(text) {
            const tempTextArea = document.createElement('textarea');
            tempTextArea.value = text;
            tempTextArea.setAttribute('readonly', '');
            tempTextArea.style.position = 'absolute';
            tempTextArea.style.left = '-9999px';
            document.body.appendChild(tempTextArea);
            tempTextArea.select();
            const didCopy = document.execCommand('copy');
            document.body.removeChild(tempTextArea);
            if (!didCopy) {
                throw new Error('execCommand copy failed');
            }
        }

        async function copyTabContent(kind, button) {
            let textToCopy = '';
            let successLabel = 'Copied';

            if (kind === 'original') {
                textToCopy = getCurrentOriginalText();
                successLabel = 'Copied Original';
            } else if (kind === 'enhanced') {
                textToCopy = originalTranscriptText || '';
                successLabel = 'Copied Enhanced';
            } else if (kind === 'summary') {
                textToCopy = getCurrentSummaryText();
                successLabel = 'Copied Summary';
            }

            if (!textToCopy || !textToCopy.trim()) {
                window.alert('Nothing to copy yet.');
                return;
            }

            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(textToCopy);
                } else {
                    fallbackCopyText(textToCopy);
                }
            } catch (error) {
                try {
                    fallbackCopyText(textToCopy);
                } catch (fallbackError) {
                    console.error('Failed to copy transcript content', { error, fallbackError });
                    window.alert('Unable to copy text. Please try again.');
                    return;
                }
            }

            if (button) {
                const originalLabel = button.dataset.originalLabel || button.textContent || 'Copy';
                button.dataset.originalLabel = originalLabel;
                button.textContent = successLabel;
                button.disabled = true;
                window.setTimeout(() => {
                    button.textContent = originalLabel;
                    button.disabled = false;
                }, 1200);
            }
        }

        function confirmDiscardOriginalChanges() {
            if (!isManualNote || !hasUnsavedOriginalChanges) {
                return true;
            }
            return window.confirm('You have unsaved changes in Original. Continue without saving?');
        }

        function setupOriginalEditor() {
            if (!isManualNote) {
                return;
            }
            const editor = document.getElementById('original-editor-input');
            const saveBtn = document.getElementById('save-original-btn');
            if (!editor || !saveBtn) {
                return;
            }

            editor.addEventListener('input', () => {
                updateOriginalDirtyState();
            });

            editor.addEventListener('keydown', (e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    saveOriginalContent();
                }
            });

            updateOriginalDirtyState();
        }

        function saveOriginalContent() {
            if (!isManualNote) {
                return;
            }
            const editor = document.getElementById('original-editor-input');
            const saveBtn = document.getElementById('save-original-btn');
            if (!editor || !saveBtn || saveBtn.disabled) {
                return;
            }

            const newContent = editor.value;
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
            setOriginalSaveStatus('Saving...', '');

            vscode.postMessage({
                command: 'saveOriginalContent',
                transcriptPath: transcriptPath,
                transcriptUri: transcriptUri,
                newContent: newContent
            });
        }

        function enhanceFromOriginal() {
            const enhanceBtn = document.getElementById('enhance-original-btn');
            const originalText = getCurrentOriginalText();
            if (!originalText || !originalText.trim()) {
                window.alert('Original is empty. Add content before running Enhance.');
                return;
            }

            const hasExistingEnhanced = showEnhancedTab && (!isManualNote || hasManualEnhancedContent);

            if (enhanceBtn) {
                enhanceBtn.disabled = true;
                enhanceBtn.textContent = hasExistingEnhanced ? 'Confirming...' : 'Enhancing...';
            }

            vscode.postMessage({
                command: 'enhanceFromOriginal',
                transcriptPath: transcriptPath,
                transcriptUri: transcriptUri,
                originalText: originalText,
                hasExistingEnhanced: hasExistingEnhanced
            });
        }

        function switchTab(tabName) {
            if (tabName === activeTabName) {
                vscode.setState({ activeTabName: tabName });
                if (tabName === 'enhanced') {
                    ensureEnhancementLogLoaded();
                }
                return;
            }

            if (isManualNote && activeTabName === 'raw' && tabName !== 'raw' && !confirmDiscardOriginalChanges()) {
                return;
            }

            // Update tab buttons
            document.querySelectorAll('.content-tab').forEach(tab => {
                tab.classList.remove('active');
            });
            const activeTab = document.getElementById(tabName + '-tab');
            if (activeTab && !activeTab.disabled) {
                activeTab.classList.add('active');
            }

            // Update tab content
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            const activeContent = document.getElementById(tabName + '-content');
            if (activeContent) {
                activeContent.classList.add('active');
            }
            activeTabName = tabName;
            vscode.setState({ activeTabName: tabName });
            
            // Lazy load enhancement log when tab is first opened
            if (tabName === 'enhanced') {
                ensureEnhancementLogLoaded();
            }
        }

        function ensureEnhancementLogLoaded() {
            if (!showEnhancedTab || enhancementLogLoaded) {
                return;
            }
            const enhancementContainer = document.getElementById('enhancement-log-container');
            if (!enhancementContainer) {
                return;
            }
            loadEnhancementLog();
            enhancementLogLoaded = true;
        }

        function isTabAvailable(tabName) {
            const tab = document.getElementById(tabName + '-tab');
            return !!(tab && !tab.disabled);
        }

        function restoreActiveTabPreference() {
            if (persistedTabName && isTabAvailable(persistedTabName)) {
                switchTab(persistedTabName);
                if (persistedTabName === 'enhanced') {
                    ensureEnhancementLogLoaded();
                }
                return;
            }
            if (isManualNote && isTabAvailable('raw') && activeTabName !== 'raw') {
                switchTab('raw');
                return;
            }
            if (activeTabName === 'enhanced') {
                ensureEnhancementLogLoaded();
            }
            vscode.setState({ activeTabName });
        }

        function loadEnhancementLog() {
            console.log('Loading enhancement log for transcript:', transcriptPath);
            vscode.postMessage({
                command: 'loadEnhancementLog',
                transcriptPath: transcriptPath
            });
        }

        function applySummarySetup(summaryConfig) {
            const preview = document.getElementById('summary-setup-preview');
            const description = document.getElementById('summary-setup-description');
            const generateButton = document.getElementById('summary-generate-btn');
            const configureButton = document.getElementById('summary-configure-btn');
            if (!preview || !generateButton) {
                return;
            }

            const titleEl = document.getElementById('summary-setup-title');
            const audienceEl = document.getElementById('summary-setup-audience');
            const styleEl = document.getElementById('summary-setup-style');
            const guidanceEl = document.getElementById('summary-setup-guidance');
            if (!titleEl || !audienceEl || !styleEl || !guidanceEl) {
                return;
            }

            titleEl.textContent = summaryConfig.title || '';
            audienceEl.textContent = summaryConfig.audience || '';
            styleEl.textContent = summaryConfig.styleLabel || summaryConfig.stylePreset || '';
            guidanceEl.textContent = summaryConfig.guidance || '(none)';
            preview.style.display = 'block';
            if (description) {
                description.textContent = 'Summary configuration saved. You can reconfigure it before generation.';
            }
            if (configureButton) {
                configureButton.textContent = 'Reconfigure Summary';
            }
            generateButton.disabled = false;
        }
        
        function renderEnhancementLog(data) {
            const container = document.getElementById('enhancement-log-container');
            if (!container) return;
            
            if (!data.entries || data.entries.length === 0) {
                container.innerHTML = '<div class="empty-state">No enhancement data available for this transcript</div>';
                return;
            }

            const rejectedCorrectionEntryIds = new Set(
                data.entries
                    .filter(entry => entry.action === 'correction_rejected')
                    .map(entry => Number(entry.details?.correctionEntryId))
                    .filter(id => Number.isInteger(id) && id > 0)
            );
            
            // Group entries by phase
            const byPhase = {
                transcribe: [],
                enhance: [],
                'simple-replace': []
            };
            
            data.entries.forEach(entry => {
                if (byPhase[entry.phase]) {
                    byPhase[entry.phase].push(entry);
                }
            });
            
            let html = '<div class="enhancement-timeline">';
            
            // Render each phase
            const phaseLabels = {
                transcribe: 'Transcription',
                enhance: 'Enhancement',
                'simple-replace': 'Corrections'
            };
            
            for (const [phase, entries] of Object.entries(byPhase)) {
                if (entries.length === 0) continue;
                
                html += \`
                    <div class="enhancement-phase">
                        <div class="enhancement-phase-header">\${phaseLabels[phase] || phase}</div>
                \`;
                
                entries.forEach(entry => {
                    const timestamp = new Date(entry.timestamp).toLocaleTimeString();
                    const detailsJson = entry.details ? JSON.stringify(entry.details, null, 2) : null;
                    const isCorrectionApplied = entry.action === 'correction_applied';
                    const correctionEntryId = Number(entry.id);
                    const correctionIsRejected = isCorrectionApplied && rejectedCorrectionEntryIds.has(correctionEntryId);
                    const stepId = encodeURIComponent(String(entry.id));
                    const correctionControls = isCorrectionApplied
                        ? (correctionIsRejected
                            ? '<span class="enhancement-status-pill">Rejected</span>'
                            : '<button type="button" class="enhancement-reject-btn" data-correction-entry-id="' + escapeHtml(String(entry.id)) + '" data-default-label="Reject Correction">Reject Correction</button>')
                        : '';
                    
                    html += \`
                        <div class="enhancement-step">
                            <div class="enhancement-step-header" data-step-id="\${stepId}">
                                <span class="enhancement-step-action">\${escapeHtml(entry.action)}</span>
                                <div class="enhancement-step-controls">
                                    \${correctionControls}
                                    <span class="enhancement-step-timestamp">\${timestamp}</span>
                                </div>
                            </div>
                            \${detailsJson ? \`
                            <div class="enhancement-step-details" id="step-details-\${stepId}">
                                <pre>\${escapeHtml(detailsJson)}</pre>
                            </div>
                            \` : ''}
                        </div>
                    \`;
                });
                
                html += '</div>';
            }
            
            html += '</div>';
            container.innerHTML = html;
            bindEnhancementLogInteractions(container);
        }
        
        function toggleStepDetails(stepId) {
            const details = document.getElementById('step-details-' + stepId);
            if (details) {
                details.classList.toggle('expanded');
            }
        }

        function toggleStepDetailsFromHeader(headerElement) {
            if (!headerElement) {
                return;
            }
            const stepId = headerElement.getAttribute('data-step-id');
            if (!stepId) {
                return;
            }
            toggleStepDetails(stepId);
        }

        function setRejectCorrectionButtonState(correctionEntryId, nextLabel, disabled) {
            const safeId = Number(correctionEntryId);
            if (!Number.isInteger(safeId) || safeId < 1) {
                return;
            }
            const selector = '.enhancement-reject-btn[data-correction-entry-id="' + String(safeId) + '"]';
            const button = document.querySelector(selector);
            if (!button) {
                return;
            }
            const fallbackLabel = button.getAttribute('data-default-label') || 'Reject Correction';
            button.textContent = nextLabel || fallbackLabel;
            button.disabled = !!disabled;
        }

        function rejectCorrection(triggerElement, clickEvent) {
            if (clickEvent) {
                clickEvent.preventDefault();
                clickEvent.stopPropagation();
            }
            const rawCorrectionEntryId = triggerElement && triggerElement.getAttribute
                ? triggerElement.getAttribute('data-correction-entry-id')
                : '';
            const correctionEntryId = Number(rawCorrectionEntryId);
            if (!Number.isInteger(correctionEntryId) || correctionEntryId < 1) {
                console.error('Invalid correction entry id', rawCorrectionEntryId);
                return false;
            }
            setRejectCorrectionButtonState(correctionEntryId, 'Confirm in VS Code...', true);

            vscode.postMessage({
                command: 'requestRejectCorrection',
                transcriptPath: transcriptPath,
                correctionEntryId: correctionEntryId
            });
            return false;
        }

        function bindEnhancementLogInteractions(container) {
            if (!container) {
                return;
            }
            const headers = container.querySelectorAll('.enhancement-step-header');
            headers.forEach(header => {
                header.addEventListener('click', () => {
                    toggleStepDetailsFromHeader(header);
                });
            });

            const rejectButtons = container.querySelectorAll('.enhancement-reject-btn');
            rejectButtons.forEach(button => {
                button.addEventListener('click', (event) => {
                    rejectCorrection(button, event);
                });
            });
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'enhancementLog':
                    console.log('Received enhancement log data', message.data);
                    renderEnhancementLog(message.data);
                    break;
                case 'summarySetupReady':
                    applySummarySetup(message.summaryConfig || {});
                    switchTab('summary');
                    break;
                case 'rejectCorrectionDecision':
                    if (message.approved) {
                        setRejectCorrectionButtonState(message.correctionEntryId, 'Rejecting...', true);
                    } else {
                        setRejectCorrectionButtonState(message.correctionEntryId, '', false);
                    }
                    break;
                case 'rejectCorrectionFailed':
                    setRejectCorrectionButtonState(message.correctionEntryId, '', false);
                    break;
            }
        });
        
        function changeProject() {
            vscode.postMessage({
                command: 'changeProject',
                transcriptPath: transcriptPath
            });
        }

        function submitDateChange(newDate) {
            if (!newDate) {
                return;
            }
            vscode.postMessage({
                command: 'changeDate',
                transcriptPath: transcriptPath,
                newDate: newDate
            });
        }

        function changeDate() {
            const dateInput = document.getElementById('transcript-date-input');
            if (dateInput instanceof HTMLInputElement) {
                dateInput.showPicker?.();
                dateInput.focus();
                return;
            }
            vscode.postMessage({
                command: 'changeDate',
                transcriptPath: transcriptPath
            });
        }

        function addTag() {
            vscode.postMessage({
                command: 'addTag',
                transcriptPath: transcriptPath
            });
        }

        function removeTag(tag) {
            if (!tag) {
                console.error('removeTag called without tag');
                return;
            }
            vscode.postMessage({
                command: 'removeTag',
                transcriptPath: transcriptPath,
                tag: tag
            });
        }

        function changeStatus() {
            vscode.postMessage({
                command: 'changeStatus',
                transcriptPath: transcriptPath
            });
        }

        function addTask() {
            vscode.postMessage({
                command: 'addTask',
                transcriptPath: transcriptPath
            });
        }

        function identifyTasks() {
            vscode.postMessage({
                command: 'identifyTasks',
                transcriptPath: transcriptPath
            });
        }

        function startSummarySetup() {
            vscode.postMessage({
                command: 'startSummarySetup',
                transcriptPath: transcriptPath,
                transcriptUri: transcriptUri
            });
        }

        function generateSummary() {
            const generateBtn = document.getElementById('summary-generate-btn') || document.getElementById('summary-regenerate-btn');
            if (generateBtn) {
                generateBtn.disabled = true;
                generateBtn.dataset.originalText = generateBtn.dataset.originalText || generateBtn.textContent;
                generateBtn.textContent = 'Generating...';
            }
            vscode.postMessage({
                command: 'generateSummary',
                transcriptPath: transcriptPath,
                transcriptUri: transcriptUri
            });
        }

        function deleteSummary(summaryId, event) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            if (!summaryId) {
                return;
            }
            vscode.postMessage({
                command: 'deleteSummary',
                transcriptPath: transcriptPath,
                transcriptUri: transcriptUri,
                summaryId: summaryId
            });
        }

        function selectSummary(summaryId) {
            if (!summaryId) {
                return;
            }

            const items = document.querySelectorAll('.summary-item');
            items.forEach(item => {
                if (item.dataset.summaryId === summaryId) {
                    item.classList.add('active');
                } else {
                    item.classList.remove('active');
                }
            });

            const details = document.querySelectorAll('.summary-detail');
            details.forEach(detail => {
                if (detail.dataset.summaryDetailId === summaryId) {
                    detail.classList.remove('hidden');
                } else {
                    detail.classList.add('hidden');
                }
            });
        }

        function toggleTask(taskId) {
            vscode.postMessage({
                command: 'completeTask',
                transcriptPath: transcriptPath,
                taskId: taskId
            });
        }

        function deleteTask(taskId) {
            vscode.postMessage({
                command: 'deleteTask',
                transcriptPath: transcriptPath,
                taskId: taskId
            });
        }

        let originalTitle = ${JSON.stringify(transcript.title || transcript.filename)};
        let originalTranscriptContent = originalTranscriptText;

        function startEditTitle() {
            const display = document.getElementById('title-display');
            const actions = document.getElementById('title-actions');
            
            // Check if already editing to prevent re-creating the textarea
            if (display.classList.contains('editing')) {
                return;
            }
            
            const currentText = originalTitle;
            
            // Use textarea for multi-line support
            const textarea = document.createElement('textarea');
            textarea.id = 'title-input';
            textarea.className = 'title-input';
            textarea.value = currentText;
            
            display.innerHTML = '';
            display.appendChild(textarea);
            display.classList.add('editing');
            actions.style.display = 'inline-flex';
            
            textarea.focus();
            textarea.select();
            
            // Auto-resize textarea to fit content
            function autoResize() {
                textarea.style.height = 'auto';
                textarea.style.height = textarea.scrollHeight + 'px';
            }
            autoResize();
            textarea.addEventListener('input', autoResize);
            
            textarea.addEventListener('keydown', (e) => {
                // Save on Ctrl+Enter or Cmd+Enter
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    saveTitle();
                } else if (e.key === 'Escape') {
                    cancelEditTitle();
                }
            });
        }

        function saveTitle() {
            const input = document.getElementById('title-input');
            const newTitle = input.value.trim();
            
            if (newTitle && newTitle !== originalTitle) {
                vscode.postMessage({
                    command: 'editTitle',
                    transcriptPath: transcriptPath,
                    newTitle: newTitle
                });
            } else {
                cancelEditTitle();
            }
        }

        function cancelEditTitle() {
            const display = document.getElementById('title-display');
            const actions = document.getElementById('title-actions');
            
            display.textContent = originalTitle;
            display.classList.remove('editing');
            actions.style.display = 'none';
        }

        function editInEditor(target) {
            const editTarget = target || (activeTabName === 'raw' ? 'original' : 'enhanced');
            if (editTarget === 'enhanced' && !confirmDiscardOriginalChanges()) {
                return;
            }
            vscode.postMessage({
                command: 'editInEditor',
                transcriptPath: transcriptPath,
                transcriptUri: transcriptUri,
                editTarget: editTarget
            });
        }

        function openEntity(entityType, entityId) {
            vscode.postMessage({
                command: 'openEntity',
                entityType: entityType,
                entityId: entityId
            });
        }

        function startChatFromInput() {
            console.log('Protokoll: startChatFromInput called');
            const input = document.getElementById('inline-chat-input');
            if (!input) {
                console.error('Protokoll: inline-chat-input not found');
                return;
            }
            const message = input.value.trim();
            if (!message) {
                console.log('Protokoll: No message to send');
                return;
            }
            
            console.log('Protokoll: Sending message:', message);
            
            // Clear input
            input.value = '';
            adjustTextareaHeight(input);
            
            // Send message to extension to start a new chat
            vscode.postMessage({
                command: 'startChatFromInput',
                message: message,
                transcriptPath: transcriptPath,
                transcriptUri: transcriptUri
            });
            console.log('Protokoll: Message sent to extension');
        }
        
        function adjustTextareaHeight(textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
        }
        
        // Set up inline chat event listeners
        function setupInlineChatListeners() {
            console.log('Protokoll: Setting up inline chat listeners');
            const chatInput = document.getElementById('inline-chat-input');
            const chatSendBtn = document.getElementById('inline-chat-send');
            
            console.log('Protokoll: chatInput found:', !!chatInput);
            console.log('Protokoll: chatSendBtn found:', !!chatSendBtn);
            
            if (chatInput) {
                chatInput.addEventListener('input', function() {
                    adjustTextareaHeight(this);
                });
                
                chatInput.addEventListener('keydown', function(e) {
                    console.log('Protokoll: keydown event, key:', e.key);
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log('Protokoll: Enter pressed, calling startChatFromInput');
                        startChatFromInput();
                    }
                });
                console.log('Protokoll: chatInput listeners attached');
            } else {
                console.error('Protokoll: inline-chat-input element not found!');
            }
            
            if (chatSendBtn) {
                chatSendBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log('Protokoll: Send button clicked');
                    startChatFromInput();
                });
                console.log('Protokoll: chatSendBtn listener attached');
            } else {
                console.error('Protokoll: inline-chat-send element not found!');
            }
        }
        
        // Run setup immediately (script is at end of body, DOM should be ready)
        setupInlineChatListeners();
        
        // Also run on DOMContentLoaded as backup
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setupInlineChatListeners);
        }

        function openSource() {
            if (!confirmDiscardOriginalChanges()) {
                return;
            }
            vscode.postMessage({
                command: 'openSource',
                transcriptPath: transcriptPath,
                transcriptUri: transcriptUri
            });
        }

        let selectedText = '';
        let selectionRange = null;

        function createEntityFromSelection() {
            if (!selectedText || selectedText.trim().length === 0) {
                return;
            }
            vscode.postMessage({
                command: 'createEntityFromSelection',
                selectedText: selectedText.trim(),
                transcriptPath: transcriptPath,
                transcriptUri: transcriptUri
            });
            // Hide the button after clicking
            const btn = document.getElementById('create-entity-btn');
            if (btn) {
                btn.classList.remove('show');
            }
            selectedText = '';
            selectionRange = null;
        }

        // Handle text selection in transcript content
        const transcriptContent = document.getElementById('transcript-content-display');
        const createEntityBtn = document.getElementById('create-entity-btn');
        const wrapper = transcriptContent ? transcriptContent.closest('.transcript-content-wrapper') : null;

        if (transcriptContent && createEntityBtn && wrapper) {
            transcriptContent.addEventListener('mouseup', () => {
                const selection = window.getSelection();
                if (selection && selection.toString().trim().length > 0) {
                    selectedText = selection.toString().trim();
                    const range = selection.getRangeAt(0);
                    const rect = range.getBoundingClientRect();
                    const wrapperRect = wrapper.getBoundingClientRect();
                    
                    // Position button relative to the wrapper
                    const relativeTop = rect.bottom - wrapperRect.top + wrapper.scrollTop + 5;
                    const relativeLeft = rect.left - wrapperRect.left + wrapper.scrollLeft;
                    
                    createEntityBtn.style.top = relativeTop + 'px';
                    createEntityBtn.style.left = relativeLeft + 'px';
                    createEntityBtn.classList.add('show');
                    selectionRange = range;
                } else {
                    createEntityBtn.classList.remove('show');
                    selectedText = '';
                    selectionRange = null;
                }
            });

            // Hide button when clicking elsewhere
            document.addEventListener('mousedown', (e) => {
                if (!transcriptContent.contains(e.target) && !createEntityBtn.contains(e.target)) {
                    createEntityBtn.classList.remove('show');
                    selectedText = '';
                    selectionRange = null;
                }
            });

            // Hide button on scroll
            wrapper.addEventListener('scroll', () => {
                createEntityBtn.classList.remove('show');
            });
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'showUpdateIndicator') {
                const indicator = document.getElementById('update-indicator');
                if (indicator) {
                    if (message.show) {
                        indicator.classList.add('show');
                    } else {
                        indicator.classList.remove('show');
                    }
                }
            } else if (message.command === 'summaryGenerationFailed') {
                const generateBtn = document.getElementById('summary-generate-btn') || document.getElementById('summary-regenerate-btn');
                if (generateBtn) {
                    generateBtn.disabled = false;
                    generateBtn.textContent = generateBtn.dataset.originalText || 'Generate Summary';
                }
            } else if (message.command === 'saveFailed') {
                const saveBtn = document.getElementById('save-original-btn');
                if (saveBtn) {
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save Original';
                    setOriginalSaveStatus('Save failed', 'dirty');
                }
            } else if (message.command === 'saveSucceeded') {
                const saveBtn = document.getElementById('save-original-btn');
                const editor = document.getElementById('original-editor-input');
                if (saveBtn && editor) {
                    lastSavedOriginal = editor.value;
                    hasUnsavedOriginalChanges = false;
                    saveBtn.disabled = true;
                    saveBtn.textContent = 'Save Original';
                    setOriginalSaveStatus('Saved', 'saved');
                }
            } else if (message.command === 'enhanceStarted') {
                setEnhancementTabInProgress(true);
            } else if (message.command === 'enhanceCompleted') {
                const enhanceBtn = document.getElementById('enhance-original-btn');
                if (enhanceBtn) {
                    enhanceBtn.disabled = false;
                    enhanceBtn.textContent = 'Enhance';
                }
                setEnhancementTabInProgress(false);
            } else if (message.command === 'enhanceFailed') {
                const enhanceBtn = document.getElementById('enhance-original-btn');
                if (enhanceBtn) {
                    enhanceBtn.disabled = false;
                    enhanceBtn.textContent = 'Enhance';
                }
                setEnhancementTabInProgress(false);
            } else if (message.command === 'enhanceDeferred') {
                const enhanceBtn = document.getElementById('enhance-original-btn');
                if (enhanceBtn) {
                    enhanceBtn.disabled = false;
                    enhanceBtn.textContent = 'Enhance';
                }
                setEnhancementTabInProgress(true);
            } else if (message.command === 'enhanceCancelled') {
                const enhanceBtn = document.getElementById('enhance-original-btn');
                if (enhanceBtn) {
                    enhanceBtn.disabled = false;
                    enhanceBtn.textContent = 'Enhance';
                }
                setEnhancementTabInProgress(false);
            } else if (message.command === 'entityReferencePicked') {
                addPickedEntityReference(message.section, message.entity);
            } else if (message.command === 'entityReferencesSaved') {
                isSavingEntityReferences = false;
                if (message.success) {
                    isEditingEntityReferences = false;
                    showEntityReferenceStatus('Entity references saved.', 'success');
                } else {
                    showEntityReferenceStatus(message.message || 'Failed to save entity references.', 'error');
                }
                renderEntityReferencesContent();
            } else if (message.command === 'commentsUpdated') {
                commentsState = normalizeComments(message.comments || []);
                editingCommentId = '';
                const input = document.getElementById('new-comment-input');
                const addBtn = document.getElementById('add-comment-btn');
                if (input) {
                    input.value = '';
                }
                if (addBtn) {
                    addBtn.disabled = false;
                    addBtn.textContent = 'Add Comment';
                }
                showCommentsStatus(message.statusMessage || 'Comment saved.', 'success');
                renderCommentsList();
            } else if (message.command === 'commentOperationFailed') {
                const addBtn = document.getElementById('add-comment-btn');
                if (addBtn) {
                    addBtn.disabled = false;
                    addBtn.textContent = 'Add Comment';
                }
                showCommentsStatus(message.message || 'Unable to update comments.', 'error');
            }
        });

        // Set up refresh button listener
        function setupRefreshButton() {
            const refreshButton = document.getElementById('refresh-button');
            if (refreshButton) {
                refreshButton.addEventListener('click', function() {
                    console.log('Protokoll Transcript: Refresh button clicked');
                    refreshButton.disabled = true;
                    vscode.postMessage({
                        command: 'refreshTranscript'
                    });
                });
            }
        }

        // Auto-focus the chat input when the view loads
        window.addEventListener('beforeunload', (event) => {
            if (isManualNote && hasUnsavedOriginalChanges) {
                event.preventDefault();
                event.returnValue = '';
            }
        });

        document.addEventListener('DOMContentLoaded', () => {
            setupRefreshButton();
            setupOriginalEditor();
            setupCommentsEventHandlers();
            renderCommentsList();
            restoreActiveTabPreference();
            if (isManualNote && activeTabName === 'raw') {
                const editor = document.getElementById('original-editor-input');
                if (editor) {
                    setTimeout(() => editor.focus(), 0);
                }
            }
            // Don't auto-focus on chat input - let users press 'C' to focus
        });
        
        // Handle refresh completion message from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'refreshComplete') {
                const refreshButton = document.getElementById('refresh-button');
                if (refreshButton) {
                    refreshButton.disabled = false;
                }
            }
        });

        // Function to focus on chat input
        function focusChat() {
            const chatInput = document.getElementById('inline-chat-input');
            if (chatInput) {
                chatInput.focus();
            }
        }

        // Global keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Only trigger if not in an input, textarea, or contenteditable element
            const target = e.target;
            if (target.tagName === 'INPUT' || 
                target.tagName === 'TEXTAREA' || 
                target.isContentEditable) {
                return;
            }

            // Check for keyboard shortcuts (case-insensitive)
            const key = e.key.toLowerCase();
            
            switch(key) {
                case 'c':
                    e.preventDefault();
                    focusChat();
                    break;
                case 'p':
                    e.preventDefault();
                    changeProject();
                    break;
                case 't':
                    e.preventDefault();
                    startEditTitle();
                    break;
                case 'g':
                    e.preventDefault();
                    addTag();
                    break;
                case 'k':
                    e.preventDefault();
                    addTask();
                    break;
                case 'e':
                    e.preventDefault();
                    editInEditor();
                    break;
                case 's':
                    e.preventDefault();
                    openSource();
                    break;
            }
        });
    </script>
</body>
</html>`;
  }

  public getErrorContent(errorMessage: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Error</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
        }
        .error {
            color: var(--vscode-errorForeground);
            padding: 16px;
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <div class="error">
        <h2>Error Loading Transcript</h2>
        <p>${this.escapeHtml(errorMessage)}</p>
    </div>
</body>
</html>`;
  }

  private escapeHtml(text: string): string {
    // Escape HTML special characters
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }


  private removeRedundantSections(text: string): string {
    // Sections to remove (these are shown in the metadata panel instead)
    const sectionsToRemove = [
      '## Metadata',
      '### Routing',
      '## Entity References',
    ];
    
    // If text is empty or very short, return as-is
    if (!text || text.trim().length === 0) {
      return text;
    }
    
    // Split text into lines for processing
    const lines = text.split('\n');
    const result: string[] = [];
    let inSectionToRemove = false;
    let currentSectionLevel = 0;
    let hasContentBeforeFirstHeading = false;
    let firstHeadingIndex = -1;
    
    // Find the first heading to check if there's content before it
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(/^#{1,6}\s+/)) {
        firstHeadingIndex = i;
        break;
      }
      if (line.trim().length > 0) {
        hasContentBeforeFirstHeading = true;
      }
    }
    
    // If there's content before the first heading, keep it
    if (hasContentBeforeFirstHeading && firstHeadingIndex > 0) {
      for (let i = 0; i < firstHeadingIndex; i++) {
        result.push(lines[i]);
      }
    }
    
    // Process the rest of the lines
    const startIndex = hasContentBeforeFirstHeading && firstHeadingIndex > 0 ? firstHeadingIndex : 0;
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      
      // Check if this is a heading (H1-H6)
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      
      if (headingMatch) {
        const level = headingMatch[1].length;
        const title = headingMatch[2].trim();
        
        // Check if we're entering a section to remove
        const shouldRemove = sectionsToRemove.some(section => {
          const sectionTitle = section.replace(/^#+\s+/, '').trim();
          return title === sectionTitle;
        });
        
        if (shouldRemove) {
          // Entering a section to remove
          inSectionToRemove = true;
          currentSectionLevel = level;
          continue; // Skip this heading line
        } else {
          // This is a section we want to keep
          // If we were in a section to remove, check if this heading exits it
          if (inSectionToRemove) {
            // A heading at same or higher level exits the current section
            if (level <= currentSectionLevel) {
              inSectionToRemove = false;
              result.push(line);
            } else {
              // Lower level heading - still in section to remove, skip it
              continue;
            }
          } else {
            // Not in a section to remove, keep this heading
            result.push(line);
          }
        }
      } else if (inSectionToRemove) {
        // We're in a section to remove, skip this line
        continue;
      } else {
        // Keep this line (it's not in a section to remove)
        result.push(line);
      }
    }
    
    // Join and clean up multiple consecutive newlines
    let cleaned = result.join('\n');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    
    const finalResult = cleaned.trim();
    
    // Debug: Log if all content was removed
    if (finalResult.length === 0 && text.trim().length > 0) {
      console.warn('Protokoll: All content was removed by removeRedundantSections. Original length:', text.length);
    }
    
    return finalResult;
  }

  private removeRedundantTitle(text: string, title: string): string {
    // Remove the first H1 heading if it matches the title (case-insensitive, trimmed)
    const titleNormalized = title.trim().toLowerCase();
    
    // Match H1 at the start of the text
    const h1Match = text.match(/^#\s+(.+?)(?:\n|$)/);
    if (h1Match) {
      const h1Title = h1Match[1].trim().toLowerCase();
      if (h1Title === titleNormalized) {
        // Remove the H1 line
        text = text.replace(/^#\s+.+?(?:\n|$)/, '').trim();
      }
    }
    
    return text;
  }

  private parseMetadata(text: string): {
    date?: string;
    time?: string;
    project?: string;
    projectId?: string;
    createdAt?: string;
    updatedAt?: string;
    status?: string;
    tasks?: Array<{ id: string; description: string; status: string; created: string; completed?: string }>;
    entities?: {
      people?: Array<{ id: string; name: string }>;
      projects?: Array<{ id: string; name: string }>;
      terms?: Array<{ id: string; name: string }>;
      companies?: Array<{ id: string; name: string }>;
    };
  } {
    const metadata: {
      date?: string;
      time?: string;
      project?: string;
      projectId?: string;
      createdAt?: string;
      updatedAt?: string;
      status?: string;
      tasks?: Array<{ id: string; description: string; status: string; created: string; completed?: string }>;
      entities?: {
        people?: Array<{ id: string; name: string }>;
        projects?: Array<{ id: string; name: string }>;
        terms?: Array<{ id: string; name: string }>;
        companies?: Array<{ id: string; name: string }>;
      };
    } = {};

    // Try to parse YAML frontmatter first for status, tasks, and entities
    const frontmatterMatch = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      
      // Parse status from frontmatter
      const statusMatch = frontmatter.match(/^status:\s*(\w+)/m);
      if (statusMatch) {
        metadata.status = statusMatch[1].trim();
      }
      
      // Parse tasks array from frontmatter (simple YAML parsing)
      // Match all indented lines under tasks: until we hit a non-indented line
      const tasksMatch = frontmatter.match(/^tasks:\s*\n((?:[ \t]+.*\n?)*)/m);
      if (tasksMatch) {
        const tasksYaml = tasksMatch[1];
        const tasks: Array<{ id: string; description: string; status: string; created: string; completed?: string }> = [];
        
        // Match each task block (lines starting with "  - id:" and their indented properties)
        const taskBlocks = tasksYaml.match(/\s+-\s+id:[^\n]*(?:\n\s{4,}[^\n]*)*\n?/g);
        if (taskBlocks) {
          for (const block of taskBlocks) {
            if (!block.trim()) {
              continue;
            }
            
            const idMatch = block.match(/id:\s*(\S+)/);
            const descMatch = block.match(/description:\s*(.+?)(?:\n|$)/);
            const statusMatch2 = block.match(/status:\s*(\w+)/);
            const createdMatch = block.match(/created:\s*["']?([^"'\n]+)["']?/);
            const completedMatch = block.match(/completed:\s*["']?([^"'\n]+)["']?/);
            
            if (idMatch && descMatch && statusMatch2 && createdMatch) {
              tasks.push({
                id: idMatch[1].trim(),
                description: descMatch[1].trim().replace(/^["']|["']$/g, ''),
                status: statusMatch2[1].trim(),
                created: createdMatch[1].trim(),
                completed: completedMatch ? completedMatch[1].trim() : undefined,
              });
            }
          }
        }
        
        if (tasks.length > 0) {
          metadata.tasks = tasks;
        }
      }
      
      // Parse entities from frontmatter (projects, people, terms, companies)
      const entitiesMatch = frontmatter.match(/^entities:\s*\n((?:\s+\w+:[\s\S]*?(?=\n\w|\n---|\s*$))+)/m);
      if (entitiesMatch) {
        const entitiesYaml = entitiesMatch[1];
        metadata.entities = {};
        
        // Parse projects
        const projectsMatch = entitiesYaml.match(/projects:\s*\n((?:\s+-[\s\S]*?(?=\n\s+\w+:|\s*$))+)/);
        if (projectsMatch) {
          const projectsYaml = projectsMatch[1];
          const projects: Array<{ id: string; name: string }> = [];
          const projectBlocks = projectsYaml.split(/\n\s+-\s+id:/);
          for (const block of projectBlocks) {
            if (!block.trim()) {
              continue;
            }
            const projectText = block.startsWith('id:') ? block : 'id:' + block;
            const idMatch = projectText.match(/id:\s*(\S+)/);
            const nameMatch = projectText.match(/name:\s*(.+?)(?:\n|$)/);
            if (idMatch && nameMatch) {
              projects.push({
                id: idMatch[1].trim(),
                name: nameMatch[1].trim().replace(/^["']|["']$/g, ''),
              });
            }
          }
          if (projects.length > 0) {
            metadata.entities.projects = projects;
          }
        }
        
        // Parse people
        const peopleMatch = entitiesYaml.match(/people:\s*\n((?:\s+-[\s\S]*?(?=\n\s+\w+:|\s*$))+)/);
        if (peopleMatch) {
          const peopleYaml = peopleMatch[1];
          const people: Array<{ id: string; name: string }> = [];
          const peopleBlocks = peopleYaml.split(/\n\s+-\s+id:/);
          for (const block of peopleBlocks) {
            if (!block.trim()) {
              continue;
            }
            const personText = block.startsWith('id:') ? block : 'id:' + block;
            const idMatch = personText.match(/id:\s*(\S+)/);
            const nameMatch = personText.match(/name:\s*(.+?)(?:\n|$)/);
            if (idMatch && nameMatch) {
              people.push({
                id: idMatch[1].trim(),
                name: nameMatch[1].trim().replace(/^["']|["']$/g, ''),
              });
            }
          }
          if (people.length > 0) {
            metadata.entities.people = people;
          }
        }
        
        // Parse terms
        const termsMatch = entitiesYaml.match(/terms:\s*\n((?:\s+-[\s\S]*?(?=\n\s+\w+:|\s*$))+)/);
        if (termsMatch) {
          const termsYaml = termsMatch[1];
          const terms: Array<{ id: string; name: string }> = [];
          const termsBlocks = termsYaml.split(/\n\s+-\s+id:/);
          for (const block of termsBlocks) {
            if (!block.trim()) {
              continue;
            }
            const termText = block.startsWith('id:') ? block : 'id:' + block;
            const idMatch = termText.match(/id:\s*(\S+)/);
            const nameMatch = termText.match(/name:\s*(.+?)(?:\n|$)/);
            if (idMatch && nameMatch) {
              terms.push({
                id: idMatch[1].trim(),
                name: nameMatch[1].trim().replace(/^["']|["']$/g, ''),
              });
            }
          }
          if (terms.length > 0) {
            metadata.entities.terms = terms;
          }
        }
        
        // Parse companies
        const companiesMatch = entitiesYaml.match(/companies:\s*\n((?:\s+-[\s\S]*?(?=\n\s+\w+:|\s*$))+)/);
        if (companiesMatch) {
          const companiesYaml = companiesMatch[1];
          const companies: Array<{ id: string; name: string }> = [];
          const companiesBlocks = companiesYaml.split(/\n\s+-\s+id:/);
          for (const block of companiesBlocks) {
            if (!block.trim()) {
              continue;
            }
            const companyText = block.startsWith('id:') ? block : 'id:' + block;
            const idMatch = companyText.match(/id:\s*(\S+)/);
            const nameMatch = companyText.match(/name:\s*(.+?)(?:\n|$)/);
            if (idMatch && nameMatch) {
              companies.push({
                id: idMatch[1].trim(),
                name: nameMatch[1].trim().replace(/^["']|["']$/g, ''),
              });
            }
          }
          if (companies.length > 0) {
            metadata.entities.companies = companies;
          }
        }
      }
    }

    // Try to find metadata in the Metadata section
    const metadataSection = text.match(/## Metadata\s*\n([\s\S]*?)(?:\n##|$)/);
    if (metadataSection) {
      const sectionContent = metadataSection[1];
      
      // Parse Date: **Date**: January 31, 2026
      const dateMatch = sectionContent.match(/\*\*Date\*\*:\s*(.+?)(?:\n|$)/);
      if (dateMatch) {
        metadata.date = dateMatch[1].trim();
      }
      
      // Parse Time: **Time**: 08:32 PM
      const timeMatch = sectionContent.match(/\*\*Time\*\*:\s*(.+?)(?:\n|$)/);
      if (timeMatch) {
        metadata.time = timeMatch[1].trim();
      }
      
      // Parse Project: **Project**: Redaksjon
      const projectMatch = sectionContent.match(/\*\*Project\*\*:\s*(.+?)(?:\n|$)/);
      if (projectMatch) {
        metadata.project = projectMatch[1].trim();
      }
      
      // Parse Project ID: **Project ID**: `redaksjon`
      const projectIdMatch = sectionContent.match(/\*\*Project ID\*\*:\s*`([^`]+)`/);
      if (projectIdMatch) {
        metadata.projectId = projectIdMatch[1].trim();
      }
      
      // Parse Created At: **Created At**: 2026-01-31T20:32:00Z
      const createdAtMatch = sectionContent.match(/\*\*Created At\*\*:\s*(.+?)(?:\n|$)/);
      if (createdAtMatch) {
        metadata.createdAt = createdAtMatch[1].trim();
      }
      
      // Parse Updated At: **Updated At**: 2026-01-31T20:32:00Z
      const updatedAtMatch = sectionContent.match(/\*\*Updated At\*\*:\s*(.+?)(?:\n|$)/);
      if (updatedAtMatch) {
        metadata.updatedAt = updatedAtMatch[1].trim();
      }
    }

    return metadata;
  }

  private getStatusIcon(status: string): string {
    const icons: Record<string, string> = {
      initial: '📝',
      enhanced: '✨',
      reviewed: '👀',
      'in_progress': '🔄',
      closed: '✅',
      archived: '📦',
      deleted: '🗑️',
    };
    return icons[status] || '❓';
  }

  private getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      initial: 'Initial',
      enhanced: 'Enhanced',
      reviewed: 'Reviewed',
      'in_progress': 'In Progress',
      closed: 'Closed',
      archived: 'Archived',
      deleted: 'Deleted',
    };
    return labels[status] || status;
  }

  private parseRouting(text: string): {
    destination?: string;
    confidence?: number;
    reasoning?: string;
  } | null {
    // Try to find routing in the Routing section
    const routingSection = text.match(/### Routing\s*\n([\s\S]*?)(?:\n###|\n##|$)/);
    if (!routingSection) {
      return null;
    }

    const sectionContent = routingSection[1];
    const routing: {
      destination?: string;
      confidence?: number;
      reasoning?: string;
    } = {};

    // Parse Destination: **Destination**: ./notes
    const destinationMatch = sectionContent.match(/\*\*Destination\*\*:\s*(.+?)(?:\n|$)/);
    if (destinationMatch) {
      routing.destination = destinationMatch[1].trim();
    }

    // Parse Confidence: **Confidence**: 30.0%
    const confidenceMatch = sectionContent.match(/\*\*Confidence\*\*:\s*([\d.]+)%/);
    if (confidenceMatch) {
      routing.confidence = parseFloat(confidenceMatch[1]);
    }

    // Parse Reasoning: **Reasoning**: topic: transcription, topic: MCP, ...
    const reasoningMatch = sectionContent.match(/\*\*Reasoning\*\*:\s*(.+?)(?:\n|$)/);
    if (reasoningMatch) {
      routing.reasoning = reasoningMatch[1].trim();
    }

    return Object.keys(routing).length > 0 ? routing : null;
  }

  private parseTags(text: string): string[] {
    const tags: string[] = [];

    // Look for Tags line anywhere in the text: **Tags**: `tag1`, `tag2`, etc.
    // The tags line appears in the Metadata section, possibly in the Routing subsection
    // Match until we hit --- separator, next ## section, or end of string
    const tagsMatch = text.match(/\*\*Tags\*\*:\s*([\s\S]*?)(?:\n\s*---|\n##|$)/);
    if (tagsMatch) {
      const tagsLine = tagsMatch[1].trim();
      // Extract tags from backticks - match all `tag` patterns
      const tagMatches = tagsLine.match(/`([^`]+)`/g);
      if (tagMatches) {
        tags.push(...tagMatches.map(t => t.replace(/`/g, '').trim()).filter(t => t.length > 0));
      }
    }

    return tags;
  }

  private parseEntityReferences(text: string): {
    projects?: Array<{ id: string; name: string }>;
    people?: Array<{ id: string; name: string }>;
    terms?: Array<{ id: string; name: string }>;
    companies?: Array<{ id: string; name: string }>;
  } {
    const entities: {
      projects?: Array<{ id: string; name: string }>;
      people?: Array<{ id: string; name: string }>;
      terms?: Array<{ id: string; name: string }>;
      companies?: Array<{ id: string; name: string }>;
    } = {};

    // Find the Entity References section
    const entitySection = text.match(/## Entity References\s*\n([\s\S]*?)(?:\n##|$)/);
    if (!entitySection) {
      return entities;
    }

    const sectionContent = entitySection[1];

    // Parse Projects
    const projectsMatch = sectionContent.match(/### Projects\s*\n([\s\S]*?)(?:\n###|\n##|$)/);
    if (projectsMatch) {
      const projectsContent = projectsMatch[1];
      const projectLines = projectsContent.match(/^-\s*`([^`]+)`:\s*(.+)$/gm);
      if (projectLines) {
        entities.projects = projectLines.map(line => {
          const match = line.match(/^-\s*`([^`]+)`:\s*(.+)$/);
          if (match) {
            return { id: match[1], name: match[2].trim() };
          }
          return null;
        }).filter((p): p is { id: string; name: string } => p !== null);
      }
    }

    // Parse People
    const peopleMatch = sectionContent.match(/### People\s*\n([\s\S]*?)(?:\n###|\n##|$)/);
    if (peopleMatch) {
      const peopleContent = peopleMatch[1];
      const peopleLines = peopleContent.match(/^-\s*`([^`]+)`:\s*(.+)$/gm);
      if (peopleLines) {
        entities.people = peopleLines.map(line => {
          const match = line.match(/^-\s*`([^`]+)`:\s*(.+)$/);
          if (match) {
            return { id: match[1], name: match[2].trim() };
          }
          return null;
        }).filter((p): p is { id: string; name: string } => p !== null);
      }
    }

    // Parse Terms
    const termsMatch = sectionContent.match(/### Terms\s*\n([\s\S]*?)(?:\n###|\n##|$)/);
    if (termsMatch) {
      const termsContent = termsMatch[1];
      const termsLines = termsContent.match(/^-\s*`([^`]+)`:\s*(.+)$/gm);
      if (termsLines) {
        entities.terms = termsLines.map(line => {
          const match = line.match(/^-\s*`([^`]+)`:\s*(.+)$/);
          if (match) {
            return { id: match[1], name: match[2].trim() };
          }
          return null;
        }).filter((t): t is { id: string; name: string } => t !== null);
      }
    }

    // Parse Companies
    const companiesMatch = sectionContent.match(/### Companies\s*\n([\s\S]*?)(?:\n###|\n##|$)/);
    if (companiesMatch) {
      const companiesContent = companiesMatch[1];
      const companiesLines = companiesContent.match(/^-\s*`([^`]+)`:\s*(.+)$/gm);
      if (companiesLines) {
        entities.companies = companiesLines.map(line => {
          const match = line.match(/^-\s*`([^`]+)`:\s*(.+)$/);
          if (match) {
            return { id: match[1], name: match[2].trim() };
          }
          return null;
        }).filter((c): c is { id: string; name: string } => c !== null);
      }
    }

    return entities;
  }

  private renderEntityReferences(entities: {
    projects?: Array<{ id: string; name: string }>;
    people?: Array<{ id: string; name: string }>;
    terms?: Array<{ id: string; name: string }>;
    companies?: Array<{ id: string; name: string }>;
  }): string {
    const sectionDefs = [
      { key: 'projects', title: 'Projects', type: 'project', label: 'Project' },
      { key: 'people', title: 'People', type: 'person', label: 'Person' },
      { key: 'terms', title: 'Terms', type: 'term', label: 'Term' },
      { key: 'companies', title: 'Companies', type: 'company', label: 'Company' },
    ] as const;

    const sections: string[] = [];
    for (const section of sectionDefs) {
      const items = entities[section.key] ?? [];
      if (!items.length) {
        continue;
      }
      sections.push(`
        <div class="entity-section">
          <h3>${section.title}</h3>
          <div class="entity-list">
            ${items.map(item => `
              <a href="#" class="entity-item" onclick="openEntity('${section.type}', '${this.escapeHtml(item.id)}'); return false;">
                <span class="entity-type-label">${section.label}:</span> ${this.escapeHtml(item.name)}
              </a>
            `).join('')}
          </div>
        </div>
      `);
    }

    const initialContent = sections.length > 0
      ? sections.join('')
      : '<div class="entity-empty">No entity references yet.</div>';

    return `
      <div class="entity-references" id="entity-references">
        <div class="entity-references-header">
          <h3>Entity References</h3>
          <div class="entity-references-actions">
            <button class="button button-secondary" id="entity-references-edit-btn" onclick="startEditEntityReferences()">Edit</button>
            <button class="button" id="entity-references-save-btn" style="display:none;" onclick="saveEntityReferences()">Save</button>
          </div>
        </div>
        <div id="entity-references-status" class="entity-references-status" style="display:none;"></div>
        <div id="entity-references-content">${initialContent}</div>
      </div>
    `;
  }

  private markdownToHtml(markdown: string): string {
    // Simple markdown to HTML converter
    let html = this.escapeHtml(markdown);
    
    // Code blocks (do this first before other processing)
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    
    // Split into lines for processing
    const lines = html.split('\n');
    const processedLines: string[] = [];
    let inList = false;
    let listType: 'ul' | 'ol' | null = null;
    let listItems: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Headers
      if (line.match(/^###\s+(.+)$/)) {
        if (inList) {
          processedLines.push(`<${listType}>${listItems.join('')}</${listType}>`);
          listItems = [];
          inList = false;
          listType = null;
        }
        processedLines.push(`<h3>${line.replace(/^###\s+/, '')}</h3>`);
        continue;
      }
      if (line.match(/^##\s+(.+)$/)) {
        if (inList) {
          processedLines.push(`<${listType}>${listItems.join('')}</${listType}>`);
          listItems = [];
          inList = false;
          listType = null;
        }
        processedLines.push(`<h2>${line.replace(/^##\s+/, '')}</h2>`);
        continue;
      }
      if (line.match(/^#\s+(.+)$/)) {
        if (inList) {
          processedLines.push(`<${listType}>${listItems.join('')}</${listType}>`);
          listItems = [];
          inList = false;
          listType = null;
        }
        processedLines.push(`<h1>${line.replace(/^#\s+/, '')}</h1>`);
        continue;
      }
      
      // Unordered lists
      const ulMatch = line.match(/^[*\-+]\s+(.+)$/);
      if (ulMatch) {
        if (inList && listType !== 'ul') {
          processedLines.push(`<${listType}>${listItems.join('')}</${listType}>`);
          listItems = [];
        }
        inList = true;
        listType = 'ul';
        listItems.push(`<li>${ulMatch[1]}</li>`);
        continue;
      }
      
      // Ordered lists
      const olMatch = line.match(/^\d+\.\s+(.+)$/);
      if (olMatch) {
        if (inList && listType !== 'ol') {
          processedLines.push(`<${listType}>${listItems.join('')}</${listType}>`);
          listItems = [];
        }
        inList = true;
        listType = 'ol';
        listItems.push(`<li>${olMatch[1]}</li>`);
        continue;
      }
      
      // Empty line or regular content
      if (inList) {
        processedLines.push(`<${listType}>${listItems.join('')}</${listType}>`);
        listItems = [];
        inList = false;
        listType = null;
      }
      
      if (line) {
        processedLines.push(line);
      } else {
        processedLines.push('');
      }
    }
    
    // Close any open list
    if (inList && listType) {
      processedLines.push(`<${listType}>${listItems.join('')}</${listType}>`);
    }
    
    html = processedLines.join('\n');
    
    // Bold
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    // Italic (but not if it's part of bold)
    html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
    
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    
    // Convert double newlines to paragraph breaks, single newlines to spaces
    // Split by double newlines to get paragraphs
    const paragraphs = html.split(/\n\n+/);
    html = paragraphs.map(p => {
      const trimmed = p.trim();
      if (!trimmed) {
        return '';
      }
      // If it's already a block element, don't wrap in p
      if (/^<(h[1-6]|ul|ol|pre|code)/.test(trimmed)) {
        return trimmed;
      }
      // Replace single newlines with spaces and wrap in paragraph
      return '<p>' + trimmed.replace(/\n/g, ' ') + '</p>';
    }).filter(p => p).join('\n');
    
    return html;
  }
}
