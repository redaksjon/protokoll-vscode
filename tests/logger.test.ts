/**
 * Tests for Logger
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { initLogger, log } from '../src/logger';

// Mock fs
vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
}));

describe('logger', () => {
  let mockOutputChannel: vscode.OutputChannel;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  let consoleLogSpy: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOutputChannel = {
      appendLine: vi.fn(),
      append: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      name: 'Test Channel',
      replace: vi.fn(),
    };

    consoleLogSpy = vi.fn();
    consoleErrorSpy = vi.fn();
    console.log = consoleLogSpy;
    console.error = consoleErrorSpy;

    vi.clearAllMocks();
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  describe('initLogger', () => {
    it('should initialize logger with output channel', () => {
      initLogger(mockOutputChannel);
      
      // Verify by logging something
      log('test message');
      expect(mockOutputChannel.appendLine).toHaveBeenCalled();
    });

    it('should log initialization message', () => {
      initLogger(mockOutputChannel);
      
      expect(consoleLogSpy).toHaveBeenCalled();
      expect(mockOutputChannel.appendLine).toHaveBeenCalled();
    });
  });

  describe('log', () => {
    beforeEach(() => {
      initLogger(mockOutputChannel);
      vi.clearAllMocks();
    });

    it('should log message to console', () => {
      log('test message');
      
      expect(consoleLogSpy).toHaveBeenCalled();
      const loggedMessage = consoleLogSpy.mock.calls[0][0];
      expect(loggedMessage).toContain('test message');
    });

    it('should log message to output channel', () => {
      log('test message');
      
      expect(mockOutputChannel.appendLine).toHaveBeenCalled();
      const loggedMessage = mockOutputChannel.appendLine.mock.calls[0][0];
      expect(loggedMessage).toContain('test message');
    });

    it('should log message to file', () => {
      log('test message');
      
      expect(fs.appendFileSync).toHaveBeenCalled();
      const [_path, content] = (fs.appendFileSync as any).mock.calls[0];
      expect(content).toContain('test message');
    });

    it('should include timestamp in log message', () => {
      log('test message');
      
      const loggedMessage = consoleLogSpy.mock.calls[0][0];
      expect(loggedMessage).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    });

    it('should handle additional arguments', () => {
      log('test message', { key: 'value' }, 123);
      
      const loggedMessage = consoleLogSpy.mock.calls[0][0];
      expect(loggedMessage).toContain('test message');
      expect(loggedMessage).toContain('"key":"value"');
      expect(loggedMessage).toContain('123');
    });

    it('should work without output channel', () => {
      // Log should work even without initializing the output channel
      // (it will just skip the output channel part)
      expect(() => log('test without channel')).not.toThrow();
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('should handle file write errors gracefully', () => {
      (fs.appendFileSync as any).mockImplementation(() => {
        throw new Error('Write failed');
      });

      expect(() => log('test message')).not.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to write to log file:',
        expect.any(Error)
      );
    });

    it('should format message with no additional args', () => {
      log('simple message');
      
      const loggedMessage = consoleLogSpy.mock.calls[0][0];
      expect(loggedMessage).toContain('simple message');
      expect(loggedMessage).not.toContain('undefined');
    });

    it('should stringify complex objects', () => {
      const complexObj = {
        nested: {
          value: 'test',
          array: [1, 2, 3],
        },
      };
      
      log('message', complexObj);
      
      const loggedMessage = consoleLogSpy.mock.calls[0][0];
      expect(loggedMessage).toContain('"nested"');
      expect(loggedMessage).toContain('"value":"test"');
    });
  });
});
