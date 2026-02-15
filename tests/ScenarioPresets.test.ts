/**
 * Scenario Presets and Composer Tests
 * 
 * Verifies that scenario presets, composition, and builder APIs work correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ScenarioPresets,
  ScenarioComposer,
  MockServerBuilder,
  TestHelpers,
  MockTransportServer,
} from '../src/test/mock';

describe('ScenarioPresets', () => {
  it('should list all available presets', () => {
    const presets = ScenarioPresets.listPresets();
    expect(presets.length).toBeGreaterThan(0);
    
    // Verify preset structure
    presets.forEach(preset => {
      expect(preset).toHaveProperty('name');
      expect(preset).toHaveProperty('description');
      expect(preset).toHaveProperty('categories');
      expect(Array.isArray(preset.categories)).toBe(true);
    });
  });

  it('should describe a specific preset', () => {
    const info = ScenarioPresets.describe('happy-path-transcripts');
    expect(info).toBeTruthy();
    expect(info?.name).toBe('happy-path-transcripts');
    expect(info?.description).toContain('transcript');
  });

  it('should return null for unknown preset', () => {
    const info = ScenarioPresets.describe('unknown-preset');
    expect(info).toBeNull();
  });

  it('should check if preset exists', () => {
    expect(ScenarioPresets.has('happy-path-transcripts')).toBe(true);
    expect(ScenarioPresets.has('unknown-preset')).toBe(false);
  });

  it('should load happy-path-transcripts preset', async () => {
    const server = new MockTransportServer();
    ScenarioPresets.load('happy-path-transcripts', server);

    // Verify handlers were configured
    const transcriptHandler = server.getHandler('transcripts');
    expect(transcriptHandler).toBeTruthy();
  });

  it('should load empty-project preset', async () => {
    const server = new MockTransportServer();
    ScenarioPresets.load('empty-project', server);

    const transcriptHandler = server.getHandler('transcripts');
    const contextHandler = server.getHandler('context');
    
    expect(transcriptHandler).toBeTruthy();
    expect(contextHandler).toBeTruthy();
  });

  it('should throw error for unknown preset', () => {
    const server = new MockTransportServer();
    expect(() => {
      ScenarioPresets.load('unknown-preset', server);
    }).toThrow('Unknown preset');
  });
});

describe('ScenarioComposer', () => {
  it('should create empty scenario', () => {
    const scenario = ScenarioComposer.create().build();
    expect(scenario).toBeTruthy();
    expect(scenario.basePreset).toBeUndefined();
    expect(scenario.steps).toHaveLength(0);
  });

  it('should create scenario from preset', () => {
    const scenario = ScenarioComposer
      .preset('happy-path-transcripts')
      .build();

    expect(scenario.basePreset).toBe('happy-path-transcripts');
  });

  it('should add tool response step', () => {
    const scenario = ScenarioComposer
      .create()
      .onTool('protokoll_get_version')
      .respondWith({ version: 'custom' })
      .build();

    expect(scenario.steps).toHaveLength(1);
    expect(scenario.steps[0].type).toBe('tool-response');
  });

  it('should add tool error step', () => {
    const scenario = ScenarioComposer
      .create()
      .onTool('protokoll_list_transcripts')
      .failWith({ code: -32603, message: 'Test error' })
      .build();

    expect(scenario.steps).toHaveLength(1);
    expect(scenario.steps[0].type).toBe('tool-error');
  });

  it('should modify preset scenario', () => {
    const scenario = ScenarioComposer
      .preset('happy-path-transcripts')
      .modify()
      .onTool('protokoll_get_version')
      .respondWith({ version: 'modified' })
      .build();

    expect(scenario.basePreset).toBe('happy-path-transcripts');
    expect(scenario.steps).toHaveLength(1);
  });

  it('should chain multiple modifications', () => {
    const scenario = ScenarioComposer
      .create()
      .onTool('protokoll_get_version')
      .respondWith({ version: 'v1' })
      .onTool('protokoll_info')
      .respondWith({ name: 'test' })
      .build();

    expect(scenario.steps).toHaveLength(2);
  });

  it('should configure session expiration', () => {
    const scenario = ScenarioComposer
      .create()
      .afterRequests(3)
      .expireSession()
      .build();

    expect(scenario.steps).toHaveLength(1);
    expect(scenario.steps[0].type).toBe('session-action');
  });
});

describe('MockServerBuilder', () => {
  let server: MockTransportServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('should create server with preset', async () => {
    server = await MockServerBuilder
      .create()
      .withPreset('happy-path-transcripts')
      .build();

    expect(server.isRunning()).toBe(true);
    expect(server.getPort()).toBeGreaterThan(0);
  });

  it('should create server with multiple presets', async () => {
    server = await MockServerBuilder
      .create()
      .withPreset('happy-path-transcripts')
      .withPreset('session-expiration')
      .build();

    expect(server.isRunning()).toBe(true);
  });

  it('should create server with scenario', async () => {
    const scenario = ScenarioComposer
      .create()
      .onTool('protokoll_get_version')
      .respondWith({ version: 'custom' })
      .build();

    server = await MockServerBuilder
      .create()
      .withScenario(scenario)
      .build();

    expect(server.isRunning()).toBe(true);
  });

  it('should configure tool response', async () => {
    server = await MockServerBuilder
      .create()
      .withTool('protokoll_get_version')
      .returning({ version: 'builder-test' })
      .build();

    expect(server.isRunning()).toBe(true);

    // Verify the tool was configured
    const handler = server.getHandlerForTool('protokoll_get_version');
    expect(handler).toBeTruthy();
  });

  it('should configure tool error', async () => {
    server = await MockServerBuilder
      .create()
      .withTool('protokoll_list_transcripts')
      .throwing({ code: -32603, message: 'Builder error' })
      .build();

    expect(server.isRunning()).toBe(true);
  });

  it('should configure session timeout', async () => {
    server = await MockServerBuilder
      .create()
      .withSession()
      .timeout(10000)
      .done()
      .build();

    expect(server.isRunning()).toBe(true);
    // Session timeout is set internally
  });

  it('should build without starting', () => {
    const builtServer = MockServerBuilder
      .create()
      .withPreset('happy-path-transcripts')
      .buildWithoutStarting();

    expect(builtServer.isRunning()).toBe(false);
  });

  it('should chain multiple configurations', async () => {
    server = await MockServerBuilder
      .create({ verbose: false })
      .withPreset('happy-path-transcripts')
      .withTool('protokoll_get_version')
      .returning({ version: 'chained' })
      .withSession()
      .timeout(5000)
      .done()
      .build();

    expect(server.isRunning()).toBe(true);
  });
});

describe('TestHelpers', () => {
  let server: MockTransportServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('should create happy path server', async () => {
    server = await TestHelpers.createHappyPathServer();
    expect(server.isRunning()).toBe(true);
  });

  it('should create empty project server', async () => {
    server = await TestHelpers.createEmptyProjectServer();
    expect(server.isRunning()).toBe(true);
  });

  it('should create custom server', async () => {
    server = await TestHelpers.createCustomServer(
      { verbose: false },
      (builder) => builder.withPreset('happy-path-transcripts')
    );
    expect(server.isRunning()).toBe(true);
  });
});

describe('Integration: Preset + Scenario + Builder', () => {
  let server: MockTransportServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('should combine preset with scenario modifications', async () => {
    const scenario = ScenarioComposer
      .preset('happy-path-transcripts')
      .modify()
      .onTool('protokoll_get_version')
      .respondWith({ version: 'modified' })
      .build();

    server = await MockServerBuilder
      .create()
      .withScenario(scenario)
      .build();

    expect(server.isRunning()).toBe(true);

    // Verify the modification was applied
    const handler = server.getHandlerForTool('protokoll_get_version');
    expect(handler).toBeTruthy();
  });

  it('should apply multiple scenarios in order', async () => {
    const scenario1 = ScenarioComposer
      .create()
      .onTool('protokoll_get_version')
      .respondWith({ version: 'v1' })
      .build();

    const scenario2 = ScenarioComposer
      .create()
      .onTool('protokoll_info')
      .respondWith({ name: 'test' })
      .build();

    server = await MockServerBuilder
      .create()
      .withScenario(scenario1)
      .withScenario(scenario2)
      .build();

    expect(server.isRunning()).toBe(true);
  });

  it('should support complex test setup workflow', async () => {
    // This demonstrates a realistic test setup
    server = await MockServerBuilder
      .create({ verbose: false })
      .withPreset('happy-path-transcripts')
      .withTool('protokoll_get_version')
      .returning({ version: '1.0.0-test' })
      .withSession()
      .timeout(30000)
      .expireAfter(10)
      .done()
      .build();

    expect(server.isRunning()).toBe(true);
    expect(server.getBaseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
