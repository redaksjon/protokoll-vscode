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
import { URL } from 'url';

export function getProxyUrl(): string | undefined {
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
