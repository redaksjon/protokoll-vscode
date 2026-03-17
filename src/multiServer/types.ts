export type MultiServerConnectionState = 'connected' | 'connecting' | 'degraded' | 'disconnected';

export interface ServerProfile {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServerRuntimeStatus {
  serverId: string;
  state: MultiServerConnectionState;
  sessionId: string | null;
  lastError?: string;
  lastConnectedAt?: string;
}

