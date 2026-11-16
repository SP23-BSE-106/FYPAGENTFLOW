/**
 * Shared types for the multi-agent orchestration engine (implementation plan
 * Phase 5 + Phase 6).
 *
 * These describe the request/result contract and the per-node execution
 * context passed to every agent during a workflow run.
 */

import type { Agent } from '@/lib/mongo/agent'
import type { AgentMessage } from '@/lib/mongo/agentMessages'
import type { SharedContext } from '@/lib/mongo/sharedContexts'
import type { WorkflowNode } from '@/lib/mongo/workflow'

export type OrchestrationMode = 'sequential' | 'parallel' | 'supervisor'

export type OrchestrationRequest = {
  /** Agent that owns the workflow graph to execute. */
  agentId: string
  /** Original user request. */
  input: string
  userId: string
  mode: OrchestrationMode
}

export type OrchestrationResult = {
  runId: string
  status: 'completed' | 'failed' | 'paused' | 'cancelled'
  output?: unknown
  tasksCompleted: number
  tasksFailed: number
  messagesCreated: number
  durationMs: number
}

export type AgentExecutionContext = {
  workflowRunId: string
  /** The original user request that started the run. */
  originalInput: string
  /** Outputs keyed by the node id that produced them. */
  previousResults: Record<string, unknown>
  /** Shared run-level context readable/writable by every agent. */
  sharedContext: SharedContext
  /** Messages emitted so far in this run, newest last. */
  relevantMessages: AgentMessage[]
  /** Agent responsible for the current node. */
  agent: Agent | null
  /** Workflow node being executed. */
  node: WorkflowNode
}

export type NodeExecutionResult = {
  nodeId: string
  ok: boolean
  output?: unknown
  error?: string
  durationMs: number
  provider?: string | null
  model?: string | null
  /** Messages emitted during this node's execution. */
  messages?: Array<Omit<AgentMessage, '_id' | 'userId' | 'workflowId' | 'workflowRunId' | 'createdAt'>>
}

export type ResolvedNode = {
  node: WorkflowNode
  agent: Agent | null
}
