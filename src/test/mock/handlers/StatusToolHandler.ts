/**
 * Status Tool Handler
 * 
 * Handles lifecycle status and task tools:
 * - protokoll_set_status
 * - protokoll_create_task
 * - protokoll_complete_task
 * - protokoll_delete_task
 */

import { BaseToolHandler } from './BaseToolHandler';
import { FixtureFactory } from '../fixtures/FixtureFactory';

export class StatusToolHandler extends BaseToolHandler {
  readonly category = 'status';
  readonly tools = [
    'protokoll_set_status',
    'protokoll_create_task',
    'protokoll_complete_task',
    'protokoll_delete_task',
  ];

  constructor() {
    super();
    this.initializeDefaults();
  }

  protected initializeDefaults(): void {
    this.responses.set('protokoll_set_status', {
      success: true,
      newStatus: 'enhanced',
    });

    this.responses.set('protokoll_create_task', {
      success: true,
      task: FixtureFactory.task(),
    });

    this.responses.set('protokoll_complete_task', { success: true });
    this.responses.set('protokoll_delete_task', { success: true });
  }
}
