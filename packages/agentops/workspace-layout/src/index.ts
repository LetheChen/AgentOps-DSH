/**
 * Canonical filesystem layout for AgentOps artifacts.
 * @module @agentops/dsh-workspace-layout
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { resolveLayout, resolvePolicy, resolveScope } from './layout.ts'
import type {
  Layout,
  LayoutPolicy,
  LayoutPolicyRequest,
  LayoutRequest,
  LayoutScope,
  LayoutScopeRequest,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceLayout: WorkspaceLayout
  }
}

/** Resolve AgentOps artifact paths within the Session workspace. */
export class WorkspaceLayout extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workspaceLayout')
  }

  /**
   * Create and return the canonical directory and file path for one artifact.
   * @param request - selected workspace, AgentOps scope, and relative artifact.
   * @returns canonical absolute directory and file paths.
   */
  async resolve(request: LayoutRequest): Promise<Layout> {
    return resolveLayout(request)
  }

  /**
   * Create and return the canonical directory for one AgentOps scope.
   * @param request - selected workspace, business id, and AgentOps scope.
   * @returns the canonical absolute scope directory.
   */
  async resolveScope(request: LayoutScopeRequest): Promise<LayoutScope> {
    return resolveScope(request)
  }

  /**
   * Create a scope directory and narrow an execution policy to it.
   * @param request - scope inputs and the deployment policy to narrow.
   * @returns the canonical scope directory and explicit execution policy.
   */
  async resolvePolicy(request: LayoutPolicyRequest): Promise<LayoutPolicy> {
    return resolvePolicy(request)
  }
}

export { LayoutError, resolveLayout, resolvePolicy, resolveScope } from './layout.ts'
export type {
  Layout,
  LayoutErrorCode,
  LayoutPolicy,
  LayoutPolicyRequest,
  LayoutRequest,
  LayoutScope,
  LayoutScopeField,
  LayoutScopeRequest,
} from './types.ts'
export default WorkspaceLayout
