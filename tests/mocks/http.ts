/**
 * Mock HTTP module
 */

import { vi } from 'vitest';
import { mockHttpRequestFn } from '../helpers/httpMock';

export default {
  request: mockHttpRequestFn,
};

export const request = mockHttpRequestFn;
