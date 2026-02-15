/**
 * Discovery Tool Handler
 * 
 * Handles discovery and configuration tools:
 * - protokoll_discover_config
 * - protokoll_suggest_project
 */

import { BaseToolHandler } from './BaseToolHandler';

export class DiscoveryToolHandler extends BaseToolHandler {
  readonly category = 'discovery';
  readonly tools = ['protokoll_discover_config', 'protokoll_suggest_project'];

  constructor() {
    super();
    this.initializeDefaults();
  }

  protected initializeDefaults(): void {
    this.responses.set('protokoll_discover_config', {
      found: true,
      configPath: '/mock/protokoll.yaml',
      config: {
        outputDirectory: '/mock/transcripts',
        contextDirectory: '/mock/context',
      },
    });

    this.responses.set('protokoll_suggest_project', {
      suggestions: [
        { id: 'project-1', name: 'Project 1', confidence: 0.9 },
        { id: 'project-2', name: 'Project 2', confidence: 0.7 },
      ],
    });
  }
}
