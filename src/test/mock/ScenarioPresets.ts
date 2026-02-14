/**
 * Scenario Presets
 * 
 * Pre-configured scenarios for common testing patterns.
 * Reduces boilerplate while maintaining flexibility.
 */

import type { MockTransportServer } from './MockTransportServer';
import { FixtureFactory } from './fixtures/FixtureFactory';
import type { TranscriptToolHandler, ContextToolHandler } from './handlers';

export interface PresetInfo {
  name: string;
  description: string;
  categories: string[];
}

export interface PresetDefinition {
  description: string;
  categories: string[];
  setup: (server: MockTransportServer) => void;
}

/**
 * Library of preset scenarios for common testing patterns
 */
export class ScenarioPresets {
  static readonly presets: Record<string, PresetDefinition> = {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    'happy-path-transcripts': {
      description: 'Working transcript operations with sample data',
      categories: ['transcripts', 'context'],
      setup: (server: MockTransportServer) => {
        const transcriptHandler = server.getHandler<TranscriptToolHandler>('transcripts');
        const contextHandler = server.getHandler<ContextToolHandler>('context');

        if (transcriptHandler) {
          // Set up transcript list with sample data
          transcriptHandler.setListingFixture(
            'default',
            FixtureFactory.transcriptsList({
              transcripts: [
                FixtureFactory.templates.happyPathTranscript(),
                FixtureFactory.templates.transcriptWithEntities(),
              ],
            })
          );

          // Set up transcript content
          transcriptHandler.setTranscriptFixture(
            'default',
            FixtureFactory.transcriptContent()
          );
        }

        if (contextHandler) {
          // Set up active context
          contextHandler.setResponse('protokoll_context_status', {
            people: 5,
            projects: 3,
            terms: 10,
            companies: 2,
          });
        }
      },
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'empty-project': {
      description: 'New project with no transcripts or entities',
      categories: ['transcripts', 'context'],
      setup: (server: MockTransportServer) => {
        const transcriptHandler = server.getHandler<TranscriptToolHandler>('transcripts');
        const contextHandler = server.getHandler<ContextToolHandler>('context');

        if (transcriptHandler) {
          transcriptHandler.setListingFixture(
            'default',
            FixtureFactory.transcriptsList({
              transcripts: [],
              pagination: {
                total: 0,
                limit: 50,
                offset: 0,
                hasMore: false,
              },
            })
          );
        }

        if (contextHandler) {
          contextHandler.setResponse('protokoll_context_status', {
            people: 0,
            projects: 0,
            terms: 0,
            companies: 0,
          });

          contextHandler.setEntityList('projects', []);
          contextHandler.setEntityList('people', []);
          contextHandler.setEntityList('terms', []);
          contextHandler.setEntityList('companies', []);
        }
      },
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'large-dataset': {
      description: 'Large dataset with many transcripts for pagination testing',
      categories: ['transcripts'],
      setup: (server: MockTransportServer) => {
        const transcriptHandler = server.getHandler<TranscriptToolHandler>('transcripts');

        if (transcriptHandler) {
          transcriptHandler.setListingFixture(
            'default',
            FixtureFactory.templates.largeTranscriptList(100)
          );
        }
      },
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'transcripts-with-tasks': {
      description: 'Transcripts with open tasks for workflow testing',
      categories: ['transcripts', 'status'],
      setup: (server: MockTransportServer) => {
        const transcriptHandler = server.getHandler<TranscriptToolHandler>('transcripts');

        if (transcriptHandler) {
          transcriptHandler.setListingFixture(
            'default',
            FixtureFactory.transcriptsList({
              transcripts: [
                FixtureFactory.templates.transcriptWithTasks(3),
                FixtureFactory.templates.transcriptWithTasks(1),
              ],
            })
          );
        }
      },
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'session-expiration': {
      description: 'Tests session recovery and reconnection scenarios',
      categories: ['session'],
      setup: (server: MockTransportServer) => {
        // Set short session timeout for testing
        server.getSessionManager().setSessionTimeout(5000);
      },
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'slow-responses': {
      description: 'Simulates slow server responses for timeout testing',
      categories: ['performance'],
      setup: (server: MockTransportServer) => {
        void server; // Available for future implementation
        // This would need additional support in handlers for delayed responses
        // For now, just document the pattern
        console.log('[Preset] slow-responses: Handler-level delays not yet implemented');
      },
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'error-responses': {
      description: 'All operations return errors for error handling testing',
      categories: ['errors'],
      setup: (server: MockTransportServer) => {
        const transcriptHandler = server.getHandler<TranscriptToolHandler>('transcripts');

        if (transcriptHandler) {
          transcriptHandler.setError('protokoll_list_transcripts', {
            code: -32603,
            message: 'Internal server error',
          });

          transcriptHandler.setError('protokoll_read_transcript', {
            code: -32602,
            message: 'Transcript not found',
          });
        }
      },
    },

    // eslint-disable-next-line @typescript-eslint/naming-convention
    'mixed-status-transcripts': {
      description: 'Transcripts in various lifecycle states',
      categories: ['transcripts', 'status'],
      setup: (server: MockTransportServer) => {
        const transcriptHandler = server.getHandler<TranscriptToolHandler>('transcripts');

        if (transcriptHandler) {
          transcriptHandler.setListingFixture(
            'default',
            FixtureFactory.transcriptsList({
              transcripts: [
                FixtureFactory.transcript({ status: 'initial' }),
                FixtureFactory.transcript({ status: 'enhanced' }),
                FixtureFactory.transcript({ status: 'reviewed' }),
                FixtureFactory.transcript({ status: 'in_progress' }),
                FixtureFactory.transcript({ status: 'closed' }),
              ],
            })
          );
        }
      },
    },
  };

  /**
   * Load a preset scenario onto a server
   */
  static load(presetName: string, server: MockTransportServer): void {
    const preset = this.presets[presetName];
    if (!preset) {
      throw new Error(`Unknown preset: ${presetName}`);
    }

    preset.setup(server);
  }

  /**
   * List all available presets
   */
  static listPresets(): PresetInfo[] {
    return Object.entries(this.presets).map(([name, preset]) => ({
      name,
      description: preset.description,
      categories: preset.categories,
    }));
  }

  /**
   * Get information about a specific preset
   */
  static describe(presetName: string): PresetInfo | null {
    const preset = this.presets[presetName];
    if (!preset) {
      return null;
    }

    return {
      name: presetName,
      description: preset.description,
      categories: preset.categories,
    };
  }

  /**
   * Check if a preset exists
   */
  static has(presetName: string): boolean {
    return presetName in this.presets;
  }
}
