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

export type MergePhase = 'tagging' | 'merging' | 'resolving' | 'testing' | 'complete' | 'reverted';

export interface MergeRunState {
  mergeRunId: string;
  phase: MergePhase;
  preMergeTag: string;
  branchOrder: string[];
  mergedBranches: string[];
  verifyCommand: string;
  startedAt: string;
  completedAt: string | null;
  error?: string;
}

export interface WorkspaceState {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  repoPath: string;
  intent: string;
  agentRatio: AgentRatioEntry[];
  panes: PaneState[];
  plan: PlanState | null;
  mergeState: MergeRunState | null;
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
  intent?: string;
  plan?: string;
}

export const CURRENT_SCHEMA_VERSION = 1;
