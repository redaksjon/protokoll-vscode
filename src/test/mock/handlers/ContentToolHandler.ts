/**
 * Content Tool Handler
 * 
 * Handles content management tools:
 * - protokoll_add_content
 * - protokoll_remove_content
 * - protokoll_list_content
 * - protokoll_get_content
 */

import { BaseToolHandler } from './BaseToolHandler';

export class ContentToolHandler extends BaseToolHandler {
  readonly category = 'content';
  readonly tools = [
    'protokoll_add_content',
    'protokoll_remove_content',
    'protokoll_list_content',
    'protokoll_get_content',
  ];

  constructor() {
    super();
    this.initializeDefaults();
  }

  protected initializeDefaults(): void {
    this.responses.set('protokoll_add_content', {
      success: true,
      contentId: 'mock-content-id',
    });

    this.responses.set('protokoll_remove_content', { success: true });
    
    this.responses.set('protokoll_list_content', {
      content: [],
    });

    this.responses.set('protokoll_get_content', {
      id: 'mock-content-id',
      type: 'note',
      text: 'Mock content text',
    });
  }
}
