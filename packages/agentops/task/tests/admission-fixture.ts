import type {
  Actor,
  CandidateAdmissionResult,
  TaskRecord,
  TaskService,
} from '../src/service.ts'

export const ADMISSION_USER: Actor = { type: 'user', name: 'pm' }

export interface AdmitCandidateOptions {
  readonly projectId: string
  readonly title: string
  readonly lifecycleMode?: 'p0' | 'v1'
  readonly actor?: Actor
  readonly candidateId?: string
  readonly riskLevel?: 'low' | 'medium' | 'high'
  readonly complexity?: 'simple' | 'medium' | 'complex'
}

/**
 * Run the shortest valid Candidate admission path for tests.
 * The version sequence is capture v0 -> analyze v1 -> analyze v2 -> snapshot v3
 * -> approve Candidate v4 / Task v0.
 */
export function admitCandidate(service: TaskService, options: AdmitCandidateOptions): CandidateAdmissionResult {
  const actor = options.actor ?? ADMISSION_USER
  const candidate = service.captureCandidate({
    projectId: options.projectId,
    title: options.title,
    actor,
    ...(options.candidateId === undefined ? {} : { candidateId: options.candidateId }),
    ...(options.riskLevel === undefined ? {} : { riskLevel: options.riskLevel }),
    ...(options.complexity === undefined ? {} : { complexity: options.complexity }),
  })
  service.analyzeCandidate({
    candidateId: candidate.candidateId,
    ifVersion: 0,
    actor,
    analysisProblem: options.title,
    analysisDeliverables: options.title,
    acceptanceCriteria: [{ description: `${options.title} accepted` }],
  })
  service.analyzeCandidate({
    candidateId: candidate.candidateId,
    ifVersion: 1,
    actor,
    analysisNonGoals: '',
    dependencies: [],
  })
  service.createAdmissionSnapshot({
    candidateId: candidate.candidateId,
    ifVersion: 2,
    actor,
    query: {},
    searchCoverage: 'complete',
  })

  const awaiting = service.getCandidate(candidate.candidateId)
  return service.approveCandidateGate({
    candidateId: candidate.candidateId,
    ifVersion: awaiting.version,
    actor,
    ...(options.lifecycleMode === undefined ? {} : { lifecycleMode: options.lifecycleMode }),
  })
}

/** Admit a Candidate and legally advance the Task to the requested status. */
export function createAdmittedTask(
  service: TaskService,
  options: AdmitCandidateOptions & { readonly status?: string },
): TaskRecord {
  const result = admitCandidate(service, options)
  const target = options.status
  if (target === undefined || target === result.task.status) return result.task

  const actor = options.actor ?? ADMISSION_USER
  let task = result.task
  const advance = (to: string): void => {
    task = service.advance({ taskId: task.taskId, to, ifVersion: task.version, actor })
  }

  if (result.task.lifecycleMode === 'p0') {
    const path: Record<string, readonly string[]> = {
      idea: [],
      backlog: ['backlog'],
      discussing: ['backlog', 'discussing'],
      reviewing: ['backlog', 'discussing', 'reviewing'],
      closed: ['backlog', 'discussing', 'reviewing', 'closed'],
    }
    const statusPath = path[target]
    if (statusPath === undefined) throw new Error(`unsupported P0 test target ${target}`)
    for (const status of statusPath) advance(status)
    return task
  }

  const path: Record<string, readonly string[]> = {
    discussing: [],
    decomposing: ['decomposing'],
    reviewing: ['decomposing', 'reviewing'],
    backlog: ['decomposing', 'reviewing', 'backlog'],
    in_progress: ['decomposing', 'reviewing', 'backlog', 'in_progress'],
    validating: ['decomposing', 'reviewing', 'backlog', 'validating'],
    closing: ['decomposing', 'reviewing', 'backlog', 'validating', 'closing'],
    blocked: ['decomposing', 'reviewing', 'backlog', 'in_progress', 'blocked'],
    paused: ['decomposing', 'reviewing', 'backlog', 'in_progress', 'paused'],
    failed: ['decomposing', 'reviewing', 'backlog', 'in_progress', 'failed'],
    canceled: ['canceled'],
    abandoned: ['abandoned'],
  }
  const statusPath = path[target]
  if (statusPath === undefined) throw new Error(`unsupported V1 test target ${target}`)
  for (const status of statusPath) advance(status)
  return task
}
