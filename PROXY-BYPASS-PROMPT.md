# Prompt: Add Proxy Bypass Setting to protokoll-vscode Extension

## Problem

The protokoll-vscode extension cannot connect to remote Protokoll servers (e.g. a cloud-hosted instance) when running behind a corporate proxy. The extension already has proxy *support* via `src/proxyUtils.ts` (using `https-proxy-agent`), which correctly routes traffic through a proxy when one is configured. However, the **opposite** is also needed: the ability to **bypass** the proxy for the Protokoll server specifically.

In this specific environment:
- macOS system proxy is `sysproxy.wal-mart.com:8080` (configured via PAC file at `http://wmtpac.wal-mart.com/proxies/anycast-universal.pac`)
- McAfee sets local relay env vars (`HTTP_PROXY=http://127.0.0.1:62365`)
- VSCode/Cursor reads the system proxy via `scutil --proxy` and patches Node's `http`/`https` modules to inject proxy support at a level deeper than environment variables
- The corporate proxy blocks or interferes with connections to external servers like `getfjell.com`
- Direct connections (bypassing proxy) work fine: `curl --noproxy '*' https://server.getfjell.com/mcp` succeeds

The existing `isProxyBypassed()` function in `proxyUtils.ts` checks `NO_PROXY` env vars, but this doesn't help because:
1. VSCode/Cursor injects its own proxy agent at a lower level than env vars
2. Even when `NO_PROXY=*` is set in the shell before launching Cursor, the system-level proxy (from `scutil --proxy`) still takes effect

## Current Architecture

### `src/proxyUtils.ts` — Already exists, provides:
- `getProxyUrl()` — Reads proxy URL from `http.proxy` setting or env vars
- `isProxyBypassed(targetUrl)` — Checks `NO_PROXY` env var
- `getStrictSSL()` — Reads `http.proxyStrictSSL` setting
- `getProxyAgent(targetUrl)` — Returns an `HttpsProxyAgent` or `undefined`

### Files that call `getProxyAgent()`:
1. **`src/mcpClient.ts`** — `sendRequest()` (line ~194), `healthCheck()` (line ~541), `startSSEConnection()` (line ~760)
2. **`src/uploadService.ts`** — `uploadAudio()` (line ~133)

### `src/openaiClient.ts` — Uses `getProxyUrl()` / `isProxyBypassed()` directly with the OpenAI SDK (this is fine — OpenAI API calls *should* go through the proxy)

## What Needs to Change

### 1. Add `protokoll.proxyBypass` setting

Add to `package.json` contributes.configuration.properties:

```json
"protokoll.proxyBypass": {
    "type": "boolean",
    "default": false,
    "description": "Bypass system/corporate proxy when connecting to the Protokoll server. Enable this if your Protokoll server is accessible directly but blocked by a corporate proxy.",
    "markdownDescription": "Bypass system/corporate proxy when connecting to the Protokoll server. Enable this when your Protokoll server is reachable directly but a corporate proxy interferes with the connection."
}
```

### 2. Modify `src/proxyUtils.ts`

Add a new function that returns an explicit **direct** agent (no proxy) when bypass is enabled:

```typescript
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

/**
 * Return the appropriate agent for the given target URL, considering
 * both proxy and proxy-bypass settings.
 *
 * When `protokoll.proxyBypass` is true, returns an explicit direct agent
 * that overrides VSCode's proxy injection. When false, delegates to the
 * existing getProxyAgent() logic.
 */
export function resolveAgent(targetUrl: string): http.Agent | undefined {
    const bypass = vscode.workspace.getConfiguration('protokoll').get<boolean>('proxyBypass', false);
    if (bypass) {
        const isHttps = targetUrl.startsWith('https:');
        return isHttps
            ? new HttpsAgent({ keepAlive: true })
            : new HttpAgent({ keepAlive: true });
    }
    return getProxyAgent(targetUrl);
}
```

### 3. Update callers

Replace `getProxyAgent()` calls with `resolveAgent()` in:

- `src/mcpClient.ts` — 3 call sites (`sendRequest`, `healthCheck`, `startSSEConnection`)
- `src/uploadService.ts` — 1 call site (`uploadAudio`)

The change at each site is minimal:

```typescript
// Before:
const proxyAgent = getProxyAgent(url.toString());
// ...
...(proxyAgent ? { agent: proxyAgent } : {}),

// After:
const agent = resolveAgent(url.toString());
// ...
...(agent ? { agent } : {}),
```

### 4. Watch for config changes in `src/extension.ts`

The extension already watches `protokoll.serverUrl` and `protokoll.apiKey` in `onDidChangeConfiguration`. Add `protokoll.proxyBypass` to that check so the connection is re-established when the setting changes.

### 5. Do NOT change `src/openaiClient.ts`

The OpenAI client talks to `api.openai.com` which *should* go through the corporate proxy. The bypass setting should only affect connections to the Protokoll server.

## If the Simple Agent Approach Doesn't Work

VSCode deeply patches Node's HTTP stack. If creating a new `HttpAgent`/`HttpsAgent` still routes through the proxy, the fallback is to use `undici` (which has its own HTTP implementation independent of Node's `http` module). The kjerneverk monorepo already uses `undici` for proxy support in other packages — see `/Users/tobrien/gitw/kjerneverk/PROXY-SUPPORT-SUMMARY.md`. Here you'd use `undici.fetch()` or `undici.request()` with no proxy agent to bypass VSCode's patching entirely.

## Files to Modify

| File | Change |
|------|--------|
| `package.json` | Add `protokoll.proxyBypass` configuration property |
| `src/proxyUtils.ts` | Add `resolveAgent()` function |
| `src/mcpClient.ts` | Replace 3x `getProxyAgent()` calls with `resolveAgent()` |
| `src/uploadService.ts` | Replace 1x `getProxyAgent()` call with `resolveAgent()` |
| `src/extension.ts` | Add `protokoll.proxyBypass` to config change watcher |

## Testing

1. Set `protokoll.serverUrl` to a remote server (e.g. `https://server.getfjell.com`)
2. Set `protokoll.proxyBypass` to `true`
3. The Connection Status view should show "connected"
4. Transcripts should load in the sidebar
5. Audio upload should work
6. With `proxyBypass: false` (default), existing proxy-dependent setups should continue working
7. OpenAI calls (task identification) should still route through the proxy regardless of the bypass setting

## Context

- See `~/PROXY_CURSOR_CONFIG.md` for the full proxy diagnosis on this machine
- See `/Users/tobrien/gitw/kjerneverk/PROXY-SUPPORT-SUMMARY.md` for how other kjerneverk packages handle proxy
- See `/Users/tobrien/gitw/kjerneverk/riotplan-vscode/PROXY-BYPASS-PROMPT.md` for the identical prompt for the riotplan-vscode extension (same problem, but that extension doesn't have existing proxy support infrastructure)
- The Cursor MCP connection (separate from the extension) was fixed via `mcp-remote` stdio bridge with per-process env overrides in `~/.cursor/mcp.json`
