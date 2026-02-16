/**
 * Companies List View Provider
 */

import * as vscode from 'vscode';
import { McpClient } from './mcpClient';
import { log } from './logger';

interface Company {
  id: string;
  name: string;
  fullName?: string;
  industry?: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  sounds_like?: string[];
}

interface CompaniesListResponse {
  total: number;
  limit: number;
  offset: number;
  count: number;
  companies: Company[];
}

type CompanyItemType = 'company' | 'load-more';

class CompanyItem extends vscode.TreeItem {
  constructor(
    public readonly type: CompanyItemType,
    public readonly company?: Company,
    label?: string,
    collapsibleState?: vscode.TreeItemCollapsibleState
  ) {
    super(label || company?.name || '', collapsibleState || vscode.TreeItemCollapsibleState.None);

    if (type === 'company' && company) {
      this.id = `company-${company.id}`;
      this.tooltip = this.buildTooltip(company);
      this.description = this.buildDescription(company);
      this.contextValue = 'company';
      this.command = {
        command: 'protokoll.openEntity',
        title: 'Open Company',
        arguments: ['company', company.id],
      };
    } else if (type === 'load-more') {
      this.id = 'load-more';
      this.iconPath = new vscode.ThemeIcon('arrow-down');
      this.contextValue = 'load-more';
      this.command = {
        command: 'protokoll.companies.loadMore',
        title: 'Load More',
      };
    }
  }

  private buildTooltip(company: Company): string {
    const parts: string[] = [company.name];
    if (company.fullName) {
      parts.push(`Full Name: ${company.fullName}`);
    }
    if (company.industry) {
      parts.push(`Industry: ${company.industry}`);
    }
    if (company.sounds_like && company.sounds_like.length > 0) {
      parts.push(`Sounds like: ${company.sounds_like.join(', ')}`);
    }
    return parts.join('\n');
  }

  private buildDescription(company: Company): string {
    const parts: string[] = [];
    if (company.industry) {
      parts.push(company.industry);
    }
    return parts.join(' • ');
  }
}

export class CompaniesViewProvider implements vscode.TreeDataProvider<CompanyItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<CompanyItem | undefined | null | void> = 
    new vscode.EventEmitter<CompanyItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<CompanyItem | undefined | null | void> = 
    this._onDidChangeTreeData.event;

  private client: McpClient | null = null;
  private companies: Company[] = [];
  private total: number = 0;
  private limit: number = 50;
  private offset: number = 0;
  private searchQuery: string = '';
  private treeView: vscode.TreeView<CompanyItem> | null = null;
  private _isLoading = false;

  constructor(private context: vscode.ExtensionContext) {}

  setTreeView(treeView: vscode.TreeView<CompanyItem>): void {
    this.treeView = treeView;
    this.updateTitle();
  }

  setClient(client: McpClient): void {
    log('CompaniesViewProvider.setClient called', { hasClient: !!client });
    const hadClient = !!this.client;
    this.client = client;
    
    if (!hadClient && client && this.treeView?.visible) {
      log('CompaniesViewProvider.setClient: Client set while view visible, firing change event');
      this._onDidChangeTreeData.fire();
    }
  }

  hasCompanies(): boolean {
    return this.companies.length > 0;
  }

  fireTreeDataChange(): void {
    log('CompaniesViewProvider.fireTreeDataChange called');
    this._onDidChangeTreeData.fire();
  }

  private updateTitle(): void {
    if (this.treeView) {
      this.treeView.title = `Companies (${this.total})`;
    }
  }

  async refresh(): Promise<void> {
    log('CompaniesViewProvider.refresh called', { 
      hasClient: !!this.client,
      currentCompaniesCount: this.companies.length,
      offset: this.offset,
      searchQuery: this.searchQuery
    });
    
    if (!this.client) {
      log('CompaniesViewProvider.refresh: No client, returning early');
      return;
    }

    try {
      this.offset = 0;
      await this.loadCompanies();
    } catch (error) {
      log('CompaniesViewProvider.refresh: ERROR', { error: error instanceof Error ? error.message : String(error) });
      vscode.window.showErrorMessage(
        `Failed to load companies: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async loadMore(): Promise<void> {
    log('CompaniesViewProvider.loadMore called', { 
      currentOffset: this.offset,
      currentCount: this.companies.length,
      total: this.total
    });
    
    if (!this.client) {
      return;
    }

    try {
      this.offset += this.limit;
      await this.loadCompanies(true);
    } catch (error) {
      log('CompaniesViewProvider.loadMore: ERROR', { error: error instanceof Error ? error.message : String(error) });
      vscode.window.showErrorMessage(
        `Failed to load more companies: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async setSearch(query: string): Promise<void> {
    log('CompaniesViewProvider.setSearch called', { query });
    this.searchQuery = query;
    this.offset = 0;
    await this.refresh();
  }

  async clearSearch(): Promise<void> {
    log('CompaniesViewProvider.clearSearch called');
    this.searchQuery = '';
    this.offset = 0;
    await this.refresh();
  }

  private async loadCompanies(append: boolean = false): Promise<void> {
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

    log('CompaniesViewProvider.loadCompanies: Calling protokoll_list_companies', args);
    
    const response = await this.client.callTool('protokoll_list_companies', args) as CompaniesListResponse;

    log('CompaniesViewProvider.loadCompanies: Got response', { 
      companiesCount: response.companies.length,
      total: response.total,
      limit: response.limit,
      offset: response.offset
    });

    if (append) {
      this.companies = [...this.companies, ...response.companies];
    } else {
      this.companies = response.companies;
    }
    
    this.total = response.total;
    this.updateTitle();
    this._onDidChangeTreeData.fire();
    log('CompaniesViewProvider.loadCompanies: Fired tree data change event');
  }

  getTreeItem(element: CompanyItem): vscode.TreeItem {
    return element;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getParent(_element: CompanyItem): vscode.ProviderResult<CompanyItem> {
    return null;
  }

  async getChildren(element?: CompanyItem): Promise<CompanyItem[]> {
    log('CompaniesViewProvider.getChildren called', { 
      hasElement: !!element,
      elementType: element?.type,
      companiesCount: this.companies.length,
      hasClient: !!this.client,
      isLoading: this._isLoading
    });
    
    if (!element && this.companies.length === 0 && this.client && !this._isLoading) {
      this._isLoading = true;
      log('CompaniesViewProvider.getChildren: Starting auto-load');
      try {
        await this.refresh();
        log('CompaniesViewProvider.getChildren: Auto-load completed', { companiesCount: this.companies.length });
      } catch (error) {
        log('CompaniesViewProvider.getChildren: Auto-load FAILED', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        this._isLoading = false;
      }
    }

    if (!element) {
      const items: CompanyItem[] = this.companies.map(company => new CompanyItem('company', company));
      
      if (this.companies.length < this.total) {
        items.push(new CompanyItem('load-more', undefined, 'Load More...'));
      }
      
      return items;
    }

    return [];
  }
}
