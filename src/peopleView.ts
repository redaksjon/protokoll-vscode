/**
 * People List View Provider
 */

import * as vscode from 'vscode';
import { McpClient } from './mcpClient';
import { log } from './logger';

interface Person {
  id: string;
  name: string;
  company?: string;
  role?: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  sounds_like?: string[];
}

interface PeopleListResponse {
  total: number;
  limit: number;
  offset: number;
  count: number;
  people: Person[];
}

type PersonItemType = 'person' | 'load-more';

class PersonItem extends vscode.TreeItem {
  constructor(
    public readonly type: PersonItemType,
    public readonly person?: Person,
    label?: string,
    collapsibleState?: vscode.TreeItemCollapsibleState
  ) {
    super(label || person?.name || '', collapsibleState || vscode.TreeItemCollapsibleState.None);

    if (type === 'person' && person) {
      this.id = `person-${person.id}`;
      this.tooltip = this.buildTooltip(person);
      this.description = this.buildDescription(person);
      this.contextValue = 'person';
      this.command = {
        command: 'protokoll.openEntity',
        title: 'Open Person',
        arguments: ['person', person.id],
      };
    } else if (type === 'load-more') {
      this.id = 'load-more';
      this.iconPath = new vscode.ThemeIcon('arrow-down');
      this.contextValue = 'load-more';
      this.command = {
        command: 'protokoll.people.loadMore',
        title: 'Load More',
      };
    }
  }

  private buildTooltip(person: Person): string {
    const parts: string[] = [person.name];
    if (person.company) {
      parts.push(`Company: ${person.company}`);
    }
    if (person.role) {
      parts.push(`Role: ${person.role}`);
    }
    if (person.sounds_like && person.sounds_like.length > 0) {
      parts.push(`Sounds like: ${person.sounds_like.join(', ')}`);
    }
    return parts.join('\n');
  }

  private buildDescription(person: Person): string {
    const parts: string[] = [];
    if (person.company) {
      parts.push(person.company);
    }
    if (person.role) {
      parts.push(person.role);
    }
    return parts.join(' • ');
  }
}

export class PeopleViewProvider implements vscode.TreeDataProvider<PersonItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<PersonItem | undefined | null | void> = 
    new vscode.EventEmitter<PersonItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<PersonItem | undefined | null | void> = 
    this._onDidChangeTreeData.event;

  private client: McpClient | null = null;
  private people: Person[] = [];
  private total: number = 0;
  private limit: number = 50;
  private offset: number = 0;
  private searchQuery: string = '';
  private treeView: vscode.TreeView<PersonItem> | null = null;
  private _isLoading = false;
  private _hasAttemptedLoad = false;

  constructor(private context: vscode.ExtensionContext) {}

  setTreeView(treeView: vscode.TreeView<PersonItem>): void {
    this.treeView = treeView;
    this.updateTitle();
  }

  setClient(client: McpClient): void {
    log('PeopleViewProvider.setClient called', { hasClient: !!client });
    const hadClient = !!this.client;
    this.client = client;
    
    this._hasAttemptedLoad = false;
    
    if (!hadClient && client && this.treeView?.visible) {
      log('PeopleViewProvider.setClient: Client set while view visible, firing change event');
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Check if people have been loaded
   */
  hasPeople(): boolean {
    return this.people.length > 0;
  }

  /**
   * Manually fire the tree data change event
   */
  fireTreeDataChange(): void {
    log('PeopleViewProvider.fireTreeDataChange called');
    this._onDidChangeTreeData.fire();
  }

  /**
   * Update the tree view title with count
   */
  private updateTitle(): void {
    if (this.treeView) {
      this.treeView.title = `People (${this.total})`;
    }
  }

  /**
   * Refresh the people list
   */
  async refresh(): Promise<void> {
    log('PeopleViewProvider.refresh called', { 
      hasClient: !!this.client,
      currentPeopleCount: this.people.length,
      offset: this.offset,
      searchQuery: this.searchQuery
    });
    
    if (!this.client) {
      log('PeopleViewProvider.refresh: No client, returning early');
      return;
    }

    try {
      // Reset to first page
      this.offset = 0;
      await this.loadPeople();
    } catch (error) {
      log('PeopleViewProvider.refresh: ERROR', { error: error instanceof Error ? error.message : String(error) });
      vscode.window.showErrorMessage(
        `Failed to load people: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Load more people (pagination)
   */
  async loadMore(): Promise<void> {
    log('PeopleViewProvider.loadMore called', { 
      currentOffset: this.offset,
      currentCount: this.people.length,
      total: this.total
    });
    
    if (!this.client) {
      return;
    }

    try {
      // Move to next page
      this.offset += this.limit;
      await this.loadPeople(true);
    } catch (error) {
      log('PeopleViewProvider.loadMore: ERROR', { error: error instanceof Error ? error.message : String(error) });
      vscode.window.showErrorMessage(
        `Failed to load more people: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Set search query and refresh
   */
  async setSearch(query: string): Promise<void> {
    log('PeopleViewProvider.setSearch called', { query });
    this.searchQuery = query;
    this.offset = 0;
    await this.refresh();
  }

  /**
   * Clear search and refresh
   */
  async clearSearch(): Promise<void> {
    log('PeopleViewProvider.clearSearch called');
    this.searchQuery = '';
    this.offset = 0;
    await this.refresh();
  }

  /**
   * Load people from MCP server
   */
  private async loadPeople(append: boolean = false): Promise<void> {
    if (!this.client) {
      return;
    }

    const args: Record<string, unknown> = {
      limit: this.limit,
      offset: this.offset,
    };

    if (this.searchQuery) {
      args.search = this.searchQuery;
    }

    log('PeopleViewProvider.loadPeople: Calling protokoll_list_people', args);
    
    const response = await this.client.callTool('protokoll_list_people', args) as PeopleListResponse;

    log('PeopleViewProvider.loadPeople: Got response', { 
      peopleCount: response.people.length,
      total: response.total,
      limit: response.limit,
      offset: response.offset
    });

    if (append) {
      this.people = [...this.people, ...response.people];
    } else {
      this.people = response.people;
    }
    this.people.sort((a, b) => a.name.localeCompare(b.name));
    
    this.total = response.total;
    this.updateTitle();
    this._onDidChangeTreeData.fire();
    log('PeopleViewProvider.loadPeople: Fired tree data change event');
  }

  getTreeItem(element: PersonItem): vscode.TreeItem {
    return element;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getParent(_element: PersonItem): vscode.ProviderResult<PersonItem> {
    // Flat list - no parent hierarchy
    return null;
  }

  async getChildren(element?: PersonItem): Promise<PersonItem[]> {
    log('PeopleViewProvider.getChildren called', { 
      hasElement: !!element,
      elementType: element?.type,
      peopleCount: this.people.length,
      hasClient: !!this.client,
      isLoading: this._isLoading,
      hasAttemptedLoad: this._hasAttemptedLoad
    });
    
    if (!element && this.people.length === 0 && this.client && !this._isLoading && !this._hasAttemptedLoad) {
      this._isLoading = true;
      this._hasAttemptedLoad = true;
      log('PeopleViewProvider.getChildren: Starting auto-load');
      try {
        await this.refresh();
        log('PeopleViewProvider.getChildren: Auto-load completed', { peopleCount: this.people.length });
      } catch (error) {
        log('PeopleViewProvider.getChildren: Auto-load FAILED', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        this._isLoading = false;
      }
    }

    if (!element) {
      // Root level - return people list
      const items: PersonItem[] = this.people.map(person => new PersonItem('person', person));
      
      // Add "Load More" item if there are more results
      if (this.people.length < this.total) {
        items.push(new PersonItem('load-more', undefined, 'Load More...'));
      }
      
      return items;
    }

    // No children for person items
    return [];
  }
}
