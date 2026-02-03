/**
 * Shared logger for Protokoll extension
 * Logs to console, VS Code output channel, and file
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const debugLogPath = path.join(os.homedir(), 'protokoll-debug.log');

let outputChannel: vscode.OutputChannel | null = null;

export function initLogger(channel: vscode.OutputChannel): void {
  outputChannel = channel;
  log('Logger initialized', { logPath: debugLogPath });
}

export function log(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const fullMessage = `[${timestamp}] ${message}${args.length > 0 ? ' ' + JSON.stringify(args) : ''}`;
  
  console.log(fullMessage);
  
  if (outputChannel) {
    outputChannel.appendLine(fullMessage);
  }
  
  // Also write to file for easy access
  try {
    fs.appendFileSync(debugLogPath, fullMessage + '\n', 'utf8');
  } catch (error) {
    console.error('Failed to write to log file:', error);
  }
}
