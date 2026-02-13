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
  private selectedStatusFilters: Set<string> = new Set(['initial', 'enhanced', 'reviewed', 'in_progress', 'closed']); // Statuses to show (archived excluded by default)
  private sortOrder: 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' = 'date-desc'; // Default: date descending
  private treeView: vscode.TreeView<TranscriptItem> | null = null;

  constructor(private context: vscode.ExtensionContext) {
    // Load workspace-specific filter settings
    this.loadWorkspaceSettings();
  }

  /**
   * Load filter settings from workspace state
   */
  private loadWorkspaceSettings(): void {
    // Load project filter (workspace-specific)
    const savedProjectFilter = this.context.workspaceState.get<string | null>('protokoll.projectFilter');
    this.selectedProjectFilter = savedProjectFilter ?? null;
    
    // Load status filters (workspace-specific)
    const savedStatusFilters = this.context.workspaceState.get<string[]>('protokoll.statusFilters');
    if (savedStatusFilters) {
      this.selectedStatusFilters = new Set(savedStatusFilters);
    }
    
    // Load sort order (workspace-specific)
    const savedSortOrder = this.context.workspaceState.get<'date-desc' | 'date-asc' | 'title-asc' | 'title-desc'>('protokoll.sortOrder');
    if (savedSortOrder) {
      this.sortOrder = savedSortOrder;
    }
    
    log('TranscriptsViewProvider: Loaded workspace settings', {
      projectFilter: this.selectedProjectFilter,
      statusFilters: Array.from(this.selectedStatusFilters),
      sortOrder: this.sortOrder
    });
  }

  /**
   * Save filter settings to workspace state
   */
  private async saveWorkspaceSettings(): Promise<void> {
    await this.context.workspaceState.update('protokoll.projectFilter', this.selectedProjectFilter);
    await this.context.workspaceState.update('protokoll.statusFilters', Array.from(this.selectedStatusFilters));
    await this.context.workspaceState.update('protokoll.sortOrder', this.sortOrder);
    
    log('TranscriptsViewProvider: Saved workspace settings', {
      projectFilter: this.selectedProjectFilter,
      statusFilters: Array.from(this.selectedStatusFilters),
      sortOrder: this.sortOrder
    });
  }

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
    // Save to workspace state
    this.saveWorkspaceSettings().catch(err => {
      log('Failed to save project filter to workspace state', err);
    });
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

  setStatusFilters(statuses: Set<string>): void {
    this.selectedStatusFilters = statuses;
    // Save to workspace state
    this.saveWorkspaceSettings().catch(err => {
      log('Failed to save status filters to workspace state', err);
    });
    // Refresh the transcript list with the new filter
    this.refresh().catch(err => {
      vscode.window.showErrorMessage(
        `Failed to refresh transcripts: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  getStatusFilters(): Set<string> {
    return this.selectedStatusFilters;
  }

  setSortOrder(sortOrder: 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc'): void {
    this.sortOrder = sortOrder;
    // Save to workspace state
    this.saveWorkspaceSettings().catch(err => {
      log('Failed to save sort order to workspace state', err);
    });
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

      log('TranscriptsViewProvider.refresh: Got response', { 
        transcriptsCount: response.transcripts.length,
        sampleTranscript: response.transcripts[0] ? {
          title: response.transcripts[0].title,
          hasEntities: !!response.transcripts[0].entities,
          entities: response.transcripts[0].entities
        } : null
      });
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getParent(_element: TranscriptItem): vscode.ProviderResult<TranscriptItem> {
    // Flat list - no parent hierarchy
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
      // Root level - return day groups
      const dayGroups = this.groupTranscriptsByDay();
      log('TranscriptsViewProvider.getChildren: Returning root level', { dayCount: Object.keys(dayGroups).length });
      
      return Object.keys(dayGroups)
        .sort((a, b) => b.localeCompare(a)) // Sort dates descending (newest first)
        .map(dateKey => {
          const transcripts = dayGroups[dateKey];
          const date = this.getTranscriptDate(transcripts[0]);
          const dayLabel = this.formatDayHeader(date);
          
          return new TranscriptItem(
            dayLabel,
            `day:${dateKey}`,
            vscode.TreeItemCollapsibleState.Expanded,
            undefined,
            undefined,
            'day',
            undefined,
            undefined,
            undefined,
            dateKey
          );
        });
    }

    if (element.type === 'day') {
      // Day level - return transcript nodes for this day
      const dateKey = element.dateKey;
      if (!dateKey) {
        return [];
      }
      const dayGroups = this.groupTranscriptsByDay();
      const transcripts = dayGroups[dateKey] || [];
      
      return transcripts.map((t: Transcript) => {
        // Debug logging to see what we're getting - log ALL transcripts to diagnose title issue
        log('TranscriptsViewProvider: Transcript data', {
          uri: t.uri,
          title: t.title,
          filename: t.filename,
          hasEntities: !!t.entities,
          entities: t.entities,
          hasProjects: !!t.entities?.projects,
          projectsLength: t.entities?.projects?.length
        });
        
        const projectNames = t.entities?.projects?.map((p: { id: string; name: string }) => p.name).join(', ') || '';
        const title = t.title || t.filename;
        
        // Truncate title if too long (max 80 chars)
        const truncatedTitle = title.length > 80 ? title.substring(0, 77) + '...' : title;
        
        // Use description field to show project
        const description = projectNames || 'No project';
        
        const item = new TranscriptItem(
          truncatedTitle,
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
        
        // Set description to show project
        item.description = description;
        
        // Debug: verify description is set
        if (t.uri.includes('Claude Skills')) {
          log('TranscriptsViewProvider: Item created', {
            label: item.label,
            description: item.description,
            projectNames
          });
        }
        
        return item;
      });
    }

    return [];
  }

  private groupTranscriptsByYearMonth(): Record<string, Record<string, Transcript[]>> {
    const grouped: Record<string, Record<string, Transcript[]>> = {};

    // Note: Project filtering is done server-side
    // Status filtering is done client-side since status is in transcript content
    let filteredTranscripts = this.transcripts;
    
    // Apply status filters - only show transcripts with selected statuses
    filteredTranscripts = filteredTranscripts.filter(t => {
      // Default status is 'reviewed' if not set
      const transcriptStatus = t.status || 'reviewed';
      return this.selectedStatusFilters.has(transcriptStatus);
    });

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

  private getTranscriptDate(transcript: Transcript): Date {
    // Try to get date from various fields
    if (transcript.date) {
      const date = new Date(transcript.date);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
    
    if (transcript.createdAt) {
      const date = new Date(transcript.createdAt);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
    
    // Fallback to epoch
    return new Date(0);
  }

  private formatDateForTable(transcript: Transcript): string {
    const date = this.getTranscriptDate(transcript);
    if (date.getTime() === 0) {
      return '—'.padEnd(12);
    }
    
    // Format as YYYY-MM-DD
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    return `${year}-${month}-${day}`;
  }

  private groupTranscriptsByDay(): Record<string, Transcript[]> {
    const grouped: Record<string, Transcript[]> = {};

    // Apply status filters - only show transcripts with selected statuses
    const filteredTranscripts = this.transcripts.filter(t => {
      const transcriptStatus = t.status || 'reviewed';
      return this.selectedStatusFilters.has(transcriptStatus);
    });

    for (const transcript of filteredTranscripts) {
      const date = this.getTranscriptDate(transcript);
      if (date.getTime() === 0) {
        continue; // Skip transcripts without valid dates
      }
      
      // Create date key as YYYY-MM-DD
      const dateKey = this.formatDateForTable(transcript);
      
      if (!grouped[dateKey]) {
        grouped[dateKey] = [];
      }
      grouped[dateKey].push(transcript);
    }

    // Sort transcripts within each day based on sortOrder
    for (const dateKey in grouped) {
      grouped[dateKey].sort((a, b) => {
        if (this.sortOrder === 'title-asc' || this.sortOrder === 'title-desc') {
          const titleA = (a.title || a.filename || '').toLowerCase();
          const titleB = (b.title || b.filename || '').toLowerCase();
          return this.sortOrder === 'title-asc' 
            ? titleA.localeCompare(titleB)
            : titleB.localeCompare(titleA);
        } else {
          // For date sorting within the same day, use time if available
          const timeA = a.time || '';
          const timeB = b.time || '';
          return this.sortOrder === 'date-desc'
            ? timeB.localeCompare(timeA)
            : timeA.localeCompare(timeB);
        }
      });
    }

    return grouped;
  }

  private formatDayHeader(date: Date): string {
    // Get day of week
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayOfWeek = dayNames[date.getDay()];
    
    // Format date as "Month Day, Year"
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const month = monthNames[date.getMonth()];
    const day = date.getDate();
    const year = date.getFullYear();
    
    return `${dayOfWeek}, ${month} ${day}, ${year}`;
  }
}

export class TranscriptItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly uri: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
    public readonly transcript?: Transcript,
    public readonly type: 'year' | 'month' | 'transcript' | 'day' = 'transcript',
    public readonly year?: string,
    public readonly month?: string,
    public readonly project?: string,
    public readonly dateKey?: string
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
    } else if (type === 'day') {
      this.contextValue = 'transcriptDay';
      this.iconPath = new vscode.ThemeIcon('calendar');
      this.tooltip = label;
    } else {
      this.contextValue = 'transcript';
      
      // Get status and use appropriate icon
      const status = transcript?.status || 'reviewed';
      
      // Show color-coded circles based on status (matching detail page colors)
      // Detail page colors: initial=#6c757d, enhanced=#17a2b8, reviewed=#007bff, 
      // in_progress=#ffc107, closed=#28a745, archived=#6c757d
      if (status === 'initial') {
        this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.gray'));
      } else if (status === 'enhanced') {
        this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue')); // Cyan/teal closest to blue
      } else if (status === 'reviewed') {
        this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
      } else if (status === 'in_progress') {
        this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
      } else if (status === 'closed') {
        this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
      } else if (status === 'archived') {
        this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.gray'));
      } else {
        // Fallback for unknown status
        this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.gray'));
      }
      
      // Note: description is set by the caller in getChildren() to show project info
      // Don't override it here
      
      // Build detailed tooltip
      const projectNames = transcript?.entities?.projects?.map(p => p.name).join(', ') || project || '';
      const typeLabel = transcript?.hasRawTranscript ? 'Transcript' : 'Note';
      const statusLabel = {
        initial: 'Initial',
        enhanced: 'Enhanced',
        reviewed: 'Reviewed',
        'in_progress': 'In Progress',
        closed: 'Closed',
        archived: 'Archived',
      }[status] || status;
      
      const openTasks = transcript?.tasks?.filter(t => t.status === 'open').length || 0;
      const taskInfo = openTasks > 0 ? `\nOpen tasks: ${openTasks}` : '';
      
      this.tooltip = projectNames 
        ? `${transcript?.title || transcript?.filename} (${typeLabel})\nStatus: ${statusLabel}\nProject: ${projectNames}${taskInfo}`
        : `${transcript?.title || transcript?.filename} (${typeLabel})\nStatus: ${statusLabel}${taskInfo}`;
    }
  }
}
