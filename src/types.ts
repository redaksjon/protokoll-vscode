/**
 * Type definitions for Protokoll MCP resources
 */

export interface Transcript {
  uri: string;
  path: string;
  filename: string;
  date: string;
  time?: string;
  title?: string;
  hasRawTranscript?: boolean;
  createdAt?: string; // Date when transcript was added to the system
  updatedAt?: string; // Date when transcript content was last updated
  entities?: {
    people?: Array<{ id: string; name: string }>;
    projects?: Array<{ id: string; name: string }>;
    terms?: Array<{ id: string; name: string }>;
    companies?: Array<{ id: string; name: string }>;
  };
}

export interface TranscriptsListResponse {
  directory: string;
  transcripts: Transcript[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  filters: {
    startDate?: string;
    endDate?: string;
  };
}

export interface TranscriptContent {
  uri: string;
  mimeType: string;
  text: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourcesListResponse {
  resources: McpResource[];
}
