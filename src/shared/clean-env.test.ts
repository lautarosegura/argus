import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildCleanEnv, ALLOWED_PASSTHROUGH_KEYS } from './clean-env.js';

describe('buildCleanEnv', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.PATH = '/usr/bin:/usr/local/bin';
    process.env.HOME = '/home/testuser';
    process.env.TEMP = '/tmp';
    process.env.TMP = '/tmp';
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('includes only allowed passthrough vars from host env', () => {
    process.env.USERPROFILE = 'C:\\Users\\test';
    const env = buildCleanEnv({ pipePath: '/tmp/argus.sock', workspaceId: 'ws-1', paneId: 'p-1' });

    expect(env.PATH).toBe('/usr/bin:/usr/local/bin');
    expect(env.HOME).toBe('/home/testuser');
    expect(env.TEMP).toBe('/tmp');
    expect(env.TMP).toBe('/tmp');
    expect(env.USERPROFILE).toBe('C:\\Users\\test');
  });

  it('injects Argus env vars', () => {
    const env = buildCleanEnv({ pipePath: '/tmp/argus.sock', workspaceId: 'ws-1', paneId: 'p-1' });

    expect(env.ARGUS_PIPE).toBe('/tmp/argus.sock');
    expect(env.ARGUS_WORKSPACE_ID).toBe('ws-1');
    expect(env.ARGUS_PANE_ID).toBe('p-1');
  });

  it('does NOT pass through ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
    const env = buildCleanEnv({ pipePath: '/tmp/argus.sock', workspaceId: 'ws-1', paneId: 'p-1' });

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('does NOT pass through OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-secret';
    const env = buildCleanEnv({ pipePath: '/tmp/argus.sock', workspaceId: 'ws-1', paneId: 'p-1' });

    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('does NOT pass through any other API-key-style env var', () => {
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    process.env.GITHUB_TOKEN = 'ghp_secret';
    process.env.SOME_RANDOM_VAR = 'should-not-leak';
    process.env.DATABASE_URL = 'postgres://secret';

    const env = buildCleanEnv({ pipePath: '/tmp/argus.sock', workspaceId: 'ws-1', paneId: 'p-1' });

    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SOME_RANDOM_VAR).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('only contains allowed passthrough keys plus Argus-injected keys', () => {
    process.env.ANTHROPIC_API_KEY = 'secret';
    process.env.OPENAI_API_KEY = 'secret';
    process.env.NODE_ENV = 'test';

    const env = buildCleanEnv({ pipePath: '/tmp/argus.sock', workspaceId: 'ws-1', paneId: 'p-1' });
    const keys = Object.keys(env);

    for (const key of keys) {
      const isAllowed = ALLOWED_PASSTHROUGH_KEYS.includes(key);
      const isArgus = key.startsWith('ARGUS_');
      expect(isAllowed || isArgus, `Unexpected key in clean env: ${key}`).toBe(true);
    }
  });

  it('omits passthrough vars that are not set in host env', () => {
    delete process.env.USERPROFILE;
    const env = buildCleanEnv({ pipePath: '/tmp/argus.sock', workspaceId: 'ws-1', paneId: 'p-1' });

    expect(env).not.toHaveProperty('USERPROFILE');
  });
});
