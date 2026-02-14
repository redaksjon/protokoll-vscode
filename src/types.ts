/**
 * Type definitions for Protokoll MCP resources
 */

/**
 * Transcript lifecycle status
 */
export type TranscriptStatus = 'initial' | 'enhanced' | 'reviewed' | 'in_progress' | 'closed' | 'archived';

/**
 * Status transition record
 */
export interface StatusTransition {
  from: TranscriptStatus;
  to: TranscriptStatus;
  at: string;
}

/**
 * Task attached to a transcript
 */
export interface Task {
  id: string;
  description: string;
  status: 'open' | 'done';
  created: string;
  changed?: string;
  completed?: string;
}

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
  // Lifecycle fields
  status?: TranscriptStatus;
  openTasksCount?: number;
  contentSize?: number;
  history?: StatusTransition[];
  tasks?: Task[];
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

/**
 * Raw MCP resource response
 */
export interface McpResourceResponse {
  uri: string;
  mimeType: string;
  text: string;
}

/**
 * Structured transcript content returned by MCP server
 * The server returns all metadata pre-parsed - clients should NOT parse this
 */
export interface TranscriptContent {
  uri: string;
  path: string;
  title: string;
  metadata: {
    date?: string;
    time?: string;
    project?: string;
    projectId?: string;
    status?: TranscriptStatus;
    tags?: string[];
    duration?: number;
    entities?: {
      people?: Array<{ id: string; name: string }>;
      projects?: Array<{ id: string; name: string }>;
      terms?: Array<{ id: string; name: string }>;
      companies?: Array<{ id: string; name: string }>;
    };
    tasks?: Task[];
    history?: StatusTransition[];
    routing?: {
      destination?: string;
      confidence?: string;
    };
  };
  content: string;
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
