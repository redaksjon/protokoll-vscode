import { McpClient } from '../mcpClient';
import type { ServerProfile, ServerRuntimeStatus } from './types';

interface ConnectionRecord {
  profile: ServerProfile;
  status: ServerRuntimeStatus;
  client: McpClient | null;
}

interface ConnectionManagerOptions {
  getApiKey: (profile: ServerProfile) => Promise<string | undefined>;
}

function disconnectedStatus(serverId: string): ServerRuntimeStatus {
  return {
    serverId,
    state: 'disconnected',
    sessionId: null,
  };
}

export class MultiServerConnectionManager {
  private records: Map<string, ConnectionRecord> = new Map();

  constructor(
    profiles: ServerProfile[],
    private readonly options: ConnectionManagerOptions
  ) {
    for (const profile of profiles) {
      this.records.set(profile.id, {
        profile,
        status: disconnectedStatus(profile.id),
        client: null,
      });
    }
  }

  listProfiles(): ServerProfile[] {
    return Array.from(this.records.values()).map((record) => record.profile);
  }

  getClient(serverId: string): McpClient | null {
    return this.records.get(serverId)?.client ?? null;
  }

  getStatus(serverId: string): ServerRuntimeStatus {
    return this.records.get(serverId)?.status ?? disconnectedStatus(serverId);
  }

  getStatuses(): ServerRuntimeStatus[] {
    return Array.from(this.records.values()).map((record) => record.status);
  }

  async connectAll(): Promise<ServerRuntimeStatus[]> {
    const enabledProfiles = this.listProfiles().filter((profile) => profile.enabled);
    await Promise.all(enabledProfiles.map(async (profile) => this.connect(profile.id)));
    return this.getStatuses();
  }

  async connect(serverId: string): Promise<ServerRuntimeStatus> {
    const record = this.records.get(serverId);
    if (!record) {
      return disconnectedStatus(serverId);
    }

    record.status = { serverId, state: 'connecting', sessionId: null };
    this.disposeClient(record);

    try {
      const apiKey = await this.options.getApiKey(record.profile);
      const client = new McpClient(record.profile.url, { apiKey });
      const isHealthy = await client.healthCheck();
      if (!isHealthy) {
        record.status = {
          serverId,
          state: 'degraded',
          sessionId: null,
          lastError: `Server at ${record.profile.url} is not responding`,
        };
        record.client = client;
        return record.status;
      }

      await client.initialize();
      const sessionId = client.getSessionId();
      record.client = client;
      record.status = {
        serverId,
        state: 'connected',
        sessionId,
        lastConnectedAt: new Date().toISOString(),
      };
      return record.status;
    } catch (error) {
      record.status = {
        serverId,
        state: 'disconnected',
        sessionId: null,
        lastError: error instanceof Error ? error.message : String(error),
      };
      return record.status;
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const record = this.records.get(serverId);
    if (!record) {
      return;
    }
    this.disposeClient(record);
    record.status = disconnectedStatus(serverId);
  }

  dispose(): void {
    for (const record of this.records.values()) {
      this.disposeClient(record);
      record.status = disconnectedStatus(record.profile.id);
    }
  }

  private disposeClient(record: ConnectionRecord): void {
    if (record.client) {
      record.client.dispose();
      record.client = null;
    }
  }
}

