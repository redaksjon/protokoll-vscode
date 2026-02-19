/**
 * Main extension entry point
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { McpClient } from './mcpClient';
import { TranscriptsViewProvider, TranscriptItem } from './transcriptsView';
import { TranscriptDetailViewProvider, getTranscriptContentProvider, getEditableTranscriptFiles } from './transcriptDetailView';
import { ConnectionStatusViewProvider } from './connectionStatusView';
import { ChatViewProvider } from './chatView';
import { ChatsViewProvider } from './chatsView';
import { PeopleViewProvider } from './peopleView';
import { TermsViewProvider } from './termsView';
import { ProjectsViewProvider } from './projectsView';
import { CompaniesViewProvider } from './companiesView';
import type { Transcript, TranscriptContent } from './types';
import { log, initLogger } from './logger';
import { shouldPassContextDirectory, clearServerModeCache } from './serverMode';

let mcpClient: McpClient | null = null;
let transcriptsViewProvider: TranscriptsViewProvider | null = null;
let transcriptDetailViewProvider: TranscriptDetailViewProvider | null = null;
let connectionStatusViewProvider: ConnectionStatusViewProvider | null = null;
let chatViewProvider: ChatViewProvider | null = null;
let chatsViewProvider: ChatsViewProvider | null = null;
let peopleViewProvider: PeopleViewProvider | null = null;
let termsViewProvider: TermsViewProvider | null = null;
let projectsViewProvider: ProjectsViewProvider | null = null;
let companiesViewProvider: CompaniesViewProvider | null = null;

function getDefaultContextDirectory(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// Create an output channel for debugging
const outputChannel = vscode.window.createOutputChannel('Protokoll Debug');

// Initialize the shared logger
initLogger(outputChannel);

export async function activate(context: vscode.ExtensionContext) {
  log('Protokoll extension is now active');
  console.log('Protokoll: [ACTIVATION] Extension activate() called');

  // Initialize MCP client
  const config = vscode.workspace.getConfiguration('protokoll');
  const rawServerUrl = config.get<string>('serverUrl', 'http://127.0.0.1:3001');
  // Remove trailing slashes to ensure consistent URL handling
  const serverUrl = rawServerUrl.replace(/\/+$/, '');
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
    clearServerModeCache(); // Clear cached server mode on new connection
    
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
        vscode.window.showInformationMessage(`Protokoll: Connected to ${serverUrl}`);
        
        // Note: connectionStatusViewProvider is not yet initialized at this point
        // It will be set up later after view providers are created
        
        // Subscribe to resource list change notifications (for transcript list and entity views)
        console.log('Protokoll: [EXTENSION] Registering notification handler for resources_changed');
        mcpClient.onNotification('notifications/resources_changed', async () => {
          console.log('Protokoll: [EXTENSION] 📢 Received resources_changed notification, refreshing views');
          
          // Refresh transcripts view
          if (transcriptsViewProvider) {
            await transcriptsViewProvider.refresh();
          } else {
            console.warn('Protokoll: [EXTENSION] ⚠️ transcriptsViewProvider is null, cannot refresh');
          }
          
          // Refresh entity views
          if (peopleViewProvider) {
            await peopleViewProvider.refresh();
          }
          if (termsViewProvider) {
            await termsViewProvider.refresh();
          }
          if (projectsViewProvider) {
            await projectsViewProvider.refresh();
          }
          if (companiesViewProvider) {
            await companiesViewProvider.refresh();
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
          
          // Check if this is an entity URI
          if (params.uri.startsWith('protokoll://entity/')) {
            console.log('Protokoll: [EXTENSION] This is an entity URI, refreshing if open');
            console.log(`Protokoll: [EXTENSION] Notification URI: ${params.uri}`);
            if (transcriptDetailViewProvider) {
              // Refresh the entity view if it's open
              await transcriptDetailViewProvider.refreshEntity(params.uri);
              console.log('Protokoll: [EXTENSION] ✅ Refreshed entity view');
            }
            return;
          }
          
          // Check if this is an individual transcript URI
          if (params.uri.startsWith('protokoll://transcript/')) {
            console.log('Protokoll: [EXTENSION] This is an individual transcript URI, refreshing if open');
            console.log(`Protokoll: [EXTENSION] Notification URI: ${params.uri}`);
            // Refresh transcripts list so status changes (e.g. archived) are reflected when filters exclude that status
            if (transcriptsViewProvider) {
              await transcriptsViewProvider.refresh();
            }
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
            if (mcpClient) {
              await mcpClient.subscribeToResource('protokoll://transcripts');
              console.log('Protokoll: [EXTENSION] ✅ Re-subscribed to transcripts list after recovery');
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

  peopleViewProvider = new PeopleViewProvider(context);
  if (mcpClient) {
    peopleViewProvider.setClient(mcpClient);
    log('Protokoll: People view provider initialized with MCP client');
  } else {
    log('Protokoll: People view provider initialized without MCP client (will need configuration)');
  }

  termsViewProvider = new TermsViewProvider(context);
  if (mcpClient) {
    termsViewProvider.setClient(mcpClient);
    log('Protokoll: Terms view provider initialized with MCP client');
  } else {
    log('Protokoll: Terms view provider initialized without MCP client (will need configuration)');
  }

  projectsViewProvider = new ProjectsViewProvider(context);
  if (mcpClient) {
    projectsViewProvider.setClient(mcpClient);
    log('Protokoll: Projects view provider initialized with MCP client');
  } else {
    log('Protokoll: Projects view provider initialized without MCP client (will need configuration)');
  }

  companiesViewProvider = new CompaniesViewProvider(context);
  if (mcpClient) {
    companiesViewProvider.setClient(mcpClient);
    log('Protokoll: Companies view provider initialized with MCP client');
  } else {
    log('Protokoll: Companies view provider initialized without MCP client (will need configuration)');
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
  if (mcpClient && chatViewProvider) {
    chatViewProvider.setClient(mcpClient);
  }
  
  // NOW set the chat provider on transcript detail view (after chatViewProvider is created)
  if (chatViewProvider) {
    transcriptDetailViewProvider.setChatProvider(chatViewProvider);
    
    // Set transcript detail provider reference for context fallback
    chatViewProvider.setTranscriptDetailProvider(transcriptDetailViewProvider);
  }

  // When a transcript's metadata changes (e.g. status), refresh the transcripts list
  // so it reflects filter changes (e.g. archived transcript disappears when archived is excluded)
  transcriptDetailViewProvider.setOnTranscriptChanged(async () => {
    if (transcriptsViewProvider) {
      await transcriptsViewProvider.refresh();
    }
  });

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

  // Register document save listener for edit-in-editor feature
  // Syncs saves from temp files back to MCP server
  const saveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
    const editableFiles = getEditableTranscriptFiles();
    const transcriptInfo = editableFiles.get(document.uri.fsPath);
    
    if (transcriptInfo && mcpClient) {
      const editedBody = document.getText();
      
      // Only sync if body content actually changed
      if (editedBody !== transcriptInfo.originalBody) {
        try {
          // Merge the preserved header with the edited body
          const fullContent = transcriptInfo.header + editedBody;
          
          log(`Protokoll: Syncing edited transcript to server: ${transcriptInfo.transcriptPath}`);
          await mcpClient.callTool('protokoll_update_transcript_content', {
            transcriptPath: transcriptInfo.transcriptPath,
            content: fullContent,
          });
          
          // Update the original body to reflect the saved state
          transcriptInfo.originalBody = editedBody;
          transcriptInfo.originalContent = fullContent;
          
          vscode.window.showInformationMessage('Protokoll: Transcript saved to server');
          
          // Refresh the transcript detail view if open
          if (transcriptDetailViewProvider) {
            await transcriptDetailViewProvider.refreshTranscript(transcriptInfo.transcriptUri);
          }
        } catch (error) {
          log(`Protokoll: Error syncing transcript to server: ${error}`);
          vscode.window.showErrorMessage(
            `Failed to save transcript to server: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  });
  context.subscriptions.push(saveListener);

  // Clean up temp files when documents are closed
  const closeListener = vscode.workspace.onDidCloseTextDocument((document) => {
    const editableFiles = getEditableTranscriptFiles();
    if (editableFiles.has(document.uri.fsPath)) {
      log(`Protokoll: Cleaning up temp file: ${document.uri.fsPath}`);
      editableFiles.delete(document.uri.fsPath);
      // Try to delete the temp file
      try {
        if (fs.existsSync(document.uri.fsPath)) {
          fs.unlinkSync(document.uri.fsPath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  });
  context.subscriptions.push(closeListener);

  // Register tree views
  log('Protokoll: Creating transcripts tree view...');
  const transcriptsTreeView = vscode.window.createTreeView('protokollTranscripts', {
    treeDataProvider: transcriptsViewProvider,
    showCollapseAll: false,
    canSelectMany: true, // Enable multi-selection
  });
  log('Protokoll: Transcripts tree view created', { visible: transcriptsTreeView.visible });

  // Set the tree view reference in the provider
  transcriptsViewProvider.setTreeView(transcriptsTreeView);

  // Refresh transcripts when view becomes visible
  // Note: We don't use hasRefreshedOnce anymore because it caused race conditions
  // where visibility fired before connection completed, blocking subsequent refreshes
  transcriptsTreeView.onDidChangeVisibility(async (e) => {
    log('Protokoll: onDidChangeVisibility fired', { visible: e.visible, hasClient: !!mcpClient, hasTranscripts: transcriptsViewProvider?.hasTranscripts() });
    if (e.visible && transcriptsViewProvider && mcpClient) {
      // Only refresh if we don't have data yet (avoids unnecessary API calls)
      if (!transcriptsViewProvider.hasTranscripts()) {
        log('Protokoll: Transcripts view became visible with no data, refreshing...');
        await transcriptsViewProvider.refresh();
        log('Protokoll: Auto-refresh on visibility completed');
        
        // VS Code sometimes doesn't render the tree immediately after visibility change
        // Fire the change event again after a short delay to ensure rendering
        setTimeout(() => {
          log('Protokoll: Firing delayed tree refresh');
          transcriptsViewProvider?.fireTreeDataChange();
        }, 100);
      } else {
        log('Protokoll: Transcripts view visible but already has data, skipping refresh');
      }
    } else if (e.visible && !mcpClient) {
      log('Protokoll: Transcripts view visible but no client yet, will refresh when connected');
    }
  });

  // Register people tree view
  log('Protokoll: Creating people tree view...');
  const peopleTreeView = vscode.window.createTreeView('protokollPeople', {
    treeDataProvider: peopleViewProvider,
    showCollapseAll: false,
  });
  log('Protokoll: People tree view created', { visible: peopleTreeView.visible });

  peopleViewProvider.setTreeView(peopleTreeView);

  peopleTreeView.onDidChangeVisibility(async (e) => {
    log('Protokoll: People onDidChangeVisibility fired', { visible: e.visible, hasClient: !!mcpClient, hasPeople: peopleViewProvider?.hasPeople() });
    if (e.visible && peopleViewProvider && mcpClient) {
      if (!peopleViewProvider.hasPeople()) {
        log('Protokoll: People view became visible with no data, refreshing...');
        await peopleViewProvider.refresh();
        log('Protokoll: People auto-refresh on visibility completed');
        
        setTimeout(() => {
          log('Protokoll: Firing delayed people tree refresh');
          peopleViewProvider?.fireTreeDataChange();
        }, 100);
      } else {
        log('Protokoll: People view visible but already has data, skipping refresh');
      }
    } else if (e.visible && !mcpClient) {
      log('Protokoll: People view visible but no client yet, will refresh when connected');
    }
  });

  // Register terms tree view
  log('Protokoll: Creating terms tree view...');
  const termsTreeView = vscode.window.createTreeView('protokollTerms', {
    treeDataProvider: termsViewProvider,
    showCollapseAll: false,
  });
  log('Protokoll: Terms tree view created', { visible: termsTreeView.visible });

  termsViewProvider.setTreeView(termsTreeView);

  termsTreeView.onDidChangeVisibility(async (e) => {
    if (e.visible && termsViewProvider && mcpClient && !termsViewProvider.hasTerms()) {
      await termsViewProvider.refresh();
      setTimeout(() => termsViewProvider?.fireTreeDataChange(), 100);
    }
  });

  // Register projects tree view
  log('Protokoll: Creating projects tree view...');
  const projectsTreeView = vscode.window.createTreeView('protokollProjects', {
    treeDataProvider: projectsViewProvider,
    showCollapseAll: false,
  });
  log('Protokoll: Projects tree view created', { visible: projectsTreeView.visible });

  projectsViewProvider.setTreeView(projectsTreeView);

  projectsTreeView.onDidChangeVisibility(async (e) => {
    if (e.visible && projectsViewProvider && mcpClient && !projectsViewProvider.hasProjects()) {
      await projectsViewProvider.refresh();
      setTimeout(() => projectsViewProvider?.fireTreeDataChange(), 100);
    }
  });

  // Register companies tree view
  log('Protokoll: Creating companies tree view...');
  const companiesTreeView = vscode.window.createTreeView('protokollCompanies', {
    treeDataProvider: companiesViewProvider,
    showCollapseAll: false,
  });
  log('Protokoll: Companies tree view created', { visible: companiesTreeView.visible });

  companiesViewProvider.setTreeView(companiesTreeView);

  companiesTreeView.onDidChangeVisibility(async (e) => {
    if (e.visible && companiesViewProvider && mcpClient && !companiesViewProvider.hasCompanies()) {
      await companiesViewProvider.refresh();
      setTimeout(() => companiesViewProvider?.fireTreeDataChange(), 100);
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
        // Remove trailing slashes to ensure consistent URL handling
        const cleanUrl = input.trim().replace(/\/+$/, '');
        await config.update('serverUrl', cleanUrl, true);
        
        // Mark that user has configured the URL
        await context.globalState.update('protokoll.hasConfiguredUrl', true);
        
        vscode.window.showInformationMessage(`Protokoll: Server URL updated to ${cleanUrl}`);
        
        // Reinitialize client
        try {
          mcpClient = new McpClient(cleanUrl);
          clearServerModeCache(); // Clear cached server mode on new connection
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

  const loadMoreTranscriptsCommand = vscode.commands.registerCommand(
    'protokoll.loadMoreTranscripts',
    async () => {
      if (!transcriptsViewProvider) {
        return;
      }
      await transcriptsViewProvider.loadMore();
    }
  );

  const refreshPeopleCommand = vscode.commands.registerCommand(
    'protokoll.refreshPeople',
    async () => {
      if (!peopleViewProvider) {
        return;
      }
      await peopleViewProvider.refresh();
    }
  );

  const searchPeopleCommand = vscode.commands.registerCommand(
    'protokoll.people.search',
    async () => {
      if (!peopleViewProvider) {
        return;
      }

      const searchQuery = await vscode.window.showInputBox({
        prompt: 'Search people by name, ID, or sounds-like variants',
        placeHolder: 'Enter search query...',
      });

      if (searchQuery !== undefined) {
        if (searchQuery === '') {
          await peopleViewProvider.clearSearch();
        } else {
          await peopleViewProvider.setSearch(searchQuery);
        }
      }
    }
  );

  const loadMorePeopleCommand = vscode.commands.registerCommand(
    'protokoll.people.loadMore',
    async () => {
      if (!peopleViewProvider) {
        return;
      }
      await peopleViewProvider.loadMore();
    }
  );

  const refreshTermsCommand = vscode.commands.registerCommand(
    'protokoll.refreshTerms',
    async () => {
      if (!termsViewProvider) {
        return;
      }
      await termsViewProvider.refresh();
    }
  );

  const searchTermsCommand = vscode.commands.registerCommand(
    'protokoll.terms.search',
    async () => {
      if (!termsViewProvider) {
        return;
      }

      const searchQuery = await vscode.window.showInputBox({
        prompt: 'Search terms by name, ID, or sounds-like variants',
        placeHolder: 'Enter search query...',
      });

      if (searchQuery !== undefined) {
        if (searchQuery === '') {
          await termsViewProvider.clearSearch();
        } else {
          await termsViewProvider.setSearch(searchQuery);
        }
      }
    }
  );

  const loadMoreTermsCommand = vscode.commands.registerCommand(
    'protokoll.terms.loadMore',
    async () => {
      if (!termsViewProvider) {
        return;
      }
      await termsViewProvider.loadMore();
    }
  );

  const refreshProjectsCommand = vscode.commands.registerCommand(
    'protokoll.refreshProjects',
    async () => {
      if (!projectsViewProvider) {
        return;
      }
      await projectsViewProvider.refresh();
    }
  );

  const searchProjectsCommand = vscode.commands.registerCommand(
    'protokoll.projects.search',
    async () => {
      if (!projectsViewProvider) {
        return;
      }

      const searchQuery = await vscode.window.showInputBox({
        prompt: 'Search projects by name or ID',
        placeHolder: 'Enter search query...',
      });

      if (searchQuery !== undefined) {
        if (searchQuery === '') {
          await projectsViewProvider.clearSearch();
        } else {
          await projectsViewProvider.setSearch(searchQuery);
        }
      }
    }
  );

  const loadMoreProjectsCommand = vscode.commands.registerCommand(
    'protokoll.projects.loadMore',
    async () => {
      if (!projectsViewProvider) {
        return;
      }
      await projectsViewProvider.loadMore();
    }
  );

  const refreshCompaniesCommand = vscode.commands.registerCommand(
    'protokoll.refreshCompanies',
    async () => {
      if (!companiesViewProvider) {
        return;
      }
      await companiesViewProvider.refresh();
    }
  );

  const searchCompaniesCommand = vscode.commands.registerCommand(
    'protokoll.companies.search',
    async () => {
      if (!companiesViewProvider) {
        return;
      }

      const searchQuery = await vscode.window.showInputBox({
        prompt: 'Search companies by name, ID, or sounds-like variants',
        placeHolder: 'Enter search query...',
      });

      if (searchQuery !== undefined) {
        if (searchQuery === '') {
          await companiesViewProvider.clearSearch();
        } else {
          await companiesViewProvider.setSearch(searchQuery);
        }
      }
    }
  );

  const loadMoreCompaniesCommand = vscode.commands.registerCommand(
    'protokoll.companies.loadMore',
    async () => {
      if (!companiesViewProvider) {
        return;
      }
      await companiesViewProvider.loadMore();
    }
  );

  interface EntityQuickPickItem extends vscode.QuickPickItem {
    entityId?: string;
    action: 'existing' | 'create';
  }

  async function showEntityPicker(opts: {
    entityType: string;
    listTool: string;
    listKey: string;
    addTool: string;
    addArgKey: string;
    addExtraArgs?: Record<string, unknown>;
    placeholder: string;
    createLabel: (input: string) => string;
    itemDescription?: (entity: { name: string; [key: string]: unknown }) => string | undefined;
    refreshView?: () => Promise<void>;
  }): Promise<void> {
    if (!mcpClient) {
      vscode.window.showErrorMessage('MCP client not initialized. Please configure the server URL first.');
      return;
    }

    const quickPick = vscode.window.createQuickPick<EntityQuickPickItem>();
    quickPick.placeholder = opts.placeholder;
    quickPick.matchOnDescription = true;

    let searchTimeout: ReturnType<typeof setTimeout> | undefined;

    const loadItems = async (query: string) => {
      quickPick.busy = true;
      try {
        const args: Record<string, unknown> = { limit: 50, offset: 0 };
        if (query) { args.search = query; }
        const response = await mcpClient!.callTool(opts.listTool, args) as { [key: string]: { id: string; name: string; [k: string]: unknown }[] };
        const entities = (response[opts.listKey] || []) as { id: string; name: string; [k: string]: unknown }[];

        const items: EntityQuickPickItem[] = [];

        if (query.trim()) {
          items.push({
            label: `$(add) ${opts.createLabel(query.trim())}`,
            action: 'create',
            alwaysShow: true,
          });
        }

        for (const entity of entities) {
          items.push({
            label: entity.name,
            description: opts.itemDescription?.(entity) || '',
            entityId: entity.id,
            action: 'existing',
          });
        }

        if (!query.trim() && items.length === 0) {
          items.push({
            label: 'Type to search or create...',
            action: 'create',
            description: 'No entities found',
          });
        }

        quickPick.items = items;
      } catch {
        // Keep current items on error
      } finally {
        quickPick.busy = false;
      }
    };

    // Initial load
    await loadItems('');

    quickPick.onDidChangeValue((value) => {
      if (searchTimeout) { clearTimeout(searchTimeout); }
      searchTimeout = setTimeout(() => loadItems(value), 200);
    });

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (!selected) { return; }
      quickPick.hide();

      if (selected.action === 'existing' && selected.entityId) {
        if (transcriptDetailViewProvider) {
          await transcriptDetailViewProvider.handleOpenEntity(opts.entityType, selected.entityId);
        }
      } else if (selected.action === 'create') {
        const name = quickPick.value.trim();
        if (!name) { return; }
        try {
          const addArgs: Record<string, unknown> = { [opts.addArgKey]: name, ...opts.addExtraArgs };
          const result = await mcpClient!.callTool(opts.addTool, addArgs) as { success: boolean; entity?: { id: string } };
          if (result.success && result.entity?.id) {
            vscode.window.showInformationMessage(`${opts.entityType.charAt(0).toUpperCase() + opts.entityType.slice(1)} "${name}" added`);
            if (opts.refreshView) { await opts.refreshView(); }
            if (transcriptDetailViewProvider) {
              await transcriptDetailViewProvider.handleOpenEntity(opts.entityType, result.entity.id);
            }
          }
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to add ${opts.entityType}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    });

    quickPick.onDidHide(() => {
      if (searchTimeout) { clearTimeout(searchTimeout); }
      quickPick.dispose();
    });

    quickPick.show();
  }

  const addPersonCommand = vscode.commands.registerCommand(
    'protokoll.people.add',
    () => showEntityPicker({
      entityType: 'person',
      listTool: 'protokoll_list_people',
      listKey: 'people',
      addTool: 'protokoll_add_person',
      addArgKey: 'name',
      placeholder: 'Search for an existing person or type a name to create one...',
      createLabel: (input) => `Create new person "${input}"`,
      itemDescription: (e) => [e.role, e.company].filter(Boolean).join(' at ') || undefined,
      refreshView: () => peopleViewProvider?.refresh() ?? Promise.resolve(),
    })
  );

  const addTermCommand = vscode.commands.registerCommand(
    'protokoll.terms.add',
    () => showEntityPicker({
      entityType: 'term',
      listTool: 'protokoll_list_terms',
      listKey: 'terms',
      addTool: 'protokoll_add_term',
      addArgKey: 'term',
      placeholder: 'Search for an existing term or type to create one...',
      createLabel: (input) => `Create new term "${input}"`,
      itemDescription: (e) => [e.expansion, e.domain].filter(Boolean).join(' - ') || undefined,
      refreshView: () => termsViewProvider?.refresh() ?? Promise.resolve(),
    })
  );

  const addProjectCommand = vscode.commands.registerCommand(
    'protokoll.projects.add',
    () => showEntityPicker({
      entityType: 'project',
      listTool: 'protokoll_list_projects',
      listKey: 'projects',
      addTool: 'protokoll_add_project',
      addArgKey: 'name',
      addExtraArgs: { useSmartAssist: false },
      placeholder: 'Search for an existing project or type a name to create one...',
      createLabel: (input) => `Create new project "${input}"`,
      itemDescription: (e) => e.contextType ? String(e.contextType) : undefined,
      refreshView: () => projectsViewProvider?.refresh() ?? Promise.resolve(),
    })
  );

  const addCompanyCommand = vscode.commands.registerCommand(
    'protokoll.companies.add',
    () => showEntityPicker({
      entityType: 'company',
      listTool: 'protokoll_list_companies',
      listKey: 'companies',
      addTool: 'protokoll_add_company',
      addArgKey: 'name',
      placeholder: 'Search for an existing company or type a name to create one...',
      createLabel: (input) => `Create new company "${input}"`,
      itemDescription: (e) => [e.fullName, e.industry].filter(Boolean).join(' - ') || undefined,
      refreshView: () => companiesViewProvider?.refresh() ?? Promise.resolve(),
    })
  );

  const openEntityCommand = vscode.commands.registerCommand(
    'protokoll.openEntity',
    async (entityType: string, entityId: string) => {
      if (!transcriptDetailViewProvider) {
        vscode.window.showErrorMessage('Transcript detail view provider not initialized');
        return;
      }
      await transcriptDetailViewProvider.handleOpenEntity(entityType, entityId);
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
        // Only pass contextDirectory if server is in local mode
        const shouldPass = await shouldPassContextDirectory(mcpClient);
        const contextDirectory = shouldPass ? getDefaultContextDirectory() : undefined;
        const projectsResult = await mcpClient.callTool(
          'protokoll_list_projects',
          contextDirectory ? { contextDirectory } : {}
        ) as {
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

  const filterByStatusCommand = vscode.commands.registerCommand(
    'protokoll.filterByStatus',
    async () => {
      if (!transcriptsViewProvider) {
        vscode.window.showErrorMessage('Transcripts view provider not initialized.');
        return;
      }

      // Get current filters
      const currentFilters = transcriptsViewProvider.getStatusFilters();

      // Define available statuses
      const statuses = [
        { id: 'initial', label: 'Initial', icon: '📝' },
        { id: 'enhanced', label: 'Enhanced', icon: '✨' },
        { id: 'reviewed', label: 'Reviewed', icon: '👀' },
        { id: 'in_progress', label: 'In Progress', icon: '🔄' },
        { id: 'closed', label: 'Closed', icon: '✅' },
        { id: 'archived', label: 'Archived', icon: '📦' },
      ];

      // Build quick pick items with checkboxes
      const items: Array<vscode.QuickPickItem & { id: string }> = statuses.map(status => ({
        label: `${status.icon} ${status.label}`,
        id: status.id,
        picked: currentFilters.has(status.id),
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select statuses to show (uncheck to hide)',
        title: 'Filter transcripts by status',
        canPickMany: true,
      });

      if (selected !== undefined) {
        // Update the filter with selected statuses
        const newFilters = new Set(selected.map(item => item.id));
        transcriptsViewProvider.setStatusFilters(newFilters);
        
        const count = newFilters.size;
        const message = count === statuses.length
          ? 'Showing all statuses'
          : count === 0
          ? 'No statuses selected - no transcripts will be shown'
          : `Showing ${count} status${count === 1 ? '' : 'es'}`;
        vscode.window.showInformationMessage(`Protokoll: ${message}`);
      }
    }
  );

  const sortTranscriptsCommand = vscode.commands.registerCommand(
    'protokoll.sortTranscripts',
    async () => {
      if (!transcriptsViewProvider) {
        vscode.window.showErrorMessage('Transcripts view provider not initialized.');
        return;
      }

      const currentSort = transcriptsViewProvider.getSortOrder();
      
      const items: Array<vscode.QuickPickItem & { sortOrder: 'date-desc' | 'date-asc' | 'title-asc' | 'title-desc' }> = [
        {
          label: '$(arrow-down) Date (Newest First)',
          description: currentSort === 'date-desc' ? 'Currently selected' : 'Sort by date, newest first',
          sortOrder: 'date-desc',
        },
        {
          label: '$(arrow-up) Date (Oldest First)',
          description: currentSort === 'date-asc' ? 'Currently selected' : 'Sort by date, oldest first',
          sortOrder: 'date-asc',
        },
        {
          label: '$(sort-alphabetically) Title (A-Z)',
          description: currentSort === 'title-asc' ? 'Currently selected' : 'Sort by title, A to Z',
          sortOrder: 'title-asc',
        },
        {
          label: '$(sort-alphabetically) Title (Z-A)',
          description: currentSort === 'title-desc' ? 'Currently selected' : 'Sort by title, Z to A',
          sortOrder: 'title-desc',
        },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select sort order for transcripts',
      });

      if (selected) {
        transcriptsViewProvider.setSortOrder(selected.sortOrder);
        /* eslint-disable @typescript-eslint/naming-convention */
        const sortLabels: Record<string, string> = {
          'date-desc': 'Date (Newest First)',
          'date-asc': 'Date (Oldest First)',
          'title-asc': 'Title (A-Z)',
          'title-desc': 'Title (Z-A)',
        };
        /* eslint-enable @typescript-eslint/naming-convention */
        vscode.window.showInformationMessage(`Protokoll: Sorting by ${sortLabels[selected.sortOrder]}`);
      }
    }
  );

  const startNewSessionCommand = vscode.commands.registerCommand(
    'protokoll.startNewSession',
    async () => {
      // Redirect to createNote command - "Start New Session" should create a new transcript
      await vscode.commands.executeCommand('protokoll.createNote');
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

      await moveTranscriptsToProject([item], mcpClient, transcriptsViewProvider);
    }
  );

  const moveSelectedToProjectCommand = vscode.commands.registerCommand(
    'protokoll.moveSelectedToProject',
    async () => {
      if (!mcpClient) {
        vscode.window.showErrorMessage('MCP client not initialized. Please configure the server URL first.');
        return;
      }

      if (!transcriptsViewProvider) {
        vscode.window.showErrorMessage('Transcripts view provider not initialized.');
        return;
      }

      const selectedItems = transcriptsViewProvider.getSelectedItems();
      if (selectedItems.length === 0) {
        vscode.window.showWarningMessage('No transcripts selected. Select one or more transcripts to move.');
        return;
      }

      await moveTranscriptsToProject(selectedItems, mcpClient, transcriptsViewProvider);
    }
  );

  // Helper function to move transcripts to a project
  async function moveTranscriptsToProject(
    items: TranscriptItem[],
    client: McpClient,
    provider: TranscriptsViewProvider | null
  ): Promise<void> {
    try {
      // List available projects
      // Only pass contextDirectory if server is in local mode
      const shouldPass = await shouldPassContextDirectory(client);
      const contextDirectory = shouldPass ? getDefaultContextDirectory() : undefined;
      const projectsResult = await client.callTool(
        'protokoll_list_projects',
        contextDirectory ? { contextDirectory } : {}
      ) as {
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
        placeHolder: `Select a project to move ${items.length} transcript${items.length > 1 ? 's' : ''} to`,
      });

      if (!selected) {
        return; // User cancelled
      }

      // Move all selected transcripts
      const errors: string[] = [];
      for (const item of items) {
        if (!item.transcript) {
          continue;
        }
        try {
          const transcriptPath = item.transcript.path || item.transcript.filename;
          await client.callTool('protokoll_edit_transcript', {
            transcriptPath: transcriptPath,
            projectId: selected.id,
          });
        } catch (error) {
          const transcriptName = item.transcript.title || item.transcript.filename;
          errors.push(`${transcriptName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (errors.length > 0) {
        vscode.window.showWarningMessage(
          `Moved ${items.length - errors.length} of ${items.length} transcript(s). Errors: ${errors.join('; ')}`
        );
      } else {
        vscode.window.showInformationMessage(
          `Protokoll: Moved ${items.length} transcript${items.length > 1 ? 's' : ''} to project "${selected.label}"`
        );
      }

      // Refresh transcripts to show the updated project
      if (provider) {
        await provider.refresh();
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to move transcripts: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const changeTranscriptStatusCommand = vscode.commands.registerCommand(
    'protokoll.changeTranscriptStatus',
    async (item: TranscriptItem) => {
      if (!mcpClient) {
        vscode.window.showErrorMessage('MCP client not initialized. Please configure the server URL first.');
        return;
      }

      if (!item || !item.transcript) {
        vscode.window.showErrorMessage('No transcript selected.');
        return;
      }

      await changeTranscriptsStatus([item], mcpClient, transcriptsViewProvider);
    }
  );

  const changeSelectedTranscriptsStatusCommand = vscode.commands.registerCommand(
    'protokoll.changeSelectedTranscriptsStatus',
    async () => {
      if (!mcpClient) {
        vscode.window.showErrorMessage('MCP client not initialized. Please configure the server URL first.');
        return;
      }

      if (!transcriptsViewProvider) {
        vscode.window.showErrorMessage('Transcripts view provider not initialized.');
        return;
      }

      const selectedItems = transcriptsViewProvider.getSelectedItems();
      if (selectedItems.length === 0) {
        vscode.window.showWarningMessage('No transcripts selected. Select one or more transcripts to change status.');
        return;
      }

      await changeTranscriptsStatus(selectedItems, mcpClient, transcriptsViewProvider);
    }
  );

  // Helper function to change transcript status
  async function changeTranscriptsStatus(
    items: TranscriptItem[],
    client: McpClient,
    provider: TranscriptsViewProvider | null
  ): Promise<void> {
    const statuses = [
      { id: 'initial', label: 'Initial', icon: '📝' },
      { id: 'enhanced', label: 'Enhanced', icon: '✨' },
      { id: 'reviewed', label: 'Reviewed', icon: '👀' },
      { id: 'in_progress', label: 'In Progress', icon: '🔄' },
      { id: 'closed', label: 'Closed', icon: '✅' },
      { id: 'archived', label: 'Archived', icon: '📦' },
    ];

    const statusItems = statuses.map(s => ({
      label: `${s.icon} ${s.label}`,
      description: s.id,
      id: s.id,
    }));

    const selected = await vscode.window.showQuickPick(statusItems, {
      placeHolder: `Select new status for ${items.length} transcript${items.length > 1 ? 's' : ''}`,
      title: 'Change transcript status',
    });

    if (!selected) {
      return; // User cancelled
    }

    const errors: string[] = [];
    for (const item of items) {
      if (!item.transcript) {
        continue;
      }
      try {
        const transcriptPath = item.transcript.path || item.transcript.filename;
        await client.callTool('protokoll_edit_transcript', {
          transcriptPath: transcriptPath,
          status: selected.id,
        });
      } catch (error) {
        const transcriptName = item.transcript.title || item.transcript.filename;
        errors.push(`${transcriptName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (errors.length > 0) {
      vscode.window.showWarningMessage(
        `Updated status for ${items.length - errors.length} of ${items.length} transcript(s). Errors: ${errors.join('; ')}`
      );
    } else {
      vscode.window.showInformationMessage(
        `Protokoll: Set ${items.length} transcript${items.length > 1 ? 's' : ''} to "${selected.label}"`
      );
    }

    if (provider) {
      await provider.refresh();
    }
  }

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
        await vscode.env.clipboard.writeText(content.content);
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

  const createNoteCommand = vscode.commands.registerCommand(
    'protokoll.createNote',
    async () => {
      if (!mcpClient) {
        vscode.window.showErrorMessage('MCP client not initialized. Please configure the server URL first.');
        return;
      }

      try {
        // Prompt for title
        const title = await vscode.window.showInputBox({
          prompt: 'Enter a title for the note',
          placeHolder: 'Note title',
          validateInput: (value) => {
            if (!value || value.trim() === '') {
              return 'Title cannot be empty';
            }
            return null;
          },
        });

        if (!title) {
          return; // User cancelled
        }

        // Prompt for project
        let projectId: string | undefined;
        try {
          // Only pass contextDirectory if server is in local mode
          const shouldPass = await shouldPassContextDirectory(mcpClient);
          const contextDirectory = shouldPass ? getDefaultContextDirectory() : undefined;
          const projectsResult = await mcpClient.callTool(
            'protokoll_list_projects',
            contextDirectory ? { contextDirectory } : {}
          ) as {
            projects?: Array<{ id: string; name: string; active?: boolean }>;
          };
          
          if (projectsResult.projects && projectsResult.projects.length > 0) {
            const activeProjects = projectsResult.projects.filter(p => p.active !== false);
            if (activeProjects.length > 0) {
              const projectItems = activeProjects.map(p => ({
                label: p.name,
                description: p.id,
                id: p.id,
              }));
              
              // Add option to skip project selection
              projectItems.unshift({
                label: '$(circle-slash) No Project',
                description: 'Create note without project assignment',
                id: '',
              });
              
              const selected = await vscode.window.showQuickPick(projectItems, {
                placeHolder: 'Select a project for this note',
              });
              
              if (selected === undefined) {
                return; // User cancelled
              }
              
              if (selected.id) {
                projectId = selected.id;
              }
            }
          }
        } catch (error) {
          // Ignore errors when fetching projects - project is optional
          console.log('Could not fetch projects:', error);
        }

        // Call the MCP tool to create the note (no content - user will add via the view)
        const result = await mcpClient.callTool('protokoll_create_note', {
          title: title.trim(),
          content: '',
          projectId: projectId,
        }) as {
          success?: boolean;
          filePath?: string;
          filename?: string;
          uri?: string;
          message?: string;
        };

        if (result.success) {
          // Refresh transcripts to show the new note
          if (transcriptsViewProvider) {
            await transcriptsViewProvider.refresh();
          }

          // Open the newly created note in the detail view
          if (result.filePath && transcriptDetailViewProvider) {
            // Construct a transcript object from the result
            const newTranscript: Transcript = {
              uri: result.uri || `protokoll://transcript/${result.filePath}`,
              path: result.filePath,
              filename: result.filename || result.filePath.split('/').pop() || '',
              title: title.trim(),
              date: new Date().toISOString(),
            };
            
            await transcriptDetailViewProvider.showTranscript(newTranscript.uri, newTranscript);
          }
        } else {
          vscode.window.showErrorMessage('Failed to create note: Unknown error');
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to create note: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  // Refresh transcripts when configuration changes
  const configWatcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (e.affectsConfiguration('protokoll.serverUrl')) {
      const config = vscode.workspace.getConfiguration('protokoll');
      const rawServerUrl = config.get<string>('serverUrl', 'http://127.0.0.1:3000');
      // Remove trailing slashes to ensure consistent URL handling
      const serverUrl = rawServerUrl.replace(/\/+$/, '');
      
      if (connectionStatusViewProvider) {
        connectionStatusViewProvider.setServerUrl(serverUrl);
      }
      
      if (serverUrl && serverUrl !== '') {
        try {
          mcpClient = new McpClient(serverUrl);
          clearServerModeCache(); // Clear cached server mode on new connection
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
      await mcpClient.subscribeToResource('protokoll://transcripts');
      console.log('Protokoll: [EXTENSION] ✅ Successfully subscribed to transcripts list');
    } catch (error) {
      console.error('Protokoll: [EXTENSION] ❌ Failed to subscribe to transcripts list:', error);
    }
  }

  // Add keyboard navigation handler for back arrow
  // Note: VS Code already handles up/down arrow navigation by default
  // The left arrow (back) will navigate to parent nodes
  const backArrowHandler = vscode.commands.registerCommand(
    'protokoll.navigateBack',
    async () => {
      if (transcriptsTreeView && transcriptsTreeView.visible) {
        const selection = transcriptsTreeView.selection;
        if (selection.length > 0) {
          const currentItem = selection[0];
          // Navigate to parent: transcript -> month -> year
          if (currentItem.type === 'transcript' || currentItem.type === 'month') {
            const parent = await transcriptsViewProvider?.getParent(currentItem);
            if (parent) {
              await transcriptsTreeView.reveal(parent, { focus: true, select: true });
            }
          } else if (currentItem.type === 'year') {
            // At year level, just focus it (VS Code will handle collapsing)
            await transcriptsTreeView.reveal(currentItem, { focus: true, select: true });
          }
        }
      }
    }
  );

  context.subscriptions.push(
    showTranscriptsCommand,
    configureServerCommand,
    openTranscriptCommand,
    openTranscriptInNewTabCommand,
    refreshTranscriptsCommand,
    loadMoreTranscriptsCommand,
    refreshPeopleCommand,
    searchPeopleCommand,
    loadMorePeopleCommand,
    refreshTermsCommand,
    searchTermsCommand,
    loadMoreTermsCommand,
    refreshProjectsCommand,
    searchProjectsCommand,
    loadMoreProjectsCommand,
    refreshCompaniesCommand,
    searchCompaniesCommand,
    loadMoreCompaniesCommand,
    addPersonCommand,
    addTermCommand,
    addProjectCommand,
    addCompanyCommand,
    openEntityCommand,
    filterByProjectCommand,
    filterByStatusCommand,
    sortTranscriptsCommand,
    startNewSessionCommand,
    renameTranscriptCommand,
    moveToProjectCommand,
    moveSelectedToProjectCommand,
    changeTranscriptStatusCommand,
    changeSelectedTranscriptsStatusCommand,
    copyTranscriptCommand,
    openTranscriptToSideCommand,
    openTranscriptWithCommand,
    copyTranscriptUrlCommand,
    copySessionIdCommand,
    openChatCommand,
    refreshChatsCommand,
    openChatPanelCommand,
    closeChatPanelCommand,
    createNoteCommand,
    backArrowHandler,
    configWatcher,
    transcriptsTreeView,
    peopleTreeView,
    termsTreeView,
    projectsTreeView,
    companiesTreeView,
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
