/**
 * Main extension entry point
 */

import * as vscode from 'vscode';
import { McpClient } from './mcpClient';
import { TranscriptsViewProvider, TranscriptItem } from './transcriptsView';
import { TranscriptDetailViewProvider, getTranscriptContentProvider } from './transcriptDetailView';
import { ConnectionStatusViewProvider } from './connectionStatusView';
import { ChatViewProvider } from './chatView';
import { ChatsViewProvider } from './chatsView';
import type { Transcript, TranscriptContent } from './types';
import { log, initLogger } from './logger';

let mcpClient: McpClient | null = null;
let transcriptsViewProvider: TranscriptsViewProvider | null = null;
let transcriptDetailViewProvider: TranscriptDetailViewProvider | null = null;
let connectionStatusViewProvider: ConnectionStatusViewProvider | null = null;
let chatViewProvider: ChatViewProvider | null = null;
let chatsViewProvider: ChatsViewProvider | null = null;

// Create an output channel for debugging
const outputChannel = vscode.window.createOutputChannel('Protokoll Debug');

// Initialize the shared logger
initLogger(outputChannel);

export async function activate(context: vscode.ExtensionContext) {
  log('Protokoll extension is now active');

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
        mcpClient.onNotification('notifications/resources_changed', async () => {
          console.log('Protokoll: [EXTENSION] 📢 Received resources_changed notification, refreshing transcripts');
          if (transcriptsViewProvider) {
            await transcriptsViewProvider.refresh();
          } else {
            console.warn('Protokoll: [EXTENSION] ⚠️ transcriptsViewProvider is null, cannot refresh');
          }
          
          // Also refresh any open transcript detail views, as they might need to update
          // (e.g., if a transcript was renamed, the list will have the new name)
          if (transcriptDetailViewProvider) {
            const allOpenTranscripts = transcriptDetailViewProvider.getAllOpenTranscripts();
            console.log(`Protokoll: [EXTENSION] Refreshing ${allOpenTranscripts.length} open transcript detail view(s)`);
            for (const openTranscript of allOpenTranscripts) {
              try {
                // Refresh each open transcript to pick up any changes
                await transcriptDetailViewProvider.refreshTranscript(openTranscript.uri);
              } catch (error) {
                console.warn(`Protokoll: [EXTENSION] ⚠️ Failed to refresh transcript ${openTranscript.uri}:`, error);
                // If refresh fails (e.g., URI changed due to rename), try to find the new URI
                // by refreshing the transcripts list and matching by content/metadata
              }
            }
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
                // Transcript might have been renamed - check all open transcripts
                // to see if any might match this URI (e.g., if it was renamed via chat)
                console.log('Protokoll: [EXTENSION] ⚠️ Transcript URI not found in open transcripts');
                console.log('Protokoll: [EXTENSION] Checking if this might be a renamed transcript...');
                
                const allOpenTranscripts = transcriptDetailViewProvider.getAllOpenTranscripts();
                console.log(`Protokoll: [EXTENSION] Found ${allOpenTranscripts.length} open transcript(s)`);
                
                // Try to read the transcript to get its metadata and see if we can match it
                try {
                  if (mcpClient) {
                    await mcpClient.readTranscript(params.uri);
                    // Extract filename from URI: protokoll://transcript/../2026/1/file.md -> file.md
                    const uriFilename = params.uri.split('/').pop() || '';
                    
                    // Check if any open transcript might be this one (by checking if they're in the same directory/timeframe)
                    // This is a heuristic - if the notification is for a transcript we don't recognize,
                    // it might be a renamed version of one we have open
                    for (const openTranscript of allOpenTranscripts) {
                      // If the URIs are in similar paths (same year/month), it might be a rename
                      const uriPath = params.uri.replace('protokoll://transcript/', '');
                      const openPath = openTranscript.uri.replace('protokoll://transcript/', '');
                      
                      // Check if paths are in the same directory (same year/month)
                      const uriDirMatch = uriPath.match(/^\.\.\/(\d+\/\d+)\//);
                      const openDirMatch = openPath.match(/^\.\.\/(\d+\/\d+)\//);
                      
                      if (uriDirMatch && openDirMatch && uriDirMatch[1] === openDirMatch[1]) {
                        // Same directory - might be a rename, update the tracking
                        console.log(`Protokoll: [EXTENSION] 🔄 Possible rename detected: ${openTranscript.uri} -> ${params.uri}`);
                        console.log(`Protokoll: [EXTENSION] Updating transcript tracking...`);
                        
                        // Update the transcript with new URI and refresh
                        const updatedTranscript: Transcript = {
                          ...openTranscript.transcript,
                          uri: params.uri,
                          path: uriPath,
                          filename: uriFilename,
                        };
                        
                        // The detail view provider will handle the URI update internally
                        await transcriptDetailViewProvider.showTranscript(params.uri, updatedTranscript);
                        break;
                      }
                    }
                  }
                } catch (error) {
                  console.warn('Protokoll: [EXTENSION] ⚠️ Could not read transcript to check for rename:', error);
                }
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
            if (mcpClient) {
              let transcriptsListUri: string;
              if (transcriptsDir) {
                const params = new URLSearchParams();
                params.set('directory', transcriptsDir);
                transcriptsListUri = `protokoll://transcripts?${params.toString()}`;
              } else {
                // No directory configured - use server's default outputDirectory
                transcriptsListUri = 'protokoll://transcripts';
              }
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
    // Don't refresh here - wait for view to be revealed to avoid unnecessary API calls
    log('Protokoll: Transcripts view provider initialized with MCP client');
  } else {
    log('Protokoll: Transcripts view provider initialized without MCP client (will need configuration)');
  }

  transcriptDetailViewProvider = new TranscriptDetailViewProvider(context.extensionUri);
  if (mcpClient) {
    transcriptDetailViewProvider.setClient(mcpClient);
  }

  connectionStatusViewProvider = new ConnectionStatusViewProvider(context);
  if (mcpClient) {
    connectionStatusViewProvider.setClient(mcpClient);
    connectionStatusViewProvider.setConnectionStatus(serverConnected, mcpClient.getSessionId());
  } else {
    connectionStatusViewProvider.setServerUrl(serverUrl);
  }

  // Create chatViewProvider BEFORE setting it on transcriptDetailViewProvider
  chatViewProvider = new ChatViewProvider(context.extensionUri);
  if (mcpClient) {
    chatViewProvider.setClient(mcpClient);
  }
  
  // NOW set the chat provider on transcript detail view (after chatViewProvider is created)
  transcriptDetailViewProvider.setChatProvider(chatViewProvider);
  
  // Set transcript detail provider reference for context fallback
  chatViewProvider.setTranscriptDetailProvider(transcriptDetailViewProvider);

  // Initialize chats view provider
  chatsViewProvider = new ChatsViewProvider();
  // Set chats view provider reference in chat view provider
  if (chatViewProvider && chatsViewProvider) {
    chatViewProvider.setChatsViewProvider(chatsViewProvider);
  }

  // Register transcript content provider for virtual documents
  const transcriptContentProvider = getTranscriptContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('protokoll-transcript', transcriptContentProvider)
  );

  // Register tree views
  const transcriptsTreeView = vscode.window.createTreeView('protokollTranscripts', {
    treeDataProvider: transcriptsViewProvider,
    showCollapseAll: false,
  });

  // Refresh transcripts when view becomes visible
  let hasRefreshedOnce = false;
  transcriptsTreeView.onDidChangeVisibility(async (e) => {
    log('Protokoll: onDidChangeVisibility fired', { visible: e.visible, hasRefreshedOnce });
    if (e.visible && !hasRefreshedOnce && transcriptsViewProvider) {
      log('Protokoll: Transcripts view became visible, refreshing...');
      hasRefreshedOnce = true;
      await transcriptsViewProvider.refresh();
      log('Protokoll: Auto-refresh on visibility completed');
      
      // VS Code sometimes doesn't render the tree immediately after visibility change
      // Fire the change event again after a short delay to ensure rendering
      setTimeout(() => {
        log('Protokoll: Firing delayed tree refresh');
        transcriptsViewProvider?.fireTreeDataChange();
      }, 100);
    }
  });

  const chatsTreeView = vscode.window.createTreeView('protokollChats', {
    treeDataProvider: chatsViewProvider,
    showCollapseAll: false,
  });

  const connectionStatusTreeView = vscode.window.createTreeView('protokollConnectionStatus', {
    treeDataProvider: connectionStatusViewProvider,
    showCollapseAll: false,
  });

  // Automatically reveal the Protokoll view in the Activity Bar when extension activates
  // This is especially useful when debugging (F5)
  // Use setTimeout to ensure views are fully initialized before revealing
  setTimeout(async () => {
    try {
      log('Protokoll: Starting auto-reveal sequence');
      
      // First, load the data
      if (transcriptsViewProvider && mcpClient) {
        log('Protokoll: Pre-loading transcripts before reveal');
        await transcriptsViewProvider.refresh();
        log('Protokoll: Pre-load complete');
      }
      
      // Try multiple approaches to reveal the view
      // Approach 1: Use the auto-generated focus command (if it exists)
      try {
        await vscode.commands.executeCommand('protokollTranscripts.focus');
        log('Protokoll: Revealed Protokoll view using focus command');
        
        // Force a tree refresh after focus
        setTimeout(() => {
          log('Protokoll: Forcing tree refresh after focus');
          transcriptsViewProvider?.fireTreeDataChange();
        }, 200);
        
        return; // Success, exit early
      } catch (focusError) {
        log('Protokoll: Focus command failed, trying next approach', focusError);
        // Continue to next approach
      }

      // Approach 2: Use workbench view command
      try {
        await vscode.commands.executeCommand('workbench.view.extension.protokoll');
        log('Protokoll: Revealed Protokoll view using workbench command');
        return; // Success, exit early
      } catch (workbenchError) {
        log('Protokoll: Workbench command failed, trying next approach', workbenchError);
        // Continue to next approach
      }

      // Approach 3: Try to reveal by showing the transcripts view
      // Check if view is visible, if not try to make it visible
      if (transcriptsViewProvider) {
        const visible = transcriptsTreeView.visible;
        log(`Protokoll: Transcripts view visible: ${visible}`);
        if (!visible) {
          // Try to get the first item and reveal it, which will show the view
          const children = await transcriptsViewProvider.getChildren();
          log(`Protokoll: Found ${children?.length || 0} transcript items`);
          if (children && children.length > 0) {
            await transcriptsTreeView.reveal(children[0], { focus: true, expand: false });
            log('Protokoll: Revealed Protokoll view by revealing first item');
          } else {
            // No items yet, just refresh which might help
            await transcriptsViewProvider.refresh();
            log('Protokoll: Refreshed transcripts view (no items to reveal)');
          }
        } else {
          log('Protokoll: View is already visible');
        }
      }
    } catch (error) {
      log('Protokoll: Could not automatically reveal view', error);
    }
  }, 1000); // Increased delay to ensure extension host is fully ready

  // Register commands
  const showTranscriptsCommand = vscode.commands.registerCommand(
    'protokoll.showTranscripts',
    async () => {
      if (!transcriptsViewProvider) {
        return;
      }
      // Reveal the view container by focusing on the transcripts view
      try {
        await vscode.commands.executeCommand('protokollTranscripts.focus');
      } catch (error) {
        // If focus command doesn't exist, just refresh
        console.log('Protokoll: Could not focus transcripts view');
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

  const refreshChatsCommand = vscode.commands.registerCommand(
    'protokoll.refreshChats',
    async () => {
      if (!chatsViewProvider) {
        return;
      }
      chatsViewProvider.refresh();
    }
  );

  const openChatPanelCommand = vscode.commands.registerCommand(
    'protokoll.openChatPanel',
    async (chatId: string) => {
      // This command is called when clicking on a chat in the chats view
      // The chat panel should already exist, we just need to reveal it
      console.log('Protokoll: Opening chat panel:', chatId);
      // The panel will be revealed automatically by VS Code when the command is triggered
      // from the tree item, but we can add additional logic here if needed
    }
  );

  const closeChatPanelCommand = vscode.commands.registerCommand(
    'protokoll.closeChatPanel',
    async (chatId: string) => {
      // This command is called to close a specific chat panel
      console.log('Protokoll: Closing chat panel:', chatId);
      // The ChatViewProvider will handle the actual disposal
      // and the chatsViewProvider will be notified via the onDidDispose event
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
      // If directory is not configured, subscribe without it (server will use configured outputDirectory)
      const config = vscode.workspace.getConfiguration('protokoll');
      const transcriptsDir = config.get<string>('transcriptsDirectory', '');
      console.log(`Protokoll: [EXTENSION] Transcripts directory from config: ${transcriptsDir || '(empty - will use server default)'}`);
      
      let transcriptsListUri: string;
      if (transcriptsDir) {
        const params = new URLSearchParams();
        params.set('directory', transcriptsDir);
        transcriptsListUri = `protokoll://transcripts?${params.toString()}`;
      } else {
        // No directory configured - use server's default outputDirectory
        transcriptsListUri = 'protokoll://transcripts';
      }
      
      console.log(`Protokoll: [EXTENSION] Subscribing to transcripts list URI: ${transcriptsListUri}`);
      await mcpClient.subscribeToResource(transcriptsListUri);
      console.log(`Protokoll: [EXTENSION] ✅ Successfully subscribed to transcripts list: ${transcriptsListUri}`);
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
    refreshChatsCommand,
    openChatPanelCommand,
    closeChatPanelCommand,
    configWatcher,
    transcriptsTreeView,
    chatsTreeView,
    connectionStatusTreeView,
    outputChannel // Register output channel so it can be disposed properly
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
