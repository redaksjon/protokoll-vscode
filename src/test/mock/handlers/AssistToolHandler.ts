/**
 * Assist Tool Handler
 * 
 * Handles smart assistance tools:
 * - protokoll_suggest_project_metadata
 * - protokoll_suggest_term_metadata
 */

import { BaseToolHandler } from './BaseToolHandler';

export class AssistToolHandler extends BaseToolHandler {
  readonly category = 'assist';
  readonly tools = [
    'protokoll_suggest_project_metadata',
    'protokoll_suggest_term_metadata',
  ];

  constructor() {
    super();
    this.initializeDefaults();
  }

  protected initializeDefaults(): void {
    this.responses.set('protokoll_suggest_project_metadata', {
      suggestions: {
        description: 'Suggested project description',
        tags: ['tag1', 'tag2'],
      },
    });

    this.responses.set('protokoll_suggest_term_metadata', {
      suggestions: {
        definition: 'Suggested term definition',
        relatedTerms: ['term1', 'term2'],
      },
    });
  }
}
