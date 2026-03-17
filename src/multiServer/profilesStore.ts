import * as vscode from 'vscode';
import type { ServerProfile } from './types';

const SERVER_PROFILES_KEY = 'serverProfiles';
const ACTIVE_SERVER_ID_KEY = 'activeServerId';

function buildDefaultProfile(url: string): ServerProfile {
  const now = new Date().toISOString();
  return {
    id: 'default-server',
    name: 'Server',
    url,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export class ServerProfilesStore {
  constructor(private readonly _globalState?: vscode.Memento) {}

  private getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('protokoll');
  }

  async loadProfiles(legacyServerUrl: string): Promise<{ profiles: ServerProfile[]; activeServerId: string | null }> {
    const config = this.getConfig();
    const storedProfiles = config.get<ServerProfile[]>(SERVER_PROFILES_KEY) ?? [];
    const sanitized = storedProfiles
      .filter((profile) => !!profile.id && !!profile.name && !!profile.url)
      .map((profile) => ({
        ...profile,
        url: normalizeUrl(profile.url),
        enabled: profile.enabled !== false,
      }));

    if (sanitized.length > 0) {
      const activeServerId = config.get<string>(ACTIVE_SERVER_ID_KEY) ?? sanitized[0].id;
      return { profiles: sanitized, activeServerId };
    }

    const fallbackUrl = normalizeUrl(legacyServerUrl);
    const defaultProfile = buildDefaultProfile(fallbackUrl);
    await config.update(SERVER_PROFILES_KEY, [defaultProfile], vscode.ConfigurationTarget.Global);
    await config.update(ACTIVE_SERVER_ID_KEY, defaultProfile.id, vscode.ConfigurationTarget.Global);
    return { profiles: [defaultProfile], activeServerId: defaultProfile.id };
  }

  async saveProfiles(profiles: ServerProfile[]): Promise<void> {
    const config = this.getConfig();
    await config.update(SERVER_PROFILES_KEY, profiles, vscode.ConfigurationTarget.Global);
  }

  async saveActiveServerId(serverId: string | null): Promise<void> {
    const config = this.getConfig();
    await config.update(ACTIVE_SERVER_ID_KEY, serverId, vscode.ConfigurationTarget.Global);
  }
}

