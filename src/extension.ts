/**
 * Main extension entry point
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { McpClient } from './mcpClient';
import { TranscriptsViewProvider, TranscriptItem } from './transcriptsView';
import { TranscriptDetailViewProvider, getTranscriptContentProvider, getEditableTranscriptFiles } from './transcriptDetailView';
import { ConnectionStatusViewProvider, ServerConnectionEntry } from './connectionStatusView';
import { ChatViewProvider } from './chatView';
import { ChatsViewProvider } from './chatsView';
import { PeopleViewProvider } from './peopleView';
import { TermsViewProvider } from './termsView';
import { ProjectsViewProvider } from './projectsView';
import { CompaniesViewProvider } from './companiesView';
import { DashboardViewProvider } from './dashboardView';
import type { Transcript, TranscriptContent, TranscriptStatus, TranscriptContentType } from './types';
import { log, initLogger } from './logger';
import { shouldPassContextDirectory, clearServerModeCache } from './serverMode';
import { UploadService } from './uploadService';
import { applyProxyEnvironmentPolicy } from './proxyUtils';
import { ServerProfilesStore } from './multiServer/profilesStore';
import type { ServerProfile } from './multiServer/types';
import { getServerApiKeySecretStorageKey } from './multiServer/auth';

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
let dashboardViewProvider: DashboardViewProvider | null = null;
let serverConnections: ServerConnectionEntry[] = [];
let activeServerId: string | null = null;
const connectedServerClients: Map<string, McpClient> = new Map();
const TRANSCRIPTS_REFRESH_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ENTITY_SYNC_LIMIT = 200;
const ENTITY_SYNC_MUTE_MS = 8000;

type SyncEntityType = 'person' | 'term' | 'project' | 'company';

interface EntitySyncConfig {
  listTool: string;
  listKey: string;
  addTool: string;
  editTool: string;
}

const ENTITY_SYNC_CONFIG: Record<SyncEntityType, EntitySyncConfig> = {
  person: {
    listTool: 'protokoll_list_people',
    listKey: 'people',
    addTool: 'protokoll_add_person',
    editTool: 'protokoll_edit_person',
  },
  term: {
    listTool: 'protokoll_list_terms',
    listKey: 'terms',
    addTool: 'protokoll_add_term',
    editTool: 'protokoll_edit_term',
  },
  project: {
    listTool: 'protokoll_list_projects',
    listKey: 'projects',
    addTool: 'protokoll_add_project',
    editTool: 'protokoll_edit_project',
  },
  company: {
    listTool: 'protokoll_list_companies',
    listKey: 'companies',
    addTool: 'protokoll_add_company',
    editTool: 'protokoll_edit_company',
  },
};

function getDefaultContextDirectory(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getConfigurationScopeUri(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

function getProtokollConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('protokoll', getConfigurationScopeUri());
}

const LEGACY_API_KEY_SECRET_STORAGE_KEY = 'protokoll.apiKey';
const DEFAULT_SERVER_PROFILE_ID = 'default-server';

function getApiKeySecretStorageKey(serverId: string): string {
  return getServerApiKeySecretStorageKey(serverId);
}

async function getConfiguredApiKey(context: vscode.ExtensionContext, serverId: string): Promise<string | undefined> {
  const raw = await context.secrets.get(getApiKeySecretStorageKey(serverId));
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

async function clearLegacyApiKeyConfiguration(): Promise<void> {
  const config = vscode.workspace.getConfiguration('protokoll');
  await config.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
  await config.update('apiKey', undefined, vscode.ConfigurationTarget.Workspace);

  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (workspaceUri) {
    const workspaceConfig = vscode.workspace.getConfiguration('protokoll', workspaceUri);
    await workspaceConfig.update('apiKey', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}

async function migrateLegacyApiKeySetting(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('protokoll');
  const rawLegacyValue = config.get<string>('apiKey', '');
  const legacyApiKey = rawLegacyValue?.trim();
  const storedLegacySecret = (await context.secrets.get(LEGACY_API_KEY_SECRET_STORAGE_KEY))?.trim();
  const sourceApiKey = legacyApiKey || storedLegacySecret;
  if (!sourceApiKey) {
    return;
  }

  const storedApiKey = await getConfiguredApiKey(context, DEFAULT_SERVER_PROFILE_ID);
  if (!storedApiKey) {
    await context.secrets.store(getApiKeySecretStorageKey(DEFAULT_SERVER_PROFILE_ID), sourceApiKey);
    await context.secrets.delete(LEGACY_API_KEY_SECRET_STORAGE_KEY);
    vscode.window.showInformationMessage('Protokoll: Migrated API key to per-server secure secret storage.');
  }

  await clearLegacyApiKeyConfiguration();
}

function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function resolveTranscriptToolRef(transcript: Transcript): string {
  if (transcript.uri && transcript.uri.startsWith('protokoll://transcript/')) {
    return transcript.uri.replace(/^protokoll:\/\/transcript\/\.\.\//, 'protokoll://transcript/');
  }
  if (transcript.path && transcript.path.trim().length > 0) {
    return transcript.path;
  }
  throw new Error(`Transcript reference is missing for "${transcript.filename}"`);
}

function resolveEditableTranscriptRef(transcriptUri: string, transcriptPath: string): string {
  if (transcriptUri && transcriptUri.startsWith('protokoll://transcript/')) {
    return transcriptUri.replace(/^protokoll:\/\/transcript\/\.\.\//, 'protokoll://transcript/');
  }
  if (transcriptPath && transcriptPath.trim().length > 0) {
    return transcriptPath;
  }
  throw new Error('Transcript reference is missing for save sync');
}

function applyClientToProviders(client: McpClient): void {
  if (transcriptsViewProvider) {
    transcriptsViewProvider.setClient(client);
  }
  if (peopleViewProvider) {
    peopleViewProvider.setClient(client);
  }
  if (termsViewProvider) {
    termsViewProvider.setClient(client);
  }
  if (projectsViewProvider) {
    projectsViewProvider.setClient(client);
  }
  if (companiesViewProvider) {
    companiesViewProvider.setClient(client);
  }
  if (transcriptDetailViewProvider) {
    transcriptDetailViewProvider.setClient(client);
  }
  if (chatViewProvider) {
    chatViewProvider.setClient(client);
  }
  if (dashboardViewProvider) {
    dashboardViewProvider.setClient(client);
    const active = activeServerId
      ? serverConnections.find((c) => c.id === activeServerId)
      : serverConnections[0];
    dashboardViewProvider.setPrimaryServerLabel(active?.name ?? '');
  }
  if (connectionStatusViewProvider) {
    connectionStatusViewProvider.setClient(client);
  }
}

function buildConnectedServerClientEntries(): Array<{ id: string; name: string; client: McpClient }> {
  return serverConnections
    .filter((connection) => connection.isConnected === true)
    .map((connection) => {
      const client = connectedServerClients.get(connection.id);
      if (!client) {
        return null;
      }
      return {
        id: connection.id,
        name: connection.name,
        client,
      };
    })
    .filter((entry): entry is { id: string; name: string; client: McpClient } => entry !== null);
}

function syncTranscriptsProviderClients(): void {
  if (!transcriptsViewProvider) {
    return;
  }
  const entries = buildConnectedServerClientEntries();
  transcriptsViewProvider.setClients(entries);
  dashboardViewProvider?.setServerClients(entries);
  dashboardViewProvider?.scheduleDataRefreshDebouncedIfVisible();
}

// Create an output channel for debugging
const outputChannel = vscode.window.createOutputChannel('Protokoll Debug');

// Initialize the shared logger
initLogger(outputChannel);

export async function activate(context: vscode.ExtensionContext) {
  log('Protokoll extension is now active');
  console.log('Protokoll: [ACTIVATION] Extension activate() called');
  applyProxyEnvironmentPolicy();
  await migrateLegacyApiKeySetting(context);
  // Clear legacy multi-server state from earlier versions.
  await context.globalState.update('protokoll.serverConnections', undefined);
  await context.globalState.update('protokoll.activeServerId', undefined);

  // Initialize MCP client
  const config = getProtokollConfiguration();
  const rawServerUrl = config.get<string>('serverUrl', 'http://127.0.0.1:3002');
  const fallbackServerUrl = normalizeServerUrl(rawServerUrl);
  const hasConfiguredUrl = context.globalState.get<boolean>('protokoll.hasConfiguredUrl', false);
  const profilesStore = new ServerProfilesStore(context.globalState);
  const { profiles, activeServerId: storedActiveServerId } = await profilesStore.loadProfiles(fallbackServerUrl);
  const resolveDisplayName = (profile: ServerProfile, index: number): string => profile.name?.trim() || `Server ${index + 1}`;
  serverConnections = profiles.map((profile, index) => ({
    id: profile.id,
    name: resolveDisplayName(profile, index),
    url: profile.url,
    isConnected: false,
    hasApiKey: false,
    sessionId: null,
  }));
  activeServerId = storedActiveServerId ?? serverConnections[0]?.id ?? null;
  const activeConnection = serverConnections.find((connection) => connection.id === activeServerId) ?? serverConnections[0];
  if (activeConnection && activeConnection.id !== activeServerId) {
    activeServerId = activeConnection.id;
    await profilesStore.saveActiveServerId(activeServerId);
  }
  const serverUrl = activeConnection?.url ?? fallbackServerUrl;

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
  const entityNotificationDisposers: Map<string, Array<() => void>> = new Map();
  let registerEntitySyncHandlers: (serverId: string, client: McpClient) => void = () => {};
  let maybeSyncAllEntitiesAcrossPeers: (reason: string) => Promise<void> = async () => {};
  
  try {
    mcpClient = new McpClient(serverUrl, { apiKey: await getConfiguredApiKey(context, activeServerId ?? DEFAULT_SERVER_PROFILE_ID) });
    clearServerModeCache(); // Clear cached server mode on new connection

    let notificationRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let notificationRefreshInFlight = false;
    let pendingTranscriptRefresh = false;
    let pendingEntityRefresh = false;
    let pendingOpenTranscriptRefresh = false;

    const runNotificationRefreshQueue = async (): Promise<void> => {
      if (notificationRefreshInFlight) {
        return;
      }
      notificationRefreshInFlight = true;
      try {
        do {
          const refreshTranscripts = pendingTranscriptRefresh;
          const refreshEntities = pendingEntityRefresh;
          const refreshOpenTranscripts = pendingOpenTranscriptRefresh;
          pendingTranscriptRefresh = false;
          pendingEntityRefresh = false;
          pendingOpenTranscriptRefresh = false;

          if (refreshTranscripts && transcriptsViewProvider) {
            await transcriptsViewProvider.refresh();
          }

          if (refreshEntities) {
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
          }

          if (refreshOpenTranscripts && transcriptDetailViewProvider) {
            const allOpenTranscripts = transcriptDetailViewProvider.getAllOpenTranscripts();
            for (const openTranscript of allOpenTranscripts) {
              try {
                await transcriptDetailViewProvider.refreshTranscript(openTranscript.uri);
              } catch (error) {
                console.warn(`Protokoll: [EXTENSION] ⚠️ Failed to refresh transcript ${openTranscript.uri}:`, error);
              }
            }
          }
        } while (pendingTranscriptRefresh || pendingEntityRefresh || pendingOpenTranscriptRefresh);
      } finally {
        notificationRefreshInFlight = false;
      }
    };

    const scheduleNotificationRefresh = (options: {
      transcripts?: boolean;
      entities?: boolean;
      openTranscripts?: boolean;
    }): void => {
      pendingTranscriptRefresh = pendingTranscriptRefresh || options.transcripts === true;
      pendingEntityRefresh = pendingEntityRefresh || options.entities === true;
      pendingOpenTranscriptRefresh = pendingOpenTranscriptRefresh || options.openTranscripts === true;
      if (notificationRefreshTimer) {
        clearTimeout(notificationRefreshTimer);
      }
      notificationRefreshTimer = setTimeout(() => {
        notificationRefreshTimer = undefined;
        void runNotificationRefreshQueue();
      }, 250);
    };

    const mutedEntityNotifications: Map<string, number> = new Map();
    let entitySyncInFlight = false;

    const parseEntityUri = (uri: string): { entityType: SyncEntityType; entityId: string } | null => {
      const match = uri.match(/^protokoll:\/\/entity\/([^/]+)\/(.+)$/);
      if (!match) {
        return null;
      }
      const entityType = match[1] as SyncEntityType;
      if (!Object.prototype.hasOwnProperty.call(ENTITY_SYNC_CONFIG, entityType)) {
        return null;
      }
      return {
        entityType,
        entityId: decodeURIComponent(match[2]),
      };
    };

    const normalizeEntityName = (entity: Record<string, unknown>): string | null => {
      const value = typeof entity.name === 'string' ? entity.name.trim() : '';
      return value.length > 0 ? value : null;
    };

    const normalizeEntityId = (entity: Record<string, unknown>): string | null => {
      const value = typeof entity.id === 'string' ? entity.id.trim() : '';
      return value.length > 0 ? value : null;
    };

    const buildEntityUri = (entityType: SyncEntityType, entityId: string): string =>
      `protokoll://entity/${entityType}/${encodeURIComponent(entityId)}`;

    const parseEntityPayload = (raw: string): Record<string, unknown> | null => {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
      return null;
    };

    const buildAddArgs = (entityType: SyncEntityType, entity: Record<string, unknown>): Record<string, unknown> => {
      const name = normalizeEntityName(entity);
      const id = normalizeEntityId(entity);
      if (!name) {
        throw new Error('Entity is missing name');
      }
      if (!id) {
        throw new Error('Entity is missing canonical id');
      }
      if (entityType === 'term') {
        return { term: name, id };
      }
      if (entityType === 'project') {
        return { name, id, useSmartAssist: false };
      }
      return { name, id };
    };

    const buildEditArgs = (
      entityType: SyncEntityType,
      targetId: string,
      entity: Record<string, unknown>
    ): Record<string, unknown> => {
      const args: Record<string, unknown> = { id: targetId };
      const maybeCopy = (key: string, destinationKey?: string) => {
        if (entity[key] !== undefined) {
          args[destinationKey ?? key] = entity[key];
        }
      };

      maybeCopy('name');
      if (entityType === 'person') {
        maybeCopy('description', 'context');
        maybeCopy('context');
        maybeCopy('role');
        maybeCopy('company');
        maybeCopy('firstName');
        maybeCopy('lastName');
        maybeCopy('sounds_like', 'add_sounds_like');
        return args;
      }

      maybeCopy('description');

      if (entityType === 'term') {
        maybeCopy('expansion');
        maybeCopy('domain');
        maybeCopy('sounds_like', 'add_sounds_like');
      } else if (entityType === 'project') {
        maybeCopy('destination');
        maybeCopy('structure');
        maybeCopy('contextType');
        maybeCopy('triggerPhrases');
        maybeCopy('active');
      } else if (entityType === 'company') {
        maybeCopy('fullName');
        maybeCopy('industry');
        maybeCopy('sounds_like', 'add_sounds_like');
      }

      return args;
    };

    const fetchEntityList = async (
      client: McpClient,
      entityType: SyncEntityType
    ): Promise<Array<Record<string, unknown>>> => {
      const config = ENTITY_SYNC_CONFIG[entityType];
      const response = await client.callTool(config.listTool, { limit: ENTITY_SYNC_LIMIT, offset: 0 }) as Record<string, unknown>;
      const list = response[config.listKey];
      if (!Array.isArray(list)) {
        return [];
      }
      return list.filter((item): item is Record<string, unknown> =>
        !!item && typeof item === 'object' && !Array.isArray(item)
      );
    };

    const upsertEntityOnTarget = async (
      targetServerId: string,
      targetClient: McpClient,
      entityType: SyncEntityType,
      sourceEntity: Record<string, unknown>
    ): Promise<void> => {
      const sourceName = normalizeEntityName(sourceEntity);
      const sourceId = normalizeEntityId(sourceEntity);
      if (!sourceName || !sourceId) {
        return;
      }
      const targetEntities = await fetchEntityList(targetClient, entityType);
      const existingById = targetEntities.find((entity) => normalizeEntityId(entity) === sourceId);
      const existingByName = targetEntities.find((entity) => normalizeEntityName(entity)?.toLowerCase() === sourceName.toLowerCase());
      const existing = existingById ?? existingByName;
      const config = ENTITY_SYNC_CONFIG[entityType];

      let targetId: string | null = null;
      if (existing && typeof existing.id === 'string' && existing.id.trim().length > 0) {
        targetId = existing.id;
        if (targetId !== sourceId) {
          log('Protokoll: Entity id mismatch detected across peers; preserving existing target id', {
            targetServerId,
            entityType,
            sourceId,
            targetId,
            name: sourceName,
          });
        }
      } else {
        const created = await targetClient.callTool(config.addTool, buildAddArgs(entityType, sourceEntity)) as Record<string, unknown>;
        const createdId = typeof created.id === 'string'
          ? created.id
          : (created.entity && typeof created.entity === 'object' && !Array.isArray(created.entity) && typeof (created.entity as Record<string, unknown>).id === 'string')
            ? String((created.entity as Record<string, unknown>).id)
            : null;
        targetId = createdId;
      }

      if (!targetId) {
        return;
      }

      const editArgs = buildEditArgs(entityType, targetId, sourceEntity);
      if (Object.keys(editArgs).length > 1) {
        try {
          await targetClient.callTool(config.editTool, editArgs);
        } catch (error) {
          log('Protokoll: Entity sync edit failed; continuing with best effort', {
            targetServerId,
            entityType,
            targetId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const muteKeyByUri = `${targetServerId}:${buildEntityUri(entityType, targetId)}`;
      const muteKeyByName = `${targetServerId}:${entityType}:${sourceName.toLowerCase()}`;
      const muteUntil = Date.now() + ENTITY_SYNC_MUTE_MS;
      mutedEntityNotifications.set(muteKeyByUri, muteUntil);
      mutedEntityNotifications.set(muteKeyByName, muteUntil);
    };

    const withEntitySyncLock = async (task: () => Promise<void>): Promise<void> => {
      if (entitySyncInFlight) {
        return;
      }
      entitySyncInFlight = true;
      try {
        await task();
      } finally {
        entitySyncInFlight = false;
      }
    };

    const propagateEntityToPeers = async (
      sourceServerId: string,
      entityType: SyncEntityType,
      sourceEntity: Record<string, unknown>
    ): Promise<void> => {
      const targets = Array.from(connectedServerClients.entries()).filter(([serverId]) => serverId !== sourceServerId);
      await Promise.all(targets.map(async ([targetServerId, targetClient]) => {
        await upsertEntityOnTarget(targetServerId, targetClient, entityType, sourceEntity);
      }));
    };

    maybeSyncAllEntitiesAcrossPeers = async (reason: string): Promise<void> => {
      const connectedEntries = Array.from(connectedServerClients.entries());
      if (connectedEntries.length < 2) {
        return;
      }
      await withEntitySyncLock(async () => {
        log('Protokoll: Running peer context sync', { reason, servers: connectedEntries.length });
        for (const [sourceServerId, sourceClient] of connectedEntries) {
          for (const entityType of Object.keys(ENTITY_SYNC_CONFIG) as SyncEntityType[]) {
            const sourceEntities = await fetchEntityList(sourceClient, entityType);
            for (const sourceEntity of sourceEntities) {
              await propagateEntityToPeers(sourceServerId, entityType, sourceEntity);
            }
          }
        }
      });
      scheduleNotificationRefresh({ entities: true });
    };

    registerEntitySyncHandlers = (serverId: string, client: McpClient): void => {
      const existingDisposers = entityNotificationDisposers.get(serverId);
      if (existingDisposers) {
        for (const dispose of existingDisposers) {
          dispose();
        }
      }

      const disposers: Array<() => void> = [];
      disposers.push(client.onNotification('notifications/resource_changed', async (data: unknown) => {
        const params = data as { uri?: string };
        const uri = params.uri;
        if (!uri || !uri.startsWith('protokoll://entity/')) {
          return;
        }

        const now = Date.now();
        const muteKeyByUri = `${serverId}:${uri}`;
        const mutedByUriUntil = mutedEntityNotifications.get(muteKeyByUri);
        if (mutedByUriUntil && mutedByUriUntil > now) {
          return;
        }

        const parsedUri = parseEntityUri(uri);
        if (!parsedUri) {
          return;
        }

        try {
          const content = await client.readResource(uri);
          const sourceEntity = parseEntityPayload(content.text);
          if (!sourceEntity) {
            return;
          }

          const sourceName = normalizeEntityName(sourceEntity);
          if (sourceName) {
            const muteKeyByName = `${serverId}:${parsedUri.entityType}:${sourceName.toLowerCase()}`;
            const mutedByNameUntil = mutedEntityNotifications.get(muteKeyByName);
            if (mutedByNameUntil && mutedByNameUntil > now) {
              return;
            }
          }

          await withEntitySyncLock(async () => {
            await propagateEntityToPeers(serverId, parsedUri.entityType, sourceEntity);
          });
          scheduleNotificationRefresh({ entities: true });
        } catch (error) {
          log('Protokoll: Failed to propagate entity notification to peers', {
            serverId,
            uri,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }));

      disposers.push(client.onSessionRecovered(async () => {
        try {
          await client.subscribeToResource('protokoll://transcripts');
        } catch (error) {
          log('Protokoll: Failed to re-subscribe transcripts on session recovery', {
            serverId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }));

      entityNotificationDisposers.set(serverId, disposers);
    };
    
    // Check server health
    const isHealthy = await mcpClient.healthCheck();
    if (!isHealthy) {
      if (activeServerId) {
        updateConnection(activeServerId, { url: serverUrl, isConnected: false, sessionId: null });
      }
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
        if (activeServerId && mcpClient) {
          connectedServerClients.set(activeServerId, mcpClient);
        }
        if (activeServerId && mcpClient) {
          updateConnection(activeServerId, {
            url: serverUrl,
            isConnected: true,
            sessionId: mcpClient?.getSessionId() ?? null,
          });
          registerEntitySyncHandlers(activeServerId, mcpClient);
        }
        vscode.window.showInformationMessage(`Protokoll: Connected to ${serverUrl}`);
        
        // Note: connectionStatusViewProvider is not yet initialized at this point
        // It will be set up later after view providers are created
        
        // Subscribe to resource list change notifications (for transcript list and entity views)
        console.log('Protokoll: [EXTENSION] Registering notification handler for resources_changed');
        mcpClient.onNotification('notifications/resources_changed', async () => {
          console.log('Protokoll: [EXTENSION] 📢 Received resources_changed notification, refreshing views');
          scheduleNotificationRefresh({ transcripts: true, entities: true, openTranscripts: true });
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
            scheduleNotificationRefresh({ transcripts: true });
            return;
          }
          
          // Check if this is an entity URI
          if (params.uri.startsWith('protokoll://entity/')) {
            console.log('Protokoll: [EXTENSION] This is an entity URI, refreshing if open');
            console.log(`Protokoll: [EXTENSION] Notification URI: ${params.uri}`);
            scheduleNotificationRefresh({ entities: true });
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
            scheduleNotificationRefresh({ transcripts: true });
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
        if (activeServerId) {
          serverConnections = serverConnections.map((connection) => connection.id === activeServerId
            ? { ...connection, isConnected: false, sessionId: null }
            : connection);
        }
        vscode.window.showWarningMessage(
          `Protokoll: Connected to server but initialization failed: ${initError instanceof Error ? initError.message : String(initError)}`
        );
        if (connectionStatusViewProvider) {
          connectionStatusViewProvider.setConnectionStatus(false, null);
        }
      }
    }
  } catch (error) {
    if (activeServerId) {
      serverConnections = serverConnections.map((connection) => connection.id === activeServerId
        ? { ...connection, isConnected: false, sessionId: null }
        : connection);
    }
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
    syncTranscriptsProviderClients();
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
  connectionStatusViewProvider.setConnections(serverConnections, activeServerId);
  if (mcpClient) {
    connectionStatusViewProvider.setClient(mcpClient);
    connectionStatusViewProvider.setConnectionStatus(serverConnected, mcpClient.getSessionId());
  } else {
    connectionStatusViewProvider.setServerUrl(serverUrl);
  }
  void refreshServerApiKeyState();
  if (serverConnections.length > 1) {
    void connectAdditionalServers();
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

  // Dashboard and upload service (shared by dashboard provider and upload command)
  const uploadService = new UploadService();
  dashboardViewProvider = new DashboardViewProvider(context.extensionUri);
  dashboardViewProvider.setUploadService(uploadService);
  dashboardViewProvider.setTranscriptsProvider(transcriptsViewProvider);
  if (mcpClient) {
    dashboardViewProvider.setClient(mcpClient);
    const activeForLabel = activeServerId
      ? serverConnections.find((c) => c.id === activeServerId)
      : serverConnections[0];
    dashboardViewProvider.setPrimaryServerLabel(activeForLabel?.name ?? '');
    log('Protokoll: Dashboard view provider initialized with MCP client');

    // Wire merged servers before the first refresh so stats match the Transcripts tree.
    // (Avoids a second full refresh from syncTranscriptsProviderClients right after show().)
    dashboardViewProvider.setServerClients(buildConnectedServerClientEntries());

    // Auto-open dashboard on startup (if not disabled)
    const autoOpen = vscode.workspace.getConfiguration('protokoll').get<boolean>('dashboard.autoOpen', true);
    if (autoOpen && serverConnected) {
      void dashboardViewProvider.show();
    }
  } else {
    log('Protokoll: Dashboard view provider initialized without MCP client');
  }

  // When a transcript's metadata changes (e.g. status), update the transcripts list.
  // Uses in-place update when a specific URI and changes are provided, avoiding a
  // full re-fetch that would reset scroll position on large loaded lists.
  transcriptDetailViewProvider.setOnTranscriptChanged(async (transcriptUri, updates) => {
    if (!transcriptsViewProvider) {
      return;
    }
    if (transcriptUri && updates) {
      const updated = transcriptsViewProvider.updateTranscriptInPlace(transcriptUri, updates);
      if (updated) {
        return;
      }
    }
    await transcriptsViewProvider.refresh();
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
          
          const transcriptRef = resolveEditableTranscriptRef(
            transcriptInfo.transcriptUri,
            transcriptInfo.transcriptPath
          );
          log(`Protokoll: Syncing edited transcript to server: ${transcriptRef}`);
          await mcpClient.callTool('protokoll_update_transcript_content', {
            transcriptPath: transcriptRef,
            content: fullContent,
            contentTarget: transcriptInfo.editTarget,
          });
          
          // Update the original body to reflect the saved state
          transcriptInfo.originalBody = editedBody;
          transcriptInfo.originalContent = fullContent;
          
          vscode.window.showInformationMessage(
            transcriptInfo.editTarget === 'original'
              ? 'Protokoll: Original content saved to server'
              : 'Protokoll: Enhanced content saved to server'
          );
          
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

  // Fallback polling for transcript list changes:
  // If SSE/resource notifications are missed, periodically re-subscribe and refresh.
  let transcriptsPollTimer: ReturnType<typeof setInterval> | undefined;
  let transcriptsPollInFlight = false;
  const runTranscriptsPollRefresh = async (reason: 'interval' | 'visible'): Promise<void> => {
    if (transcriptsPollInFlight || !mcpClient || !transcriptsViewProvider) {
      return;
    }
    // For interval polls, skip work when the transcript tree isn't visible.
    if (reason === 'interval' && !transcriptsTreeView.visible) {
      return;
    }
    transcriptsPollInFlight = true;
    try {
      try {
        await mcpClient.subscribeToResource('protokoll://transcripts');
      } catch (error) {
        log('Protokoll: Transcript poll re-subscribe failed (continuing with refresh)', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await transcriptsViewProvider.refresh();
    } catch (error) {
      log('Protokoll: Transcript poll refresh failed', {
        error: error instanceof Error ? error.message : String(error),
        reason,
      });
    } finally {
      transcriptsPollInFlight = false;
    }
  };
  const stopTranscriptsPoll = (): void => {
    if (transcriptsPollTimer) {
      clearInterval(transcriptsPollTimer);
      transcriptsPollTimer = undefined;
    }
  };
  const startTranscriptsPoll = (): void => {
    stopTranscriptsPoll();
    transcriptsPollTimer = setInterval(() => {
      void runTranscriptsPollRefresh('interval');
    }, TRANSCRIPTS_REFRESH_POLL_INTERVAL_MS);
  };
  if (mcpClient) {
    startTranscriptsPoll();
  }
  context.subscriptions.push(new vscode.Disposable(() => {
    stopTranscriptsPoll();
  }));

  // Refresh transcripts when view becomes visible
  // Note: We don't use hasRefreshedOnce anymore because it caused race conditions
  // where visibility fired before connection completed, blocking subsequent refreshes
  transcriptsTreeView.onDidChangeVisibility(async (e) => {
    log('Protokoll: onDidChangeVisibility fired', { visible: e.visible, hasClient: !!mcpClient, hasTranscripts: transcriptsViewProvider?.hasTranscripts() });
    if (e.visible && transcriptsViewProvider && mcpClient) {
      // Always attempt re-subscribe when the view becomes visible.
      // This makes event listening more resilient across reconnect/session recovery edges.
      void runTranscriptsPollRefresh('visible');

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

  const syncConnectionStatusView = (): void => {
    if (!connectionStatusViewProvider) {
      return;
    }
    connectionStatusViewProvider.setConnections(serverConnections, activeServerId);
    const active = serverConnections.find((connection) => connection.id === activeServerId) ?? serverConnections[0];
    if (active) {
      connectionStatusViewProvider.setServerUrl(active.url);
      connectionStatusViewProvider.setConnectionStatus(active.isConnected ?? false, active.sessionId ?? null);
    }
  };

  function updateConnection(serverId: string, updates: Partial<ServerConnectionEntry>): void {
    serverConnections = serverConnections.map((connection) => connection.id === serverId
      ? { ...connection, ...updates }
      : connection);
  }

  function getConnectionById(serverId: string): ServerConnectionEntry | undefined {
    return serverConnections.find((connection) => connection.id === serverId);
  }

  function getClientForServer(serverId: string | null | undefined): McpClient | null {
    if (!serverId) {
      return mcpClient;
    }
    const mapped = connectedServerClients.get(serverId);
    if (mapped) {
      return mapped;
    }
    if (activeServerId === serverId && mcpClient) {
      return mcpClient;
    }
    return null;
  }

  async function activateServerContext(serverId: string): Promise<McpClient | null> {
    const client = getClientForServer(serverId);
    if (!client) {
      return null;
    }
    activeServerId = serverId;
    mcpClient = client;
    applyClientToProviders(client);
    await profilesStore.saveActiveServerId(serverId);
    syncConnectionStatusView();
    syncTranscriptsProviderClients();
    return client;
  }

  async function getClientForTranscript(transcript: Transcript): Promise<McpClient | null> {
    const transcriptServerId = transcript.serverId ?? activeServerId;
    if (!transcriptServerId) {
      return mcpClient;
    }
    return activateServerContext(transcriptServerId);
  }

  async function refreshServerApiKeyState(): Promise<void> {
    await Promise.all(serverConnections.map(async (connection) => {
      const hasApiKey = !!(await getConfiguredApiKey(context, connection.id));
      updateConnection(connection.id, { hasApiKey });
    }));
    syncConnectionStatusView();
  }

  async function persistProfilesFromConnections(): Promise<void> {
    const existingProfiles = profiles;
    const profileMap = new Map(existingProfiles.map((profile) => [profile.id, profile]));
    const updatedProfiles: ServerProfile[] = serverConnections.map((connection, index) => {
      const existing = profileMap.get(connection.id);
      const now = new Date().toISOString();
      return {
        id: connection.id,
        name: connection.name || `Server ${index + 1}`,
        url: normalizeServerUrl(connection.url),
        enabled: existing?.enabled ?? true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
    });
    await profilesStore.saveProfiles(updatedProfiles);
  }

  async function connectAdditionalServers(): Promise<void> {
    const targets = serverConnections.filter((connection) => connection.id !== activeServerId);
    const failedConnections: string[] = [];
    await Promise.all(targets.map(async (connection) => {
      try {
        const client = new McpClient(connection.url, {
          apiKey: await getConfiguredApiKey(context, connection.id),
        });
        const healthy = await client.healthCheck();
        if (!healthy) {
          updateConnection(connection.id, {
            isConnected: false,
            sessionId: null,
            lastError: `Server at ${connection.url} is not responding`,
          });
          failedConnections.push(connection.name);
          client.dispose();
          return;
        }
        await client.initialize();
        connectedServerClients.set(connection.id, client);
        registerEntitySyncHandlers(connection.id, client);
        updateConnection(connection.id, { isConnected: true, sessionId: client.getSessionId(), lastError: undefined });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log('Protokoll: Failed to connect additional server', {
          serverId: connection.id,
          error: errorMessage,
        });
        updateConnection(connection.id, { isConnected: false, sessionId: null, lastError: errorMessage });
        failedConnections.push(connection.name);
      }
    }));
    syncConnectionStatusView();
    syncTranscriptsProviderClients();
    await maybeSyncAllEntitiesAcrossPeers('connect-additional-servers');
    if (failedConnections.length > 0) {
      const action = await vscode.window.showWarningMessage(
        `Protokoll: ${failedConnections.length} server connection${failedConnections.length === 1 ? '' : 's'} failed (${failedConnections.join(', ')}).`,
        'Open Connection Status'
      );
      if (action === 'Open Connection Status') {
        await vscode.commands.executeCommand('protokollConnectionStatus.focus');
      }
    }
  }

  const connectToActiveServer = async (showSuccessMessage: boolean, updateConfig: boolean = true): Promise<void> => {
    const active = serverConnections.find((connection) => connection.id === activeServerId) ?? serverConnections[0];
    if (!active) {
      return;
    }

    const cleanUrl = normalizeServerUrl(active.url);
    if (updateConfig) {
      await config.update('serverUrl', cleanUrl, true);
    }
    await context.globalState.update('protokoll.hasConfiguredUrl', true);

    const previousClient = mcpClient;
    const previousClientServerId = previousClient
      ? Array.from(connectedServerClients.entries()).find(([, client]) => client === previousClient)?.[0] ?? null
      : null;
    try {
      const newClient = new McpClient(cleanUrl, { apiKey: await getConfiguredApiKey(context, active.id) });
      clearServerModeCache();
      const isHealthy = await newClient.healthCheck();
      const replacedClient = connectedServerClients.get(active.id);
      mcpClient = newClient;
      connectedServerClients.set(active.id, newClient);
      applyClientToProviders(newClient);
      startTranscriptsPoll();

      if (isHealthy) {
        await newClient.initialize();
        registerEntitySyncHandlers(active.id, newClient);
        const sessionId = newClient.getSessionId();
        updateConnection(active.id, { isConnected: true, sessionId, url: cleanUrl, lastError: undefined });
        syncConnectionStatusView();
        syncTranscriptsProviderClients();
        await maybeSyncAllEntitiesAcrossPeers('connect-active-server');
        if (transcriptsViewProvider) {
          await transcriptsViewProvider.refresh();
        }
        if (showSuccessMessage) {
          vscode.window.showInformationMessage(`Protokoll: Connected to ${cleanUrl}`);
        }
      } else {
        updateConnection(active.id, {
          isConnected: false,
          sessionId: null,
          url: cleanUrl,
          lastError: `Server at ${cleanUrl} is not responding`,
        });
        syncConnectionStatusView();
        syncTranscriptsProviderClients();
        vscode.window.showWarningMessage(`Protokoll: Server at ${cleanUrl} is not responding`);
      }

      if (replacedClient && replacedClient !== newClient && replacedClient !== previousClient) {
        replacedClient.dispose();
      }
      if (previousClient && previousClient !== newClient && previousClientServerId === active.id) {
        previousClient.dispose();
      }
    } catch (error) {
      connectedServerClients.delete(active.id);
      const notificationDisposers = entityNotificationDisposers.get(active.id);
      if (notificationDisposers) {
        for (const dispose of notificationDisposers) {
          dispose();
        }
        entityNotificationDisposers.delete(active.id);
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      updateConnection(active.id, { isConnected: false, sessionId: null, url: cleanUrl, lastError: errorMessage });
      syncConnectionStatusView();
      syncTranscriptsProviderClients();
      vscode.window.showErrorMessage(
        `Protokoll: Failed to connect: ${errorMessage}`
      );
    }
  };

  const configureServerCommand = vscode.commands.registerCommand(
    'protokoll.configureServer',
    async () => {
      const active = serverConnections.find((connection) => connection.id === activeServerId) ?? serverConnections[0];
      const currentUrl = active?.url || config.get<string>('serverUrl', 'http://127.0.0.1:3002');
      
      const input = await vscode.window.showInputBox({
        prompt: 'Enter the Protokoll HTTP MCP server URL',
        value: currentUrl,
        placeHolder: 'http://127.0.0.1:3002',
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
        const cleanUrl = normalizeServerUrl(input);
        await config.update('serverUrl', cleanUrl, true);
        if (active) {
          updateConnection(active.id, { url: cleanUrl, isConnected: false, sessionId: null });
          await profilesStore.saveActiveServerId(active.id);
        }
        await persistProfilesFromConnections();
        syncConnectionStatusView();
        await connectToActiveServer(true, false);
      }
    }
  );

  const resolveServerProfileId = async (serverId?: string): Promise<string | null> => {
    if (serverId && getConnectionById(serverId)) {
      return serverId;
    }
    if (serverConnections.length === 0) {
      return activeServerId ?? DEFAULT_SERVER_PROFILE_ID;
    }
    if (serverConnections.length === 1) {
      return serverConnections[0].id;
    }
    const selected = await vscode.window.showQuickPick(
      serverConnections.map((connection) => ({
        label: connection.name,
        description: connection.url,
        detail: connection.hasApiKey ? 'Token configured' : 'No token configured',
        id: connection.id,
      })),
      { placeHolder: 'Select server profile' }
    );
    return selected?.id ?? null;
  };

  const configureApiKeyCommand = vscode.commands.registerCommand(
    'protokoll.configureApiKey',
    async (serverId?: string) => {
      const profileId = await resolveServerProfileId(serverId);
      if (!profileId) {
        return;
      }

      const connection = getConnectionById(profileId);
      const currentValue = await getConfiguredApiKey(context, profileId);
      const input = await vscode.window.showInputBox({
        prompt: `Enter API key for ${connection?.name || 'selected server'}`,
        password: true,
        ignoreFocusOut: true,
        value: currentValue || '',
        placeHolder: 'API key',
      });

      if (input === undefined) {
        return;
      }

      const trimmedValue = input.trim();
      const secretKey = getApiKeySecretStorageKey(profileId);
      if (trimmedValue.length === 0) {
        await context.secrets.delete(secretKey);
        updateConnection(profileId, { hasApiKey: false });
        syncConnectionStatusView();
        vscode.window.showInformationMessage(`Protokoll: API key cleared for ${connection?.name || profileId}.`);
        return;
      }

      await context.secrets.store(secretKey, trimmedValue);
      updateConnection(profileId, { hasApiKey: true });
      syncConnectionStatusView();
      vscode.window.showInformationMessage(`Protokoll: API key saved for ${connection?.name || profileId}.`);
    }
  );

  const clearApiKeyCommand = vscode.commands.registerCommand(
    'protokoll.clearApiKey',
    async (serverId?: string) => {
      const profileId = await resolveServerProfileId(serverId);
      if (!profileId) {
        return;
      }
      const connection = getConnectionById(profileId);
      await context.secrets.delete(getApiKeySecretStorageKey(profileId));
      updateConnection(profileId, { hasApiKey: false });
      syncConnectionStatusView();
      vscode.window.showInformationMessage(`Protokoll: API key cleared for ${connection?.name || profileId}.`);
    }
  );

  const addServerConnectionCommand = vscode.commands.registerCommand(
    'protokoll.addServerConnection',
    async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Enter a name for the server profile',
        placeHolder: 'Work Server',
        validateInput: (value) => !value || !value.trim() ? 'Profile name cannot be empty' : null,
      });
      if (!name) {
        return;
      }

      const url = await vscode.window.showInputBox({
        prompt: 'Enter the Protokoll HTTP MCP server URL',
        placeHolder: 'http://127.0.0.1:3002',
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
      if (!url) {
        return;
      }

      const id = `server-${Date.now().toString(36)}`;
      const cleanUrl = normalizeServerUrl(url);
      serverConnections.push({
        id,
        name: name.trim(),
        url: cleanUrl,
        isConnected: false,
        hasApiKey: false,
        sessionId: null,
      });
      activeServerId = id;
      await profilesStore.saveActiveServerId(id);
      await persistProfilesFromConnections();
      syncConnectionStatusView();
      await connectToActiveServer(true, true);
    }
  );

  const switchServerConnectionCommand = vscode.commands.registerCommand(
    'protokoll.switchServerConnection',
    async (targetServerId?: string) => {
      if (serverConnections.length === 0) {
        vscode.window.showWarningMessage('Protokoll: No server profiles found. Add or configure a server connection first.');
        return;
      }
      let nextServerId = targetServerId;
      if (!nextServerId) {
        const selected = await vscode.window.showQuickPick(
          serverConnections.map((connection) => ({
            label: connection.name,
            description: connection.url,
            id: connection.id,
          })),
          { placeHolder: 'Select active server connection' }
        );
        nextServerId = selected?.id;
      }
      if (!nextServerId) {
        return;
      }
      activeServerId = nextServerId;
      await profilesStore.saveActiveServerId(nextServerId);
      syncConnectionStatusView();
      const existingClient = getClientForServer(nextServerId);
      const connection = getConnectionById(nextServerId);
      if (existingClient && connection?.isConnected) {
        mcpClient = existingClient;
        applyClientToProviders(existingClient);
        syncTranscriptsProviderClients();
        if (transcriptsViewProvider) {
          await transcriptsViewProvider.refresh();
        }
      } else {
        await connectToActiveServer(true, false);
      }
    }
  );

  const removeServerConnectionCommand = vscode.commands.registerCommand(
    'protokoll.removeServerConnection',
    async (serverId?: string) => {
      if (serverConnections.length <= 1) {
        vscode.window.showWarningMessage('Protokoll: At least one server profile must remain.');
        return;
      }

      let target = serverId ? getConnectionById(serverId) : undefined;
      if (!target) {
        const selected = await vscode.window.showQuickPick(
          serverConnections.map((connection) => ({
            label: connection.name,
            description: connection.url,
            id: connection.id,
          })),
          { placeHolder: 'Select server profile to remove' }
        );
        if (!selected) {
          return;
        }
        target = getConnectionById(selected.id);
      }
      if (!target) {
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        `Delete server profile "${target.name}"? This cannot be undone.`,
        { modal: true },
        'Delete Profile',
        'Delete Profile + Token',
        'Cancel'
      );
      if (!choice || choice === 'Cancel') {
        return;
      }

      serverConnections = serverConnections.filter((connection) => connection.id !== target.id);
      const removedClient = connectedServerClients.get(target.id);
      if (removedClient) {
        removedClient.dispose();
        connectedServerClients.delete(target.id);
      }
      const notificationDisposers = entityNotificationDisposers.get(target.id);
      if (notificationDisposers) {
        for (const dispose of notificationDisposers) {
          dispose();
        }
        entityNotificationDisposers.delete(target.id);
      }

      if (choice === 'Delete Profile + Token') {
        await context.secrets.delete(getApiKeySecretStorageKey(target.id));
      }

      if (activeServerId === target.id) {
        activeServerId = serverConnections[0]?.id ?? null;
        await profilesStore.saveActiveServerId(activeServerId);
        if (activeServerId) {
          await connectToActiveServer(false, false);
        }
      }

      await persistProfilesFromConnections();
      syncConnectionStatusView();
      syncTranscriptsProviderClients();
      vscode.window.showInformationMessage(`Protokoll: Removed server profile "${target.name}".`);
    }
  );

  const openServerManagerCommand = vscode.commands.registerCommand(
    'protokoll.openServerManager',
    async () => {
      const items: Array<vscode.QuickPickItem & { id: string }> = [
        {
          label: '$(add) Add server profile',
          description: 'Create a new server profile',
          id: '__add__',
        },
        ...serverConnections.map((connection) => {
          const badges = [
            connection.id === activeServerId ? 'active' : undefined,
            connection.isConnected ? 'connected' : 'disconnected',
            connection.hasApiKey ? 'token set' : 'no token',
          ].filter((value): value is string => !!value);
          return {
            label: connection.name,
            description: connection.url,
            detail: badges.join(' - '),
            id: connection.id,
          };
        }),
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Manage server profiles and API tokens',
        title: 'Protokoll Server Manager',
      });
      if (!selected) {
        return;
      }

      if (selected.id === '__add__') {
        await vscode.commands.executeCommand('protokoll.addServerConnection');
        return;
      }

      const connection = getConnectionById(selected.id);
      if (!connection) {
        return;
      }

      const actions: string[] = [
        'Switch Active Server',
        'Configure API Token',
        'Edit Server URL',
        'Show Details',
      ];
      if (connection.hasApiKey) {
        actions.push('Clear API Token');
      }
      if (serverConnections.length > 1) {
        actions.push('Remove Server');
      }

      const action = await vscode.window.showQuickPick(actions, {
        placeHolder: `Manage "${connection.name}"`,
      });
      if (!action) {
        return;
      }

      if (action === 'Switch Active Server') {
        await vscode.commands.executeCommand('protokoll.switchServerConnection', connection.id);
      } else if (action === 'Configure API Token') {
        await vscode.commands.executeCommand('protokoll.configureApiKey', connection.id);
      } else if (action === 'Clear API Token') {
        await vscode.commands.executeCommand('protokoll.clearApiKey', connection.id);
      } else if (action === 'Edit Server URL') {
        await vscode.commands.executeCommand('protokoll.switchServerConnection', connection.id);
        await vscode.commands.executeCommand('protokoll.configureServer');
      } else if (action === 'Remove Server') {
        await vscode.commands.executeCommand('protokoll.removeServerConnection', connection.id);
      } else if (action === 'Show Details') {
        await vscode.commands.executeCommand('protokoll.showServerConnectionDetails', connection.id);
      }
    }
  );

  const showServerConnectionDetailsCommand = vscode.commands.registerCommand(
    'protokoll.showServerConnectionDetails',
    async (serverId?: string) => {
      if (serverConnections.length === 0) {
        vscode.window.showWarningMessage('Protokoll: No server profiles found. Add or configure a server connection first.');
        return;
      }

      let resolvedServerId = serverId;
      if (!resolvedServerId) {
        if (serverConnections.length === 1) {
          resolvedServerId = serverConnections[0].id;
        } else {
          const selected = await vscode.window.showQuickPick(
            serverConnections.map((entry) => ({
              label: entry.name,
              description: entry.url,
              detail: entry.isConnected ? 'Connected' : (entry.lastError || 'Disconnected'),
              id: entry.id,
            })),
            { placeHolder: 'Select server profile to view details' }
          );
          resolvedServerId = selected?.id;
        }
      }

      if (!resolvedServerId) {
        // User cancelled quick pick
        return;
      }
      const connection = getConnectionById(resolvedServerId);
      if (!connection) {
        vscode.window.showWarningMessage('Protokoll: Selected server profile was not found.');
        return;
      }
      const lines = [
        `Server: ${connection.name}`,
        `URL: ${connection.url}`,
        `Status: ${connection.isConnected ? 'Connected' : 'Disconnected'}`,
      ];
      if (connection.sessionId) {
        lines.push(`Session ID: ${connection.sessionId}`);
      }
      if (connection.lastError) {
        lines.push(`Last Error: ${connection.lastError}`);
      }
      lines.push(`API Token: ${connection.hasApiKey ? 'Configured (secret storage)' : 'Not configured'}`);
      const message = lines.join('\n');
      const actions: string[] = ['Switch to this Server', 'Configure Token'];
      if (connection.hasApiKey) {
        actions.push('Clear Token');
      }
      if (connection.lastError) {
        actions.push('Reconnect');
      }
      const action = await vscode.window.showInformationMessage(message, ...actions);
      if (action === 'Switch to this Server') {
        await vscode.commands.executeCommand('protokoll.switchServerConnection', connection.id);
      }
      if (action === 'Configure Token') {
        await vscode.commands.executeCommand('protokoll.configureApiKey', connection.id);
      }
      if (action === 'Clear Token') {
        await vscode.commands.executeCommand('protokoll.clearApiKey', connection.id);
      }
      if (action === 'Reconnect') {
        await vscode.commands.executeCommand('protokoll.switchServerConnection', connection.id);
      }
    }
  );

  const openTranscriptCommand = vscode.commands.registerCommand(
    'protokoll.openTranscript',
    async (uri: string, transcript: Transcript) => {
      if (!transcriptDetailViewProvider) {
        return;
      }
      await getClientForTranscript(transcript);
      await transcriptDetailViewProvider.showTranscript(uri, transcript);
    }
  );

  const openTranscriptInNewTabCommand = vscode.commands.registerCommand(
    'protokoll.openTranscriptInNewTab',
    async (uri: string, transcript: Transcript) => {
      if (!transcriptDetailViewProvider) {
        return;
      }
      await getClientForTranscript(transcript);
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

  const syncContextAcrossServersCommand = vscode.commands.registerCommand(
    'protokoll.syncContextAcrossServers',
    async () => {
      const connectedCount = serverConnections.filter((connection) => connection.isConnected).length;
      if (connectedCount < 2) {
        vscode.window.showWarningMessage('Protokoll: Connect at least two servers to sync context entities.');
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Protokoll: Syncing context entities across servers...',
          cancellable: false,
        },
        async () => {
          await maybeSyncAllEntitiesAcrossPeers('manual-command');
        }
      );
      vscode.window.showInformationMessage('Protokoll: Context entity sync complete.');
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
          ...activeProjects
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
            .map(p => ({
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

  const filterByServerCommand = vscode.commands.registerCommand(
    'protokoll.filterByServer',
    async () => {
      if (!transcriptsViewProvider) {
        vscode.window.showErrorMessage('Transcripts view provider not initialized.');
        return;
      }

      const availableServers = transcriptsViewProvider.getAvailableServers();
      if (availableServers.length === 0) {
        vscode.window.showWarningMessage('No connected servers available.');
        return;
      }

      const currentFilters = transcriptsViewProvider.getServerFilters();
      const items: Array<vscode.QuickPickItem & { id: string }> = availableServers.map((server) => ({
        label: server.name,
        description: server.id,
        picked: currentFilters.has(server.id),
        id: server.id,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select servers to show (none selected = all servers)',
        title: 'Filter transcripts by server',
      });

      if (selected !== undefined) {
        transcriptsViewProvider.setServerFilters(new Set(selected.map((item) => item.id)));
        const message = selected.length === 0
          ? 'Showing transcripts from all servers'
          : `Showing transcripts from ${selected.length} server${selected.length === 1 ? '' : 's'}`;
        vscode.window.showInformationMessage(`Protokoll: ${message}`);
        void dashboardViewProvider?.refreshData();
      }
    }
  );

  const applyProjectFilterCommand = vscode.commands.registerCommand(
    'protokoll.applyProjectFilter',
    (projectId: string | null) => {
      if (!transcriptsViewProvider) {
        return;
      }
      transcriptsViewProvider.setProjectFilter(projectId);
      // Reveal the transcripts view so the user sees the filtered result
      void vscode.commands.executeCommand('protokollTranscripts.focus');
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
        { id: 'deleted', label: 'Deleted', icon: '🗑️' },
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
      const createChoices: Array<vscode.QuickPickItem & { contentType: TranscriptContentType }> = [
        {
          label: '$(cloud-upload) Upload audio transcript',
          description: 'Use the existing audio upload/transcription flow',
          contentType: 'audio_transcript',
        },
        {
          label: '$(file-text) Create manual note',
          description: 'Create a note and start with editable original text',
          contentType: 'manual_note',
        },
      ];

      const selected = await vscode.window.showQuickPick(createChoices, {
        title: 'Create New Item',
        placeHolder: 'Choose what kind of item to create',
      });

      if (!selected) {
        return;
      }

      if (selected.contentType === 'audio_transcript') {
        await vscode.commands.executeCommand('protokoll.uploadAudio');
        return;
      }

      await vscode.commands.executeCommand('protokoll.createNote');
    }
  );

  const renameTranscriptCommand = vscode.commands.registerCommand(
    'protokoll.renameTranscript',
    async (item: TranscriptItem) => {
      if (!item || !item.transcript) {
        vscode.window.showErrorMessage('No transcript selected for renaming.');
        return;
      }
      const transcriptClient = await getClientForTranscript(item.transcript);
      if (!transcriptClient) {
        vscode.window.showErrorMessage('Transcript server is not connected.');
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
        const transcriptRef = resolveTranscriptToolRef(item.transcript);
        
        // Call the edit transcript tool
        await transcriptClient.callTool('protokoll_edit_transcript', {
          transcriptPath: transcriptRef,
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

  const transferTranscriptCommand = vscode.commands.registerCommand(
    'protokoll.transferTranscript',
    async (item?: TranscriptItem) => {
      if (!transcriptsViewProvider) {
        vscode.window.showErrorMessage('Transcripts view provider not initialized.');
        return;
      }

      const selectedItems = transcriptsViewProvider.getSelectedItems();
      const targetItems = selectedItems.length > 0
        ? selectedItems
        : (item?.transcript ? [item] : []);

      if (targetItems.length === 0) {
        vscode.window.showErrorMessage('No transcript selected.');
        return;
      }

      if (targetItems.length > 1) {
        vscode.window.showWarningMessage('Please transfer one transcript at a time in this version.');
        return;
      }

      const sourceTranscript = targetItems[0].transcript;
      if (!sourceTranscript) {
        return;
      }
      const sourceServerId = sourceTranscript.serverId ?? activeServerId;
      if (!sourceServerId) {
        vscode.window.showErrorMessage('Unable to determine source server for selected transcript.');
        return;
      }
      const sourceClient = connectedServerClients.get(sourceServerId) ?? (activeServerId === sourceServerId ? mcpClient : null);
      if (!sourceClient) {
        vscode.window.showErrorMessage('Source server is not connected.');
        return;
      }

      const targetServers = serverConnections.filter((connection) => connection.id !== sourceServerId && connection.isConnected);
      if (targetServers.length === 0) {
        vscode.window.showWarningMessage('No connected target servers available.');
        return;
      }

      const selectedTarget = await vscode.window.showQuickPick(
        targetServers.map((connection) => ({
          label: connection.name,
          description: connection.url,
          id: connection.id,
        })),
        { placeHolder: 'Select target server for transfer' }
      );
      if (!selectedTarget) {
        return;
      }

      const targetClient = connectedServerClients.get(selectedTarget.id);
      if (!targetClient) {
        vscode.window.showErrorMessage('Target server is not connected.');
        return;
      }

      const transferModePick = await vscode.window.showQuickPick(
        [
          { label: 'Move', description: 'Copy then delete from source', mode: 'move' as const },
          { label: 'Copy', description: 'Keep source transcript', mode: 'copy' as const },
        ],
        {
          placeHolder: 'Select transfer mode',
          title: 'Transfer Transcript',
          ignoreFocusOut: true,
        }
      );
      const transferMode = transferModePick?.mode ?? 'move';

      try {
        const transcriptContent = await sourceClient.readTranscript(sourceTranscript.uri);
        const currentTitle = transcriptContent.title?.trim() || sourceTranscript.title || sourceTranscript.filename;
        const resolveTransferDate = (...candidates: Array<string | undefined>): string | undefined => {
          for (const candidate of candidates) {
            if (!candidate || candidate.trim().length === 0) {
              continue;
            }
            const trimmed = candidate.trim();
            const isoDateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
            if (isoDateMatch) {
              return isoDateMatch[1];
            }

            const parsed = new Date(trimmed);
            if (!isNaN(parsed.getTime())) {
              const year = parsed.getFullYear();
              const month = String(parsed.getMonth() + 1).padStart(2, '0');
              const day = String(parsed.getDate()).padStart(2, '0');
              return `${year}-${month}-${day}`;
            }
          }
          return undefined;
        };
        const transferDate = resolveTransferDate(
          transcriptContent.metadata?.date,
          sourceTranscript.date,
          sourceTranscript.createdAt
        );

        let targetTitle = currentTitle;
        const targetList = await targetClient.listTranscripts({ limit: 200, offset: 0 });
        const duplicate = targetList.transcripts.find((transcript) => (transcript.title || transcript.filename) === currentTitle);
        if (duplicate) {
          const duplicateChoice = await vscode.window.showQuickPick(
            [
              { label: 'Overwrite', action: 'overwrite' as const },
              { label: 'Rename', action: 'rename' as const },
              { label: 'Skip', action: 'skip' as const },
            ],
            { placeHolder: `Duplicate "${currentTitle}" found on target server.` }
          );
          if (!duplicateChoice || duplicateChoice.action === 'skip') {
            vscode.window.showInformationMessage('Protokoll: Transfer skipped.');
            return;
          }
          if (duplicateChoice.action === 'rename') {
            targetTitle = `${currentTitle} (copied)`;
          }
          if (duplicateChoice.action === 'overwrite') {
            targetTitle = currentTitle;
          }
        }

        const createResult = await targetClient.callTool('protokoll_create_note', {
          title: targetTitle,
          content: transcriptContent.content,
          projectId: transcriptContent.metadata?.projectId,
          date: transferDate,
        }) as { success?: boolean; message?: string; filePath?: string };

        if (!createResult?.success) {
          vscode.window.showErrorMessage(`Failed to create transcript on target server: ${createResult?.message || 'Unknown error'}`);
          return;
        }

        const sourceIsManualNote =
          sourceTranscript.contentType === 'manual_note' || sourceTranscript.hasRawTranscript === false;
        const sourceStatus = sourceTranscript.status || transcriptContent.metadata?.status;

        // Transfers currently create via protokoll_create_note. For audio transcripts, restore
        // original/raw content on the target so list metadata preserves transcript semantics.
        if (!sourceIsManualNote && createResult.filePath) {
          const originalText = transcriptContent.rawTranscript?.text?.trim() || transcriptContent.content?.trim() || '';
          if (originalText.length > 0) {
            await targetClient.callTool('protokoll_update_transcript_content', {
              transcriptPath: createResult.filePath,
              content: originalText,
              contentTarget: 'original',
            });
          }
        }

        if (sourceStatus && createResult.filePath) {
          await targetClient.callTool('protokoll_edit_transcript', {
            transcriptPath: createResult.filePath,
            status: sourceStatus,
          });
        }

        if (transferMode === 'move') {
          const transcriptRef = resolveTranscriptToolRef(sourceTranscript);
          await sourceClient.callTool('protokoll_edit_transcript', {
            transcriptPath: transcriptRef,
            status: 'deleted',
          });
        }

        vscode.window.showInformationMessage(
          `Protokoll: Transcript ${transferMode === 'move' ? 'moved' : 'copied'} to ${selectedTarget.label}.`
        );
        await transcriptsViewProvider.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(
          `Transfer failed: ${error instanceof Error ? error.message : String(error)}`
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

      await moveTranscriptsToProject([item], transcriptsViewProvider);
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

      await moveTranscriptsToProject(selectedItems, transcriptsViewProvider);
    }
  );

  // Helper function to move transcripts to a project
  async function moveTranscriptsToProject(
    items: TranscriptItem[],
    provider: TranscriptsViewProvider | null
  ): Promise<void> {
    try {
      const transcripts = items
        .map((item) => item.transcript)
        .filter((transcript): transcript is Transcript => !!transcript);
      if (transcripts.length === 0) {
        vscode.window.showWarningMessage('No transcripts selected.');
        return;
      }

      const serverIds = new Set(
        transcripts
          .map((transcript) => transcript.serverId ?? activeServerId)
          .filter((serverId): serverId is string => !!serverId && serverId.trim().length > 0)
      );

      if (serverIds.size > 1) {
        vscode.window.showWarningMessage(
          'Selected transcripts come from multiple servers. Please select transcripts from one server when moving to a project.'
        );
        return;
      }

      const targetServerId = Array.from(serverIds)[0] ?? activeServerId;
      const client = getClientForServer(targetServerId);
      if (!client) {
        const targetName = targetServerId
          ? (getConnectionById(targetServerId)?.name ?? targetServerId)
          : 'selected server';
        vscode.window.showErrorMessage(`Protokoll: Source server "${targetName}" is not connected.`);
        return;
      }

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
      const projectItems = activeProjects
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map(p => ({
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

      const resolveLocalProjectReference = async (): Promise<string> => {
        try {
          const refreshed = await client.callTool(
            'protokoll_list_projects',
            contextDirectory ? { contextDirectory } : {}
          ) as {
            projects?: Array<{ id: string; name: string; active?: boolean }>;
          };
          const refreshedProjects = (refreshed.projects || []).filter((p) => p.active !== false);
          const byId = refreshedProjects.find((p) => p.id === selected.id);
          if (byId) {
            return byId.id;
          }
          const selectedName = selected.label.trim().toLowerCase();
          const byName = refreshedProjects.find((p) => p.name.trim().toLowerCase() === selectedName);
          if (byName) {
            return byName.id;
          }
        } catch (error) {
          log('Protokoll: Failed to refresh project list before move, falling back to selected project name', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // In multi-server environments IDs may differ; server-side matching supports names.
        return selected.label;
      };

      const projectReference = await resolveLocalProjectReference();

      // Move all selected transcripts
      const errors: string[] = [];
      for (const transcript of transcripts) {
        try {
          const transcriptRef = resolveTranscriptToolRef(transcript);
          await client.callTool('protokoll_edit_transcript', {
            transcriptPath: transcriptRef,
            projectId: projectReference,
          });
        } catch (error) {
          const transcriptName = transcript.title || transcript.filename;
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

  interface IdentifyTaskCandidate {
    id: string;
    taskText: string;
    confidenceBucket: 'high' | 'medium' | 'low';
    rationale: string;
    suggestedTags?: string[];
  }

  const identifyTasksInTranscriptCommand = vscode.commands.registerCommand(
    'protokoll.identifyTasksInTranscript',
    async (item?: TranscriptItem) => {
      if (!mcpClient) {
        vscode.window.showErrorMessage('MCP client not initialized. Please configure the server URL first.');
        return;
      }
      if (!transcriptsViewProvider) {
        vscode.window.showErrorMessage('Transcripts view provider not initialized.');
        return;
      }

      const targetItems = item?.transcript
        ? [item]
        : transcriptsViewProvider.getSelectedItems();
      if (targetItems.length === 0) {
        vscode.window.showWarningMessage('No transcripts selected. Select one or more transcripts first.');
        return;
      }

      const normalize = (text: string): string[] => text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(token => token.length > 2);
      const similarity = (a: string, b: string): number => {
        const aTokens = new Set(normalize(a));
        const bTokens = new Set(normalize(b));
        if (aTokens.size === 0 || bTokens.size === 0) {
          return 0;
        }
        const overlap = Array.from(aTokens).filter(token => bTokens.has(token)).length;
        return overlap / Math.max(aTokens.size, bTokens.size);
      };

      let totalCreated = 0;
      let totalBlocked = 0;
      let processed = 0;

      for (const target of targetItems) {
        const transcript = target.transcript;
        if (!transcript) {
          continue;
        }
        processed += 1;

        const transcriptRef = resolveTranscriptToolRef(transcript);
        const identifyResult = await mcpClient.callTool('protokoll_identify_tasks_from_transcript', {
          transcriptPath: transcriptRef,
          maxCandidates: 25,
          includeTagSuggestions: true,
        }) as { candidates?: IdentifyTaskCandidate[] };

        const candidates = identifyResult.candidates || [];
        if (candidates.length === 0) {
          continue;
        }
        log('IdentifyTasks: candidates found', {
          transcriptUri: transcript.uri,
          candidateCount: candidates.length,
        });

        const selected = await vscode.window.showQuickPick(
          candidates.map(candidate => ({
            label: candidate.taskText,
            description: `${(transcript.title || transcript.filename)} • ${candidate.confidenceBucket.toUpperCase()} • ${candidate.rationale}`,
            candidate,
            picked: false,
          })),
          {
            canPickMany: true,
            title: `Identify Tasks: ${transcript.title || transcript.filename}`,
            placeHolder: 'Select which identified tasks to create',
            ignoreFocusOut: true,
          }
        );

        if (!selected || selected.length === 0) {
          continue;
        }

        const latest = await mcpClient.readTranscript(transcript.uri);
        const existingDescriptions = (latest.metadata?.tasks || []).map(task => task.description);
        const createdInThisRun: string[] = [];

        for (const selectedItem of selected) {
          const taskText = selectedItem.candidate.taskText;
          const isDuplicate = [...existingDescriptions, ...createdInThisRun].some(existing => {
            return similarity(taskText, existing) >= 0.75;
          });

          if (isDuplicate) {
            totalBlocked += 1;
            continue;
          }

          await mcpClient.callTool('protokoll_create_task', {
            transcriptPath: transcriptRef,
            description: taskText,
          });
          totalCreated += 1;
          createdInThisRun.push(taskText);
        }

        const suggestedTags = Array.from(new Set(
          selected.flatMap(candidate => candidate.candidate.suggestedTags || [])
        ));
        if (suggestedTags.length > 0) {
          const selectedTags = await vscode.window.showQuickPick(
            suggestedTags.map(tag => ({ label: tag })),
            {
              canPickMany: true,
              title: `Apply Suggested Tags: ${transcript.title || transcript.filename}`,
              placeHolder: 'Optional: select tags to add',
              ignoreFocusOut: true,
            }
          );
          if (selectedTags && selectedTags.length > 0) {
            await mcpClient.callTool('protokoll_edit_transcript', {
              transcriptPath: transcriptRef,
              tagsToAdd: selectedTags.map(tag => tag.label),
            });
          }
        }
      }

      if (processed > 0) {
        vscode.window.showInformationMessage(
          `Protokoll: Created ${totalCreated} task${totalCreated === 1 ? '' : 's'}` +
          `${totalBlocked > 0 ? ` (${totalBlocked} duplicate${totalBlocked === 1 ? '' : 's'} blocked)` : ''}.`
        );
        log('IdentifyTasks: run summary', {
          processedTranscripts: processed,
          totalCreated,
          totalBlocked,
        });
      }

      if (transcriptsViewProvider) {
        await transcriptsViewProvider.refresh();
      }
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
      { id: 'deleted', label: 'Deleted', icon: '🗑️' },
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

    const newStatus = selected.id as TranscriptStatus;
    const rollbackStatusByUri = new Map<string, TranscriptStatus | undefined>();
    if (provider) {
      for (const item of items) {
        if (!item.transcript) {
          continue;
        }
        rollbackStatusByUri.set(item.transcript.uri, item.transcript.status);
        provider.updateTranscriptInPlace(item.transcript.uri, { status: newStatus });
      }
    }

    const errors: string[] = [];
    const succeededUris: string[] = [];
    for (const item of items) {
      if (!item.transcript) {
        continue;
      }
      try {
        const transcriptRef = resolveTranscriptToolRef(item.transcript);
        await client.callTool('protokoll_edit_transcript', {
          transcriptPath: transcriptRef,
          status: selected.id,
        });
        succeededUris.push(item.transcript.uri);
      } catch (error) {
        if (provider) {
          provider.updateTranscriptInPlace(item.transcript.uri, {
            status: rollbackStatusByUri.get(item.transcript.uri),
          });
        }
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

    if (provider && succeededUris.length > 0) {
      if (errors.length > 0) {
        // Mixed success/failure: refresh once to guarantee consistency.
        await provider.refresh();
      }
    }
  }

  const resolveCopyTargets = (item?: TranscriptItem): TranscriptItem[] => {
    if (!transcriptsViewProvider) {
      return item?.transcript ? [item] : [];
    }
    const selectedItems = transcriptsViewProvider.getSelectedItems();
    return selectedItems.length > 0
      ? selectedItems
      : (item?.transcript ? [item] : []);
  };

  const buildTranscriptClipboardBlock = (
    transcript: TranscriptContent,
    variant: 'original' | 'enhanced',
    fallbackStatus?: TranscriptStatus
  ): string => {
    const title = transcript.title?.trim() || transcript.path.split('/').pop() || 'Untitled Transcript';
    const date = transcript.metadata?.date?.trim();
    const time = transcript.metadata?.time?.trim();
    const dateTime = [date, time].filter(Boolean).join(' ').trim() || transcript.path;
    const tags = transcript.metadata?.tags && transcript.metadata.tags.length > 0
      ? transcript.metadata.tags.join(', ')
      : 'None';
    const status = transcript.metadata?.status || fallbackStatus || 'unknown';
    const content = variant === 'original'
      ? (transcript.rawTranscript?.text?.trim() || transcript.content.trim())
      : transcript.content.trim();

    return [
      `## ${title}`,
      '',
      `**Date/Time:** ${dateTime}`,
      `**Tags:** ${tags}`,
      `**Status:** ${status}`,
      '',
      content,
    ].join('\n');
  };

  const copyTranscriptVariant = async (
    item: TranscriptItem | undefined,
    variant: 'original' | 'enhanced'
  ): Promise<void> => {
    const targets = resolveCopyTargets(item);
    if (targets.length === 0) {
      vscode.window.showErrorMessage('No transcript selected.');
      return;
    }

    try {
      const blocks: string[] = [];
      for (const target of targets) {
        if (!target.transcript?.uri) {
          continue;
        }
        const targetClient = await getClientForTranscript(target.transcript);
        if (!targetClient) {
          continue;
        }
        const transcript = await targetClient.readTranscript(target.transcript.uri);
        blocks.push(buildTranscriptClipboardBlock(transcript, variant, target.transcript.status));
      }

      if (blocks.length === 0) {
        vscode.window.showErrorMessage('No transcript content available to copy.');
        return;
      }

      await vscode.env.clipboard.writeText(blocks.join('\n\n---\n\n'));
      const label = variant === 'original' ? 'Original' : 'Enhanced';
      vscode.window.showInformationMessage(
        blocks.length === 1
          ? `${label} transcript copied to clipboard`
          : `${blocks.length} ${label.toLowerCase()} transcripts copied to clipboard`
      );
    } catch (error) {
      const label = variant === 'original' ? 'original transcript' : 'enhanced transcript';
      vscode.window.showErrorMessage(
        `Failed to copy ${label}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const copyTranscriptOriginalCommand = vscode.commands.registerCommand(
    'protokoll.copyTranscriptOriginal',
    async (item: TranscriptItem) => {
      await copyTranscriptVariant(item, 'original');
    }
  );

  const copyTranscriptEnhancedCommand = vscode.commands.registerCommand(
    'protokoll.copyTranscriptEnhanced',
    async (item: TranscriptItem) => {
      await copyTranscriptVariant(item, 'enhanced');
    }
  );

  // Backward-compatible command id; maps to enhanced copy behavior.
  const copyTranscriptCommand = vscode.commands.registerCommand(
    'protokoll.copyTranscript',
    async (item: TranscriptItem) => {
      await copyTranscriptVariant(item, 'enhanced');
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

      await getClientForTranscript(item.transcript);
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
      if (!transcriptsViewProvider) {
        vscode.window.showErrorMessage('Transcripts view provider not initialized.');
        return;
      }

      const selectedItems = transcriptsViewProvider.getSelectedItems();
      const targetItems = selectedItems.length > 0
        ? selectedItems
        : (item?.transcript ? [item] : []);

      if (targetItems.length === 0) {
        vscode.window.showErrorMessage('No transcript selected.');
        return;
      }

      try {
        const uniqueUrls = Array.from(new Set(
          targetItems
            .map(target => target.transcript?.uri)
            .filter((uri): uri is string => !!uri && uri.trim().length > 0)
        ));

        if (uniqueUrls.length === 0) {
          vscode.window.showErrorMessage('No transcript URL available.');
          return;
        }

        await vscode.env.clipboard.writeText(uniqueUrls.join('\n'));
        vscode.window.showInformationMessage(
          uniqueUrls.length === 1
            ? 'Transcript URL copied to clipboard'
            : `${uniqueUrls.length} transcript URLs copied to clipboard`
        );
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
              const projectItems = activeProjects
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
                .map(p => ({
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
              contentType: 'manual_note',
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
    if (e.affectsConfiguration('protokoll.serverUrl') || e.affectsConfiguration('protokoll.proxyBypass')) {
      applyProxyEnvironmentPolicy();
      const config = getProtokollConfiguration();
      const rawServerUrl = config.get<string>('serverUrl', 'http://127.0.0.1:3002');
      const serverUrl = normalizeServerUrl(rawServerUrl);
      if (!serverUrl) {
        return;
      }
      const active = serverConnections.find((connection) => connection.id === activeServerId) ?? serverConnections[0];
      if (active) {
        updateConnection(active.id, { url: serverUrl, isConnected: false, sessionId: null });
        await persistProfilesFromConnections();
      }
      syncConnectionStatusView();
      await connectToActiveServer(false, false);
    }
  });

  const secretWatcher = context.secrets.onDidChange(async (event) => {
    if (!event.key.startsWith('protokoll.apiKey.server.')) {
      return;
    }
    await connectToActiveServer(false, false);
  });

  // Auto-refresh transcripts on activation (only if server is connected)
  if (transcriptsViewProvider && serverConnected && mcpClient) {
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

  const openDashboardCommand = vscode.commands.registerCommand(
    'protokoll.openDashboard',
    () => {
      if (dashboardViewProvider) {
        void dashboardViewProvider.show();
      } else {
        vscode.window.showErrorMessage('Protokoll: Dashboard not available.');
      }
    }
  );

  const dashboardStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  dashboardStatusBarItem.text = '$(dashboard) Protokoll';
  dashboardStatusBarItem.tooltip = 'Open Protokoll Dashboard';
  dashboardStatusBarItem.command = 'protokoll.openDashboard';
  dashboardStatusBarItem.show();

  const uploadAudioCommand = vscode.commands.registerCommand(
    'protokoll.uploadAudio',
    async () => {
      if (!mcpClient) {
        vscode.window.showErrorMessage('Protokoll: MCP client not initialized. Please configure the server URL first.');
        return;
      }

      // Resolve upload target server first so project listing and upload destination
      // are both scoped to the same server.
      let targetConnection = serverConnections.find((connection) => connection.id === activeServerId) ?? serverConnections[0];
      if (!targetConnection) {
        vscode.window.showErrorMessage('Protokoll: No server profiles configured.');
        return;
      }

      if (serverConnections.length > 1) {
        const selectedServer = await vscode.window.showQuickPick(
          serverConnections.map((connection) => ({
            label: connection.name,
            description: connection.url,
            detail: [
              connection.id === activeServerId ? 'Active' : undefined,
              connection.isConnected ? 'Connected' : 'Not connected',
            ].filter((value): value is string => !!value).join(' - '),
            id: connection.id,
          })),
          {
            title: 'Select Upload Server',
            placeHolder: 'Choose which server should receive this audio upload',
          }
        );
        if (!selectedServer) {
          return;
        }
        const resolved = getConnectionById(selectedServer.id);
        if (!resolved) {
          vscode.window.showErrorMessage('Protokoll: Selected server profile was not found.');
          return;
        }
        targetConnection = resolved;
      }

      let uploadClient = getClientForServer(targetConnection.id);
      if (!uploadClient) {
        try {
          const apiKey = await getConfiguredApiKey(context, targetConnection.id);
          const tempClient = new McpClient(targetConnection.url, { apiKey });
          const healthy = await tempClient.healthCheck();
          if (!healthy) {
            vscode.window.showWarningMessage(`Protokoll: Server at ${targetConnection.url} is not responding`);
            tempClient.dispose();
            return;
          }
          await tempClient.initialize();
          connectedServerClients.set(targetConnection.id, tempClient);
          registerEntitySyncHandlers(targetConnection.id, tempClient);
          updateConnection(targetConnection.id, {
            isConnected: true,
            sessionId: tempClient.getSessionId(),
            lastError: undefined,
          });
          syncConnectionStatusView();
          syncTranscriptsProviderClients();
          await maybeSyncAllEntitiesAcrossPeers('upload-server-connect');
          uploadClient = tempClient;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          updateConnection(targetConnection.id, {
            isConnected: false,
            sessionId: null,
            lastError: errorMessage,
          });
          syncConnectionStatusView();
          syncTranscriptsProviderClients();
          vscode.window.showErrorMessage(`Protokoll: Failed to connect to ${targetConnection.name}: ${errorMessage}`);
          return;
        }
      }

      // 1. Open file picker for audio files
      const fileUris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: 'Select Audio File to Upload',
        filters: {
          // eslint-disable-next-line @typescript-eslint/naming-convention -- VS Code filter key is user-facing label
          'Audio Files': ['mp3', 'm4a', 'wav', 'webm', 'mp4', 'aac', 'ogg', 'flac'],
        },
      });

      if (!fileUris || fileUris.length === 0) {
        return; // User cancelled
      }

      const filePath = fileUris[0].fsPath;

      // 2. Optional title input
      const title = await vscode.window.showInputBox({
        prompt: 'Enter a title for this transcript (optional)',
        placeHolder: 'e.g., Weekly Team Standup',
        title: 'Transcript Title',
      });

      if (title === undefined) {
        return; // User pressed Escape — cancel the whole flow
      }

      // 3. Resolve project assignment before upload.
      // We always prefer a concrete project when at least one active project exists,
      // which keeps scoped-key uploads and subsequent transcript reads consistent.
      type UploadProjectOption = vscode.QuickPickItem & { id: string };
      let activeProjects: Array<{ id: string; name: string }> = [];
      try {
        const shouldPass = await shouldPassContextDirectory(uploadClient);
        const contextDirectory = shouldPass ? getDefaultContextDirectory() : undefined;
        const projectsResult = await uploadClient.callTool(
          'protokoll_list_projects',
          contextDirectory ? { contextDirectory } : {}
        ) as { projects?: Array<{ id: string; name: string; active?: boolean }> };

        if (projectsResult.projects && projectsResult.projects.length > 0) {
          activeProjects = projectsResult.projects
            .filter((p) => p.active !== false)
            .map((p) => ({ id: p.id, name: p.name }));
        }
      } catch {
        // Project assignment is best-effort; upload can still proceed without it.
      }

      let project: string | undefined;
      if (activeProjects.length === 1) {
        // Single-project access: remove unnecessary prompt and enforce the valid project id.
        project = activeProjects[0].id;
      } else if (activeProjects.length > 1) {
        const projectPickItems: UploadProjectOption[] = activeProjects
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
          .map((p) => ({
          label: p.name,
          description: p.id,
          id: p.id,
        }));
        const projectPick = await vscode.window.showQuickPick(projectPickItems, {
          title: 'Select Project',
          placeHolder: 'Choose a project for this transcript',
        });
        if (!projectPick) {
          return; // User cancelled
        }
        project = projectPick.id;
      }

      // 4. Perform upload with progress notification
      const serverUrl = targetConnection.url;
      const apiKey = await getConfiguredApiKey(context, targetConnection.id);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Uploading audio...',
          cancellable: false,
        },
        async (progress) => {
          try {
            const result = await uploadService.uploadAudio({
              filePath,
              serverUrl,
              title: title && title.trim() ? title.trim() : undefined,
              project,
              apiKey,
              onProgress: (state) => {
                const percent = state.totalBytes > 0
                  ? Math.min(100, Math.round((state.uploadedBytes / state.totalBytes) * 100))
                  : 0;
                const message = state.phase === 'creating'
                  ? 'Preparing upload session'
                  : state.phase === 'finalizing'
                    ? 'Finalizing upload'
                    : `Uploading ${percent}%`;
                progress.report({ message });
              },
            });

            if (result.success) {
              if (transcriptsViewProvider) {
                await transcriptsViewProvider.refresh();
              }
              const tracking = result.uuid?.substring(0, 8) || result.uploadId?.substring(0, 8) || 'unknown';
              void vscode.window.showInformationMessage(
                `Audio uploaded successfully! Tracking ID: ${tracking}`,
                'Open Dashboard'
              ).then((action) => {
                if (action === 'Open Dashboard') {
                  void vscode.commands.executeCommand('protokoll.openDashboard');
                }
              });
            } else {
              vscode.window.showErrorMessage(`Upload failed: ${result.error}`);
            }
          } catch (err) {
            vscode.window.showErrorMessage(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      );
    }
  );

  context.subscriptions.push(
    showTranscriptsCommand,
    configureServerCommand,
    configureApiKeyCommand,
    clearApiKeyCommand,
    addServerConnectionCommand,
    switchServerConnectionCommand,
    removeServerConnectionCommand,
    openServerManagerCommand,
    showServerConnectionDetailsCommand,
    openTranscriptCommand,
    openTranscriptInNewTabCommand,
    refreshTranscriptsCommand,
    syncContextAcrossServersCommand,
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
    filterByServerCommand,
    applyProjectFilterCommand,
    filterByStatusCommand,
    sortTranscriptsCommand,
    startNewSessionCommand,
    renameTranscriptCommand,
    transferTranscriptCommand,
    moveToProjectCommand,
    moveSelectedToProjectCommand,
    changeTranscriptStatusCommand,
    changeSelectedTranscriptsStatusCommand,
    identifyTasksInTranscriptCommand,
    copyTranscriptCommand,
    copyTranscriptOriginalCommand,
    copyTranscriptEnhancedCommand,
    openTranscriptToSideCommand,
    openTranscriptWithCommand,
    copyTranscriptUrlCommand,
    copySessionIdCommand,
    openChatCommand,
    refreshChatsCommand,
    openChatPanelCommand,
    closeChatPanelCommand,
    createNoteCommand,
    openDashboardCommand,
    dashboardStatusBarItem,
    uploadAudioCommand,
    backArrowHandler,
    configWatcher,
    secretWatcher,
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
  for (const client of connectedServerClients.values()) {
    client.dispose();
  }
  connectedServerClients.clear();
  if (mcpClient) {
    mcpClient.dispose();
  }
  mcpClient = null;
  transcriptsViewProvider = null;
  transcriptDetailViewProvider = null;
}
