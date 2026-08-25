import { describe, expect, it } from 'vitest';
import { findPlaceholders } from '../scripts/config-placeholders.mjs';

describe('findPlaceholders', () => {
  it('returns an empty array when there are no placeholders', () => {
    expect(findPlaceholders('{"database_id": "abc123"}')).toEqual([]);
  });

  it('detects REPLACE_WITH_* placeholder tokens', () => {
    const contents =
      '{"database_id": "REPLACE_WITH_D1_DATABASE_ID", "client_id": "REPLACE_WITH_TESLA_CLIENT_ID"}';
    expect(findPlaceholders(contents)).toEqual([
      'REPLACE_WITH_D1_DATABASE_ID',
      'REPLACE_WITH_TESLA_CLIENT_ID',
    ]);
  });

  it('deduplicates repeated placeholders', () => {
    const contents = 'REPLACE_WITH_FOO REPLACE_WITH_FOO';
    expect(findPlaceholders(contents)).toEqual(['REPLACE_WITH_FOO']);
  });
});
