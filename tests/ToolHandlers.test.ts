/**
 * Tool Handler Tests
 * 
 * Verifies that all tool handlers correctly route tool calls,
 * return expected responses, and support custom configuration.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ToolHandlerRegistry,
  SystemToolHandler,
  TranscriptToolHandler,
  ContextToolHandler,
  EntityToolHandler,
  AudioToolHandler,
  DiscoveryToolHandler,
  RelationshipToolHandler,
  ContentToolHandler,
  AssistToolHandler,
  StatusToolHandler,
  createDefaultHandlers,
  FixtureFactory,
} from '../src/test/mock';

describe('ToolHandlerRegistry', () => {
  let registry: ToolHandlerRegistry;

  beforeEach(() => {
    registry = new ToolHandlerRegistry();
  });

  it('should register handlers', () => {
    const handler = new SystemToolHandler();
    registry.register(handler);

    expect(registry.getHandler('system')).toBe(handler);
  });

  it('should route tool calls to correct handler', async () => {
    const handler = new SystemToolHandler();
    registry.register(handler);

    const result = await registry.handleToolCall('protokoll_get_version', {});
    expect(result).toHaveProperty('version');
  });

  it('should throw error for unknown tool', async () => {
    await expect(registry.handleToolCall('unknown_tool', {})).rejects.toThrow(
      'No handler registered for tool'
    );
  });

  it('should get handler for specific tool', () => {
    const handler = new SystemToolHandler();
    registry.register(handler);

    expect(registry.getHandlerForTool('protokoll_get_version')).toBe(handler);
  });

  it('should list all registered tools', () => {
    registry.register(new SystemToolHandler());
    registry.register(new AudioToolHandler());

    const tools = registry.getAllTools();
    expect(tools).toContain('protokoll_get_version');
    expect(tools).toContain('protokoll_process_audio');
  });

  it('should reset all handlers', async () => {
    const handler = new SystemToolHandler();
    registry.register(handler);

    handler.setResponse('protokoll_get_version', { custom: true });
    registry.resetAll();

    // After reset, should return default response
    const result = await handler.handleTool('protokoll_get_version', {});
    expect(result).toHaveProperty('version');
  });
});

describe('SystemToolHandler', () => {
  let handler: SystemToolHandler;

  beforeEach(() => {
    handler = new SystemToolHandler();
  });

  it('should handle protokoll_get_version', async () => {
    const result = await handler.handleTool('protokoll_get_version', {});
    expect(result).toHaveProperty('version');
    expect(result).toHaveProperty('commit');
  });

  it('should handle protokoll_info', async () => {
    const result = await handler.handleTool('protokoll_info', {});
    expect(result).toHaveProperty('name', 'protokoll-mock');
  });

  it('should support custom responses', async () => {
    handler.setResponse('protokoll_get_version', { version: 'custom' });
    const result = await handler.handleTool('protokoll_get_version', {});
    expect(result).toEqual({ version: 'custom' });
  });

  it('should support error simulation', async () => {
    handler.setError('protokoll_get_version', {
      code: -32001,
      message: 'Test error',
    });

    await expect(handler.handleTool('protokoll_get_version', {})).rejects.toThrow(
      'Test error'
    );
  });

  it('should reset to defaults', async () => {
    handler.setResponse('protokoll_get_version', { custom: true });
    handler.reset();

    const result = await handler.handleTool('protokoll_get_version', {});
    expect(result).toHaveProperty('version');
    expect(result).not.toHaveProperty('custom');
  });
});

describe('TranscriptToolHandler', () => {
  let handler: TranscriptToolHandler;

  beforeEach(() => {
    handler = new TranscriptToolHandler();
  });

  it('should handle protokoll_read_transcript', async () => {
    const result = await handler.handleTool('protokoll_read_transcript', {});
    expect(result).toHaveProperty('uri');
    expect(result).toHaveProperty('content');
  });

  it('should handle protokoll_list_transcripts', async () => {
    const result = await handler.handleTool('protokoll_list_transcripts', {});
    expect(result).toHaveProperty('transcripts');
    expect(result).toHaveProperty('pagination');
  });

  it('should filter transcripts by project', async () => {
    const transcript = FixtureFactory.transcript({
      entities: {
        projects: [{ id: 'project-1', name: 'Project 1' }],
      },
    });

    handler.setListingFixture('default', FixtureFactory.transcriptsList({
      transcripts: [transcript],
    }));

    const result = await handler.handleTool('protokoll_list_transcripts', {
      projectId: 'project-1',
    }) as any;

    expect(result.transcripts).toHaveLength(1);
    expect(result.transcripts[0].entities.projects[0].id).toBe('project-1');
  });

  it('should apply pagination', async () => {
    const transcripts = Array.from({ length: 10 }, (_, i) =>
      FixtureFactory.transcript({ date: `2026-02-${String(i + 1).padStart(2, '0')}` })
    );

    handler.setListingFixture('default', FixtureFactory.transcriptsList({
      transcripts,
    }));

    const result = await handler.handleTool('protokoll_list_transcripts', {
      limit: 5,
      offset: 0,
    }) as any;

    expect(result.transcripts).toHaveLength(5);
    expect(result.pagination.hasMore).toBe(true);
  });

  it('should handle mutation operations', async () => {
    const result = await handler.handleTool('protokoll_edit_transcript', {
      path: '/test.md',
      title: 'New Title',
    });

    expect(result).toHaveProperty('success', true);
  });
});

describe('ContextToolHandler', () => {
  let handler: ContextToolHandler;

  beforeEach(() => {
    handler = new ContextToolHandler();
  });

  it('should handle protokoll_context_status', async () => {
    const result = await handler.handleTool('protokoll_context_status', {});
    expect(result).toHaveProperty('people');
    expect(result).toHaveProperty('projects');
  });

  it('should handle protokoll_list_projects', async () => {
    const result = await handler.handleTool('protokoll_list_projects', {}) as any;
    expect(result).toHaveProperty('projects');
    expect(Array.isArray(result.projects)).toBe(true);
  });

  it('should support custom entity lists', async () => {
    const customProjects = [
      { id: 'p1', name: 'Project 1' },
      { id: 'p2', name: 'Project 2' },
    ];

    handler.setEntityList('projects', customProjects);

    const result = await handler.handleTool('protokoll_list_projects', {}) as any;
    expect(result.projects).toEqual(customProjects);
  });
});

describe('EntityToolHandler', () => {
  let handler: EntityToolHandler;

  beforeEach(() => {
    handler = new EntityToolHandler();
  });

  it('should handle add operations', async () => {
    const result = await handler.handleTool('protokoll_add_person', {
      name: 'John Doe',
    });

    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('id');
  });

  it('should handle edit operations', async () => {
    const result = await handler.handleTool('protokoll_edit_person', {
      id: 'person-1',
      name: 'Jane Doe',
    });

    expect(result).toHaveProperty('success', true);
  });

  it('should handle delete operations', async () => {
    const result = await handler.handleTool('protokoll_delete_entity', {
      type: 'person',
      id: 'person-1',
    });

    expect(result).toHaveProperty('success', true);
  });
});

describe('createDefaultHandlers', () => {
  it('should create registry with all handlers', () => {
    const registry = createDefaultHandlers();

    const handlers = registry.getAllHandlers();
    expect(handlers).toHaveLength(10);

    // Verify all categories are registered
    expect(registry.getHandler('system')).toBeTruthy();
    expect(registry.getHandler('transcripts')).toBeTruthy();
    expect(registry.getHandler('context')).toBeTruthy();
    expect(registry.getHandler('entity')).toBeTruthy();
    expect(registry.getHandler('audio')).toBeTruthy();
    expect(registry.getHandler('discovery')).toBeTruthy();
    expect(registry.getHandler('relationship')).toBeTruthy();
    expect(registry.getHandler('content')).toBeTruthy();
    expect(registry.getHandler('assist')).toBeTruthy();
    expect(registry.getHandler('status')).toBeTruthy();
  });

  it('should register all 47 tools', () => {
    const registry = createDefaultHandlers();
    const tools = registry.getAllTools();

    // We have 47 tools across 10 categories
    expect(tools.length).toBe(47);

    // Verify some key tools are present
    expect(tools).toContain('protokoll_get_version');
    expect(tools).toContain('protokoll_list_transcripts');
    expect(tools).toContain('protokoll_context_status');
    expect(tools).toContain('protokoll_add_person');
    expect(tools).toContain('protokoll_process_audio');
  });
});

describe('FixtureFactory', () => {
  it('should create transcript fixtures', () => {
    const transcript = FixtureFactory.transcript();
    expect(transcript).toHaveProperty('uri');
    expect(transcript).toHaveProperty('date');
    expect(transcript).toHaveProperty('filename');
  });

  it('should support overrides', () => {
    const transcript = FixtureFactory.transcript({
      title: 'Custom Title',
      status: 'reviewed',
    });

    expect(transcript.title).toBe('Custom Title');
    expect(transcript.status).toBe('reviewed');
  });

  it('should create transcript content', () => {
    const content = FixtureFactory.transcriptContent();
    expect(content).toHaveProperty('content');
    expect(content).toHaveProperty('metadata');
    expect(content).toHaveProperty('rawTranscript');
  });

  it('should create transcript lists', () => {
    const list = FixtureFactory.transcriptsList();
    expect(list).toHaveProperty('transcripts');
    expect(list).toHaveProperty('pagination');
    expect(Array.isArray(list.transcripts)).toBe(true);
  });

  it('should create entities', () => {
    const person = FixtureFactory.entity('person');
    expect(person).toHaveProperty('id');
    expect(person).toHaveProperty('name');
  });

  it('should use templates', () => {
    const transcript = FixtureFactory.templates.happyPathTranscript();
    expect(transcript.status).toBe('reviewed');
    expect(transcript.openTasksCount).toBe(0);
  });
});
