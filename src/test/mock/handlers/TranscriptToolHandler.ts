/**
 * Transcript Tool Handler
 * 
 * Handles transcript operations:
 * - protokoll_read_transcript
 * - protokoll_list_transcripts
 * - protokoll_edit_transcript
 * - protokoll_change_transcript_date
 * - protokoll_combine_transcripts
 * - protokoll_provide_feedback
 * - protokoll_update_transcript_content
 * - protokoll_update_transcript_entity_references
 * - protokoll_create_note
 */

import type { ToolHandler } from './ToolHandler';
import type { JsonRpcError } from '../types';
import type { TranscriptContent, TranscriptsListResponse } from '../../../types';
import { FixtureFactory } from '../fixtures/FixtureFactory';

export class TranscriptToolHandler implements ToolHandler {
  readonly category = 'transcripts';
  readonly tools = [
    'protokoll_read_transcript',
    'protokoll_list_transcripts',
    'protokoll_edit_transcript',
    'protokoll_change_transcript_date',
    'protokoll_combine_transcripts',
    'protokoll_provide_feedback',
    'protokoll_update_transcript_content',
    'protokoll_update_transcript_entity_references',
    'protokoll_create_note',
  ];

  private transcriptFixtures = new Map<string, TranscriptContent>();
  private listingFixtures = new Map<string, TranscriptsListResponse>();
  private responses = new Map<string, unknown>();
  private errors = new Map<string, JsonRpcError>();

  constructor() {
    this.initializeDefaultFixtures();
  }

  private initializeDefaultFixtures(): void {
    // Default transcript content
    this.transcriptFixtures.set('default', FixtureFactory.transcriptContent());
    
    // Default transcript list
    this.listingFixtures.set('default', FixtureFactory.transcriptsList());

    // Default responses for mutation operations
    this.responses.set('protokoll_edit_transcript', { success: true });
    this.responses.set('protokoll_change_transcript_date', { success: true });
    this.responses.set('protokoll_combine_transcripts', { 
      success: true,
      combinedPath: '/mock/transcripts/combined-transcript.md',
    });
    this.responses.set('protokoll_provide_feedback', { success: true });
    this.responses.set('protokoll_update_transcript_content', { success: true });
    this.responses.set('protokoll_update_transcript_entity_references', { success: true });
    this.responses.set('protokoll_create_note', { 
      success: true,
      notePath: '/mock/notes/note.md',
    });
  }

  async handleTool(toolName: string, args: unknown): Promise<unknown> {
    // Check for configured error
    const error = this.errors.get(toolName);
    if (error) {
      throw new Error(error.message);
    }

    // Handle each tool
    switch (toolName) {
      case 'protokoll_read_transcript':
        return this.handleReadTranscript(args);
      
      case 'protokoll_list_transcripts':
        return this.handleListTranscripts(args);
      
      case 'protokoll_edit_transcript':
      case 'protokoll_change_transcript_date':
      case 'protokoll_combine_transcripts':
      case 'protokoll_provide_feedback':
      case 'protokoll_update_transcript_content':
      case 'protokoll_update_transcript_entity_references':
      case 'protokoll_create_note':
        // Return configured response or default
        return this.responses.get(toolName) || { success: true };
      
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private handleReadTranscript(args: unknown): TranscriptContent {
    const params = args as { path?: string; uri?: string };
    
    // Try to find a specific fixture by path/uri
    const key = params.path || params.uri || 'default';
    const fixture = this.transcriptFixtures.get(key) || this.transcriptFixtures.get('default');
    
    if (!fixture) {
      throw new Error('Transcript not found');
    }

    return fixture;
  }

  private handleListTranscripts(args: unknown): TranscriptsListResponse {
    const params = args as {
      directory?: string;
      startDate?: string;
      endDate?: string;
      limit?: number;
      offset?: number;
      projectId?: string;
    };

    // Try to find a specific fixture by directory
    const key = params.directory || 'default';
    const fixture = this.listingFixtures.get(key) || this.listingFixtures.get('default');

    if (!fixture) {
      throw new Error('No transcripts found');
    }

    // Apply filters if provided
    let transcripts = [...fixture.transcripts];

    if (params.projectId) {
      transcripts = transcripts.filter(t =>
        t.entities?.projects?.some(p => p.id === params.projectId)
      );
    }

    if (params.startDate) {
      transcripts = transcripts.filter(t => t.date >= params.startDate!);
    }

    if (params.endDate) {
      transcripts = transcripts.filter(t => t.date <= params.endDate!);
    }

    // Apply pagination
    const offset = params.offset || 0;
    const limit = params.limit || 50;
    const paginatedTranscripts = transcripts.slice(offset, offset + limit);

    return {
      ...fixture,
      transcripts: paginatedTranscripts,
      pagination: {
        total: transcripts.length,
        limit,
        offset,
        hasMore: offset + limit < transcripts.length,
      },
      filters: {
        startDate: params.startDate,
        endDate: params.endDate,
      },
    };
  }

  /**
   * Set a transcript fixture for a specific path/uri
   */
  setTranscriptFixture(key: string, transcript: TranscriptContent): void {
    this.transcriptFixtures.set(key, transcript);
  }

  /**
   * Set a transcript list fixture for a specific directory
   */
  setListingFixture(key: string, listing: TranscriptsListResponse): void {
    this.listingFixtures.set(key, listing);
  }

  setResponse(toolName: string, response: unknown): void {
    if (!this.tools.includes(toolName)) {
      throw new Error(`Tool ${toolName} is not handled by ${this.category} handler`);
    }
    this.responses.set(toolName, response);
  }

  setError(toolName: string, error: JsonRpcError): void {
    if (!this.tools.includes(toolName)) {
      throw new Error(`Tool ${toolName} is not handled by ${this.category} handler`);
    }
    this.errors.set(toolName, error);
  }

  reset(): void {
    this.transcriptFixtures.clear();
    this.listingFixtures.clear();
    this.responses.clear();
    this.errors.clear();
    this.initializeDefaultFixtures();
  }
}
