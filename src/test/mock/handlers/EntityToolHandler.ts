/**
 * Entity Tool Handler
 * 
 * Handles entity CRUD operations:
 * - protokoll_add_person, protokoll_edit_person
 * - protokoll_add_project, protokoll_edit_project, protokoll_update_project
 * - protokoll_add_term, protokoll_edit_term, protokoll_update_term, protokoll_merge_terms
 * - protokoll_add_company
 * - protokoll_delete_entity
 */

import { BaseToolHandler } from './BaseToolHandler';

export class EntityToolHandler extends BaseToolHandler {
  readonly category = 'entity';
  readonly tools = [
    'protokoll_add_person',
    'protokoll_edit_person',
    'protokoll_add_project',
    'protokoll_edit_project',
    'protokoll_update_project',
    'protokoll_add_term',
    'protokoll_edit_term',
    'protokoll_update_term',
    'protokoll_merge_terms',
    'protokoll_add_company',
    'protokoll_delete_entity',
  ];

  constructor() {
    super();
    this.initializeDefaults();
  }

  protected initializeDefaults(): void {
    // Default success responses for all entity operations
    for (const tool of this.tools) {
      this.responses.set(tool, { success: true });
    }

    // Specific responses for add operations
    this.responses.set('protokoll_add_person', {
      success: true,
      id: 'mock-person-id',
    });

    this.responses.set('protokoll_add_project', {
      success: true,
      id: 'mock-project-id',
    });

    this.responses.set('protokoll_add_term', {
      success: true,
      id: 'mock-term-id',
    });

    this.responses.set('protokoll_add_company', {
      success: true,
      id: 'mock-company-id',
    });
  }
}
