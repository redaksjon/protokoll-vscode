/**
 * Transcripts List View Provider
 */

import * as vscode from 'vscode';
import { McpClient } from './mcpClient';
import type { Transcript, TranscriptsListResponse } from './types';

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
    this.client = client;
  }

  setProjectFilter(projectId: string | null): void {
    this.selectedProjectFilter = projectId;
    this._onDidChangeTreeData.fire();
  }

  getProjectFilter(): string | null {
    return this.selectedProjectFilter;
  }

  async refresh(directory?: string): Promise<void> {
    if (!this.client) {
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

      const response: TranscriptsListResponse = await this.client.listTranscripts(this.directory, {
        limit: 100,
      });

      this.transcripts = response.transcripts;
      this._onDidChangeTreeData.fire();
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to load transcripts: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getTreeItem(element: TranscriptItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TranscriptItem): TranscriptItem[] {
    if (!element) {
      // Root level - return year nodes
      const yearMonths = this.groupTranscriptsByYearMonth();
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
        
        return new TranscriptItem(
          t.title || t.filename,
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

    // Filter transcripts by selected project if filter is set
    const filteredTranscripts = this.selectedProjectFilter
      ? this.transcripts.filter(t => 
          t.entities?.projects?.some(p => p.id === this.selectedProjectFilter)
        )
      : this.transcripts;

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

    // Sort transcripts within each month by date descending
    for (const year in grouped) {
      for (const month in grouped[year]) {
        grouped[year][month].sort((a, b) => {
          const dateCompare = b.date.localeCompare(a.date);
          if (dateCompare !== 0) {
            return dateCompare;
          }
          if (a.time && b.time) {
            return b.time.localeCompare(a.time);
          }
          return 0;
        });
      }
    }

    return grouped;
  }

  private extractYearMonth(transcript: Transcript): YearMonth | null {
    // Try to extract from date field (YYYY-MM-DD format)
    if (transcript.date) {
      const dateMatch = transcript.date.match(/^(\d{4})-(\d{2})/);
      if (dateMatch) {
        return {
          year: dateMatch[1],
          month: String(parseInt(dateMatch[2])), // Remove leading zero
        };
      }
    }

    // Fallback: try to extract from path (e.g., "2026/1/29-...")
    if (transcript.path) {
      const pathMatch = transcript.path.match(/(\d{4})\/(\d{1,2})\//);
      if (pathMatch) {
        return {
          year: pathMatch[1],
          month: String(parseInt(pathMatch[2])), // Remove leading zero
        };
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
