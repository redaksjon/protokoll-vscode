/**
 * Main extension entry point
 */

import * as vscode from 'vscode';
import { McpClient } from './mcpClient';
import { TranscriptsViewProvider, TranscriptItem } from './transcriptsView';
import { TranscriptDetailViewProvider } from './transcriptDetailView';
import { ConnectionStatusViewProvider } from './connectionStatusView';
import { ChatViewProvider } from './chatView';
import type { Transcript, TranscriptContent } from './types';

let mcpClient: McpClient | null = null;
let transcriptsViewProvider: TranscriptsViewProvider | null = null;
let transcriptDetailViewProvider: TranscriptDetailViewProvider | null = null;
let connectionStatusViewProvider: ConnectionStatusViewProvider | null = null;
let chatViewProvider: ChatViewProvider | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('Protokoll extension is now active');

  // Initialize MCP client
  const config = vscode.workspace.getConfiguration('protokoll');
  const serverUrl = config.get<string>('serverUrl', 'http://127.0.0.1:3001');
  const hasConfiguredUrl = context.globalState.get<boolean>('protokoll.hasConfiguredUrl', false);

  // Check if server URL is configured or if we should prompt
  if (!serverUrl || serverUrl === '') {
    // Prompt user to configure server URL
    const action = await vscode.window.showInformationMessage(
      'Protokoll: Please configure the server URL',
      'Configure'
    );

    if (action === 'Configure') {
      await vscode.commands.executeCommand('protokoll.configureServer');
    }
    return;
  }

  // Initialize client and check health
  let serverConnected = false;
  let shouldPromptForConfig = false;
  
  try {
    mcpClient = new McpClient(serverUrl);
    
    // Check server health
    const isHealthy = await mcpClient.healthCheck();
    if (!isHealthy) {
      // If server is not healthy and user hasn't configured URL yet, we'll prompt them
      if (!hasConfiguredUrl) {
        shouldPromptForConfig = true;
      } else {
        // User has configured it before, just show a warning
        vscode.window.showWarningMessage(
          `Protokoll: Server at ${serverUrl} is not responding. Please check if the server is running.`
        );
      }
    } else {
      // Initialize MCP session
      try {
        await mcpClient.initialize();
        serverConnected = true;
        const sessionId = mcpClient.getSessionId();
        vscode.window.showInformationMessage(`Protokoll: Connected to ${serverUrl}`);
        
        // Update connection status view
        if (connectionStatusViewProvider) {
          connectionStatusViewProvider.setClient(mcpClient);
          connectionStatusViewProvider.setConnectionStatus(true, sessionId);
        }
        
        // Subscribe to resource list change notifications (for transcript list)
        console.log('Protokoll: [EXTENSION] Registering notification handler for resources_changed');
        mcpClient.onNotification('notifications/resources_changed', () => {
          console.log('Protokoll: [EXTENSION] 📢 Received resources_changed notification, refreshing transcripts');
          if (transcriptsViewProvider) {
            transcriptsViewProvider.refresh();
          } else {
            console.warn('Protokoll: [EXTENSION] ⚠️ transcriptsViewProvider is null, cannot refresh');
          }
        });
        
        // Subscribe to individual resource change notifications
        console.log('Protokoll: [EXTENSION] Registering notification handler for resource_changed');
        mcpClient.onNotification('notifications/resource_changed', async (data: unknown) => {
          const params = data as { uri?: string };
          console.log('Protokoll: [EXTENSION] 📢 Received resource_changed notification');
          console.log(`Protokoll: [EXTENSION] Resource URI: ${params.uri || '(none)'}`);
          
          if (!params.uri) {
            console.warn('Protokoll: [EXTENSION] ⚠️ Notification has no URI parameter');
            return;
          }
          
          // Check if this is a transcript list URI
          if (params.uri.startsWith('protokoll://transcripts')) {
            console.log('Protokoll: [EXTENSION] This is a transcripts list URI, refreshing list');
            if (transcriptsViewProvider) {
              await transcriptsViewProvider.refresh();
            } else {
              console.warn('Protokoll: [EXTENSION] ⚠️ transcriptsViewProvider is null');
            }
            return;
          }
          
          // Check if this is an individual transcript URI
          if (params.uri.startsWith('protokoll://transcript/')) {
            console.log('Protokoll: [EXTENSION] This is an individual transcript URI, refreshing if open');
            console.log(`Protokoll: [EXTENSION] Notification URI: ${params.uri}`);
            if (transcriptDetailViewProvider) {
              // Refresh the transcript view if it's open
              const currentTranscript = transcriptDetailViewProvider.getCurrentTranscript(params.uri);
              if (currentTranscript) {
                console.log('Protokoll: [EXTENSION] ✅ Transcript is currently open, refreshing...');
                console.log(`Protokoll: [EXTENSION] Stored URI: ${currentTranscript.uri}`);
                await transcriptDetailViewProvider.refreshTranscript(params.uri);
              } else {
                console.log('Protokoll: [EXTENSION] ⚠️ Transcript is not currently open, skipping refresh');
                console.log(`Protokoll: [EXTENSION] Looking for URI: ${params.uri}`);
              }
            } else {
              console.warn('Protokoll: [EXTENSION] ⚠️ transcriptDetailViewProvider is null');
            }
          } else {
            console.log(`Protokoll: [EXTENSION] Unknown URI type: ${params.uri}`);
          }
        });

        // Register callback to re-subscribe after session recovery
        mcpClient.onSessionRecovered(async () => {
          console.log('Protokoll: [EXTENSION] Session recovered, re-subscribing to transcripts list...');
          try {
            const config = vscode.workspace.getConfiguration('protokoll');
            const transcriptsDir = config.get<string>('transcriptsDirectory', '');
            if (transcriptsDir && mcpClient) {
              const params = new URLSearchParams();
              params.set('directory', transcriptsDir);
              const transcriptsListUri = `protokoll://transcripts?${params.toString()}`;
              await mcpClient.subscribeToResource(transcriptsListUri);
              console.log(`Protokoll: [EXTENSION] ✅ Re-subscribed to transcripts list after recovery`);
            }
          } catch (error) {
            console.warn('Protokoll: [EXTENSION] ⚠️ Failed to re-subscribe after recovery:', error);
          }
        });
      } catch (initError) {
        vscode.window.showWarningMessage(
          `Protokoll: Connected to server but initialization failed: ${initError instanceof Error ? initError.message : String(initError)}`
        );
        if (connectionStatusViewProvider) {
          connectionStatusViewProvider.setConnectionStatus(false, null);
        }
      }
    }
  } catch (error) {
    // If connection fails and user hasn't configured URL, we'll prompt them
    if (!hasConfiguredUrl) {
      shouldPromptForConfig = true;
    } else {
      vscode.window.showErrorMessage(
        `Protokoll: Failed to connect to server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (connectionStatusViewProvider) {
      connectionStatusViewProvider.setConnectionStatus(false, null);
    }
  }

  // Prompt user to configure if needed (do this after initializing views so commands are available)
  if (shouldPromptForConfig) {
    // Use setTimeout to ensure the extension is fully initialized
    setTimeout(async () => {
      const action = await vscode.window.showInformationMessage(
        `Protokoll: Server at ${serverUrl} is not responding. Please configure your Protokoll HTTP MCP server URL.`,
        'Configure Server URL'
      );

      if (action === 'Configure Server URL') {
        await vscode.commands.executeCommand('protokoll.configureServer');
      }
    }, 500);
  }

  // Initialize view providers even if server isn't connected yet
  // User can configure and reconnect later
  transcriptsViewProvider = new TranscriptsViewProvider(context);
  if (mcpClient) {
    transcriptsViewProvider.setClient(mcpClient);
  }

  transcriptDetailViewProvider = new TranscriptDetailViewProvider(context.extensionUri);
  if (mcpClient) {
    transcriptDetailViewProvider.setClient(mcpClient);
  }
  if (chatViewProvider) {
    transcriptDetailViewProvider.setChatProvider(chatViewProvider);
  }

  connectionStatusViewProvider = new ConnectionStatusViewProvider(context);
  if (mcpClient) {
    connectionStatusViewProvider.setClient(mcpClient);
    connectionStatusViewProvider.setConnectionStatus(serverConnected, mcpClient.getSessionId());
  } else {
    connectionStatusViewProvider.setServerUrl(serverUrl);
  }

  chatViewProvider = new ChatViewProvider(context.extensionUri);
  if (mcpClient) {
    chatViewProvider.setClient(mcpClient);
  }

  // Register tree views
  const transcriptsTreeView = vscode.window.createTreeView('protokollTranscripts', {
    treeDataProvider: transcriptsViewProvider,
    showCollapseAll: false,
  });

  const connectionStatusTreeView = vscode.window.createTreeView('protokollConnectionStatus', {
    treeDataProvider: connectionStatusViewProvider,
    showCollapseAll: false,
  });

  // Register commands
  const showTranscriptsCommand = vscode.commands.registerCommand(
    'protokoll.showTranscripts',
    async () => {
      if (!transcriptsViewProvider) {
        return;
      }
      await transcriptsViewProvider.refresh();
    }
  );

  const configureServerCommand = vscode.commands.registerCommand(
    'protokoll.configureServer',
    async () => {
      const config = vscode.workspace.getConfiguration('protokoll');
      const currentUrl = config.get<string>('serverUrl', 'http://127.0.0.1:3001');
      
      const input = await vscode.window.showInputBox({
        prompt: 'Enter the Protokoll HTTP MCP server URL',
        value: currentUrl,
        placeHolder: 'http://127.0.0.1:3001',
        validateInput: (value) => {
          if (!value || value.trim() === '') {
            return 'Server URL cannot be empty';
          }
          try {
            new URL(value);
            return null;
          } catch {
            return 'Invalid URL format';
          }
        },
      });

      if (input) {
        await config.update('serverUrl', input.trim(), true);
        
        // Mark that user has configured the URL
        await context.globalState.update('protokoll.hasConfiguredUrl', true);
        
        vscode.window.showInformationMessage(`Protokoll: Server URL updated to ${input.trim()}`);
        
        // Reinitialize client
        try {
          mcpClient = new McpClient(input.trim());
          const isHealthy = await mcpClient.healthCheck();
          if (isHealthy) {
            await mcpClient.initialize();
            const sessionId = mcpClient.getSessionId();
            if (transcriptsViewProvider) {
              transcriptsViewProvider.setClient(mcpClient);
              // Refresh transcripts after reconnecting
              await transcriptsViewProvider.refresh();
            }
            if (transcriptDetailViewProvider) {
              transcriptDetailViewProvider.setClient(mcpClient);
            }
            if (connectionStatusViewProvider) {
              connectionStatusViewProvider.setClient(mcpClient);
              connectionStatusViewProvider.setServerUrl(input.trim());
              connectionStatusViewProvider.setConnectionStatus(true, sessionId);
            }
            if (chatViewProvider) {
              chatViewProvider.setClient(mcpClient);
            }
            vscode.window.showInformationMessage(`Protokoll: Connected to ${input.trim()}`);
          } else {
            vscode.window.showWarningMessage('Protokoll: Server is not responding');
            // Still set the client so user can try to refresh later
            if (transcriptsViewProvider) {
              transcriptsViewProvider.setClient(mcpClient);
            }
            if (transcriptDetailViewProvider) {
              transcriptDetailViewProvider.setClient(mcpClient);
            }
            if (connectionStatusViewProvider) {
              connectionStatusViewProvider.setClient(mcpClient);
              connectionStatusViewProvider.setServerUrl(input.trim());
              connectionStatusViewProvider.setConnectionStatus(false, null);
            }
            if (chatViewProvider) {
              chatViewProvider.setClient(mcpClient);
            }
          }
        } catch (error) {
          vscode.window.showErrorMessage(
            `Protokoll: Failed to connect: ${error instanceof Error ? error.message : String(error)}`
          );
          if (connectionStatusViewProvider) {
            connectionStatusViewProvider.setClient(null);
            connectionStatusViewProvider.setServerUrl(input.trim());
            connectionStatusViewProvider.setConnectionStatus(false, null);
          }
        }
      }
    }
  );

  const openTranscriptCommand = vscode.commands.registerCommand(
    'protokoll.openTranscript',
    async (uri: string, transcript: Transcript) => {
      if (!transcriptDetailViewProvider) {
        return;
      }
      await transcriptDetailViewProvider.showTranscript(uri, transcript);
    }
  );

  const openTranscriptInNewTabCommand = vscode.commands.registerCommand(
    'protokoll.openTranscriptInNewTab',
    async (uri: string, transcript: Transcript) => {
      if (!transcriptDetailViewProvider) {
        return;
      }
      await transcriptDetailViewProvider.showTranscript(uri, transcript, vscode.ViewColumn.Beside, true);
    }
  );

  const refreshTranscriptsCommand = vscode.commands.registerCommand(
    'protokoll.refreshTranscripts',
    async () => {
      if (!transcriptsViewProvider) {
        return;
      }
      await transcriptsViewProvider.refresh();
    }
  );

  const filterByProjectCommand = vscode.commands.registerCommand(
    'protokoll.filterByProject',
    async () => {
      if (!mcpClient || !transcriptsViewProvider) {
        vscode.window.showErrorMessage('MCP client not initialized. Please configure the server URL first.');
        return;
      }

      try {
        // List available projects
        const projectsResult = await mcpClient.callTool('protokoll_list_projects', {}) as {
          projects?: Array<{ id: string; name: string; active?: boolean }>;
        };

        if (!projectsResult.projects || projectsResult.projects.length === 0) {
          vscode.window.showWarningMessage('No projects found.');
          return;
        }

        // Filter to active projects only
        const activeProjects = projectsResult.projects.filter(p => p.active !== false);

        // Get current filter
        const currentFilter = transcriptsViewProvider.getProjectFilter();

        // Build quick pick items
        const items: Array<vscode.QuickPickItem & { id: string | null }> = [
          {
            label: '$(clear-all) Show All Projects',
            description: 'Remove project filter',
            id: null,
          },
          ...activeProjects.map(p => ({
            label: p.name,
            description: p.id === currentFilter ? 'Currently filtered' : p.id,
            id: p.id,
          })),
        ];

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a project to filter transcripts',
        });

        if (selected) {
          transcriptsViewProvider.setProjectFilter(selected.id);
          const message = selected.id
            ? `Filtering transcripts by project: ${selected.label}`
            : 'Showing all transcripts';
          vscode.window.showInformationMessage(`Protokoll: ${message}`);
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to filter by project: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  const startNewSessionCommand = vscode.commands.registerCommand(
    'protokoll.startNewSession',
    async () => {
      if (!mcpClient) {
        vscode.window.showErrorMessage('MCP client not initialized. Please configure the server URL first.');
        return;
      }

      try {
        await mcpClient.startNewSession();
        vscode.window.showInformationMessage('Protokoll: Started new session');
        
        // Refresh transcripts after starting new session
        if (transcriptsViewProvider) {
          await transcriptsViewProvider.refresh();
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to start new session: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  const renameTranscriptCommand = vscode.commands.registerCommand(
    'protokoll.renameTranscript',
    async (item: TranscriptItem) => {
      if (!mcpClient) {
        vscode.window.showErrorMessage('MCP client not initialized. Please configure the server URL first.');
        return;
      }

      if (!item || !item.transcript) {
        vscode.window.showErrorMessage('No transcript selected for renaming.');
        return;
      }

      const currentTitle = item.transcript.title || item.transcript.filename;
      const newTitle = await vscode.window.showInputBox({
        prompt: 'Enter new name for the transcript',
        value: currentTitle,
        placeHolder: 'Transcript name',
        validateInput: (value) => {
          if (!value || value.trim() === '') {
            return 'Transcript name cannot be empty';
          }
          return null;
        },
      });

      if (!newTitle || newTitle.trim() === currentTitle) {
        return; // User cancelled or didn't change the name
      }

      try {
        // Extract transcript path from URI or use filename
        const transcriptPath = item.transcript.path || item.transcript.filename;
        
        // Call the edit transcript tool
        await mcpClient.callTool('protokoll_edit_transcript', {
          transcriptPath: transcriptPath,
          title: newTitle.trim(),
        });

        vscode.window.showInformationMessage(`Protokoll: Transcript renamed to "${newTitle.trim()}"`);
        
        // Refresh transcripts to show the updated name
        if (transcriptsViewProvider) {
          await transcriptsViewProvider.refresh();
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to rename transcript: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  const moveToProjectCommand = vscode.commands.registerCommand(
    'protokoll.moveToProject',
    async (item: TranscriptItem) => {
      if (!mcpClient) {
        vscode.window.showErrorMessage('MCP client not initialized. Please configure the server URL first.');
        return;
      }

      if (!item || !item.transcript) {
        vscode.window.showErrorMessage('No transcript selected.');
        return;
      }

      try {
        // List available projects
        const projectsResult = await mcpClient.callTool('protokoll_list_projects', {}) as {
          projects?: Array<{ id: string; name: string; active?: boolean }>;
        };

        if (!projectsResult.projects || projectsResult.projects.length === 0) {
          vscode.window.showWarningMessage('No projects found. Please configure projects in your context directory.');
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
          placeHolder: 'Select a project to move this transcript to',
        });

        if (!selected) {
          return; // User cancelled
        }

        // Extract transcript path from URI or use filename
        const transcriptPath = item.transcript.path || item.transcript.filename;
        
        // Call the edit transcript tool with the new projectId
        await mcpClient.callTool('protokoll_edit_transcript', {
          transcriptPath: transcriptPath,
          projectId: selected.id,
        });

        vscode.window.showInformationMessage(`Protokoll: Transcript moved to project "${selected.label}"`);
        
        // Refresh transcripts to show the updated project
        if (transcriptsViewProvider) {
          await transcriptsViewProvider.refresh();
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to move transcript: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  const copyTranscriptCommand = vscode.commands.registerCommand(
    'protokoll.copyTranscript',
    async (item: TranscriptItem) => {
      if (!mcpClient) {
        vscode.window.showErrorMessage('MCP client not initialized. Please configure the server URL first.');
        return;
      }

      if (!item || !item.transcript) {
        vscode.window.showErrorMessage('No transcript selected.');
        return;
      }

      try {
        const content: TranscriptContent = await mcpClient.readTranscript(item.transcript.uri);
        await vscode.env.clipboard.writeText(content.text);
        vscode.window.showInformationMessage('Transcript text copied to clipboard');
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to copy transcript: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  const openTranscriptToSideCommand = vscode.commands.registerCommand(
    'protokoll.openTranscriptToSide',
    async (item: TranscriptItem) => {
      if (!transcriptDetailViewProvider) {
        return;
      }

      if (!item || !item.transcript) {
        vscode.window.showErrorMessage('No transcript selected.');
        return;
      }

      // Open transcript in the side column
      await transcriptDetailViewProvider.showTranscript(item.transcript.uri, item.transcript, vscode.ViewColumn.Beside);
    }
  );

  const openTranscriptWithCommand = vscode.commands.registerCommand(
    'protokoll.openTranscriptWith',
    async (item: TranscriptItem) => {
      if (!item || !item.transcript) {
        vscode.window.showErrorMessage('No transcript selected.');
        return;
      }

      // Get the file path
      const filePath = item.transcript.path;
      if (!filePath) {
        vscode.window.showErrorMessage('Transcript path not available.');
        return;
      }

      try {
        // Check if the file exists
        const uri = vscode.Uri.file(filePath);
        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          vscode.window.showWarningMessage('Transcript file not found on disk. It may be a virtual resource.');
          return;
        }

        // Use VSCode's built-in "Open With" command
        await vscode.commands.executeCommand('vscode.openWith', uri);
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to open transcript: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  const copyTranscriptUrlCommand = vscode.commands.registerCommand(
    'protokoll.copyTranscriptUrl',
    async (item: TranscriptItem) => {
      if (!item || !item.transcript) {
        vscode.window.showErrorMessage('No transcript selected.');
        return;
      }

      try {
        await vscode.env.clipboard.writeText(item.transcript.uri);
        vscode.window.showInformationMessage('Transcript URL copied to clipboard');
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to copy URL: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  const copySessionIdCommand = vscode.commands.registerCommand(
    'protokoll.copySessionId',
    async (sessionId: string) => {
      if (!sessionId) {
        vscode.window.showErrorMessage('No session ID available.');
        return;
      }

      try {
        await vscode.env.clipboard.writeText(sessionId);
        vscode.window.showInformationMessage('Session ID copied to clipboard');
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to copy session ID: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  const openChatCommand = vscode.commands.registerCommand(
    'protokoll.openChat',
    async () => {
      if (!chatViewProvider) {
        vscode.window.showErrorMessage('Chat view provider not initialized');
        return;
      }
      await chatViewProvider.showChat();
    }
  );

  // Refresh transcripts when configuration changes
  const configWatcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (e.affectsConfiguration('protokoll.serverUrl')) {
      const config = vscode.workspace.getConfiguration('protokoll');
      const serverUrl = config.get<string>('serverUrl', 'http://127.0.0.1:3000');
      
      if (connectionStatusViewProvider) {
        connectionStatusViewProvider.setServerUrl(serverUrl);
      }
      
      if (serverUrl && serverUrl !== '') {
        try {
          mcpClient = new McpClient(serverUrl);
          await mcpClient.initialize();
          const sessionId = mcpClient.getSessionId();
          if (transcriptsViewProvider) {
            transcriptsViewProvider.setClient(mcpClient);
            await transcriptsViewProvider.refresh();
          }
          if (transcriptDetailViewProvider) {
            transcriptDetailViewProvider.setClient(mcpClient);
          }
          if (connectionStatusViewProvider) {
            connectionStatusViewProvider.setClient(mcpClient);
            connectionStatusViewProvider.setConnectionStatus(true, sessionId);
          }
        } catch (error) {
          vscode.window.showErrorMessage(
            `Protokoll: Failed to reconnect: ${error instanceof Error ? error.message : String(error)}`
          );
          if (connectionStatusViewProvider) {
            connectionStatusViewProvider.setClient(mcpClient);
            connectionStatusViewProvider.setConnectionStatus(false, null);
          }
        }
      }
    }
  });

  // Auto-refresh transcripts on activation (only if server is connected)
  if (transcriptsViewProvider && serverConnected && mcpClient) {
    await transcriptsViewProvider.refresh();
    
    // Subscribe to transcripts list changes
    try {
      console.log('Protokoll: [EXTENSION] Setting up subscription to transcripts list...');
      // Get the transcripts list URI
      const config = vscode.workspace.getConfiguration('protokoll');
      const transcriptsDir = config.get<string>('transcriptsDirectory', '');
      console.log(`Protokoll: [EXTENSION] Transcripts directory from config: ${transcriptsDir || '(empty)'}`);
      
      if (transcriptsDir) {
        const params = new URLSearchParams();
        params.set('directory', transcriptsDir);
        const transcriptsListUri = `protokoll://transcripts?${params.toString()}`;
        console.log(`Protokoll: [EXTENSION] Subscribing to transcripts list URI: ${transcriptsListUri}`);
        await mcpClient.subscribeToResource(transcriptsListUri);
        console.log(`Protokoll: [EXTENSION] ✅ Successfully subscribed to transcripts list: ${transcriptsListUri}`);
      } else {
        console.warn('Protokoll: [EXTENSION] ⚠️ No transcripts directory configured, skipping subscription');
      }
    } catch (error) {
      console.error('Protokoll: [EXTENSION] ❌ Failed to subscribe to transcripts list:', error);
    }
  }

  context.subscriptions.push(
    showTranscriptsCommand,
    configureServerCommand,
    openTranscriptCommand,
    openTranscriptInNewTabCommand,
    refreshTranscriptsCommand,
    filterByProjectCommand,
    startNewSessionCommand,
    renameTranscriptCommand,
    moveToProjectCommand,
    copyTranscriptCommand,
    openTranscriptToSideCommand,
    openTranscriptWithCommand,
    copyTranscriptUrlCommand,
    copySessionIdCommand,
    openChatCommand,
    configWatcher,
    transcriptsTreeView,
    connectionStatusTreeView
  );
}

export function deactivate() {
  if (mcpClient) {
    mcpClient.dispose();
  }
  mcpClient = null;
  transcriptsViewProvider = null;
  transcriptDetailViewProvider = null;
}
