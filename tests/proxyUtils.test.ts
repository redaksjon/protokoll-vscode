import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import {
  applyProxyEnvironmentPolicy,
  getProxyAgent,
  getProxyUrl,
  getStrictSSL,
  isProxyBypassed,
  resolveAgent,
} from '../src/proxyUtils';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.PROTOKOLL_PROXY_BYPASS;
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.ALL_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.all_proxy;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
}

describe('proxyUtils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEnv();

    vi.mocked(vscode.workspace.getConfiguration).mockImplementation(() => ({
      get: vi.fn((_: string, defaultValue?: unknown) => defaultValue),
      update: vi.fn(),
    }) as any);
    (vscode.workspace as any).workspaceFolders = undefined;
    (vscode.window as any).activeTextEditor = undefined;
  });

  it('prefers VS Code http.proxy over environment proxy', () => {
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation((section?: string) => {
      if (section === 'http') {
        return {
          get: vi.fn((key: string) => key === 'proxy' ? '  http://corp-proxy:8080  ' : undefined),
          update: vi.fn(),
        } as any;
      }
      return {
        get: vi.fn((_: string, defaultValue?: unknown) => defaultValue),
        update: vi.fn(),
      } as any;
    });

    process.env.HTTPS_PROXY = 'http://env-proxy:9000';
    expect(getProxyUrl()).toBe('http://corp-proxy:8080');
  });

  it('returns undefined proxy URL when bypass is forced via env', () => {
    process.env.PROTOKOLL_PROXY_BYPASS = 'true';
    process.env.HTTPS_PROXY = 'http://env-proxy:9000';
    expect(getProxyUrl()).toBeUndefined();
  });

  it('falls back to HTTPS_PROXY and then HTTP_PROXY', () => {
    process.env.HTTPS_PROXY = 'http://https-proxy:8080';
    expect(getProxyUrl()).toBe('http://https-proxy:8080');

    delete process.env.HTTPS_PROXY;
    process.env.HTTP_PROXY = 'http://http-proxy:8081';
    expect(getProxyUrl()).toBe('http://http-proxy:8081');
  });

  it('matches NO_PROXY wildcard, exact host, suffix host, and invalid URLs', () => {
    process.env.NO_PROXY = '*';
    expect(isProxyBypassed('https://example.com')).toBe(true);

    process.env.NO_PROXY = 'api.example.com';
    expect(isProxyBypassed('https://api.example.com/path')).toBe(true);

    process.env.NO_PROXY = '.example.com';
    expect(isProxyBypassed('https://sub.example.com/path')).toBe(true);

    process.env.NO_PROXY = 'another.example.com';
    expect(isProxyBypassed('https://api.example.com/path')).toBe(false);
    expect(isProxyBypassed('not-a-url')).toBe(false);
  });

  it('reads strict SSL from VS Code config', () => {
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation((section?: string) => {
      if (section === 'http') {
        return {
          get: vi.fn((key: string, defaultValue?: unknown) => (
            key === 'proxyStrictSSL' ? false : defaultValue
          )),
          update: vi.fn(),
        } as any;
      }
      return {
        get: vi.fn((_: string, defaultValue?: unknown) => defaultValue),
        update: vi.fn(),
      } as any;
    });

    expect(getStrictSSL()).toBe(false);
  });

  it('applies and restores proxy environment policy when bypass toggles', () => {
    process.env.HTTPS_PROXY = 'http://secure-proxy:8443';
    process.env.http_proxy = 'http://legacy-proxy:8080';
    process.env.PROTOKOLL_PROXY_BYPASS = '1';

    applyProxyEnvironmentPolicy();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.http_proxy).toBeUndefined();
    expect(process.env.NO_PROXY).toBe('*');
    expect(process.env.no_proxy).toBe('*');

    delete process.env.PROTOKOLL_PROXY_BYPASS;
    applyProxyEnvironmentPolicy();
    expect(process.env.HTTPS_PROXY).toBe('http://secure-proxy:8443');
    expect(process.env.http_proxy).toBe('http://legacy-proxy:8080');
  });

  it('returns a proxy agent when proxy applies and bypass is off', () => {
    process.env.HTTPS_PROXY = 'http://proxy:8080';
    const agent = getProxyAgent('https://example.com');
    expect(agent).toBeInstanceOf(HttpsProxyAgent);
  });

  it('returns direct agents when bypass is enabled', () => {
    process.env.PROTOKOLL_PROXY_BYPASS = 'yes';
    expect(resolveAgent('https://example.com')).toBeInstanceOf(HttpsAgent);
    expect(resolveAgent('http://example.com')).toBeInstanceOf(HttpAgent);
    expect(resolveAgent('not-a-url')).toBeInstanceOf(HttpAgent);
  });
});
