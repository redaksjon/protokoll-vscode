/**
 * Tests for Server Mode Utilities
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shouldPassContextDirectory, clearServerModeCache, getCachedServerMode } from '../src/serverMode';
import { McpClient } from '../src/mcpClient';

describe('serverMode', () => {
  let mockClient: McpClient;

  beforeEach(() => {
    clearServerModeCache();
    mockClient = {
      callTool: vi.fn(),
    } as any;
    vi.clearAllMocks();
  });

  describe('shouldPassContextDirectory', () => {
    it('should return false when client is null', async () => {
      const result = await shouldPassContextDirectory(null);
      expect(result).toBe(false);
    });

    it('should return true for local mode server', async () => {
      mockClient.callTool = vi.fn().mockResolvedValue({
        mode: 'local',
        acceptsDirectoryParameters: true,
      });

      const result = await shouldPassContextDirectory(mockClient);
      expect(result).toBe(true);
      expect(mockClient.callTool).toHaveBeenCalledWith('protokoll_info', {});
    });

    it('should return false for remote mode server', async () => {
      mockClient.callTool = vi.fn().mockResolvedValue({
        mode: 'remote',
        acceptsDirectoryParameters: false,
      });

      const result = await shouldPassContextDirectory(mockClient);
      expect(result).toBe(false);
    });

    it('should cache the server mode after first call', async () => {
      mockClient.callTool = vi.fn().mockResolvedValue({
        mode: 'local',
        acceptsDirectoryParameters: true,
      });

      // First call
      await shouldPassContextDirectory(mockClient);
      expect(mockClient.callTool).toHaveBeenCalledTimes(1);

      // Second call should use cache
      await shouldPassContextDirectory(mockClient);
      expect(mockClient.callTool).toHaveBeenCalledTimes(1); // Still 1, not called again
    });

    it('should default to local mode when protokoll_info fails', async () => {
      mockClient.callTool = vi.fn().mockRejectedValue(new Error('Tool not found'));

      const result = await shouldPassContextDirectory(mockClient);
      expect(result).toBe(true);
      expect(getCachedServerMode()).toBe('local');
    });

    it('should default to local mode when mode is not specified', async () => {
      mockClient.callTool = vi.fn().mockResolvedValue({
        acceptsDirectoryParameters: true,
      });

      const result = await shouldPassContextDirectory(mockClient);
      expect(result).toBe(true);
      expect(getCachedServerMode()).toBe('local');
    });

    it('should respect acceptsDirectoryParameters flag', async () => {
      mockClient.callTool = vi.fn().mockResolvedValue({
        mode: 'local',
        acceptsDirectoryParameters: false,
      });

      const result = await shouldPassContextDirectory(mockClient);
      expect(result).toBe(false);
    });

    it('should default acceptsDirectoryParameters to true when not specified', async () => {
      mockClient.callTool = vi.fn().mockResolvedValue({
        mode: 'local',
      });

      const result = await shouldPassContextDirectory(mockClient);
      expect(result).toBe(true);
    });
  });

  describe('clearServerModeCache', () => {
    it('should clear the cached server mode', async () => {
      mockClient.callTool = vi.fn().mockResolvedValue({
        mode: 'remote',
        acceptsDirectoryParameters: false,
      });

      // Cache a value
      await shouldPassContextDirectory(mockClient);
      expect(getCachedServerMode()).toBe('remote');

      // Clear cache
      clearServerModeCache();
      expect(getCachedServerMode()).toBeNull();
    });

    it('should allow re-detection after clearing cache', async () => {
      mockClient.callTool = vi.fn()
        .mockResolvedValueOnce({ mode: 'local' })
        .mockResolvedValueOnce({ mode: 'remote' });

      // First detection
      await shouldPassContextDirectory(mockClient);
      expect(getCachedServerMode()).toBe('local');

      // Clear and re-detect
      clearServerModeCache();
      await shouldPassContextDirectory(mockClient);
      expect(getCachedServerMode()).toBe('remote');
      expect(mockClient.callTool).toHaveBeenCalledTimes(2);
    });
  });

  describe('getCachedServerMode', () => {
    it('should return null initially', () => {
      expect(getCachedServerMode()).toBeNull();
    });

    it('should return cached mode after detection', async () => {
      mockClient.callTool = vi.fn().mockResolvedValue({
        mode: 'local',
      });

      await shouldPassContextDirectory(mockClient);
      expect(getCachedServerMode()).toBe('local');
    });

    it('should return remote mode when cached', async () => {
      mockClient.callTool = vi.fn().mockResolvedValue({
        mode: 'remote',
      });

      await shouldPassContextDirectory(mockClient);
      expect(getCachedServerMode()).toBe('remote');
    });
  });
});
