/**
 * Transcripts List View Provider
 */

import * as vscode from 'vscode';
import { McpClient } from './mcpClient';
import type { Transcript, TranscriptsListResponse } from './types';
import { log } from './logger';

interface YearMonth {
  year: string;
  month: string;
}

export class TranscriptsViewProvider implements vscode.TreeDataProvider<TranscriptItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TranscriptItem | undefined | null | void> = 
    new vscode.EventEmitter<TranscriptItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TranscriptItem | undefined | null | void> = 
    this._onDidChangeTreeData.event;

  private client: McpClient | null = null;
  private transcripts: Transcript[] = [];
  private directory: string = '';
  private selectedProjectFilter: string | null = null; // Project ID to filter by

  constructor(private context: vscode.ExtensionContext) {}

  setClient(client: McpClient): void {
    log('TranscriptsViewProvider.setClient called', { hasClient: !!client });
    this.client = client;
  }

  /**
   * Manually fire the tree data change event to force VS Code to re-render
   */
  fireTreeDataChange(): void {
    log('TranscriptsViewProvider.fireTreeDataChange called');
    this._onDidChangeTreeData.fire();
  }

  setProjectFilter(projectId: string | null): void {
    this.selectedProjectFilter = projectId;
    // Refresh the transcript list with the new filter
    this.refresh().catch(err => {
      vscode.window.showErrorMessage(
        `Failed to refresh transcripts: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  getProjectFilter(): string | null {
    return this.selectedProjectFilter;
  }

  async refresh(directory?: string): Promise<void> {
    log('TranscriptsViewProvider.refresh called', { 
      hasClient: !!this.client, 
      directory, 
      currentDirectory: this.directory,
      currentTranscriptsCount: this.transcripts.length 
    });
    
    if (!this.client) {
      log('TranscriptsViewProvider.refresh: No client, returning early');
      return;
    }

    try {
      if (directory) {
        this.directory = directory;
      }

      if (!this.directory) {
        // Try to discover transcripts from server resources first
        try {
          const resources = await this.client.listResources();
          const transcriptsResource = resources.resources.find(
            (r) => r.uri.startsWith('protokoll://transcripts') || r.name.toLowerCase().includes('transcript')
          );

          if (transcriptsResource) {
            // Parse directory from protokoll:// URI
            const uri = transcriptsResource.uri;
            if (uri.includes('?')) {
              const queryPart = uri.split('?')[1];
              const params = new URLSearchParams(queryPart);
              const dir = params.get('directory');
              if (dir) {
                this.directory = dir;
              }
            }
          }
        } catch {
          // If resource discovery fails, continue to config/user input
        }

        // If still no directory, try config or ask user
        if (!this.directory) {
          const config = vscode.workspace.getConfiguration('protokoll');
          const defaultDir = config.get<string>('transcriptsDirectory', '');
          
          if (!defaultDir) {
            const input = await vscode.window.showInputBox({
              prompt: 'Enter the transcripts directory path',
              placeHolder: '/path/to/transcripts',
            });
            
            if (input) {
              this.directory = input;
              await config.update('transcriptsDirectory', input, true);
            } else {
              return;
            }
          } else {
            this.directory = defaultDir;
          }
        }
      }

      // Pass directory only if set (empty string means use server default)
      // Use this.directory directly, or undefined if empty (server will use its default)
      const directoryToUse = this.directory || undefined;
      log('TranscriptsViewProvider.refresh: Calling listTranscripts', { directoryToUse, projectFilter: this.selectedProjectFilter });
      
      const response: TranscriptsListResponse = await this.client.listTranscripts(directoryToUse, {
        limit: 100,
        projectId: this.selectedProjectFilter || undefined,
      });

      log('TranscriptsViewProvider.refresh: Got response', { transcriptsCount: response.transcripts.length });
      this.transcripts = response.transcripts;
      this._onDidChangeTreeData.fire();
      log('TranscriptsViewProvider.refresh: Fired tree data change event');
    } catch (error) {
      log('TranscriptsViewProvider.refresh: ERROR', { error: error instanceof Error ? error.message : String(error) });
      vscode.window.showErrorMessage(
        `Failed to load transcripts: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getTreeItem(element: TranscriptItem): vscode.TreeItem {
    return element;
  }

  private _isLoading = false;

  async getChildren(element?: TranscriptItem): Promise<TranscriptItem[]> {
    log('TranscriptsViewProvider.getChildren called', { 
      hasElement: !!element, 
      elementType: element?.type,
      transcriptsCount: this.transcripts.length,
      hasClient: !!this.client,
      isLoading: this._isLoading
    });
    
    // Auto-load transcripts if we have no data yet and have a client
    if (!element && this.transcripts.length === 0 && this.client && !this._isLoading) {
      this._isLoading = true;
      log('TranscriptsViewProvider.getChildren: Starting auto-load');
      try {
        await this.refresh();
        log('TranscriptsViewProvider.getChildren: Auto-load completed', { transcriptsCount: this.transcripts.length });
      } catch (error) {
        log('TranscriptsViewProvider.getChildren: Auto-load FAILED', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        this._isLoading = false;
      }
    }

    if (!element) {
      // Root level - return year nodes
      const yearMonths = this.groupTranscriptsByYearMonth();
      log('TranscriptsViewProvider.getChildren: Returning root level', { yearCount: Object.keys(yearMonths).length });
      return Object.keys(yearMonths)
        .sort((a, b) => b.localeCompare(a)) // Sort years descending (newest first)
        .map(year => {
          return new TranscriptItem(
            year,
            `year:${year}`,
            vscode.TreeItemCollapsibleState.Expanded,
            undefined,
            undefined,
            'year'
          );
        });
    }

    if (element.type === 'year') {
      // Year level - return month nodes for this year
      const year = element.uri.replace('year:', '');
      const yearMonths = this.groupTranscriptsByYearMonth();
      const months = yearMonths[year] || {};
      
      return Object.keys(months)
        .sort((a, b) => parseInt(b) - parseInt(a)) // Sort months descending (newest first)
        .map(month => {
          return new TranscriptItem(
            this.getMonthName(month),
            `year:${year}:month:${month}`,
            vscode.TreeItemCollapsibleState.Expanded,
            undefined,
            undefined,
            'month',
            year,
            month
          );
        });
    }

    if (element.type === 'month') {
      // Month level - return transcript nodes for this year/month
      const parts = element.uri.split(':');
      const year = parts[1];
      const month = parts[3];
      const yearMonths = this.groupTranscriptsByYearMonth();
      const transcripts = yearMonths[year]?.[month] || [];
      
      return transcripts.map(t => {
        const projectNames = t.entities?.projects?.map(p => p.name).join(', ') || '';
        const day = this.extractDay(t);
        const dayPrefix = day !== null ? `${day}. ` : '';
        const label = `${dayPrefix}${t.title || t.filename}`;
        
        return new TranscriptItem(
          label,
          t.uri,
          vscode.TreeItemCollapsibleState.None,
          {
            command: 'protokoll.openTranscript',
            title: 'Open Transcript',
            arguments: [t.uri, t],
          },
          t,
          'transcript',
          undefined,
          undefined,
          projectNames || undefined
        );
      });
    }

    return [];
  }

  private groupTranscriptsByYearMonth(): Record<string, Record<string, Transcript[]>> {
    const grouped: Record<string, Record<string, Transcript[]>> = {};

    // Note: Filtering is now done server-side, but we keep this as a fallback
    // The server should already have filtered by projectId if selectedProjectFilter is set
    const filteredTranscripts = this.transcripts;

    for (const transcript of filteredTranscripts) {
      const yearMonth = this.extractYearMonth(transcript);
      if (!yearMonth) {
        continue;
      }

      if (!grouped[yearMonth.year]) {
        grouped[yearMonth.year] = {};
      }
      if (!grouped[yearMonth.year][yearMonth.month]) {
        grouped[yearMonth.year][yearMonth.month] = [];
      }
      grouped[yearMonth.year][yearMonth.month].push(transcript);
    }

    // Sort transcripts within each month by day ascending
    for (const year in grouped) {
      for (const month in grouped[year]) {
        grouped[year][month].sort((a, b) => {
          const dayA = this.extractDay(a);
          const dayB = this.extractDay(b);
          
          // Compare by day number (ascending)
          if (dayA !== null && dayB !== null) {
            const dayCompare = dayA - dayB;
            if (dayCompare !== 0) {
              return dayCompare;
            }
          }
          
          // If day extraction failed, fall back to date string comparison
          const dateCompare = a.date.localeCompare(b.date);
          if (dateCompare !== 0) {
            return dateCompare;
          }
          
          // Then by time if available
          if (a.time && b.time) {
            return a.time.localeCompare(b.time);
          }
          return 0;
        });
      }
    }

    return grouped;
  }

  private extractYearMonth(transcript: Transcript): YearMonth | null {
    // Extract from path format: <year>/<month>/<day>-<name>.md
    // e.g., "2026/1/29-control-your-context.md" or "2026/01/29-control-your-context.md"
    if (transcript.path) {
      const pathMatch = transcript.path.match(/(\d{4})\/(\d{1,2})\//);
      if (pathMatch) {
        return {
          year: pathMatch[1],
          month: String(parseInt(pathMatch[2])), // Remove leading zero
        };
      }
    }

    // Fallback: try to parse date field if path doesn't match expected format
    if (transcript.date) {
      // Format 1: YYYY-MM-DD (e.g., "2026-01-29")
      const isoMatch = transcript.date.match(/^(\d{4})-(\d{2})/);
      if (isoMatch) {
        return {
          year: isoMatch[1],
          month: String(parseInt(isoMatch[2])), // Remove leading zero
        };
      }

      // Format 2: Try to parse as Date object
      try {
        const dateObj = new Date(transcript.date);
        if (!isNaN(dateObj.getTime())) {
          return {
            year: String(dateObj.getFullYear()),
            month: String(dateObj.getMonth() + 1), // getMonth() is 0-based
          };
        }
      } catch {
        // Date parsing failed
      }
    }

    // Last resort: try createdAt field
    if (transcript.createdAt) {
      try {
        const dateObj = new Date(transcript.createdAt);
        if (!isNaN(dateObj.getTime())) {
          return {
            year: String(dateObj.getFullYear()),
            month: String(dateObj.getMonth() + 1),
          };
        }
      } catch {
        // Date parsing failed
      }
    }

    return null;
  }

  private getMonthName(month: string): string {
    const monthNum = parseInt(month);
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return monthNames[monthNum - 1] || `Month ${month}`;
  }

  private extractDay(transcript: Transcript): number | null {
    // Extract from path format: <year>/<month>/<day>-<name>.md
    // e.g., "2026/1/29-control-your-context.md" or "2026/01/29-control-your-context.md"
    if (transcript.path) {
      const pathMatch = transcript.path.match(/\d{4}\/\d{1,2}\/(\d{1,2})/);
      if (pathMatch) {
        return parseInt(pathMatch[1]);
      }
    }

    // Fallback: try to extract day from date field if path doesn't match expected format
    if (transcript.date) {
      // Format 1: YYYY-MM-DD (e.g., "2026-01-29")
      const isoMatch = transcript.date.match(/^\d{4}-\d{2}-(\d{2})/);
      if (isoMatch) {
        return parseInt(isoMatch[1]);
      }

      // Format 2: Try to parse as Date object
      try {
        const dateObj = new Date(transcript.date);
        if (!isNaN(dateObj.getTime())) {
          return dateObj.getDate();
        }
      } catch {
        // Date parsing failed
      }
    }

    return null;
  }
}

export class TranscriptItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly uri: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
    public readonly transcript?: Transcript,
    public readonly type: 'year' | 'month' | 'transcript' = 'transcript',
    public readonly year?: string,
    public readonly month?: string,
    public readonly project?: string
  ) {
    super(label, collapsibleState);
    
    if (type === 'year') {
      this.contextValue = 'transcriptYear';
      this.iconPath = new vscode.ThemeIcon('calendar');
      this.tooltip = `Year ${label}`;
    } else if (type === 'month') {
      this.contextValue = 'transcriptMonth';
      this.iconPath = new vscode.ThemeIcon('calendar');
      this.tooltip = `${label} ${year}`;
    } else {
      this.contextValue = 'transcript';
      // Show different icons for transcripts vs notes
      // Transcripts have raw transcript data (audio transcriptions)
      // Notes don't have raw transcript data (manually written)
      if (transcript?.hasRawTranscript) {
        this.iconPath = new vscode.ThemeIcon('mic'); // Microphone icon for transcripts
      } else {
        this.iconPath = new vscode.ThemeIcon('note'); // Note icon for notes
      }
      // Show project as description (secondary text/column)
      if (project) {
        this.description = project;
      }
      const projectNames = transcript?.entities?.projects?.map(p => p.name).join(', ') || project || '';
      const typeLabel = transcript?.hasRawTranscript ? 'Transcript' : 'Note';
      this.tooltip = projectNames 
        ? `${transcript?.title || transcript?.filename} (${typeLabel})\nProject: ${projectNames}`
        : `${transcript?.title || transcript?.filename} (${typeLabel})`;
    }
  }
}
