/**
 * Proxy-aware HTTP agent resolution for all outgoing connections.
 *
 * Resolution order:
 *   1. VS Code's built-in `http.proxy` setting
 *   2. Environment variables: HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy
 *
 * Returns `undefined` when no proxy is configured so callers can omit the
 * `agent` option and fall back to direct connections.
 */

import * as vscode from 'vscode';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type * as http from 'http';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { URL } from 'url';

const directHttpAgent = new HttpAgent({ keepAlive: true });
const directHttpsAgent = new HttpsAgent({ keepAlive: true });
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];
const originalProxyEnv = new Map<string, string | undefined>();
let proxyEnvironmentBypassApplied = false;

function getConfiguredProxyBypass(): boolean {
  const envOverride = process.env.PROTOKOLL_PROXY_BYPASS?.trim().toLowerCase();
  if (envOverride === '1' || envOverride === 'true' || envOverride === 'yes') {
    return true;
  }

  const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
  if (activeEditorUri) {
    const activeEditorValue = vscode.workspace.getConfiguration('protokoll', activeEditorUri).get<boolean>('proxyBypass');
    if (activeEditorValue === true) {
      return true;
    }
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderValue = vscode.workspace.getConfiguration('protokoll', folder.uri).get<boolean>('proxyBypass');
    if (folderValue === true) {
      return true;
    }
  }

  const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folderUri) {
    const folderValue = vscode.workspace.getConfiguration('protokoll', folderUri).get<boolean>('proxyBypass');
    if (typeof folderValue === 'boolean') {
      return folderValue;
    }
  }
  return vscode.workspace.getConfiguration('protokoll').get<boolean>('proxyBypass', false);
}

export function getProxyUrl(): string | undefined {
  if (getConfiguredProxyBypass()) {
    return undefined;
  }

  const httpConfig = vscode.workspace.getConfiguration('http');
  const vscodeSetting = httpConfig.get<string>('proxy');
  if (vscodeSetting && vscodeSetting.trim().length > 0) {
    return vscodeSetting.trim();
  }

  return (
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    undefined
  );
}

export function isProxyBypassed(targetUrl: string): boolean {
  const noProxy =
    process.env.NO_PROXY ||
    process.env.no_proxy;

  if (!noProxy) {
    return false;
  }

  let hostname: string;
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    return false;
  }

  const entries = noProxy.split(',').map(e => e.trim()).filter(Boolean);
  for (const entry of entries) {
    if (entry === '*') {
      return true;
    }
    const pattern = entry.startsWith('.') ? entry : `.${entry}`;
    if (hostname === entry || hostname.endsWith(pattern)) {
      return true;
    }
  }

  return false;
}

export function getStrictSSL(): boolean {
  const httpConfig = vscode.workspace.getConfiguration('http');
  return httpConfig.get<boolean>('proxyStrictSSL', true);
}

export function applyProxyEnvironmentPolicy(): void {
  const bypass = getConfiguredProxyBypass();
  if (bypass) {
    if (!proxyEnvironmentBypassApplied) {
      for (const key of PROXY_ENV_KEYS) {
        originalProxyEnv.set(key, process.env[key]);
      }
    }
    for (const key of PROXY_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.NO_PROXY = '*';
    process.env.no_proxy = '*';
    proxyEnvironmentBypassApplied = true;
    return;
  }

  if (!proxyEnvironmentBypassApplied) {
    return;
  }

  for (const key of PROXY_ENV_KEYS) {
    const originalValue = originalProxyEnv.get(key);
    if (typeof originalValue === 'string') {
      process.env[key] = originalValue;
    } else {
      delete process.env[key];
    }
  }
  originalProxyEnv.clear();
  proxyEnvironmentBypassApplied = false;
}

/**
 * Return a proxy-aware HTTP agent for the given target URL, or `undefined`
 * when no proxy applies (direct connection).  Used by code that calls
 * `http.request()` / `https.request()` directly.
 */
export function getProxyAgent(targetUrl: string): http.Agent | undefined {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) {
    return undefined;
  }

  if (isProxyBypassed(targetUrl)) {
    return undefined;
  }

  return new HttpsProxyAgent(proxyUrl, {
    rejectUnauthorized: getStrictSSL(),
  });
}

/**
 * Return the appropriate agent for the given target URL, considering
 * both proxy and proxy-bypass settings.
 *
 * When `protokoll.proxyBypass` is true, returns an explicit direct agent
 * that overrides VSCode's proxy injection. When false, delegates to the
 * existing getProxyAgent() logic.
 */
export function resolveAgent(targetUrl: string): http.Agent | undefined {
  const bypass = getConfiguredProxyBypass();
  if (bypass) {
    try {
      const isHttps = new URL(targetUrl).protocol === 'https:';
      return isHttps ? directHttpsAgent : directHttpAgent;
    } catch {
      return directHttpAgent;
    }
  }
  return getProxyAgent(targetUrl);
}
