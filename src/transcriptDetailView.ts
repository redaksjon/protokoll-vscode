/**
 * Transcript Detail View Provider
 * Shows transcript metadata and text in a webview
 */

import * as vscode from 'vscode';
import { McpClient } from './mcpClient';
import type { Transcript, TranscriptContent } from './types';

export class TranscriptDetailViewProvider {
  public static readonly viewType = 'protokoll.transcriptDetail';

  private _panels: Map<string, vscode.WebviewPanel> = new Map();
  private _client: McpClient | null = null;
  private _currentTranscripts: Map<string, { uri: string; transcript: Transcript }> = new Map();
  private _updatingTranscripts: Set<string> = new Set(); // Track transcripts being updated

  constructor(private readonly _extensionUri: vscode.Uri) {}

  /**
   * Get current transcript for a URI (for external access)
   */
  getCurrentTranscript(uri: string): { uri: string; transcript: Transcript } | undefined {
    return this._currentTranscripts.get(uri);
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

    // Show update indicator
    this._updatingTranscripts.add(transcriptUri);
    this.showUpdateIndicator(panel, true);

    try {
      // Re-read the transcript to get updated data
      const content: TranscriptContent = await this._client.readTranscript(transcriptUri);
      
      // Update the stored transcript with fresh data (may include updatedAt)
      const updatedTranscript = { ...currentTranscript.transcript };
      
      // Parse updatedAt from content if available
      const parsedMetadata = this.parseMetadata(content.text);
      if (parsedMetadata.updatedAt) {
        updatedTranscript.updatedAt = parsedMetadata.updatedAt;
      }
      
      // Update stored transcript
      this._currentTranscripts.set(transcriptUri, {
        uri: transcriptUri,
        transcript: updatedTranscript,
      });
      
      // Update the panel with fresh content
      panel.webview.html = this.getWebviewContent(updatedTranscript, content);
    } catch (error) {
      console.error(`Protokoll: Error refreshing transcript ${transcriptUri}:`, error);
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

    // If panel exists and we're not forcing a new tab, just reveal it
    if (panel && !openInNewTab) {
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
            await this.handleChangeProject(currentTranscript.transcript, transcriptUri);
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
      
      // Debug: Log if content is empty
      if (!content.text || content.text.trim().length === 0) {
        console.warn(`Protokoll: Empty content for transcript ${transcriptUri}`);
      }
      
      panel.webview.html = this.getWebviewContent(transcript, content);
    } catch (error) {
      console.error(`Protokoll: Error loading transcript ${transcriptUri}:`, error);
      panel.webview.html = this.getErrorContent(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async handleChangeProject(transcript: Transcript, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      // List available projects
      const projectsResult = await this._client.callTool('protokoll_list_projects', {}) as {
        projects?: Array<{ id: string; name: string; active?: boolean }>;
      };

      if (!projectsResult.projects || projectsResult.projects.length === 0) {
        vscode.window.showWarningMessage('No projects found.');
        return;
      }

      // Filter to active projects only
      const activeProjects = projectsResult.projects.filter(p => p.active !== false);

      if (activeProjects.length === 0) {
        vscode.window.showWarningMessage('No active projects found.');
        return;
      }

      // Show quick pick to select project
      const projectItems = activeProjects.map(p => ({
        label: p.name,
        description: p.id,
        id: p.id,
      }));

      const selected = await vscode.window.showQuickPick(projectItems, {
        placeHolder: 'Select a project for this transcript',
      });

      if (!selected) {
        return; // User cancelled
      }

      // Update transcript
      const transcriptPath = transcript.path || transcript.filename;
      
      // Log for debugging
      console.log(`Protokoll: Updating transcript with path: ${transcriptPath}, projectId: ${selected.id}`);
      
      try {
        const result = await this._client.callTool('protokoll_edit_transcript', {
          transcriptPath: transcriptPath,
          projectId: selected.id,
        });
        
        console.log(`Protokoll: Edit transcript result:`, result);
        vscode.window.showInformationMessage(`Protokoll: Transcript assigned to project "${selected.label}"`);
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
              id: selected.id,
              name: selected.label,
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
      // Get current tags from the transcript content
      const content: TranscriptContent = await this._client.readTranscript(transcript.uri);
      const currentTags = this.parseTags(content.text);
      
      // Check if tag already exists
      if (currentTags.includes(newTag.trim())) {
        vscode.window.showWarningMessage(`Tag "${newTag.trim()}" already exists`);
        return;
      }

      // Use edit_transcript tool to add the tag
      await this._client.callTool('protokoll_edit_transcript', {
        transcriptPath: transcriptPath,
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
        transcriptPath: transcriptPath,
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

  private async handleEditTitle(transcript: Transcript, transcriptPath: string, newTitle: string, transcriptUri: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      await this._client.callTool('protokoll_edit_transcript', {
        transcriptPath: transcriptPath,
        title: newTitle.trim(),
      });

      vscode.window.showInformationMessage(`Protokoll: Title updated to "${newTitle.trim()}"`);

      // Refresh the transcripts list view
      await vscode.commands.executeCommand('protokoll.refreshTranscripts');

      // Refresh the detail view after a short delay to allow the server to process
      setTimeout(async () => {
        const currentTranscript = this._currentTranscripts.get(transcriptUri);
        if (currentTranscript) {
          await this.showTranscript(currentTranscript.uri, currentTranscript.transcript);
        }
      }, 1000);
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
      // Use provide_feedback tool to edit the transcript content
      await this._client.callTool('protokoll_provide_feedback', {
        transcriptPath: transcriptPath,
        feedback: `Update the transcript content to:\n\n${newContent}`,
      });

      vscode.window.showInformationMessage('Protokoll: Transcript content updated');

      // Refresh the detail view after a short delay to allow the server to process
      setTimeout(async () => {
        const currentTranscript = this._currentTranscripts.get(transcriptUri);
        if (currentTranscript) {
          await this.showTranscript(currentTranscript.uri, currentTranscript.transcript);
        }
      }, 1000);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to update transcript: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleOpenEntity(entityType: string, entityId: string): Promise<void> {
    if (!this._client) {
      vscode.window.showErrorMessage('MCP client not initialized');
      return;
    }

    try {
      // Build entity URI: protokoll://entity/{type}/{id}
      const entityUri = `protokoll://entity/${entityType}/${encodeURIComponent(entityId)}`;
      
      // Read the entity resource
      const content = await this._client.readResource(entityUri);
      
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

      // Display entity content
      panel.webview.html = this.getEntityContent(entityType, entityId, content.text, entityData);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open entity: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
  }): string {
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
    </style>
</head>
<body>
    <div class="entity-header">
        <div class="entity-type">${this.escapeHtml(entityType)}</div>
        <h1>${this.escapeHtml(entityName)}</h1>
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
</body>
</html>`;
  }

  public getWebviewContent(transcript: Transcript, content: TranscriptContent): string {
    const text = content.text;
    const metadata: Record<string, string> = {};
    let transcriptText = text;

    // Try to parse frontmatter at the start (YAML-style)
    const frontmatterMatch = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      transcriptText = frontmatterMatch[2];

      // Parse YAML-like frontmatter
      frontmatter.split('\n').forEach((line) => {
        const match = line.match(/^(\w+):\s*(.+)$/);
        if (match) {
          metadata[match[1]] = match[2].trim();
        }
      });
    }

    // Parse metadata from the content (Date, Time, Project, Project ID)
    const parsedMetadata = this.parseMetadata(text);

    // Parse tags from the content
    const tags = this.parseTags(text);

    // Parse routing information from the content
    const routing = this.parseRouting(text);

    // Parse entity references from the content
    const entityReferences = this.parseEntityReferences(text);
    
    // Add project from parsed metadata if available and not already in entity references
    if (parsedMetadata.projectId && parsedMetadata.project) {
      if (!entityReferences.projects) {
        entityReferences.projects = [];
      }
      // Check if project already exists
      const projectExists = entityReferences.projects.some(p => p.id === parsedMetadata.projectId);
      if (!projectExists) {
        entityReferences.projects.push({
          id: parsedMetadata.projectId,
          name: parsedMetadata.project,
        });
      }
    }
    
    // Also merge with entities from transcript object if available
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

    // Extract content between two --- delimiters (the body of the transcript)
    // Pattern: ... ---\n[content]\n---
    const bodyMatch = transcriptText.match(/---\s*\n([\s\S]*?)\n---/);
    if (bodyMatch) {
      // Found content between two --- delimiters
      transcriptText = bodyMatch[1].trim();
    } else {
      // Fallback: if no --- delimiters found, try to find content after the first ---
      // (in case there's only one delimiter)
      const singleDelimiterMatch = transcriptText.match(/---\s*\n([\s\S]*)$/);
      if (singleDelimiterMatch) {
        transcriptText = singleDelimiterMatch[1].trim();
      } else {
        // No delimiters found, use the old method to remove redundant sections
        transcriptText = this.removeRedundantSections(transcriptText);
        transcriptText = this.removeRedundantTitle(transcriptText, transcript.title || transcript.filename);
      }
    }
    
    // Ensure we have content to display
    if (!transcriptText || transcriptText.trim().length === 0) {
      transcriptText = '*No content available*';
    }

    // Format date/time - prefer parsed metadata, fallback to transcript object
    const date = parsedMetadata.date || transcript.date || 'Unknown date';
    const time = parsedMetadata.time || transcript.time || '';
    const dateTime = time ? `${date} ${time}` : date;

    // Get createdAt and updatedAt - prefer parsed metadata, fallback to transcript object
    const createdAt = parsedMetadata.createdAt || transcript.createdAt;
    const updatedAt = parsedMetadata.updatedAt || transcript.updatedAt;

    // Get project info - prefer parsed metadata, fallback to transcript object
    const projectId = parsedMetadata.projectId || transcript.entities?.projects?.[0]?.id || '';
    const projectName = parsedMetadata.project || transcript.entities?.projects?.[0]?.name || '';
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
            display: inline-block;
            min-width: 200px;
        }
        .title-header .editable-title:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .title-header .editable-title.editing {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            padding: 4px 8px;
        }
        .title-header .title-input {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 4px 8px;
            border-radius: 3px;
            font-size: inherit;
            font-family: inherit;
            width: 100%;
            min-width: 300px;
        }
        .project-corner {
            position: absolute;
            top: 0;
            right: 0;
            text-align: right;
        }
        .project-corner .project-info {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
            justify-content: flex-end;
        }
        .project-corner .project-name {
            font-weight: 600;
            font-size: 0.95em;
        }
        .project-corner .project-name.clickable {
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 3px;
            display: inline-block;
        }
        .project-corner .project-name.clickable:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .project-corner .button {
            margin-left: 0;
            margin-top: 4px;
        }
        .metadata {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 16px;
            margin-bottom: 24px;
        }
        .metadata h2 {
            margin-top: 0;
            color: var(--vscode-textLink-foreground);
        }
        .metadata-row {
            display: flex;
            margin-bottom: 8px;
            align-items: flex-start;
        }
        .metadata-label {
            font-weight: 600;
            min-width: 120px;
            color: var(--vscode-descriptionForeground);
        }
        .metadata-value {
            flex: 1;
            color: var(--vscode-foreground);
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
            word-wrap: break-word;
            margin: 0;
            text-align: left;
            line-height: 1.6;
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
            margin-top: 24px;
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
    </style>
</head>
<body>
    <div class="header">
        <h1 class="title-header">
            <span class="editable-title" id="title-display" onclick="startEditTitle()">${this.escapeHtml(transcript.title || transcript.filename)}</span>
            <span id="update-indicator" class="update-indicator">
                <span class="spinner"></span>
                <span>Updating...</span>
            </span>
        </h1>
        <div class="title-actions" id="title-actions" style="display: none;">
            <button class="button" onclick="saveTitle()">Save</button>
            <button class="button button-secondary" onclick="cancelEditTitle()">Cancel</button>
        </div>
        <div class="project-corner">
            ${projectName ? `
                <div class="project-info">
                    <span class="project-name clickable" onclick="changeProject()">${this.escapeHtml(projectName)}</span>
                </div>
            ` : `
                <div class="project-info">
                    <span style="color: var(--vscode-descriptionForeground); font-style: italic;">No project assigned</span>
                    <button class="button button-secondary" onclick="changeProject()">Assign Project</button>
                </div>
            `}
        </div>
    </div>
    <div class="metadata">
        <h2>Transcript Metadata</h2>
        <div class="metadata-row">
            <div class="metadata-label">Date/Time:</div>
            <div class="metadata-value">${this.escapeHtml(dateTime)}</div>
        </div>
        ${createdAt ? `
        <div class="metadata-row">
            <div class="metadata-label">Created At:</div>
            <div class="metadata-value">${this.escapeHtml(this.formatDate(createdAt))}</div>
        </div>
        ` : ''}
        ${updatedAt ? `
        <div class="metadata-row">
            <div class="metadata-label">Updated At:</div>
            <div class="metadata-value">${this.escapeHtml(this.formatDate(updatedAt))}</div>
        </div>
        ` : ''}
        <div class="metadata-row">
            <div class="metadata-label">Tags:</div>
            <div class="metadata-value">
                ${tags.map(tag => `
                    <span class="tag">
                        ${this.escapeHtml(tag)}
                        <button class="tag-remove" onclick="event.stopPropagation(); removeTag('${this.escapeHtml(tag)}'); return false;" title="Remove tag">×</button>
                    </span>
                `).join('')}
                <button class="tag-add" onclick="addTag()" title="Add tag">+ Add Tag</button>
            </div>
        </div>
        ${routing ? `
        <div class="metadata-row">
            <div class="metadata-label">Routing:</div>
            <div class="metadata-value">
                ${routing.destination ? `<div><strong>Destination:</strong> ${this.escapeHtml(routing.destination)}</div>` : ''}
                ${routing.confidence !== undefined ? `<div><strong>Confidence:</strong> <span class="confidence">${routing.confidence}%</span></div>` : ''}
                ${routing.reasoning ? `<div style="margin-top: 8px;"><strong>Reasoning:</strong> ${this.escapeHtml(routing.reasoning)}</div>` : ''}
            </div>
        </div>
        ` : ''}
        ${Object.entries(metadata).map(([key, value]) => `
        <div class="metadata-row">
            <div class="metadata-label">${this.escapeHtml(key)}:</div>
            <div class="metadata-value">${this.escapeHtml(value)}</div>
        </div>
        `).join('')}
    </div>
    <div class="transcript-content-wrapper">
        <button class="edit-button" onclick="startEditTranscript()" id="edit-transcript-btn">Edit Transcript</button>
        <div class="transcript-content" id="transcript-content-display">
            ${this.markdownToHtml(transcriptText)}
        </div>
        <div id="transcript-content-edit" style="display: none;">
            <textarea id="transcript-textarea" class="title-input" style="min-height: 400px; font-family: var(--vscode-editor-font-family);">${this.escapeHtml(transcriptText)}</textarea>
            <div style="margin-top: 8px;">
                <button class="button" onclick="saveTranscript()">Save</button>
                <button class="button button-secondary" onclick="cancelEditTranscript()">Cancel</button>
            </div>
        </div>
    </div>
    ${this.renderEntityReferences(entityReferences)}
    <script>
        const vscode = acquireVsCodeApi();
        const transcriptPath = ${JSON.stringify(transcriptPath)};
        const projectId = ${JSON.stringify(projectId)};
        const currentTags = ${JSON.stringify(tags)};
        const originalTranscriptText = ${JSON.stringify(transcriptText)};

        function changeProject() {
            vscode.postMessage({
                command: 'changeProject',
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

        let originalTitle = ${JSON.stringify(transcript.title || transcript.filename)};
        let originalTranscriptContent = originalTranscriptText;

        function startEditTitle() {
            const display = document.getElementById('title-display');
            const actions = document.getElementById('title-actions');
            const currentText = display.textContent;
            
            display.innerHTML = \`<input type="text" id="title-input" class="title-input" value="\${currentText}">\`;
            display.classList.add('editing');
            actions.style.display = 'inline-flex';
            
            const input = document.getElementById('title-input');
            input.focus();
            input.select();
            
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
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

        function startEditTranscript() {
            const display = document.getElementById('transcript-content-display');
            const edit = document.getElementById('transcript-content-edit');
            const editBtn = document.getElementById('edit-transcript-btn');
            
            display.style.display = 'none';
            edit.style.display = 'block';
            editBtn.style.display = 'none';
            
            const textarea = document.getElementById('transcript-textarea');
            textarea.focus();
        }

        function saveTranscript() {
            const textarea = document.getElementById('transcript-textarea');
            const newContent = textarea.value;
            
            vscode.postMessage({
                command: 'editTranscript',
                transcriptPath: transcriptPath,
                newContent: newContent
            });
        }

        function cancelEditTranscript() {
            const display = document.getElementById('transcript-content-display');
            const edit = document.getElementById('transcript-content-edit');
            const editBtn = document.getElementById('edit-transcript-btn');
            
            display.style.display = 'block';
            edit.style.display = 'none';
            editBtn.style.display = 'block';
            
            const textarea = document.getElementById('transcript-textarea');
            textarea.value = originalTranscriptContent;
        }

        function openEntity(entityType, entityId) {
            vscode.postMessage({
                command: 'openEntity',
                entityType: entityType,
                entityId: entityId
            });
        }

        // Handle update indicator messages from extension
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
  } {
    const metadata: {
      date?: string;
      time?: string;
      project?: string;
      projectId?: string;
      createdAt?: string;
      updatedAt?: string;
    } = {};

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
