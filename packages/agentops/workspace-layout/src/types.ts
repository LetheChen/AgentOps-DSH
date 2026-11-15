import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

/** Stable failure categories returned by workspace layout resolution. */
export type LayoutErrorCode =
  | 'ARTIFACT_PATH_REJECTED'
  | 'BUSINESS_ID_REJECTED'
  | 'SCOPE_ID_REJECTED'
  | 'SESSION_CWD_REJECTED'
  | 'ESCAPES_WORKSPACE'

/** Path components that identify an AgentOps scope. */
export type LayoutScopeField = 'agentId' | 'workflowId' | 'runId' | 'nodeId'

/** One artifact request within a selected workspace. */
export interface LayoutRequest {
  /** Session workspace selected before the conversation starts. */
  readonly sessionCwd: string
  readonly businessId: string
  readonly scope:
    | { readonly kind: 'agent'; readonly agentId: string }
    | {
      readonly kind: 'workflow'
      readonly workflowId: string
      readonly runId: string
      readonly nodeId?: string
    }
  /** A file name or restricted relative path chosen by the caller. */
  readonly artifact: string
}

/** A selected workspace and AgentOps scope without an artifact. */
export type LayoutScopeRequest = Omit<LayoutRequest, 'artifact'>

/** A created AgentOps scope directory. */
export interface LayoutScope {
  /** Canonical absolute directory, created by the resolver. */
  readonly dir: string
}

/** A created target directory and its artifact path. */
export interface Layout {
  /** Canonical absolute directory, created by the resolver. */
  readonly dir: string
  /** Absolute path formed from the canonical directory and artifact. */
  readonly file: string
}

/** One explicit execution policy derived from a workspace baseline. */
export interface LayoutPolicyRequest {
  readonly scopeRequest: LayoutScopeRequest
  readonly baselinePolicy: SandboxExecutionPolicy
}

/** A scope directory and the explicit execution policy narrowed to it. */
export interface LayoutPolicy {
  /** Canonical scope directory; also the policy workspace root. */
  readonly cwd: string
  /** Explicit policy without deployment-wide extra writable roots. */
  readonly policy: SandboxExecutionPolicy
}
