import { describe, it, expect } from 'vitest';
import { checkCliInPath, checkCliVersion, checkDaemonPipe, type CheckResult } from './doctor.js';

describe('doctor checks', () => {
  describe('checkCliInPath', () => {
    it('returns PASS when CLI is found in PATH', async () => {
      const result = await checkCliInPath('node', {
        which: async () => '/usr/bin/node',
      });
      expect(result.status).toBe('PASS');
      expect(result.name).toContain('node');
    });

    it('returns FAIL when CLI is missing from PATH', async () => {
      const result = await checkCliInPath('nonexistent-cli-xyz', {
        which: async () => null,
      });
      expect(result.status).toBe('FAIL');
      expect(result.remediation).toBeDefined();
      expect(result.remediation!.length).toBeGreaterThan(0);
    });
  });

  describe('checkCliVersion', () => {
    it('returns PASS when version command succeeds', async () => {
      const result = await checkCliVersion('claude', {
        runVersion: async () => ({ ok: true, output: 'claude 1.0.0' }),
      });
      expect(result.status).toBe('PASS');
      expect(result.detail).toContain('claude 1.0.0');
    });

    it('returns FAIL when version command fails', async () => {
      const result = await checkCliVersion('claude', {
        runVersion: async () => ({ ok: false, output: 'auth error: not logged in' }),
      });
      expect(result.status).toBe('FAIL');
      expect(result.remediation).toBeDefined();
      expect(result.remediation).toContain('login');
    });
  });

  describe('checkDaemonPipe', () => {
    it('returns PASS when pipe is reachable', async () => {
      const result = await checkDaemonPipe({
        connect: async () => ({ connected: true, autoSpawned: false }),
      });
      expect(result.status).toBe('PASS');
      expect(result.detail).toContain('reachable');
    });

    it('returns PASS with note when daemon was auto-spawned', async () => {
      const result = await checkDaemonPipe({
        connect: async () => ({ connected: true, autoSpawned: true }),
      });
      expect(result.status).toBe('PASS');
      expect(result.detail).toContain('auto-spawned');
    });

    it('returns FAIL when pipe is unreachable even after auto-spawn', async () => {
      const result = await checkDaemonPipe({
        connect: async () => ({ connected: false, autoSpawned: false }),
      });
      expect(result.status).toBe('FAIL');
      expect(result.remediation).toBeDefined();
    });
  });

  describe('CheckResult shape', () => {
    it('every FAIL includes a non-empty remediation string', async () => {
      const fails: CheckResult[] = [
        await checkCliInPath('missing-cli', { which: async () => null }),
        await checkCliVersion('claude', { runVersion: async () => ({ ok: false, output: 'err' }) }),
        await checkDaemonPipe({ connect: async () => ({ connected: false, autoSpawned: false }) }),
      ];

      for (const f of fails) {
        expect(f.status).toBe('FAIL');
        expect(f.remediation).toBeDefined();
        expect(f.remediation!.length).toBeGreaterThan(0);
      }
    });
  });
});
