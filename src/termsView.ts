/**
 * Terms List View Provider
 */

import * as vscode from 'vscode';
import { McpClient } from './mcpClient';
import { log } from './logger';

interface Term {
  id: string;
  name: string;
  expansion?: string;
  domain?: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  sounds_like?: string[];
}

interface TermsListResponse {
  total: number;
  limit: number;
  offset: number;
  count: number;
  terms: Term[];
}

type TermItemType = 'term' | 'load-more';

class TermItem extends vscode.TreeItem {
  constructor(
    public readonly type: TermItemType,
    public readonly term?: Term,
    label?: string,
    collapsibleState?: vscode.TreeItemCollapsibleState
  ) {
    super(label || term?.name || '', collapsibleState || vscode.TreeItemCollapsibleState.None);

    if (type === 'term' && term) {
      this.id = `term-${term.id}`;
      this.tooltip = this.buildTooltip(term);
      this.description = this.buildDescription(term);
      this.contextValue = 'term';
      this.command = {
        command: 'protokoll.openEntity',
        title: 'Open Term',
        arguments: ['term', term.id],
      };
    } else if (type === 'load-more') {
      this.id = 'load-more';
      this.iconPath = new vscode.ThemeIcon('arrow-down');
      this.contextValue = 'load-more';
      this.command = {
        command: 'protokoll.terms.loadMore',
        title: 'Load More',
      };
    }
  }

  private buildTooltip(term: Term): string {
    const parts: string[] = [term.name];
    if (term.expansion) {
      parts.push(`Expansion: ${term.expansion}`);
    }
    if (term.domain) {
      parts.push(`Domain: ${term.domain}`);
    }
    if (term.sounds_like && term.sounds_like.length > 0) {
      parts.push(`Sounds like: ${term.sounds_like.join(', ')}`);
    }
    return parts.join('\n');
  }

  private buildDescription(term: Term): string {
    const parts: string[] = [];
    if (term.expansion) {
      parts.push(term.expansion);
    }
    if (term.domain) {
      parts.push(term.domain);
    }
    return parts.join(' • ');
  }
}

export class TermsViewProvider implements vscode.TreeDataProvider<TermItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TermItem | undefined | null | void> = 
    new vscode.EventEmitter<TermItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TermItem | undefined | null | void> = 
    this._onDidChangeTreeData.event;

  private client: McpClient | null = null;
  private terms: Term[] = [];
  private total: number = 0;
  private limit: number = 50;
  private offset: number = 0;
  private searchQuery: string = '';
  private treeView: vscode.TreeView<TermItem> | null = null;
  private _isLoading = false;
  private _hasAttemptedLoad = false;

  constructor(private context: vscode.ExtensionContext) {}

  setTreeView(treeView: vscode.TreeView<TermItem>): void {
    this.treeView = treeView;
    this.updateTitle();
  }

  setClient(client: McpClient): void {
    log('TermsViewProvider.setClient called', { hasClient: !!client });
    const hadClient = !!this.client;
    this.client = client;
    
    this._hasAttemptedLoad = false;
    
    if (!hadClient && client && this.treeView?.visible) {
      log('TermsViewProvider.setClient: Client set while view visible, firing change event');
      this._onDidChangeTreeData.fire();
    }
  }

  hasTerms(): boolean {
    return this.terms.length > 0;
  }

  fireTreeDataChange(): void {
    log('TermsViewProvider.fireTreeDataChange called');
    this._onDidChangeTreeData.fire();
  }

  private updateTitle(): void {
    if (this.treeView) {
      this.treeView.title = `Terms (${this.total})`;
    }
  }

  async refresh(): Promise<void> {
    log('TermsViewProvider.refresh called', { 
      hasClient: !!this.client,
      currentTermsCount: this.terms.length,
      offset: this.offset,
      searchQuery: this.searchQuery
    });
    
    if (!this.client) {
      log('TermsViewProvider.refresh: No client, returning early');
      return;
    }

    try {
      this.offset = 0;
      await this.loadTerms();
    } catch (error) {
      log('TermsViewProvider.refresh: ERROR', { error: error instanceof Error ? error.message : String(error) });
      vscode.window.showErrorMessage(
        `Failed to load terms: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async loadMore(): Promise<void> {
    log('TermsViewProvider.loadMore called', { 
      currentOffset: this.offset,
      currentCount: this.terms.length,
      total: this.total
    });
    
    if (!this.client) {
      return;
    }

    try {
      this.offset += this.limit;
      await this.loadTerms(true);
    } catch (error) {
      log('TermsViewProvider.loadMore: ERROR', { error: error instanceof Error ? error.message : String(error) });
      vscode.window.showErrorMessage(
        `Failed to load more terms: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async setSearch(query: string): Promise<void> {
    log('TermsViewProvider.setSearch called', { query });
    this.searchQuery = query;
    this.offset = 0;
    await this.refresh();
  }

  async clearSearch(): Promise<void> {
    log('TermsViewProvider.clearSearch called');
    this.searchQuery = '';
    this.offset = 0;
    await this.refresh();
  }

  private async loadTerms(append: boolean = false): Promise<void> {
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

    log('TermsViewProvider.loadTerms: Calling protokoll_list_terms', args);
    
    const response = await this.client.callTool('protokoll_list_terms', args) as TermsListResponse;

    log('TermsViewProvider.loadTerms: Got response', { 
      termsCount: response.terms.length,
      total: response.total,
      limit: response.limit,
      offset: response.offset
    });

    if (append) {
      this.terms = [...this.terms, ...response.terms];
    } else {
      this.terms = response.terms;
    }
    this.terms.sort((a, b) => a.name.localeCompare(b.name));
    
    this.total = response.total;
    this.updateTitle();
    this._onDidChangeTreeData.fire();
    log('TermsViewProvider.loadTerms: Fired tree data change event');
  }

  getTreeItem(element: TermItem): vscode.TreeItem {
    return element;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getParent(_element: TermItem): vscode.ProviderResult<TermItem> {
    return null;
  }

  async getChildren(element?: TermItem): Promise<TermItem[]> {
    log('TermsViewProvider.getChildren called', { 
      hasElement: !!element,
      elementType: element?.type,
      termsCount: this.terms.length,
      hasClient: !!this.client,
      isLoading: this._isLoading,
      hasAttemptedLoad: this._hasAttemptedLoad
    });
    
    if (!element && this.terms.length === 0 && this.client && !this._isLoading && !this._hasAttemptedLoad) {
      this._isLoading = true;
      this._hasAttemptedLoad = true;
      log('TermsViewProvider.getChildren: Starting auto-load');
      try {
        await this.refresh();
        log('TermsViewProvider.getChildren: Auto-load completed', { termsCount: this.terms.length });
      } catch (error) {
        log('TermsViewProvider.getChildren: Auto-load FAILED', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        this._isLoading = false;
      }
    }

    if (!element) {
      const items: TermItem[] = this.terms.map(term => new TermItem('term', term));
      
      if (this.terms.length < this.total) {
        items.push(new TermItem('load-more', undefined, 'Load More...'));
      }
      
      return items;
    }

    return [];
  }
}
