/**
 * Server Mode Utilities
 * 
 * Handles detection of MCP server mode (local vs remote) and determines
 * whether contextDirectory parameters should be passed to tools.
 */

import type { McpClient } from './mcpClient';

let cachedServerMode: 'local' | 'remote' | null = null;

/**
 * Check if the server accepts contextDirectory parameters
 * Remote servers are pre-configured and reject directory parameters
 * 
 * @param client - MCP client instance
 * @returns true if contextDirectory should be passed, false otherwise
 */
export async function shouldPassContextDirectory(client: McpClient | null): Promise<boolean> {
  if (!client) {
    return false;
  }

  // Check cached mode
  if (cachedServerMode !== null) {
    return cachedServerMode === 'local';
  }

  // Query server mode
  try {
    const info = await client.callTool('protokoll_info', {}) as {
      mode?: 'local' | 'remote';
      acceptsDirectoryParameters?: boolean;
    };
    
    cachedServerMode = info.mode || 'local';
    return info.acceptsDirectoryParameters !== false;
  } catch (error) {
    // If protokoll_info doesn't exist (old server), assume local mode
    cachedServerMode = 'local';
    return true;
  }
}

/**
 * Clear the cached server mode (call when reconnecting to server)
 */
export function clearServerModeCache(): void {
  cachedServerMode = null;
}

/**
 * Get the cached server mode (if available)
 */
export function getCachedServerMode(): 'local' | 'remote' | null {
  return cachedServerMode;
}
