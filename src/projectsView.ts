/**
 * Projects List View Provider
 */

import * as vscode from 'vscode';
import { McpClient } from './mcpClient';
import { log } from './logger';

interface Project {
  id: string;
  name: string;
  active: boolean;
  destination?: string;
  structure?: string;
  contextType?: string;
  triggerPhrases?: string[];
}

interface ProjectsListResponse {
  total: number;
  limit: number;
  offset: number;
  count: number;
  projects: Project[];
}

type ProjectItemType = 'project' | 'load-more';

class ProjectItem extends vscode.TreeItem {
  constructor(
    public readonly type: ProjectItemType,
    public readonly project?: Project,
    label?: string,
    collapsibleState?: vscode.TreeItemCollapsibleState
  ) {
    super(label || project?.name || '', collapsibleState || vscode.TreeItemCollapsibleState.None);

    if (type === 'project' && project) {
      this.id = `project-${project.id}`;
      this.tooltip = this.buildTooltip(project);
      this.description = this.buildDescription(project);
      this.contextValue = 'project';
      this.iconPath = new vscode.ThemeIcon(project.active ? 'folder' : 'folder-library');
      this.command = {
        command: 'protokoll.openEntity',
        title: 'Open Project',
        arguments: ['project', project.id],
      };
    } else if (type === 'load-more') {
      this.id = 'load-more';
      this.iconPath = new vscode.ThemeIcon('arrow-down');
      this.contextValue = 'load-more';
      this.command = {
        command: 'protokoll.projects.loadMore',
        title: 'Load More',
      };
    }
  }

  private buildTooltip(project: Project): string {
    const parts: string[] = [project.name];
    parts.push(`Status: ${project.active ? 'Active' : 'Inactive'}`);
    if (project.destination) {
      parts.push(`Destination: ${project.destination}`);
    }
    if (project.structure) {
      parts.push(`Structure: ${project.structure}`);
    }
    if (project.contextType) {
      parts.push(`Context Type: ${project.contextType}`);
    }
    return parts.join('\n');
  }

  private buildDescription(project: Project): string {
    const parts: string[] = [];
    if (!project.active) {
      parts.push('Inactive');
    }
    if (project.destination) {
      parts.push(project.destination);
    }
    return parts.join(' • ');
  }
}

export class ProjectsViewProvider implements vscode.TreeDataProvider<ProjectItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ProjectItem | undefined | null | void> = 
    new vscode.EventEmitter<ProjectItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<ProjectItem | undefined | null | void> = 
    this._onDidChangeTreeData.event;

  private client: McpClient | null = null;
  private projects: Project[] = [];
  private total: number = 0;
  private limit: number = 50;
  private offset: number = 0;
  private searchQuery: string = '';
  private includeInactive: boolean = false;
  private treeView: vscode.TreeView<ProjectItem> | null = null;
  private _isLoading = false;

  constructor(private context: vscode.ExtensionContext) {}

  setTreeView(treeView: vscode.TreeView<ProjectItem>): void {
    this.treeView = treeView;
    this.updateTitle();
  }

  setClient(client: McpClient): void {
    log('ProjectsViewProvider.setClient called', { hasClient: !!client });
    const hadClient = !!this.client;
    this.client = client;
    
    if (!hadClient && client && this.treeView?.visible) {
      log('ProjectsViewProvider.setClient: Client set while view visible, firing change event');
      this._onDidChangeTreeData.fire();
    }
  }

  hasProjects(): boolean {
    return this.projects.length > 0;
  }

  fireTreeDataChange(): void {
    log('ProjectsViewProvider.fireTreeDataChange called');
    this._onDidChangeTreeData.fire();
  }

  private updateTitle(): void {
    if (this.treeView) {
      this.treeView.title = `Projects (${this.total})`;
    }
  }

  async refresh(): Promise<void> {
    log('ProjectsViewProvider.refresh called', { 
      hasClient: !!this.client,
      currentProjectsCount: this.projects.length,
      offset: this.offset,
      searchQuery: this.searchQuery,
      includeInactive: this.includeInactive
    });
    
    if (!this.client) {
      log('ProjectsViewProvider.refresh: No client, returning early');
      return;
    }

    try {
      this.offset = 0;
      await this.loadProjects();
    } catch (error) {
      log('ProjectsViewProvider.refresh: ERROR', { error: error instanceof Error ? error.message : String(error) });
      vscode.window.showErrorMessage(
        `Failed to load projects: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async loadMore(): Promise<void> {
    log('ProjectsViewProvider.loadMore called', { 
      currentOffset: this.offset,
      currentCount: this.projects.length,
      total: this.total
    });
    
    if (!this.client) {
      return;
    }

    try {
      this.offset += this.limit;
      await this.loadProjects(true);
    } catch (error) {
      log('ProjectsViewProvider.loadMore: ERROR', { error: error instanceof Error ? error.message : String(error) });
      vscode.window.showErrorMessage(
        `Failed to load more projects: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async setSearch(query: string): Promise<void> {
    log('ProjectsViewProvider.setSearch called', { query });
    this.searchQuery = query;
    this.offset = 0;
    await this.refresh();
  }

  async clearSearch(): Promise<void> {
    log('ProjectsViewProvider.clearSearch called');
    this.searchQuery = '';
    this.offset = 0;
    await this.refresh();
  }

  async toggleIncludeInactive(): Promise<void> {
    log('ProjectsViewProvider.toggleIncludeInactive called', { current: this.includeInactive });
    this.includeInactive = !this.includeInactive;
    this.offset = 0;
    await this.refresh();
  }

  private async loadProjects(append: boolean = false): Promise<void> {
    if (!this.client) {
      return;
    }

    const args: Record<string, unknown> = {
      limit: this.limit,
      offset: this.offset,
      includeInactive: this.includeInactive,
    };

    if (this.searchQuery) {
      args.search = this.searchQuery;
    }

    log('ProjectsViewProvider.loadProjects: Calling protokoll_list_projects', args);
    
    const response = await this.client.callTool('protokoll_list_projects', args) as ProjectsListResponse;

    log('ProjectsViewProvider.loadProjects: Got response', { 
      projectsCount: response.projects.length,
      total: response.total,
      limit: response.limit,
      offset: response.offset
    });

    if (append) {
      this.projects = [...this.projects, ...response.projects];
    } else {
      this.projects = response.projects;
    }
    
    this.total = response.total;
    this.updateTitle();
    this._onDidChangeTreeData.fire();
    log('ProjectsViewProvider.loadProjects: Fired tree data change event');
  }

  getTreeItem(element: ProjectItem): vscode.TreeItem {
    return element;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getParent(_element: ProjectItem): vscode.ProviderResult<ProjectItem> {
    return null;
  }

  async getChildren(element?: ProjectItem): Promise<ProjectItem[]> {
    log('ProjectsViewProvider.getChildren called', { 
      hasElement: !!element,
      elementType: element?.type,
      projectsCount: this.projects.length,
      hasClient: !!this.client,
      isLoading: this._isLoading
    });
    
    if (!element && this.projects.length === 0 && this.client && !this._isLoading) {
      this._isLoading = true;
      log('ProjectsViewProvider.getChildren: Starting auto-load');
      try {
        await this.refresh();
        log('ProjectsViewProvider.getChildren: Auto-load completed', { projectsCount: this.projects.length });
      } catch (error) {
        log('ProjectsViewProvider.getChildren: Auto-load FAILED', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        this._isLoading = false;
      }
    }

    if (!element) {
      const items: ProjectItem[] = this.projects.map(project => new ProjectItem('project', project));
      
      if (this.projects.length < this.total) {
        items.push(new ProjectItem('load-more', undefined, 'Load More...'));
      }
      
      return items;
    }

    return [];
  }
}
