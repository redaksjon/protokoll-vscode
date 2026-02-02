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
  private sortOrder: 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' = 'date-desc'; // Default: date descending
  private treeView: vscode.TreeView<TranscriptItem> | null = null;

  constructor(private context: vscode.ExtensionContext) {}

  setTreeView(treeView: vscode.TreeView<TranscriptItem>): void {
    this.treeView = treeView;
  }

  getSelectedItems(): TranscriptItem[] {
    if (!this.treeView) {
      return [];
    }
    return this.treeView.selection.filter(item => item.type === 'transcript' && item.transcript);
  }

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

  setSortOrder(sortOrder: 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc'): void {
    this.sortOrder = sortOrder;
    // Refresh the transcript list with the new sort order
    this.refresh().catch(err => {
      vscode.window.showErrorMessage(
        `Failed to refresh transcripts: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  getSortOrder(): 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' {
    return this.sortOrder;
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

  getParent(element: TranscriptItem): vscode.ProviderResult<TranscriptItem> {
    if (element.type === 'transcript') {
      // Transcript's parent is the month
      if (element.year && element.month) {
        return new TranscriptItem(
          this.getMonthName(element.month),
          `year:${element.year}:month:${element.month}`,
          vscode.TreeItemCollapsibleState.Expanded,
          undefined,
          undefined,
          'month',
          element.year,
          element.month
        );
      }
    } else if (element.type === 'month') {
      // Month's parent is the year
      if (element.year) {
        return new TranscriptItem(
          element.year,
          `year:${element.year}`,
          vscode.TreeItemCollapsibleState.Expanded,
          undefined,
          undefined,
          'year'
        );
      }
    }
    // Year has no parent (it's root level)
    return null;
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
        const timeStr = this.formatTime(t.time);
        const dayPrefix = day !== null 
          ? (timeStr ? `${day}. (${timeStr}) ` : `${day}. `)
          : '';
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

    // Sort transcripts within each month based on sortOrder
    for (const year in grouped) {
      for (const month in grouped[year]) {
        grouped[year][month].sort((a, b) => {
          if (this.sortOrder === 'title-asc' || this.sortOrder === 'title-desc') {
            const titleA = (a.title || a.filename || '').toLowerCase();
            const titleB = (b.title || b.filename || '').toLowerCase();
            const compare = titleA.localeCompare(titleB);
            return this.sortOrder === 'title-asc' ? compare : -compare;
          }
          
          // Date-based sorting (default)
          const dayA = this.extractDay(a);
          const dayB = this.extractDay(b);
          
          // Compare by day number (descending by default, ascending if date-asc)
          if (dayA !== null && dayB !== null) {
            const dayCompare = dayA - dayB;
            if (dayCompare !== 0) {
              return this.sortOrder === 'date-asc' ? dayCompare : -dayCompare;
            }
          }
          
          // If day extraction failed, fall back to date string comparison
          const dateCompare = a.date.localeCompare(b.date);
          if (dateCompare !== 0) {
            return this.sortOrder === 'date-asc' ? dateCompare : -dateCompare;
          }
          
          // Then by time if available (descending by default, ascending if date-asc)
          if (a.time && b.time) {
            const timeCompare = a.time.localeCompare(b.time);
            return this.sortOrder === 'date-asc' ? timeCompare : -timeCompare;
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

  private formatTime(timeStr: string | undefined): string | null {
    if (!timeStr) {
      return null;
    }

    try {
      // Try to parse various time formats
      // Format 1: HH:MM:SS or HH:MM (e.g., "20:30:00" or "20:30")
      const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})(?::\d{2})?/);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        
        // Convert to 12-hour format
        const period = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        
        return `${hours}:${minutes.toString().padStart(2, '0')} ${period}`;
      }

      // Format 2: Already in 12-hour format (e.g., "8:30 PM")
      // Just return as-is, but ensure minutes are padded
      const existing12Hour = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (existing12Hour) {
        const hours = existing12Hour[1];
        const minutes = existing12Hour[2].padStart(2, '0');
        const period = existing12Hour[3].toUpperCase();
        return `${hours}:${minutes} ${period}`;
      }

      // Format 3: Try parsing as Date object
      const dateObj = new Date(`2000-01-01T${timeStr}`);
      if (!isNaN(dateObj.getTime())) {
        let hours = dateObj.getHours();
        const minutes = dateObj.getMinutes();
        const period = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        return `${hours}:${minutes.toString().padStart(2, '0')} ${period}`;
      }
    } catch {
      // Time parsing failed
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
