/**
 * Fixture Factory for generating mock data
 * 
 * Provides builders for all Protokoll data types with sensible defaults
 * and support for partial overrides.
 */

import type {
  Transcript,
  TranscriptContent,
  TranscriptsListResponse,
  TranscriptStatus,
  Task,
  StatusTransition,
} from '../../../types';

/**
 * Generate a unique ID
 */
function generateId(): string {
  return `mock-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate a mock date string
 */
function mockDate(daysAgo = 0): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split('T')[0];
}

/**
 * Generate a mock timestamp
 */
function mockTimestamp(daysAgo = 0): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
}

/**
 * Main fixture factory class
 */
export class FixtureFactory {
  /**
   * Create a mock transcript listing entry
   */
  static transcript(overrides?: Partial<Transcript>): Transcript {
    const date = mockDate();
    const filename = `${date.replace(/-/g, '')}-1200-transcript.md`;
    
    return {
      uri: `protokoll://transcript/${filename}`,
      path: `/mock/transcripts/${filename}`,
      filename,
      date,
      time: '12:00',
      title: 'Mock Transcript',
      hasRawTranscript: true,
      createdAt: mockTimestamp(),
      updatedAt: mockTimestamp(),
      status: 'initial',
      openTasksCount: 0,
      contentSize: 1024,
      history: [],
      tasks: [],
      entities: {
        people: [],
        projects: [],
        terms: [],
        companies: [],
      },
      ...overrides,
    };
  }

  /**
   * Create a mock transcript content (full transcript with content)
   */
  static transcriptContent(overrides?: Partial<TranscriptContent>): TranscriptContent {
    const date = mockDate();
    const filename = `${date.replace(/-/g, '')}-1200-transcript.md`;
    
    return {
      uri: `protokoll://transcript/${filename}`,
      path: `/mock/transcripts/${filename}`,
      title: 'Mock Transcript',
      metadata: {
        date,
        time: '12:00',
        status: 'initial',
        tags: [],
        entities: {
          people: [],
          projects: [],
          terms: [],
          companies: [],
        },
        tasks: [],
        history: [],
      },
      content: '# Mock Transcript\n\nThis is a mock transcript for testing purposes.\n\n## Section 1\n\nSome content here.',
      rawTranscript: {
        text: 'This is the raw transcript text.',
        model: 'whisper-1',
        duration: 120,
        transcribedAt: mockTimestamp(),
      },
      ...overrides,
    };
  }

  /**
   * Create a mock transcripts list response
   */
  static transcriptsList(overrides?: Partial<TranscriptsListResponse>): TranscriptsListResponse {
    const transcripts = overrides?.transcripts || [
      FixtureFactory.transcript(),
      FixtureFactory.transcript({ date: mockDate(1) }),
      FixtureFactory.transcript({ date: mockDate(2) }),
    ];

    return {
      directory: '/mock/transcripts',
      transcripts,
      pagination: {
        total: transcripts.length,
        limit: 50,
        offset: 0,
        hasMore: false,
      },
      filters: {},
      ...overrides,
    };
  }

  /**
   * Create a mock task
   */
  static task(overrides?: Partial<Task>): Task {
    return {
      id: generateId(),
      description: 'Mock task description',
      status: 'open',
      created: mockTimestamp(),
      ...overrides,
    };
  }

  /**
   * Create a mock status transition
   */
  static statusTransition(
    from: TranscriptStatus = 'initial',
    to: TranscriptStatus = 'enhanced',
    daysAgo = 0
  ): StatusTransition {
    return {
      from,
      to,
      at: mockTimestamp(daysAgo),
    };
  }

  /**
   * Create a mock entity (person, project, term, company)
   */
  static entity(
    type: 'person' | 'project' | 'term' | 'company',
    overrides?: { id?: string; name?: string; [key: string]: unknown }
  ): { id: string; name: string; [key: string]: unknown } {
    const id = overrides?.id || generateId();
    const name = overrides?.name || `Mock ${type} ${id.slice(-4)}`;

    return {
      id,
      name,
      ...overrides,
    };
  }

  /**
   * Create a mock context status response
   */
  static contextStatus(overrides?: {
    peopleCount?: number;
    projectsCount?: number;
    termsCount?: number;
    companiesCount?: number;
  }) {
    return {
      people: overrides?.peopleCount || 0,
      projects: overrides?.projectsCount || 0,
      terms: overrides?.termsCount || 0,
      companies: overrides?.companiesCount || 0,
    };
  }

  /**
   * Create a mock entity list
   */
  static entityList(
    type: 'person' | 'project' | 'term' | 'company',
    count = 3
  ): Array<{ id: string; name: string }> {
    return Array.from({ length: count }, () => FixtureFactory.entity(type));
  }

  /**
   * Template-based fixtures for common scenarios
   */
  static templates = {
    /**
     * Happy path transcript (reviewed status, no open tasks)
     */
    happyPathTranscript: (): Transcript => {
      return FixtureFactory.transcript({
        status: 'reviewed',
        openTasksCount: 0,
        history: [
          FixtureFactory.statusTransition('initial', 'enhanced', 2),
          FixtureFactory.statusTransition('enhanced', 'reviewed', 1),
        ],
      });
    },

    /**
     * Transcript with open tasks
     */
    transcriptWithTasks: (taskCount = 3): Transcript => {
      const tasks = Array.from({ length: taskCount }, () =>
        FixtureFactory.task()
      );

      return FixtureFactory.transcript({
        status: 'in_progress',
        openTasksCount: taskCount,
        tasks,
      });
    },

    /**
     * Transcript with entities
     */
    transcriptWithEntities: (): Transcript => {
      return FixtureFactory.transcript({
        entities: {
          people: FixtureFactory.entityList('person', 2),
          projects: FixtureFactory.entityList('project', 1),
          terms: FixtureFactory.entityList('term', 3),
          companies: FixtureFactory.entityList('company', 1),
        },
      });
    },

    /**
     * Empty project (no transcripts)
     */
    emptyProject: () => {
      return FixtureFactory.entity('project', {
        transcripts: [],
        transcriptCount: 0,
      });
    },

    /**
     * Large transcript list
     */
    largeTranscriptList: (count: number): TranscriptsListResponse => {
      const transcripts = Array.from({ length: count }, (_, i) =>
        FixtureFactory.transcript({ date: mockDate(i) })
      );

      return FixtureFactory.transcriptsList({
        transcripts,
        pagination: {
          total: count,
          limit: 50,
          offset: 0,
          hasMore: count > 50,
        },
      });
    },

    /**
     * Transcript with full lifecycle history
     */
    transcriptWithFullHistory: (): Transcript => {
      return FixtureFactory.transcript({
        status: 'reviewed',
        history: [
          FixtureFactory.statusTransition('initial', 'enhanced', 5),
          FixtureFactory.statusTransition('enhanced', 'in_progress', 4),
          FixtureFactory.statusTransition('in_progress', 'enhanced', 3),
          FixtureFactory.statusTransition('enhanced', 'reviewed', 1),
        ],
      });
    },

    /**
     * Minimal transcript (only required fields)
     */
    minimalTranscript: (): Transcript => {
      const date = mockDate();
      const filename = `${date.replace(/-/g, '')}-1200-transcript.md`;

      return {
        uri: `protokoll://transcript/${filename}`,
        path: `/mock/transcripts/${filename}`,
        filename,
        date,
      };
    },
  };
}
