import { describe, it, expect } from 'vitest';
import { parseSentinelArgs } from '../../cli/commands/sentinel.js';

describe('parseSentinelArgs', () => {
  it('parses "done" with no flags', () => {
    const result = parseSentinelArgs(['done']);
    expect(result).toEqual({
      cmd: 'done',
      payload: { summary: undefined, needsReview: false },
    });
  });

  it('parses "done --summary text"', () => {
    const result = parseSentinelArgs(['done', '--summary', 'shipped auth flow']);
    expect(result).toEqual({
      cmd: 'done',
      payload: { summary: 'shipped auth flow', needsReview: false },
    });
  });

  it('parses "done --needs-review"', () => {
    const result = parseSentinelArgs(['done', '--needs-review']);
    expect(result).toEqual({
      cmd: 'done',
      payload: { summary: undefined, needsReview: true },
    });
  });

  it('parses "done --summary X --needs-review"', () => {
    const result = parseSentinelArgs(['done', '--summary', 'all tests pass', '--needs-review']);
    expect(result).toEqual({
      cmd: 'done',
      payload: { summary: 'all tests pass', needsReview: true },
    });
  });

  it('parses "blocked <reason>"', () => {
    const result = parseSentinelArgs(['blocked', 'need DB password']);
    expect(result).toEqual({
      cmd: 'blocked',
      payload: { reason: 'need DB password' },
    });
  });

  it('blocked with no reason throws', () => {
    expect(() => parseSentinelArgs(['blocked'])).toThrow(/reason is required/i);
  });

  it('parses "status <text>"', () => {
    const result = parseSentinelArgs(['status', 'running tests']);
    expect(result).toEqual({
      cmd: 'status',
      payload: { text: 'running tests' },
    });
  });

  it('status with no text throws', () => {
    expect(() => parseSentinelArgs(['status'])).toThrow(/text is required/i);
  });

  it('unknown command throws with helpful message', () => {
    expect(() => parseSentinelArgs(['foo'])).toThrow(/argus/);
  });

  it('no command throws with helpful message', () => {
    expect(() => parseSentinelArgs([])).toThrow(/argus/);
  });
});
