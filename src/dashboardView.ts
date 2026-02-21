/**
 * Dashboard View Provider
 *
 * Singleton WebviewPanel that shows the Protokoll Welcome/Dashboard:
 * - Upload button (Step 6)
 * - Project stats table with colour-coded status columns (Step 7)
 * - Active transcription queue with retry/cancel/navigate (Step 8)
 * - SSE-driven live updates with 120-second fallback poll (Step 9)
 *
 * lit-html is loaded as an ES module import from unpkg so there is no
 * build step. All rendering happens inside a single <script type="module">
 * block inside the webview HTML.
 */

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { McpClient } from './mcpClient';
import { UploadService } from './uploadService';

/** Shape of an inbound message from the webview */
interface WebviewMessage {
  type: string;
  uuid?: string;
  projectId?: string | null;
}

export class DashboardViewProvider {
  public static readonly viewType = 'protokoll.dashboard';

  private _panel: vscode.WebviewPanel | null = null;
  private _mcpClient: McpClient | null = null;
  // _uploadService is retained for use by future steps; the upload command is
  // routed back through executeCommand so this step doesn't call it directly.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private _uploadService: UploadService | null = null;

  /** SSE notification unsubscribe functions; cleared when client changes. */
  private _sseUnsubscribers: Array<() => void> = [];
  /** 120-second watchdog: fires a manual refresh if no SSE arrives while visible. */
  private _watchdogTimer: NodeJS.Timeout | undefined;
  /** 500ms debounce: coalesces rapid SSE events into a single refresh. */
  private _debounceTimer: NodeJS.Timeout | undefined;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  setClient(client: McpClient): void {
    // Tear down handlers from any previous client before switching
    this._unregisterSseHandlers();
    this._mcpClient = client;

    // notifications/resources_changed — broad "something changed" event (no URI)
    const unsub1 = client.onNotification('notifications/resources_changed', () => {
      if (this._panel?.visible) {
        this._scheduleDebouncedRefresh();
        this._startWatchdog(); // reset the 120s countdown
      }
    });

    // notifications/resource_changed — specific resource changed (has params.uri)
    const unsub2 = client.onNotification('notifications/resource_changed', (data: unknown) => {
      const params = data as { uri?: string };
      const isTranscriptRelated =
        !params.uri || params.uri.startsWith('protokoll://transcript');
      if (isTranscriptRelated && this._panel?.visible) {
        this._scheduleDebouncedRefresh();
        this._startWatchdog();
      }
    });

    this._sseUnsubscribers.push(unsub1, unsub2);
  }

  setUploadService(service: UploadService): void {
    this._uploadService = service;
  }

  /**
   * Open the dashboard, or reveal it if already open.
   * Called from protokoll.openDashboard command and auto-open on activation.
   */
  async show(): Promise<void> {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One);
    } else {
      this._panel = vscode.window.createWebviewPanel(
        DashboardViewProvider.viewType,
        'Protokoll Dashboard',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this._extensionUri],
        }
      );
      this._panel.iconPath = new vscode.ThemeIcon('dashboard');

      this._panel.webview.html = this._getHtml();

      this._panel.webview.onDidReceiveMessage(
        async (message: WebviewMessage) => {
          await this._handleWebviewMessage(message);
        },
        null
      );

      // Refresh and start/stop watchdog when the panel is shown/hidden
      this._panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          this._scheduleDebouncedRefresh();
          this._startWatchdog();
        } else {
          this._clearWatchdog();
        }
      });

      this._panel.onDidDispose(() => {
        this._clearAllTimers();
        this._unregisterSseHandlers();
        this._panel = null;
      });
    }

    // Push initial data immediately after the panel is ready, then start watchdog
    await this._refreshData();
    this._startWatchdog();
  }

  /** Send a typed message to the webview. No-ops when the panel is not open. */
  postMessage(message: unknown): void {
    this._panel?.webview.postMessage(message);
  }

  /**
   * Fetch queue + worker status from MCP and push to the webview.
   * Steps 7 and 8 will extend this to include full stats and enriched queue.
   */
  async refreshData(): Promise<void> {
    await this._refreshData();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Start (or restart) the 120-second watchdog timer. */
  private _startWatchdog(): void {
    this._clearWatchdog();
    this._watchdogTimer = setInterval(() => {
      if (this._panel?.visible) {
        console.log('Protokoll: [DASHBOARD] Watchdog fired — polling data');
        void this._refreshData();
      }
    }, 120_000);
  }

  /** Stop the watchdog timer without replacing it. */
  private _clearWatchdog(): void {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = undefined;
    }
  }

  /** Clear both the watchdog and any pending debounce timer. */
  private _clearAllTimers(): void {
    this._clearWatchdog();
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = undefined;
    }
  }

  /**
   * Schedule a refresh 500 ms from now; if called again before the timeout
   * fires, the previous timeout is cancelled (debounce).
   */
  private _scheduleDebouncedRefresh(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(async () => {
      this._debounceTimer = undefined;
      await this._refreshData();
    }, 500);
  }

  /** Remove all SSE notification subscriptions (e.g. when client swaps out). */
  private _unregisterSseHandlers(): void {
    for (const unsub of this._sseUnsubscribers) {
      unsub();
    }
    this._sseUnsubscribers = [];
  }

  private async _refreshData(): Promise<void> {
    if (!this._mcpClient || !this._panel) {
      return;
    }

    try {
      const [queueData, workerStatus, stats] = await Promise.all([
        this._fetchQueueData(),
        this._mcpClient.getWorkerStatus(),
        this._fetchStats(),
      ]);

      this.postMessage({ type: 'update-queue', data: queueData });
      this.postMessage({ type: 'update-worker', data: workerStatus });
      this.postMessage({ type: 'update-stats', data: stats });
    } catch (err) {
      console.error('Protokoll: [DASHBOARD] Failed to refresh data:', err);
    }
  }

  /**
   * Fetch queue status and enrich recent items with transcript details
   * (errorDetails, title, project) for display in the queue table.
   */
  private async _fetchQueueData(): Promise<{
    pending: Array<{ uuid: string; filename: string; uploadedAt?: string }>;
    processing: Array<{ uuid: string; filename: string; startedAt?: string }>;
    recent: Array<{
      uuid: string;
      filename: string;
      completedAt?: string;
      status: string;
      errorDetails?: string;
      title?: string;
      project?: string;
    }>;
    totalPending: number;
  }> {
    if (!this._mcpClient) {
      return { pending: [], processing: [], recent: [], totalPending: 0 };
    }

    try {
      const queueStatus = await this._mcpClient.getQueueStatus();
      const recent = queueStatus.recent ?? [];

      const enrichedRecent = await Promise.all(
        recent.map(async (item) => {
          try {
            const detail = await this._mcpClient!.getTranscriptByUuid(item.uuid);
            const meta = detail.metadata as Record<string, unknown> | undefined;
            return {
              ...item,
              errorDetails: meta?.errorDetails as string | undefined,
              title: meta?.title as string | undefined,
              project: meta?.project as string | undefined,
            };
          } catch {
            return item;
          }
        })
      );

      return {
        pending: queueStatus.pending ?? [],
        processing: queueStatus.processing ?? [],
        recent: enrichedRecent,
        totalPending: queueStatus.totalPending ?? 0,
      };
    } catch (err) {
      console.error('Protokoll: [DASHBOARD] Failed to fetch queue data:', err);
      return { pending: [], processing: [], recent: [], totalPending: 0 };
    }
  }

  /**
   * Fetch transcript statistics: total count and per-project status breakdown.
   * Uses listTranscripts to build stats; groups by project (entities.projects),
   * counts by status. Transcripts without a project appear under "Unassigned".
   */
  private async _fetchStats(): Promise<{
    totalCount: number;
    projects: Array<{ id: string | null; name: string; total: number; statuses: Record<string, number> }>;
  }> {
    if (!this._mcpClient) {
      return { totalCount: 0, projects: [] };
    }

    try {
      const result = await this._mcpClient.listTranscripts({ limit: 10000 });
      const transcripts = result.transcripts ?? [];

      const projectMap = new Map<string, { id: string | null; statuses: Record<string, number> }>();
      let totalCount = 0;

      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      // Maps lowercase project name → canonical (first-seen) display name, for case-insensitive grouping
      const nameCanonical = new Map<string, string>();

      for (const t of transcripts) {
        totalCount++;
        const projectEntity = t.entities?.projects?.[0];
        const rawName = projectEntity?.name;
        // If the stored project name is a UUID it's corrupted data — treat as unassigned
        const rawProjectName = (rawName && !UUID_RE.test(rawName)) ? rawName : 'Unassigned';
        // Merge projects that differ only by case (use the first-seen casing as the canonical name)
        const lowerKey = rawProjectName.toLowerCase();
        if (!nameCanonical.has(lowerKey)) {
          nameCanonical.set(lowerKey, rawProjectName);
        }
        const projectName = nameCanonical.get(lowerKey)!;
        const projectId = (projectName !== 'Unassigned' ? projectEntity?.id : null) ?? null;
        if (!projectMap.has(projectName)) {
          projectMap.set(projectName, { id: projectId, statuses: {} });
        }
        const entry = projectMap.get(projectName)!;
        // Normalise legacy 'open' status to 'in_progress'
        const rawStatus: string = t.status ?? 'unknown';
        const status = rawStatus === 'open' ? 'in_progress' : rawStatus;
        entry.statuses[status] = (entry.statuses[status] ?? 0) + 1;
      }

      const projects = Array.from(projectMap.entries())
        .map(([name, { id, statuses }]) => ({
          id,
          name,
          total: Object.values(statuses).reduce((a, b) => a + b, 0),
          statuses,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return { totalCount, projects };
    } catch (err) {
      console.error('Protokoll: [DASHBOARD] Failed to fetch stats:', err);
      return { totalCount: 0, projects: [] };
    }
  }

  private async _handleWebviewMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'upload':
        await vscode.commands.executeCommand('protokoll.uploadAudio');
        break;

      case 'refresh':
        await this._refreshData();
        break;

      case 'retry':
        if (message.uuid && this._mcpClient) {
          try {
            await this._mcpClient.retryTranscription(message.uuid);
            vscode.window.showInformationMessage(
              `Retrying transcription ${message.uuid.substring(0, 8)}...`
            );
            await this._refreshData();
          } catch (err) {
            vscode.window.showErrorMessage(
              `Retry failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        break;

      case 'cancel':
        if (message.uuid && this._mcpClient) {
          const confirmed = await vscode.window.showWarningMessage(
            `Cancel transcription ${message.uuid.substring(0, 8)}?`,
            { modal: true },
            'Cancel Transcription'
          );
          if (confirmed === 'Cancel Transcription') {
            try {
              await this._mcpClient.cancelTranscription(message.uuid);
              vscode.window.showInformationMessage('Transcription cancelled.');
              await this._refreshData();
            } catch (err) {
              vscode.window.showErrorMessage(
                `Cancel failed: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        }
        break;

      case 'filter-project':
        await vscode.commands.executeCommand('protokoll.applyProjectFilter', message.projectId ?? null);
        break;

      case 'navigate':
        if (message.uuid && this._mcpClient) {
          try {
            const detail = await this._mcpClient.getTranscriptByUuid(message.uuid);
            if (detail.found && detail.filePath) {
              const uri = `protokoll://transcript/${detail.filePath}`;
              await vscode.commands.executeCommand('protokoll.openTranscript', uri, {
                uri,
                path: detail.filePath,
                filename: detail.filePath.split('/').pop() || '',
                date: '',
              });
            } else {
              vscode.window.showWarningMessage('Transcript not found or not yet ready to open.');
            }
          } catch (err) {
            vscode.window.showErrorMessage(
              `Could not open transcript: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        break;
    }
  }

  /**
   * Build the full webview HTML.
   *
   * A single <script type="module"> block:
   *   1. Imports html/render from lit-html via CDN (no build step required)
   *   2. Acquires the VS Code API handle
   *   3. Wires button click handlers
   *   4. Listens for host → webview messages
   *   5. Renders the project stats table and active transcription queue
   *
   * The nonce is fresh per panel creation, satisfying VS Code's CSP
   * requirement for inline scripts.
   */
  private _getHtml(): string {
    const nonce = randomUUID().replace(/-/g, '');

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 script-src https://unpkg.com 'nonce-${nonce}';
                 style-src 'unsafe-inline';">
  <title>Protokoll Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.5;
      padding: 20px 28px;
    }

    #app { max-width: 1200px; }

    /* ── Header ─────────────────────────────────────────────────────────── */
    .dashboard-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 28px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
    }

    .dashboard-header h1 {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -.3px;
    }

    .header-actions { display: flex; gap: 8px; align-items: center; }

    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 5px 12px;
      border-radius: 3px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }

    .btn-secondary {
      background: transparent;
      color: var(--vscode-editor-foreground);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
    }
    .btn-secondary:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,.1));
    }

    /* ── Sections ───────────────────────────────────────────────────────── */
    section { margin-bottom: 32px; }

    .section-heading {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 10px;
    }

    .placeholder {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 12px;
      padding: 4px 0;
    }

    #stats-section, #queue-section { min-height: 48px; }

    /* ── Stats table (Step 7) ───────────────────────────────────────────── */
    .stats-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }

    .stats-header h2 {
      margin: 0;
      color: var(--vscode-editor-foreground);
    }

    .total-badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 12px;
    }

    .stats-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .stats-table th {
      text-align: left;
      padding: 8px 6px;
      border-bottom: 1px solid var(--vscode-widget-border);
      color: var(--vscode-descriptionForeground);
      font-weight: 500;
      font-size: 11px;
      text-transform: capitalize;
      white-space: nowrap;
    }

    .stats-table td {
      padding: 6px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    }

    .clickable-row {
      cursor: pointer;
    }

    .clickable-row:hover td {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    }

    .project-name {
      font-weight: 500;
      color: var(--vscode-editor-foreground);
    }

    .count-cell {
      text-align: center;
      min-width: 32px;
    }

    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 4px;
    }

    .status-count {
      font-weight: 600;
    }

    .zero {
      color: var(--vscode-disabledForeground);
    }

    /* ── Queue table (Step 8) ────────────────────────────────────────────── */
    .queue-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 24px 0 16px 0;
    }

    .queue-header h2 {
      margin: 0;
      color: var(--vscode-editor-foreground);
    }

    .pending-badge {
      background: #ffc107;
      color: #000;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 600;
    }

    .idle-badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 12px;
    }

    .queue-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .queue-table th {
      text-align: left;
      padding: 8px 6px;
      border-bottom: 1px solid var(--vscode-widget-border);
      color: var(--vscode-descriptionForeground);
      font-weight: 500;
      font-size: 11px;
    }

    .queue-table td {
      padding: 6px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    }

    .queue-row.clickable {
      cursor: pointer;
    }

    .queue-row.clickable:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .filename {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }

    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      color: #fff;
      font-size: 11px;
      font-weight: 500;
      text-transform: capitalize;
    }

    .action-btn {
      background: none;
      border: 1px solid var(--vscode-button-border, var(--vscode-widget-border));
      color: var(--vscode-button-foreground);
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 11px;
      cursor: pointer;
      margin-right: 4px;
    }

    .retry-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .retry-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .cancel-btn:hover {
      background: var(--vscode-errorForeground);
      color: #fff;
    }

    .error-row td {
      padding: 4px 6px 8px 6px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    }

    .error-details {
      color: var(--vscode-errorForeground);
      font-size: 12px;
      font-style: italic;
    }

    .error-icon {
      margin-right: 4px;
    }

    .empty-message {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 16px 0;
    }

    .time {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div id="app">
    <header class="dashboard-header">
      <h1>Protokoll Dashboard</h1>
      <div class="header-actions">
        <button class="btn btn-secondary" id="refresh-btn" title="Refresh data">↺ Refresh</button>
        <button class="btn" id="upload-btn" title="Upload an audio file for transcription">⬆ Upload Audio</button>
      </div>
    </header>

    <section id="stats-section">
      <div class="placeholder">Loading statistics…</div>
    </section>

    <section id="queue-section">
      <div class="placeholder">Loading queue…</div>
    </section>
  </div>

  <!--
    Single module script.
    • Imports lit-html from CDN (no build step).
    • Uses acquireVsCodeApi() which is injected globally by VS Code.
    • renderStats renders the project stats table with per-status colour coding.
    • renderQueue renders the active transcription queue with retry/cancel/navigate.
  -->
  <script type="module" nonce="${nonce}">
    import { html, render } from 'https://unpkg.com/lit-html@3/lit-html.js';

    const vscode = acquireVsCodeApi();

    // ── Button handlers ──────────────────────────────────────────────────
    document.getElementById('upload-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'upload' });
    });

    document.getElementById('refresh-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    // ── Extension → webview messages ─────────────────────────────────────
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'update-stats':  renderStats(msg.data);  break;
        case 'update-queue':  renderQueue(msg.data);  break;
        case 'update-worker': /* Worker badge — Step 9 */ break;
      }
    });

    // ── Stats (Step 7: project table with color-coded status columns) ───
    const STATUS_COLORS = {
      'uploaded': '#6c757d',
      'transcribing': '#ffc107',
      'error': '#dc3545',
      'initial': '#17a2b8',
      'enhanced': '#007bff',
      'reviewed': '#28a745',
      'in_progress': '#fd7e14',
      'closed': '#6f42c1',
      'archived': '#343a40',
      'unknown': '#6c757d'
    };

    const ALL_STATUSES = ['uploaded', 'transcribing', 'error', 'initial', 'enhanced', 'reviewed', 'in_progress', 'closed', 'archived', 'unknown'];

    function renderStats(data) {
      const root = document.getElementById('stats-section');
      if (!root) return;

      if (data.totalCount === null || data.totalCount === undefined) {
        render(html\`<div class="placeholder">Statistics loading…</div>\`, root);
        return;
      }

      const { totalCount, projects } = data;
      const template = html\`
        <div class="stats-header">
          <h2>Transcripts</h2>
          <span class="total-badge">\${totalCount} total</span>
        </div>
        <table class="stats-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Total</th>
              \${ALL_STATUSES.map(s => html\`
                <th>
                  <span class="status-dot" style="background:\${STATUS_COLORS[s] || '#6c757d'}"></span>
                  \${s}
                </th>
              \`)}
            </tr>
          </thead>
          <tbody>
            \${projects.length === 0
              ? html\`<tr><td colspan="12" class="placeholder">No transcripts yet</td></tr>\`
              : projects.map(p => html\`
                <tr class="clickable-row" @click=\${() => vscode.postMessage({ type: 'filter-project', projectId: p.id })}>
                  <td class="project-name">\${p.name}</td>
                  <td class="count-cell">\${p.total}</td>
                  \${ALL_STATUSES.map(s => html\`
                    <td class="count-cell">
                      \${p.statuses[s]
                        ? html\`<span class="status-count" style="color:\${STATUS_COLORS[s] || '#6c757d'}">\${p.statuses[s]}</span>\`
                        : html\`<span class="zero">—</span>\`}
                    </td>
                  \`)}
                </tr>
              \`)}
          </tbody>
        </table>
      \`;
      render(template, root);
    }

    // ── Utilities ────────────────────────────────────────────────────────────
    /**
     * Format an ISO timestamp as a short human-readable string.
     * Within 24 h: "5 min ago", "2 hrs ago". Older: locale short date.
     */
    function formatTime(iso) {
      if (!iso) return '—';
      try {
        const diffMs = Date.now() - new Date(iso).getTime();
        if (isNaN(diffMs)) return iso;
        const diffMin = Math.round(diffMs / 60000);
        if (diffMin < 2) return 'just now';
        if (diffMin < 60) return \`\${diffMin} min ago\`;
        const diffHrs = Math.round(diffMin / 60);
        if (diffHrs < 24) return \`\${diffHrs} hr\${diffHrs === 1 ? '' : 's'} ago\`;
        return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      } catch {
        return iso;
      }
    }

    // ── Queue (Step 8: active transcription table with retry/cancel/navigate) ─
    function navigateToTranscript(uuid) {
      vscode.postMessage({ type: 'navigate', uuid });
    }
    function retryTranscription(uuid) {
      vscode.postMessage({ type: 'retry', uuid });
    }
    function cancelTranscription(uuid) {
      vscode.postMessage({ type: 'cancel', uuid });
    }

    function renderQueue(data) {
      const root = document.getElementById('queue-section');
      if (!root) return;

      if (!data || (data.pending?.length === 0 && data.processing?.length === 0 && data.recent?.length === 0)) {
        render(html\`
          <div class="queue-header">
            <h2>Transcription Queue</h2>
            <span class="idle-badge">Idle</span>
          </div>
          <p class="empty-message">No recent transcription activity.</p>
        \`, root);
        return;
      }

      const pending = data.pending ?? [];
      const processing = data.processing ?? [];
      const recent = data.recent ?? [];
      const totalPending = data.totalPending ?? 0;

      const allItems = [
        ...processing.map(item => ({ ...item, queueStatus: 'transcribing' })),
        ...pending.map(item => ({ ...item, queueStatus: 'uploaded' })),
        ...recent.map(item => ({ ...item, queueStatus: item.status ?? 'unknown' })),
      ];

      const template = html\`
        <div class="queue-header">
          <h2>Transcription Queue</h2>
          \${totalPending > 0
            ? html\`<span class="pending-badge">\${totalPending} pending</span>\`
            : html\`<span class="idle-badge">Idle</span>\`}
        </div>
        <table class="queue-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Title</th>
              <th>Status</th>
              <th>Time</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            \${allItems.map(item => html\`
              <tr class="queue-row clickable" @click=\${() => navigateToTranscript(item.uuid)}>
                <td class="filename">\${item.filename || '—'}</td>
                <td class="title">\${item.title ?? '—'}</td>
                <td>
                  <span class="status-badge" style="background:\${STATUS_COLORS[item.queueStatus] || '#6c757d'}">
                    \${item.queueStatus}
                  </span>
                </td>
                <td class="time" title="\${item.uploadedAt || item.startedAt || item.completedAt || ''}">
                  \${formatTime(item.uploadedAt || item.startedAt || item.completedAt)}
                </td>
                <td class="actions" @click=\${(e) => e.stopPropagation()}>
                  \${item.queueStatus === 'error' ? html\`
                    <button class="action-btn retry-btn" @click=\${() => retryTranscription(item.uuid)}>
                      Retry
                    </button>
                  \` : ''}
                  \${(item.queueStatus === 'uploaded' || item.queueStatus === 'transcribing') ? html\`
                    <button class="action-btn cancel-btn" @click=\${() => cancelTranscription(item.uuid)}>
                      Cancel
                    </button>
                  \` : ''}
                </td>
              </tr>
              \${item.errorDetails ? html\`
                <tr class="error-row">
                  <td colspan="5" class="error-details">
                    <span class="error-icon">⚠</span> \${item.errorDetails}
                  </td>
                </tr>
              \` : ''}
            \`)}
          </tbody>
        </table>
      \`;
      render(template, root);
    }
  </script>
</body>
</html>`;
  }
}
