/**
 * Mock HTTPS module
 */

import { vi } from 'vitest';
import { mockHttpsRequestFn } from '../helpers/httpMock';

export default {
  request: mockHttpsRequestFn,
};

export const request = mockHttpsRequestFn;
