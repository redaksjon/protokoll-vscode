/**
 * Context Tool Handler
 * 
 * Handles context management tools:
 * - protokoll_context_status
 * - protokoll_list_projects
 * - protokoll_list_people
 * - protokoll_list_terms
 * - protokoll_list_companies
 * - protokoll_search_context
 * - protokoll_get_entity
 */

import type { ToolHandler } from './ToolHandler';
import type { JsonRpcError } from '../types';
import { FixtureFactory } from '../fixtures/FixtureFactory';

export class ContextToolHandler implements ToolHandler {
  readonly category = 'context';
  readonly tools = [
    'protokoll_context_status',
    'protokoll_list_projects',
    'protokoll_list_people',
    'protokoll_list_terms',
    'protokoll_list_companies',
    'protokoll_search_context',
    'protokoll_get_entity',
  ];

  private responses = new Map<string, unknown>();
  private errors = new Map<string, JsonRpcError>();
  private entityLists = new Map<string, Array<{ id: string; name: string }>>();

  constructor() {
    this.initializeDefaults();
  }

  private initializeDefaults(): void {
    // Default context status
    this.responses.set('protokoll_context_status', FixtureFactory.contextStatus({
      peopleCount: 5,
      projectsCount: 3,
      termsCount: 10,
      companiesCount: 2,
    }));

    // Default entity lists
    this.entityLists.set('projects', FixtureFactory.entityList('project', 3));
    this.entityLists.set('people', FixtureFactory.entityList('person', 5));
    this.entityLists.set('terms', FixtureFactory.entityList('term', 10));
    this.entityLists.set('companies', FixtureFactory.entityList('company', 2));

    // Default search results
    this.responses.set('protokoll_search_context', {
      results: [],
      total: 0,
    });

    // Default entity
    this.responses.set('protokoll_get_entity', FixtureFactory.entity('project'));
  }

  async handleTool(toolName: string, args: unknown): Promise<unknown> {
    void args; // Available for future use
    // Check for configured error
    const error = this.errors.get(toolName);
    if (error) {
      throw new Error(error.message);
    }

    // Handle each tool
    switch (toolName) {
      case 'protokoll_context_status':
        return this.responses.get(toolName);
      
      case 'protokoll_list_projects':
        return { projects: this.entityLists.get('projects') || [] };
      
      case 'protokoll_list_people':
        return { people: this.entityLists.get('people') || [] };
      
      case 'protokoll_list_terms':
        return { terms: this.entityLists.get('terms') || [] };
      
      case 'protokoll_list_companies':
        return { companies: this.entityLists.get('companies') || [] };
      
      case 'protokoll_search_context':
      case 'protokoll_get_entity':
        return this.responses.get(toolName);
      
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  /**
   * Set entity list for a specific type
   */
  setEntityList(type: 'projects' | 'people' | 'terms' | 'companies', entities: Array<{ id: string; name: string }>): void {
    this.entityLists.set(type, entities);
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
    this.responses.clear();
    this.errors.clear();
    this.entityLists.clear();
    this.initializeDefaults();
  }
}
