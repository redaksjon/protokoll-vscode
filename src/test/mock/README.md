# Mock MCP Transport Server

A lightweight, protocol-compliant mock implementation of the MCP (Model Context Protocol) server for testing the Protokoll VS Code extension.

## Overview

The Mock MCP Transport Server implements the complete MCP protocol over HTTP with Server-Sent Events (SSE) for notifications. It speaks real JSON-RPC 2.0 to genuinely exercise the extension's transport layer without stubbing or hand-waving protocol details.

## Architecture

### Core Components

- **MockTransportServer** - Main server class that orchestrates HTTP and SSE handling
- **SessionManager** - Manages session lifecycle, expiration, and subscriptions
- **SseManager** - Handles SSE connections, notifications, and connection lifecycle
- **JsonRpcHandler** - Implements JSON-RPC 2.0 protocol and method routing

### Protocol Support

- ✅ JSON-RPC 2.0 over HTTP
- ✅ Session management with unique session IDs
- ✅ SSE for server-to-client notifications
- ✅ MCP initialize handshake
- ✅ Tool listing and invocation
- ✅ Resource listing and reading
- ✅ Resource subscriptions

## Usage

### Basic Example

```typescript
import { MockTransportServer } from './test/mock';

// Create and start server
const server = new MockTransportServer({ verbose: true });
await server.start(); // Starts on random available port

const baseUrl = server.getBaseUrl(); // e.g., http://127.0.0.1:54321

// Use the server URL in your extension tests
// ...

// Stop server when done
await server.stop();
```

### Session Management Testing

```typescript
// Test session expiration and recovery
const server = new MockTransportServer();
await server.start();

// Initialize and get session ID
const initResponse = await fetch(`${server.getBaseUrl()}/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    },
  }),
});

const sessionId = initResponse.headers.get('mcp-session-id');

// Schedule session to expire after 2 more requests
server.getSessionManager().expireSessionAfter(sessionId, 2);

// Next 2 requests will succeed, then session expires
```

### SSE Testing

```typescript
// Test SSE connection and notifications
const server = new MockTransportServer();
await server.start();

// Initialize session first
// ... (see above)

// Open SSE connection
const sseResponse = await fetch(`${server.getBaseUrl()}/mcp`, {
  method: 'GET',
  headers: {
    'Accept': 'text/event-stream',
    'Mcp-Session-Id': sessionId,
  },
});

// Send notification to session
server.getSseManager().sendToSession(sessionId, {
  jsonrpc: '2.0',
  method: 'notifications/resources/updated',
  params: { uri: 'protokoll://transcripts' },
});

// Simulate connection drop for reconnection testing
server.getSseManager().simulateConnectionDrop(sessionId);
```

## Configuration

```typescript
interface MockServerConfig {
  /**
   * Port to listen on (0 = random available port)
   */
  port?: number;

  /**
   * Session timeout in milliseconds (default: 60000)
   */
  sessionTimeout?: number;

  /**
   * Enable verbose logging for debugging (default: false)
   */
  verbose?: boolean;

  /**
   * Default responses for tools (can be overridden per-test)
   */
  defaultResponses?: Record<string, unknown>;
}
```

## Test Utilities

### Session Manager

```typescript
const sessionManager = server.getSessionManager();

// Expire session after N requests (for testing recovery)
sessionManager.expireSessionAfter(sessionId, 3);

// Expire session immediately
sessionManager.expireSession(sessionId);

// Expire all sessions
sessionManager.expireAllSessions();

// Set custom session timeout
sessionManager.setSessionTimeout(30000); // 30 seconds
```

### SSE Manager

```typescript
const sseManager = server.getSseManager();

// Simulate connection drop
sseManager.simulateConnectionDrop(sessionId);

// Simulate network delay
sseManager.simulateNetworkDelay(sessionId, 1000); // 1 second delay

// Clear network delay
sseManager.clearNetworkDelay(sessionId);

// Broadcast to all sessions
sseManager.broadcast({
  jsonrpc: '2.0',
  method: 'notifications/test',
  params: { message: 'Hello' },
});
```

## Protocol Compliance

The mock server implements the MCP protocol according to the 2024-11-05 specification:

### Endpoints

- `GET /health` - Health check (returns `{ status: 'ok' }`)
- `POST /mcp` - JSON-RPC requests
- `GET /mcp` (with `Accept: text/event-stream`) - SSE connection

### Session Flow

1. Client sends `initialize` request (no session ID required)
2. Server creates session and returns session ID in `Mcp-Session-Id` header
3. Client includes `Mcp-Session-Id` header in all subsequent requests
4. Server validates session on each request
5. If session not found, server returns 404 with error

### Supported Methods

- `initialize` - Initialize MCP session
- `notifications/initialized` - Acknowledge initialization
- `tools/list` - List available tools
- `tools/call` - Invoke a tool
- `resources/list` - List available resources
- `resources/read` - Read a resource
- `resources/subscribe` - Subscribe to resource updates
- `resources/unsubscribe` - Unsubscribe from resource updates

## Next Steps (Step 2)

In Step 2, we'll add modular tool handlers for all 51 MCP tools:

- System tools (version, info)
- Discovery tools (config, project suggestions)
- Audio tools (process, batch)
- Context tools (status, list entities, search)
- Entity CRUD tools (add, edit, update, delete)
- Relationship tools (add, remove, list, find)
- Content tools (add, remove, list, get)
- Assist tools (suggest metadata)
- Transcript tools (read, list, edit, combine, etc.)
- Status tools (set status, create/complete/delete tasks)

## Testing

Run the protocol compliance tests:

```bash
npm test -- MockTransportServer
```

All tests should pass, verifying:
- Server lifecycle (start/stop)
- Health check endpoint
- MCP initialize handshake
- Session management
- JSON-RPC protocol compliance
- SSE connection handling

## Files

- `MockTransportServer.ts` - Main server class
- `SessionManager.ts` - Session lifecycle management
- `SseManager.ts` - SSE connection management
- `JsonRpcHandler.ts` - JSON-RPC protocol implementation
- `types.ts` - TypeScript type definitions
- `index.ts` - Public API exports
