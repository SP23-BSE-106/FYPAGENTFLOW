/**
 * Multi-agent orchestrator engine (implementation plan Phase 5 + Phase 6).
 *
 * Responsible for executing a workflow graph as a set of cooperating agents.
 * The initial implementation supports sequential mode: nodes are executed in
 * topological order, each receiving the original input, previous results, the
 * shared run context, and relevant messages.
 *
 * Modules it composes:
 *   - taskManager         — task lifecycle (pending → running → completed/failed)
 *   - messageBus          — structured agent-to-agent messages
 *   - contextManager      — shared run context (intermediate results, decisions)
 *   - dependencyResolver  — topological order + cycle detection
 */

import { chatCompletion } from '@/lib/llm'
import { getDb } from '@/lib/mongo/mongo'
import { ObjectId } from 'mongodb'

import { completeTask, createTask, failTask, updateTaskStatus } from './taskManager'
import { createMessage } from './messageBus'
import { getSharedContext, updateSharedContext } from './contextManager'
import { topologicalSort } from './dependencyResolver'
import type {
  AgentExecutionContext,
  NodeExecutionResult,
  OrchestrationRequest,
  OrchestrationResult,
  ResolvedNode,
} from './types'
import type { Agent } from '@/lib/mongo/agent'
import type { WorkflowGraph, WorkflowNode } from '@/lib/mongo/workflow'

/**
 * Execute one workflow run.
 *
 * Steps:
 *   1. Load the agent and its workflow graph (validate ownership).
 *   2. Create a workflow run record.
 *   3. Resolve each node to its agent, topologically sort.
 *   4. For each node: create task → execute agent → write context → emit
 *      result message → complete/fail task.
 *   5. Return the orchestration result.
 */
export async function orchestrate(request: OrchestrationRequest): Promise<OrchestrationResult> {
  const { agentId, input, userId, mode } = request
  const startedAt = Date.now()

  const db = await getDb()

  // ── 1. Load agent and workflow ───────────────────────────────────────
  const agent = (await db.collection('agents').findOne({
    _id: new ObjectId(agentId),
    userId,
  })) as unknown as Agent
  if (!agent) {
    throw new Error('Agent not found')
  }

  const graph: WorkflowGraph | null = agent.workflow ?? null
  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    throw new Error('Agent has no executable workflow graph')
  }

  // ── 2. Create the workflow run ───────────────────────────────────────
  const now = new Date()
  const runResult = await db.collection('workflow_runs').insertOne({
    userId,
    agentId,
    workflow: graph,
    input: { text: input },
    status: 'running' as const,
    mode,
    startedAt: now,
    createdAt: now,
    metadata: { mode },
  })
  const runId = String(runResult.insertedId)

  // ── 3. Resolve nodes to agents and sort topologically ────────────────
  const resolved = resolveNodes(graph.nodes, agent)
  let orderedIds: string[]
  try {
    orderedIds = topologicalSort(graph.nodes, graph.edges || [])
  } catch (error) {
    await db
      .collection('workflow_runs')
      .updateOne({ _id: runResult.insertedId, userId }, { $set: { status: 'failed' } })
    throw error
  }

  // ── 4. Shared context for this run ──────────────────────────────────
  const sharedContext = await getSharedContext(userId, runId)
  await updateSharedContext(userId, runId, { originalInput: input })

  // ── 5. Execute nodes in order ────────────────────────────────────────
  const previousResults: Record<string, unknown> = {}
  let tasksCompleted = 0
  let tasksFailed = 0
  let messagesCreated = 0
  let finalOutput: unknown = null

  for (const nodeId of orderedIds) {
    const resolvedNode = resolved.find((r) => r.node.id === nodeId)
    if (!resolvedNode) continue

    const nodeResult = await executeNode(
      userId,
      runId,
      resolvedNode,
      input,
      previousResults,
      sharedContext,
    )

    previousResults[nodeId] = nodeResult.output
    messagesCreated += nodeResult.messages?.length ?? 0

    if (nodeResult.ok) {
      tasksCompleted += 1
      // Write the node's output into shared context so downstream agents see it.
      await updateSharedContext(userId, runId, {
        intermediateResults: { [nodeId]: nodeResult.output },
      })
      finalOutput = nodeResult.output
    } else {
      tasksFailed += 1
      finalOutput = { error: nodeResult.error, failedNode: nodeId }
      // A failed node stops the sequential chain (per Phase 6 acceptance).
      break
    }
  }

  // ── 6. Finalise the run ─────────────────────────────────────────────
  const status =
    tasksFailed > 0 ? 'failed' : tasksCompleted === orderedIds.length ? 'completed' : 'failed'
  const durationMs = Date.now() - startedAt

  await db
    .collection('workflow_runs')
    .updateOne(
      { _id: runResult.insertedId, userId },
      {
        $set: {
          status,
          output: finalOutput,
          finishedAt: new Date(),
          durationMs,
        },
      },
    )

  await db.collection('execution_events').insertOne({
    userId,
    workflowRunId: runId,
    type: status === 'completed' ? 'run.completed' : 'run.failed',
    payload: { tasksCompleted, tasksFailed, messagesCreated, durationMs },
    createdAt: new Date(),
  })

  return {
    runId,
    status,
    output: finalOutput,
    tasksCompleted,
    tasksFailed,
    messagesCreated,
    durationMs,
  }
}

/** Map each workflow node to its agent (via config.agentId or the owner agent). */
function resolveNodes(
  nodes: Array<{ id: string; name: string; config?: Record<string, unknown> }>,
  ownerAgent: Agent,
): ResolvedNode[] {
  return nodes.map((node) => ({
    node: node as WorkflowNode,
    agent: ownerAgent,
  }))
}

/**
 * Execute a single node as an agent turn.
 *
 * Builds a prompt from original input, previous results, shared context and
 * relevant messages, then calls the inference provider with the agent's
 * system prompt.
 */
async function executeNode(
  userId: string,
  workflowRunId: string,
  { node, agent }: ResolvedNode,
  originalInput: string,
  previousResults: Record<string, unknown>,
  sharedContext: AgentExecutionContext['sharedContext'],
): Promise<NodeExecutionResult> {
  const start = Date.now()

  // Create the task record.
  const task = await createTask({
    userId,
    workflowRunId,
    agentId: agent?._id ?? 'system',
    title: node.name,
    description: node.description || '',
    input: previousResults,
  })

  await updateTaskStatus(String(task._id), userId, workflowRunId, {
    status: 'running',
    startedAt: true,
  })

  try {
    const system = buildSystemPrompt(node, agent)
    const prompt = buildUserPrompt({
      originalInput,
      previousResults,
      sharedContext,
      node,
    })

    const completion = await chatCompletion({
      system,
      prompt,
      maxTokens: agent?.maxTokenBudget ?? 2048,
      temperature: 0.4,
      timeoutMs: 30_000,
    })

    if (!completion.ok) {
      const error = `No inference provider answered: ${completion.failures?.map((f) => f.message).join('; ') || 'unknown'}`
      await failTask(String(task._id), userId, workflowRunId, error)
      await createMessage({
        userId,
        workflowId: workflowRunId,
        workflowRunId,
        fromAgentId: agent?._id ?? 'system',
        toAgentId: undefined,
        taskId: String(task._id),
        type: 'error',
        text: error,
        priority: 'high',
      })
      return {
        nodeId: node.id,
        ok: false,
        error,
        durationMs: Date.now() - start,
        provider: null,
        model: null,
      }
    }

    const output = completion.text

    // Write result into shared context and emit a result message.
    await updateSharedContext(userId, workflowRunId, {
      intermediateResults: { [node.id]: output },
    })

    await createMessage({
      userId,
      workflowId: workflowRunId,
      workflowRunId,
      fromAgentId: agent?._id ?? 'system',
      toAgentId: undefined,
      taskId: String(task._id),
      type: 'result',
      text: output,
      payload: { nodeId: node.id, provider: completion.provider, model: completion.model },
    })

    await completeTask(String(task._id), userId, workflowRunId, output)

    return {
      nodeId: node.id,
      ok: true,
      output,
      durationMs: Date.now() - start,
      provider: completion.provider,
      model: completion.model,
      messages: [],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await failTask(String(task._id), userId, workflowRunId, message)
    return {
      nodeId: node.id,
      ok: false,
      error: message,
      durationMs: Date.now() - start,
      provider: null,
      model: null,
    }
  }
}

/** Build the system prompt from the agent config or node config. */
function buildSystemPrompt(node: WorkflowNode, agent: Agent | null): string {
  if (agent?.systemPrompt && agent.systemPrompt.trim()) {
    return agent.systemPrompt.trim()
  }
  if (typeof node.config?.systemPrompt === 'string' && node.config.systemPrompt.trim()) {
    return node.config.systemPrompt.trim()
  }
  return `You are the "${node.name || 'Agent'}" node in an AgentFlow workflow. Answer naturally and helpfully.`
}

/** Build the user prompt from the execution context (Phase 6 input shape). */
function buildUserPrompt(ctx: {
  originalInput: string
  previousResults: Record<string, unknown>
  sharedContext: AgentExecutionContext['sharedContext']
  node: WorkflowNode
}): string {
  const parts: string[] = []

  parts.push(`Original request: ${ctx.originalInput}`)

  if (ctx.sharedContext.variables && Object.keys(ctx.sharedContext.variables).length > 0) {
    parts.push(`\nContext variables:\n${JSON.stringify(ctx.sharedContext.variables, null, 2)}`)
  }

  const prior = Object.entries(ctx.previousResults)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([nodeId, output]) => `Result from "${nodeId}":\n${String(output)}`)
  if (prior.length > 0) {
    parts.push(`\nPrevious results:\n${prior.join('\n\n---\n\n')}`)
  }

  if (ctx.sharedContext.intermediateResults && Object.keys(ctx.sharedContext.intermediateResults).length > 0) {
    parts.push(`\nIntermediate results:\n${JSON.stringify(ctx.sharedContext.intermediateResults, null, 2)}`)
  }

  parts.push(`\nCurrent node: "${ctx.node.name}" (${ctx.node.type})`)
  parts.push(`Description: ${ctx.node.description || '(none)'}`)

  return parts.join('\n')
}
