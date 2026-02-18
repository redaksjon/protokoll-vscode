/**
 * Transcript Detail View Provider
 * Shows transcript metadata and text in a webview
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { McpClient } from './mcpClient';
import { ChatViewProvider } from './chatView';
import type { Transcript, TranscriptContent } from './types';
import { shouldPassContextDirectory } from './serverMode';

/**
 * Track temp files opened for editing, mapping file path -> transcript info
 * Used by extension.ts to sync saves back to MCP
 */
export interface EditableTranscriptInfo {
  transcriptPath: string;
  transcriptUri: string;
  originalContent: string;
  /** The header/metadata section (everything before and including the --- separator) */
  header: string;
  /** The original body content (for change detection) */
  originalBody: string;
}

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

  private _panels: Map<string, vscode.WebviewPanel> = new Map();
  private _entityPanels: Map<string, vscode.WebviewPanel> = new Map(); // Track entity panels
  private _client: McpClient | null = null;
  private getDefaultContextDirectory(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }
  private _chatProvider: ChatViewProvider | null = null;
  private _currentTranscripts: Map<string, { uri: string; transcript: Transcript }> = new Map();
  private _updatingTranscripts: Set<string> = new Set(); // Track transcripts being updated
  private _entityLastFetched: Map<string, Date> = new Map(); // Track when entities were last fetched
  private _transcriptLastFetched: Map<string, Date> = new Map(); // Track when transcripts were last fetched

  constructor(private readonly _extensionUri: vscode.Uri) {}

  setChatProvider(chatProvider: ChatViewProvider): void {
    this._chatProvider = chatProvider;
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
              panel.title = matchingTranscript.title || matchingTranscript.filename;
              
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
        panel.title = transcript.title || transcript.filename;
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
      transcript.title || transcript.filename,
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

        const currentTranscript = this._currentTranscripts.get(transcriptUri);
        if (!currentTranscript) {
          return;
        }

        switch (message.command) {
          case 'changeProject':
            // Defer to next tick so QuickPick can receive focus (webview focus workaround)
            setTimeout(() => {
              this.handleChangeProject(currentTranscript.transcript, transcriptUri);
            }, 0);
            break;
          case 'changeDate':
            await this.handleChangeDate(currentTranscript.transcript, message.transcriptPath, transcriptUri);
            break;
          case 'addTag':
            await this.handleAddTag(currentTranscript.transcript, message.transcriptPath, transcriptUri);
            break;
          case 'removeTag':
            await this.handleRemoveTag(currentTranscript.transcript, message.transcriptPath, message.tag, transcriptUri);
            break;
          case 'editTitle':
            await this.handleEditTitle(currentTranscript.transcript, message.transcriptPath, message.newTitle, transcriptUri);
            break;
          case 'editTranscript':
            await this.handleEditTranscript(currentTranscript.transcript, message.transcriptPath, message.newContent, transcriptUri);
            break;
          case 'openEntity':
            await this.handleOpenEntity(message.entityType, message.entityId);
            break;
          case 'showUpdateIndicator':
            // This is handled by the webview itself, but we can acknowledge it
            break;
          case 'reviewTranscription':
            await this.handleReviewTranscription(currentTranscript.transcript, message.transcriptUri || transcriptUri);
            break;
          case 'startChatFromInput':
            await this.handleStartChatFromInput(currentTranscript.transcript, message.message, message.transcriptUri || transcriptUri);
            break;
          case 'openSource':
            await this.handleOpenSource(currentTranscript.transcript, message.transcriptPath, message.transcriptUri || transcriptUri);
            break;
          case 'editInEditor':
            await this.handleEditInEditor(currentTranscript.transcript, message.transcriptPath, message.transcriptUri || transcriptUri);
            break;
          case 'createEntityFromSelection':
            await this.handleCreateEntityFromSelection(message.selectedText, message.transcriptUri || transcriptUri);
            break;
          case 'loadEnhancementLog':
            await this.handleLoadEnhancementLog(panel, message.transcriptPath);
            break;
          case 'refreshTranscript': {
            await this.refreshTranscript(transcriptUri);
            const refreshPanel = this._panels.get(transcriptUri);
            if (refreshPanel) {
              refreshPanel.webview.postMessage({ command: 'refreshComplete' });
            }
            break;
          }
          case 'changeStatus':
            await this.handleChangeStatus(currentTranscript.transcript, message.transcriptPath, transcriptUri);
            break;
          case 'addTask':
            await this.handleAddTask(currentTranscript.transcript, message.transcriptPath, transcriptUri);
            break;
          case 'completeTask':
            await this.handleCompleteTask(currentTranscript.transcript, message.transcriptPath, message.taskId, transcriptUri);
            break;
          case 'deleteTask':
            await this.handleDeleteTask(currentTranscript.transcript, message.transcriptPath, message.taskId, transcriptUri);
            break;
        }
      },
      null
    );

    panel.onDidDispose(async () => {
      // Unsubscribe from this transcript when panel is closed
      console.log(`Protokoll: [TRANSCRIPT VIEW] Panel disposed, unsubscribing from: ${transcriptUri}`);
      if (this._client) {
        try {
          await this._client.unsubscribeFromResource(transcriptUri);
          console.log(`Protokoll: [TRANSCRIPT VIEW] ✅ Unsubscribed from transcript: ${transcriptUri}`);
        } catch (error) {
          console.error(`Protokoll: [TRANSCRIPT VIEW] ❌ Failed to unsubscribe from transcript:`, error);
        }
      } else {
        console.warn(`Protokoll: [TRANSCRIPT VIEW] ⚠️ No client available to unsubscribe`);
      }
      
      this._panels.delete(transcriptUri);
      this._currentTranscripts.delete(transcriptUri);
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

  /**
   * Convert an absolute path to a relative path for the server
   * Extracts the relative portion after '/notes/' or returns the path as-is if already relative
   */
  private convertToRelativePath(absolutePath: string): string {
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

    // Fallback: return just the filename
    return pathParts[pathParts.length - 1] || absolutePath;
  }

  private async handleChangeProject(transcript: Transcript, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      // List available projects
      // Only pass contextDirectory if server is in local mode
      const shouldPass = await shouldPassContextDirectory(this._client);
      const contextDirectory = shouldPass ? this.getDefaultContextDirectory() : undefined;
      const projectsResult = await this._client.callTool(
        'protokoll_list_projects',
        contextDirectory ? { contextDirectory } : {}
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
        ...allProjects.map(p => ({
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
      const rawPath = transcript.path || transcript.filename;
      const transcriptPath = this.convertToRelativePath(rawPath);
      
      // Log for debugging
      console.log(`Protokoll: Updating transcript with path: ${transcriptPath}, projectId: ${projectId}`);
      
      try {
        const result = await this._client.callTool('protokoll_edit_transcript', {
          transcriptPath: transcriptPath,
          projectId: projectId,
        });
        
        console.log(`Protokoll: Edit transcript result:`, result);
        vscode.window.showInformationMessage(`Protokoll: Transcript assigned to project "${projectName}"`);
      } catch (toolError) {
        console.error(`Protokoll: Error calling protokoll_edit_transcript:`, toolError);
        throw toolError; // Re-throw to be caught by outer catch
      }

      // Refresh the transcripts list view
      await vscode.commands.executeCommand('protokoll.refreshTranscripts');

      // Update the local transcript object with the new project info
      const currentTranscript = this._currentTranscripts.get(transcriptUri);
      if (currentTranscript) {
        // Update the transcript object with the new project
        const updatedTranscript: Transcript = {
          ...currentTranscript.transcript,
          entities: {
            ...currentTranscript.transcript.entities,
            projects: [{
              id: projectId,
              name: projectName,
            }],
          },
        };
        
        // Update the stored transcript
        this._currentTranscripts.set(transcriptUri, {
          uri: transcriptUri,
          transcript: updatedTranscript,
        });
        
        // Refresh the detail view with updated transcript
        await this.showTranscript(transcriptUri, updatedTranscript);
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to change project: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleChangeDate(transcript: Transcript, transcriptPath: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      // Prompt user for new date
      const dateInput = await vscode.window.showInputBox({
        prompt: 'Enter new date for transcript (YYYY-MM-DD)',
        placeHolder: '2026-01-15',
        validateInput: (value) => {
          if (!value) {
            return 'Date is required';
          }
          // Validate date format
          const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
          if (!dateRegex.test(value)) {
            return 'Invalid date format. Use YYYY-MM-DD (e.g., 2026-01-15)';
          }
          // Validate it's a valid date
          const date = new Date(value);
          if (isNaN(date.getTime())) {
            return 'Invalid date';
          }
          return null;
        },
      });

      if (!dateInput) {
        return; // User cancelled
      }

      // Convert absolute path to relative path
      const rawPath = transcript.path || transcript.filename;
      const relativePath = this.convertToRelativePath(rawPath);
      
      // Log for debugging
      console.log(`Protokoll: Changing transcript date with path: ${relativePath}, newDate: ${dateInput}`);
      
      // Show progress
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Changing transcript date...',
        cancellable: false,
      }, async () => {
        try {
          const result = await this._client!.callTool('protokoll_change_transcript_date', {
            transcriptPath: relativePath,
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
        transcriptPath: this.convertToRelativePath(transcriptPath),
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
        transcriptPath: this.convertToRelativePath(transcriptPath),
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

    const statuses = ['initial', 'enhanced', 'reviewed', 'in_progress', 'closed', 'archived'];
    const statusLabels: Record<string, string> = {
      initial: 'Initial',
      enhanced: 'Enhanced',
      reviewed: 'Reviewed',
      'in_progress': 'In Progress',
      closed: 'Closed',
      archived: 'Archived',
    };

    const selected = await vscode.window.showQuickPick(
      statuses.map(s => ({ label: statusLabels[s], value: s })),
      { placeHolder: 'Select new status' }
    );

    if (!selected) {
      return;
    }

    try {
      await this._client.callTool('protokoll_set_status', {
        transcriptPath: this.convertToRelativePath(transcriptPath),
        status: selected.value,
      });

      vscode.window.showInformationMessage(`Protokoll: Status changed to "${selected.label}"`);

      // Refresh the transcript view
      setTimeout(async () => {
        await this.refreshTranscript(transcriptUri);
      }, 500);
    } catch (error) {
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
        transcriptPath: this.convertToRelativePath(transcriptPath),
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

  private async handleCompleteTask(transcript: Transcript, transcriptPath: string, taskId: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      await this._client.callTool('protokoll_complete_task', {
        transcriptPath: this.convertToRelativePath(transcriptPath),
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
        transcriptPath: this.convertToRelativePath(transcriptPath),
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

    try {
      const result = await this._client.callTool('protokoll_edit_transcript', {
        transcriptPath: this.convertToRelativePath(transcriptPath),
        title: newTitle.trim(),
      }) as {
        success?: boolean;
        originalPath?: string;
        outputPath?: string;
        renamed?: boolean;
        message?: string;
      };

      vscode.window.showInformationMessage(`Protokoll: Title updated to "${newTitle.trim()}"`);

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
            title: newTitle.trim(),
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
          panel.title = newTitle.trim();

          // Subscribe to new URI
          try {
            await this._client.subscribeToResource(newTranscriptUri);
            console.log(`Protokoll: [TRANSCRIPT VIEW] ✅ Subscribed to new URI: ${newTranscriptUri}`);
          } catch (error) {
            console.warn(`Protokoll: [TRANSCRIPT VIEW] ⚠️ Failed to subscribe to new URI:`, error);
          }

          // Refresh the view with new URI and updated transcript
          await this.showTranscript(newTranscriptUri, updatedTranscript);
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
        // File wasn't renamed, just refresh with existing URI
        setTimeout(async () => {
          const currentTranscript = this._currentTranscripts.get(transcriptUri);
          if (currentTranscript) {
            // Update title in stored transcript
            const updatedTranscript: Transcript = {
              ...currentTranscript.transcript,
              title: newTitle.trim(),
            };
            this._currentTranscripts.set(transcriptUri, {
              uri: transcriptUri,
              transcript: updatedTranscript,
            });
            await this.showTranscript(transcriptUri, updatedTranscript);
          }
        }, 500);
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to update title: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleEditTranscript(transcript: Transcript, transcriptPath: string, newContent: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      // Use the new update_transcript_content tool to directly update the content
      await this._client.callTool('protokoll_update_transcript_content', {
        transcriptPath: this.convertToRelativePath(transcriptPath),
        content: newContent,
      });

      vscode.window.showInformationMessage('Protokoll: Transcript content updated');

      // Refresh the detail view immediately to show the updated content
      const currentTranscript = this._currentTranscripts.get(transcriptUri);
      if (currentTranscript) {
        await this.showTranscript(currentTranscript.uri, currentTranscript.transcript);
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

  public async handleOpenEntity(entityType: string, entityId: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      // Build entity URI: protokoll://entity/{type}/{id}
      const entityUri = `protokoll://entity/${entityType}/${encodeURIComponent(entityId)}`;
      
      // Read the entity resource
      const content = await this._client.readResource(entityUri);
      
      // Track when entity was fetched
      this._entityLastFetched.set(entityUri, new Date());
      
      // Parse entity content to extract name for title
      const entityData = this.parseEntityContent(content.text);
      const entityName = entityData.name || entityId;
      const panelTitle = `${this.capitalizeFirst(entityType)}: ${entityName}`;
      
      // Create a new webview panel to display the entity
      const panel = vscode.window.createWebviewPanel(
        'protokoll.entity',
        panelTitle,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      // Display entity content with last fetched time
      const lastFetched = this._entityLastFetched.get(entityUri);
      panel.webview.html = this.getEntityContent(entityType, entityId, content.text, entityData, lastFetched);

      // Track entity panel
      this._entityPanels.set(entityUri, panel);

      // Handle messages from entity webview
      panel.webview.onDidReceiveMessage(
        async (message) => {
          switch (message.command) {
            case 'startChatFromInputEntity':
              await this.handleStartChatFromInputEntity(entityType, entityId, entityUri, message.message);
              break;
            case 'refreshEntity':
              await this.refreshEntity(entityUri);
              break;
            case 'loadRelatedTranscripts':
              await this.handleLoadRelatedTranscripts(panel, message.entityType, message.entityId);
              break;
            case 'openTranscript':
              await this.handleOpenTranscriptFromEntity(message.path);
              break;
          }
        },
        null
      );

      // Clean up on dispose
      panel.onDidDispose(async () => {
        this._entityPanels.delete(entityUri);
        // Unsubscribe from entity resource when panel is closed
        if (this._client) {
          try {
            await this._client.unsubscribeFromResource(entityUri);
            console.log(`Protokoll: [ENTITY VIEW] ✅ Unsubscribed from entity: ${entityUri}`);
          } catch (error) {
            console.warn(`Protokoll: [ENTITY VIEW] ⚠️ Failed to unsubscribe from entity:`, error);
          }
        }
      }, null);

      // Subscribe to this entity for change notifications
      console.log(`Protokoll: [ENTITY VIEW] Subscribing to entity for change notifications: ${entityUri}`);
      try {
        await this._client.subscribeToResource(entityUri);
        console.log(`Protokoll: [ENTITY VIEW] ✅ Successfully subscribed to entity: ${entityUri}`);
      } catch (error) {
        console.warn(`Protokoll: [ENTITY VIEW] ⚠️ Failed to subscribe to entity ${entityUri}:`, error);
        // Continue anyway - subscription failure shouldn't prevent viewing
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open entity: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Load enhancement log for a transcript and send to webview
   */
  private async handleLoadEnhancementLog(
    panel: vscode.WebviewPanel,
    transcriptPath: string
  ): Promise<void> {
    if (!this._client) {
      return;
    }

    try {
      // Call protokoll_get_enhancement_log
      const response = await this._client.callTool('protokoll_get_enhancement_log', {
        transcriptPath,
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

  /**
   * Open a transcript from entity view
   */
  private async handleOpenTranscriptFromEntity(transcriptPath: string): Promise<void> {
    if (!this._client) {
      return;
    }

    try {
      // Read the transcript
      const transcriptContent = await this._client.callTool('protokoll_read_transcript', {
        transcriptPath,
      }) as TranscriptContent;

      // Build URI
      const uri = `protokoll://transcript/${transcriptPath.replace(/\.pkl$/, '')}`;

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
      
      // Update panel HTML with fresh content
      const lastFetched = this._entityLastFetched.get(entityUri);
      panel.webview.html = this.getEntityContent(entityType, entityId, content.text, entityData, lastFetched);
      
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
  private async handleEditInEditor(transcript: Transcript, transcriptPath: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      // Fetch transcript content from MCP server - returns structured JSON
      const content: TranscriptContent = await this._client.readTranscript(transcriptUri);
      
      // With structured response, content.content is already the body text (no header parsing needed)
      const body = content.content;
      
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
        transcriptPath: this.convertToRelativePath(transcriptPath),
        transcriptUri: transcriptUri,
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
        `Editing: ${title}`,
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

  private async showEntityPicker(
    selectedText: string,
    transcriptPath: string
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
        transcriptPath: this.convertToRelativePath(transcriptPath),
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
        description: 'Create and map to new entity'
      });
      
      // Add existing entities (first 5)
      try {
        const listResult = await this._client!.callTool(`protokoll_list_${type.plural}`, {
          limit: 5
        }) as { success?: boolean; [key: string]: unknown };
        
        const entityKey = type.plural;
        if (listResult.success && listResult[entityKey]) {
          for (const entity of listResult[entityKey] as Array<{ id: string; name: string }>) {
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
      
      if (value.length > 2) {
        searchTimeout = setTimeout(async () => {
          // Search across all entity types
          const searchItems: EntityPickerItem[] = [...items.filter(i => i.kind === vscode.QuickPickItemKind.Separator || i.source === 'create-new' || i.source === 'suggestion')];
          
          for (const type of entityTypes) {
            try {
              const searchResult = await this._client!.callTool(`protokoll_list_${type.plural}`, {
                search: value,
                limit: 10
              }) as { success?: boolean; [key: string]: unknown };
              
              const entityKey = type.plural;
              if (searchResult.success && searchResult[entityKey]) {
                for (const entity of searchResult[entityKey] as Array<{ id: string; name: string }>) {
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
      } else if (value.length === 0) {
        // Reset to original items
        picker.items = items;
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
      
      const transcriptPath = currentTranscript.transcript.path || currentTranscript.transcript.filename;
      const selectedEntity = await this.showEntityPicker(selectedText, transcriptPath);
      
      if (!selectedEntity) {
        return; // User cancelled
      }
      
      // Call unified correction tool
      const correctionArgs: {
        transcriptPath: string;
        selectedText: string;
        entityType: string;
        entityName?: string;
        entityId?: string;
      } = {
        transcriptPath: this.convertToRelativePath(transcriptPath),
        selectedText: selectedText.trim(),
        entityType: selectedEntity.type
      };
      
      if (selectedEntity.source === 'create-new') {
        correctionArgs.entityName = selectedEntity.name;
      } else {
        correctionArgs.entityId = selectedEntity.id;
      }
      
      const result = await this._client.callTool('protokoll_correct_to_entity', correctionArgs) as {
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
        
        // Navigate to entity and refresh transcript
        await this.handleOpenEntity(selectedEntity.type, result.entity.id);
        await this.refreshTranscript(transcriptUri);
      }
    } catch (error) {
      console.error('Protokoll: [TRANSCRIPT VIEW] Error correcting selection:', error);
      vscode.window.showErrorMessage(
        `Correction failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
    const data: {
      name?: string;
      id?: string;
      type?: string;
      updatedAt?: string;
      source?: string;
      description?: string;
      classification?: Record<string, unknown>;
      topics?: string[];
      [key: string]: unknown;
    } = {};

    // Parse YAML-like content
    const lines = content.split('\n');
    let currentKey: string | null = null;
    let currentValue: string[] = [];
    let inMultiline = false;
    let inList = false;
    let multilineIndent = 0;
    let listIndent = 0;
    const listItems: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineIndent = line.match(/^(\s*)/)?.[1].length || 0;

      // Check for list item: "  - item"
      const listItemMatch = line.match(/^(\s*)-\s+(.+)$/);
      
      if (listItemMatch && currentKey && !inMultiline) {
        const itemIndent = listItemMatch[1].length;
        
        // If we're starting a list or continuing one
        if (!inList || (inList && itemIndent >= listIndent)) {
          inList = true;
          listIndent = itemIndent;
          listItems.push(listItemMatch[2].trim());
          continue;
        } else {
          // List ended, save it
          if (listItems.length > 0) {
            data[currentKey] = [...listItems];
            listItems.length = 0;
            inList = false;
          }
          currentKey = null;
        }
      }

      // Check for key-value pairs: "key: value"
      const kvMatch = line.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
      
      if (kvMatch && !inMultiline) {
        // Save previous key-value if exists
        if (currentKey) {
          if (inList && listItems.length > 0) {
            data[currentKey] = [...listItems];
            listItems.length = 0;
            inList = false;
          } else if (!inList) {
            const value = currentValue.join('\n').trim();
            if (value) {
              data[currentKey] = this.parseValue(value);
            }
          }
        }

        const indent = kvMatch[1].length;
        currentKey = kvMatch[2];
        const value = kvMatch[3].trim();
        currentValue = [];

        // Check for multiline indicators: >, |, >-
        if (value.match(/^[>|]/)) {
          inMultiline = true;
          multilineIndent = indent;
          // Remove the multiline indicator
          const multilineValue = value.replace(/^[>|-]+\s*/, '');
          if (multilineValue) {
            currentValue.push(multilineValue);
          }
        } else if (value) {
          data[currentKey] = this.parseValue(value);
          currentKey = null;
        }
        // If value is empty, might be a list or multiline starting on next line
      } else if (inMultiline && currentKey) {
        // Continue multiline value
        // Check if this line is at the same or less indent level (end of multiline)
        if (trimmed && lineIndent <= multilineIndent && kvMatch) {
          // End of multiline, save and start new key
          const value = currentValue.join('\n').trim();
          if (value) {
            data[currentKey] = this.parseValue(value);
          }
          currentKey = null;
          currentValue = [];
          inMultiline = false;
          
          // Re-process this line as a new key-value
          i--;
          continue;
        } else if (trimmed || currentValue.length > 0) {
          // Remove leading indentation from multiline content
          const content = line.substring(Math.min(multilineIndent + 2, line.length));
          currentValue.push(content);
        }
      } else if (trimmed && currentKey && !inList && !inMultiline) {
        // Continuation of a value (shouldn't happen often with YAML)
        currentValue.push(trimmed);
      } else if (trimmed && !currentKey && !kvMatch && !listItemMatch) {
        // Line that doesn't match any pattern - might be content after all metadata
        // We'll handle this in the remaining content section
      }
    }

    // Save last key-value if exists
    if (currentKey) {
      if (inList && listItems.length > 0) {
        data[currentKey] = [...listItems];
      } else if (!inList) {
        const value = currentValue.join('\n').trim();
        if (value) {
          data[currentKey] = this.parseValue(value);
        }
      }
    }

    // Also try to parse topics as a fallback if not already parsed
    if (!data.topics || (Array.isArray(data.topics) && data.topics.length === 0)) {
      const topicsMatch = content.match(/topics:\s*\n((?:\s*-\s*[^\n]+\n?)+)/);
      if (topicsMatch) {
        const topicLines = topicsMatch[1].match(/^\s*-\s*(.+)$/gm);
        if (topicLines) {
          data.topics = topicLines.map(line => line.replace(/^\s*-\s*/, '').trim());
        }
      }
    }

    return data;
  }

  private parseValue(value: string): unknown {
    // Try to parse as boolean
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    
    // Try to parse as number
    if (/^-?\d+$/.test(value)) {
      return parseInt(value, 10);
    }
    if (/^-?\d+\.\d+$/.test(value)) {
      return parseFloat(value);
    }
    
    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || 
        (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    
    // Remove backticks if present
    if (value.startsWith('`') && value.endsWith('`')) {
      return value.slice(1, -1);
    }
    
    return value;
  }

  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  private formatDate(dateString: string): string {
    try {
      const date = new Date(dateString);
      return date.toLocaleString();
    } catch {
      return dateString;
    }
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
  }, lastFetched?: Date): string {
    // Parse entity data if not provided
    if (!entityData) {
      entityData = this.parseEntityContent(content);
    }

    const entityName = entityData.name || entityId;
    const entityIdDisplay = entityData.id || entityId;
    
    // Extract description and other content
    const description = entityData.description || '';
    const topics = entityData.topics || [];
    
    // Remove already-parsed fields from content to get remaining content
    let remainingContent = content;
    if (description) {
      // Try to remove the description section
      remainingContent = remainingContent.replace(
        new RegExp(`description:\\s*[>|-]?\\s*${description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 's'),
        ''
      );
    }

    // Format metadata section
    const metadataRows: string[] = [];
    
    if (entityIdDisplay) {
      metadataRows.push(`
        <div class="metadata-row">
          <div class="metadata-label">ID:</div>
          <div class="metadata-value"><code>${this.escapeHtml(String(entityIdDisplay))}</code></div>
        </div>
      `);
    }
    
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
    
    if (entityData.source) {
      metadataRows.push(`
        <div class="metadata-row">
          <div class="metadata-label">Source:</div>
          <div class="metadata-value"><code>${this.escapeHtml(String(entityData.source))}</code></div>
        </div>
      `);
    }

    if (entityData.classification) {
      const classificationStr = JSON.stringify(entityData.classification, null, 2);
      metadataRows.push(`
        <div class="metadata-row">
          <div class="metadata-label">Classification:</div>
          <div class="metadata-value"><pre>${this.escapeHtml(classificationStr)}</pre></div>
        </div>
      `);
    }

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
            margin-bottom: 16px;
            color: var(--vscode-textLink-foreground);
            font-size: 1.8em;
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
        .related-transcripts-list {
            list-style: none;
            padding: 0;
            margin: 0;
        }
        .related-transcript-item {
            padding: 12px;
            margin-bottom: 8px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            cursor: pointer;
            transition: background-color 0.2s;
        }
        .related-transcript-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .related-transcript-title {
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
            margin-bottom: 4px;
        }
        .related-transcript-meta {
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
    </style>
</head>
<body>
    <div class="entity-header">
        <button class="refresh-button" id="refresh-button" title="Refresh entity data">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 2V6L10 4M8 14V10L6 12M2 8H6L4 10M14 8H10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" fill="none"/>
            </svg>
            Refresh
        </button>
        <div class="entity-type">${this.escapeHtml(entityType)}</div>
        <h1>${this.escapeHtml(entityName)}</h1>
        ${lastFetched ? `<div class="last-fetched">Last fetched: ${this.escapeHtml(this.formatDate(lastFetched.toISOString()))}</div>` : ''}
    </div>
    ${metadataRows.length > 0 ? `
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
    ${description ? `
    <div class="description">
        <h2>Description</h2>
        <div class="entity-content">
            ${this.markdownToHtml(description)}
        </div>
    </div>
    ` : ''}
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
        
        // Load related transcripts
        function loadRelatedTranscripts() {
            console.log('Protokoll Entity: Loading related transcripts for', entityType, entityId);
            vscode.postMessage({
                command: 'loadRelatedTranscripts',
                entityType: entityType,
                entityId: entityId
            });
        }
        
        // Handle messages from extension (e.g., related transcripts data)
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'relatedTranscripts':
                    console.log('Protokoll Entity: Received related transcripts', message.transcripts);
                    renderRelatedTranscripts(message.transcripts);
                    break;
            }
        });
        
        function renderRelatedTranscripts(transcripts) {
            const container = document.getElementById('related-transcripts-content');
            if (!container) return;
            
            if (!transcripts || transcripts.length === 0) {
                container.innerHTML = '<div class="empty-state">No transcripts reference this entity</div>';
                return;
            }
            
            const listHtml = '<ul class="related-transcripts-list">' +
                transcripts.map(t => {
                    const date = t.date ? new Date(t.date).toLocaleDateString() : '';
                    const project = t.project ? \` • \${t.project}\` : '';
                    return \`
                        <li class="related-transcript-item" data-path="\${t.path}">
                            <div class="related-transcript-title">\${escapeHtml(t.title)}</div>
                            <div class="related-transcript-meta">\${date}\${project}</div>
                        </li>
                    \`;
                }).join('') +
                '</ul>';
            
            container.innerHTML = listHtml;
            
            // Add click handlers
            const items = container.querySelectorAll('.related-transcript-item');
            items.forEach(item => {
                item.addEventListener('click', () => {
                    const path = item.getAttribute('data-path');
                    if (path) {
                        vscode.postMessage({
                            command: 'openTranscript',
                            path: path
                        });
                    }
                });
            });
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        // Run setup immediately (script is at end of body, DOM should be ready)
        setupInlineChatListeners();
        setupRefreshButton();
        loadRelatedTranscripts();
        
        // Also run on DOMContentLoaded as backup
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() {
                setupInlineChatListeners();
                setupRefreshButton();
            });
        }
        
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
    </script>
</body>
</html>`;
  }

  public getWebviewContent(transcript: Transcript, content: TranscriptContent, lastFetched?: Date): string {
    // Server returns structured JSON - use metadata directly, no parsing needed
    const transcriptText = content.content || '*No content available*';
    const tags = content.metadata.tags || [];
    
    // Entity references come directly from server
    const entityReferences: {
      projects?: Array<{ id: string; name: string }>;
      people?: Array<{ id: string; name: string }>;
      terms?: Array<{ id: string; name: string }>;
      companies?: Array<{ id: string; name: string }>;
    } = {
      projects: content.metadata.entities?.projects || [],
      people: content.metadata.entities?.people || [],
      terms: content.metadata.entities?.terms || [],
      companies: content.metadata.entities?.companies || [],
    };
    
    // Add project from metadata if available and not already in entity references
    if (content.metadata.projectId && content.metadata.project) {
      const projectExists = entityReferences.projects?.some(p => p.id === content.metadata.projectId);
      if (!projectExists) {
        entityReferences.projects = entityReferences.projects || [];
        entityReferences.projects.push({
          id: content.metadata.projectId,
          name: content.metadata.project,
        });
      }
    }
    
    // Also merge with entities from transcript object if available (for backwards compatibility)
    if (transcript.entities) {
      if (transcript.entities.projects) {
        entityReferences.projects = [
          ...(entityReferences.projects || []),
          ...transcript.entities.projects.map(p => ({ id: p.id, name: p.name }))
        ];
        // Remove duplicates
        entityReferences.projects = entityReferences.projects.filter((p, index, self) =>
          index === self.findIndex((t) => t.id === p.id)
        );
      }
      if (transcript.entities.people) {
        entityReferences.people = [
          ...(entityReferences.people || []),
          ...transcript.entities.people.map(p => ({ id: p.id, name: p.name }))
        ];
        entityReferences.people = entityReferences.people.filter((p, index, self) =>
          index === self.findIndex((t) => t.id === p.id)
        );
      }
      if (transcript.entities.terms) {
        entityReferences.terms = [
          ...(entityReferences.terms || []),
          ...transcript.entities.terms.map(t => ({ id: t.id, name: t.name }))
        ];
        entityReferences.terms = entityReferences.terms.filter((t, index, self) =>
          index === self.findIndex((e) => e.id === t.id)
        );
      }
      if (transcript.entities.companies) {
        entityReferences.companies = [
          ...(entityReferences.companies || []),
          ...transcript.entities.companies.map(c => ({ id: c.id, name: c.name }))
        ];
        entityReferences.companies = entityReferences.companies.filter((c, index, self) =>
          index === self.findIndex((e) => e.id === c.id)
        );
      }
    }

    // Format date/time - use structured metadata from server
    const date = content.metadata.date || transcript.date || 'Unknown date';
    const time = content.metadata.time || transcript.time || '';
    const dateTime = time ? `${date} ${time}` : date;

    // Get createdAt and updatedAt from transcript object (not in content.metadata)
    const createdAt = transcript.createdAt;
    const updatedAt = transcript.updatedAt;

    // Get status and tasks from structured metadata
    const status = content.metadata.status || transcript.status || 'reviewed';
    const tasks = content.metadata.tasks || transcript.tasks || [];
    const openTasks = tasks.filter((t: { status: string }) => t.status === 'open');

    // Get project info from structured metadata
    const projectId = content.metadata.entities?.projects?.[0]?.id || content.metadata.projectId || transcript.entities?.projects?.[0]?.id || '';
    const projectName = content.metadata.entities?.projects?.[0]?.name || content.metadata.project || transcript.entities?.projects?.[0]?.name || '';
    const transcriptPath = transcript.path || transcript.filename;

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
        .edit-button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.9em;
            margin-bottom: 16px;
            display: inline-block;
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
        .status-badge.initial { background-color: #6c757d; color: white; }
        .status-badge.enhanced { background-color: #17a2b8; color: white; }
        .status-badge.reviewed { background-color: #007bff; color: white; }
        .status-badge.in_progress { background-color: #ffc107; color: #333; }
        .status-badge.closed { background-color: #28a745; color: white; }
        .status-badge.archived { background-color: #6c757d; color: white; }
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
                    <div class="metadata-value">
                        <span class="editable-date" onclick="changeDate()" title="Click to change transcript date">
                            ${this.escapeHtml(dateTime)}
                            <svg class="edit-icon-small" width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M11.5 1.5L14.5 4.5L5 14H2V11L11.5 1.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                                <path d="M10 3L13 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </span>
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
                <button class="task-add-btn" onclick="addTask()">+ Add Task <span class="kbd-hint">K</span></button>
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
            <button class="content-tab active" id="enhanced-tab" onclick="switchTab('enhanced')">Enhanced</button>
            <button class="content-tab ${content.rawTranscript ? '' : 'disabled'}" id="raw-tab" onclick="switchTab('raw')" ${content.rawTranscript ? '' : 'disabled'}>Original</button>
            <button class="content-tab" id="enhancement-tab" onclick="switchTab('enhancement')">Enhancement</button>
        </div>
        <div class="tab-content active" id="enhanced-content">
            <div style="display: flex; gap: 8px; margin-bottom: 16px;">
                <button class="edit-button" onclick="editInEditor()" id="edit-in-editor-btn" title="Edit in VS Code editor (supports voice dictation)">Edit in Editor <span class="kbd-hint">E</span></button>
                <button class="edit-button" onclick="openSource()" id="open-source-btn" title="View source (read-only)" style="opacity: 0.7;">View Source <span class="kbd-hint">S</span></button>
            </div>
            <div class="transcript-content" id="transcript-content-display">
                ${this.markdownToHtml(transcriptText)}
            </div>
            <button class="create-entity-button" id="create-entity-btn" onclick="createEntityFromSelection()" title="Correct this text by creating new entity or mapping to existing">Correct Text</button>
        </div>
        ${content.rawTranscript ? `
        <div class="tab-content" id="raw-content">
            <div class="transcript-content" style="white-space: pre-wrap; font-family: var(--vscode-editor-font-family);">
                ${this.escapeHtml(content.rawTranscript.text)}
            </div>
            ${content.rawTranscript.model || content.rawTranscript.transcribedAt ? `
            <div style="margin-top: 16px; padding: 12px; background-color: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; font-size: 0.85em; color: var(--vscode-descriptionForeground);">
                ${content.rawTranscript.model ? `Model: ${this.escapeHtml(content.rawTranscript.model)}` : ''}
                ${content.rawTranscript.model && content.rawTranscript.transcribedAt ? ' • ' : ''}
                ${content.rawTranscript.transcribedAt ? `Transcribed: ${this.escapeHtml(this.formatDate(content.rawTranscript.transcribedAt))}` : ''}
            </div>
            ` : ''}
        </div>
        ` : ''}
        <div class="tab-content" id="enhancement-content">
            <div id="enhancement-log-container">
                <div class="loading">Loading enhancement log...</div>
            </div>
        </div>
    </div>
    ${this.renderEntityReferences(entityReferences)}
    <script>
        const vscode = acquireVsCodeApi();
        const transcriptPath = ${JSON.stringify(transcriptPath)};
        const transcriptUri = ${JSON.stringify(transcript.uri)};
        const projectId = ${JSON.stringify(projectId)};
        const currentTags = ${JSON.stringify(tags)};
        const originalTranscriptText = ${JSON.stringify(transcriptText)};

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
        
        function switchTab(tabName) {
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
            
            // Lazy load enhancement log when tab is first opened
            if (tabName === 'enhancement' && !enhancementLogLoaded) {
                loadEnhancementLog();
                enhancementLogLoaded = true;
            }
        }

        function loadEnhancementLog() {
            console.log('Loading enhancement log for transcript:', transcriptPath);
            vscode.postMessage({
                command: 'loadEnhancementLog',
                transcriptPath: transcriptPath
            });
        }
        
        function renderEnhancementLog(data) {
            const container = document.getElementById('enhancement-log-container');
            if (!container) return;
            
            if (!data.entries || data.entries.length === 0) {
                container.innerHTML = '<div class="empty-state">No enhancement data available for this transcript</div>';
                return;
            }
            
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
                    
                    html += \`
                        <div class="enhancement-step">
                            <div class="enhancement-step-header" onclick="toggleStepDetails(\${entry.id})">
                                <span class="enhancement-step-action">\${escapeHtml(entry.action)}</span>
                                <span class="enhancement-step-timestamp">\${timestamp}</span>
                            </div>
                            \${detailsJson ? \`
                            <div class="enhancement-step-details" id="step-details-\${entry.id}">
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
        }
        
        function toggleStepDetails(stepId) {
            const details = document.getElementById('step-details-' + stepId);
            if (details) {
                details.classList.toggle('expanded');
            }
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
            }
        });
        
        function changeProject() {
            vscode.postMessage({
                command: 'changeProject',
                transcriptPath: transcriptPath
            });
        }

        function changeDate() {
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
            
            const currentText = display.textContent;
            
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

        function editInEditor() {
            vscode.postMessage({
                command: 'editInEditor',
                transcriptPath: transcriptPath,
                transcriptUri: transcriptUri
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
            } else if (message.command === 'saveFailed') {
                // Re-enable the save button if save failed
                const saveBtn = document.querySelector('#transcript-content-edit .button');
                if (saveBtn) {
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save';
                }
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
        document.addEventListener('DOMContentLoaded', () => {
            setupRefreshButton();
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
    const hasEntities = 
      (entities.projects && entities.projects.length > 0) ||
      (entities.people && entities.people.length > 0) ||
      (entities.terms && entities.terms.length > 0) ||
      (entities.companies && entities.companies.length > 0);

    if (!hasEntities) {
      return '';
    }

    const sections: string[] = [];

    if (entities.projects && entities.projects.length > 0) {
      sections.push(`
        <div>
          <h3>Projects</h3>
          <div class="entity-list">
            ${entities.projects.map(p => `
              <a href="#" class="entity-item" onclick="openEntity('project', '${this.escapeHtml(p.id)}'); return false;">
                <span class="entity-type-label">Project:</span> ${this.escapeHtml(p.name)}
              </a>
            `).join('')}
          </div>
        </div>
      `);
    }

    if (entities.people && entities.people.length > 0) {
      sections.push(`
        <div>
          <h3>People</h3>
          <div class="entity-list">
            ${entities.people.map(p => `
              <a href="#" class="entity-item" onclick="openEntity('person', '${this.escapeHtml(p.id)}'); return false;">
                <span class="entity-type-label">Person:</span> ${this.escapeHtml(p.name)}
              </a>
            `).join('')}
          </div>
        </div>
      `);
    }

    if (entities.terms && entities.terms.length > 0) {
      sections.push(`
        <div>
          <h3>Terms</h3>
          <div class="entity-list">
            ${entities.terms.map(t => `
              <a href="#" class="entity-item" onclick="openEntity('term', '${this.escapeHtml(t.id)}'); return false;">
                <span class="entity-type-label">Term:</span> ${this.escapeHtml(t.name)}
              </a>
            `).join('')}
          </div>
        </div>
      `);
    }

    if (entities.companies && entities.companies.length > 0) {
      sections.push(`
        <div>
          <h3>Companies</h3>
          <div class="entity-list">
            ${entities.companies.map(c => `
              <a href="#" class="entity-item" onclick="openEntity('company', '${this.escapeHtml(c.id)}'); return false;">
                <span class="entity-type-label">Company:</span> ${this.escapeHtml(c.name)}
              </a>
            `).join('')}
          </div>
        </div>
      `);
    }

    return `
      <div class="entity-references">
        <h3>Entity References</h3>
        ${sections.join('')}
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
