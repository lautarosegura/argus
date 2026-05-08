export interface AgentRatioEntry {
  cli: string;
  count: number;
}

export interface PaneState {
  paneId: string;
  role: 'lead' | 'worker' | 'merge';
  cli: string;
  worktreeRelPath: string;
  branchName: string;
  userClosed: boolean;
  lastKnownState: string;
}

export interface PlanState {
  path: string;
  approvedAt: string | null;
}

export interface WorkspaceState {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  repoPath: string;
  agentRatio: AgentRatioEntry[];
  panes: PaneState[];
  plan: PlanState | null;
  mergeState: unknown | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  createdAt: string;
  repoPath: string;
  agentRatio: AgentRatioEntry[];
  paneCount: number;
}

export interface CreateWorkspaceParams {
  name: string;
  agentRatio: AgentRatioEntry[];
  repoPath: string;
  plan?: string;
}

export const CURRENT_SCHEMA_VERSION = 1;
