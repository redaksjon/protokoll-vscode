/**
 * Audio Tool Handler
 * 
 * Handles audio processing tools:
 * - protokoll_process_audio
 * - protokoll_batch_process
 */

import { BaseToolHandler } from './BaseToolHandler';

export class AudioToolHandler extends BaseToolHandler {
  readonly category = 'audio';
  readonly tools = ['protokoll_process_audio', 'protokoll_batch_process'];

  constructor() {
    super();
    this.initializeDefaults();
  }

  protected initializeDefaults(): void {
    this.responses.set('protokoll_process_audio', {
      success: true,
      transcriptPath: '/mock/transcripts/20260214-1200-transcript.md',
      duration: 120,
      model: 'whisper-1',
    });

    this.responses.set('protokoll_batch_process', {
      success: true,
      processed: 3,
      failed: 0,
      transcripts: [
        '/mock/transcripts/20260214-1200-transcript.md',
        '/mock/transcripts/20260214-1300-transcript.md',
        '/mock/transcripts/20260214-1400-transcript.md',
      ],
    });
  }
}
