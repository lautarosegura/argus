export const ALLOWED_PASSTHROUGH_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
];

export interface CleanEnvOptions {
  pipePath: string;
  workspaceId: string;
  paneId: string;
}

export function buildCleanEnv(opts: CleanEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of ALLOWED_PASSTHROUGH_KEYS) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }

  env.ARGUS_PIPE = opts.pipePath;
  env.ARGUS_WORKSPACE_ID = opts.workspaceId;
  env.ARGUS_PANE_ID = opts.paneId;

  return env;
}
