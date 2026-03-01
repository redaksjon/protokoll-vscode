import { describe, expect, it } from 'vitest';
import { resolveTranscriptToolRef } from '../src/extension';
import type { Transcript } from '../src/types';

function makeTranscript(overrides: Partial<Transcript>): Transcript {
  return {
    uri: '',
    path: '',
    filename: 'sample.pkl',
    date: '2026-02-27',
    ...overrides,
  };
}

describe('resolveTranscriptToolRef', () => {
  it('prefers canonical transcript URI when available', () => {
    const transcript = makeTranscript({
      uri: 'protokoll://transcript/2026/2/27-1234-sample',
      path: '2026/2/27-1234-sample.pkl',
    });

    expect(resolveTranscriptToolRef(transcript)).toBe(
      'protokoll://transcript/2026/2/27-1234-sample'
    );
  });

  it('falls back to transcript path when URI is missing', () => {
    const transcript = makeTranscript({
      uri: '',
      path: '2026/2/27-1234-sample.pkl',
    });

    expect(resolveTranscriptToolRef(transcript)).toBe('2026/2/27-1234-sample.pkl');
  });

  it('throws when neither URI nor path is available', () => {
    const transcript = makeTranscript({
      uri: '',
      path: '',
      filename: 'fallback-only.pkl',
    });

    expect(() => resolveTranscriptToolRef(transcript)).toThrow(
      'Transcript reference is missing for "fallback-only.pkl"'
    );
  });
});
