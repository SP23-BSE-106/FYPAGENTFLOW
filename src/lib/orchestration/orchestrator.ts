/**
 * Multi-agent orchestrator engine (implementation plan Phase 5 + Phase 6).
 *
 * Responsible for executing a workflow graph as a set of cooperating agents.
 * Supports three modes:
 *   - sequential: nodes execute one after another in topological order.
 *   - parallel: independent branches run concurrently with bounded
 *     concurrency; aggregator nodes wait for all their dependencies.
 *   - supervisor: a supervisor agent generates a structured execution plan
 *     from a natural-language request, then executes it.
 *
 * Modules it composes:
 *   - taskManager         — task lifecycle (pending → running → completed/failed)
 *   - messageBus          — structured agent-to-agent messages
 *   - contextManager      — shared run context (intermediate results, decisions)
 *   - dependencyResolver  — topological order + cycle detection
 *   - scheduler           — bounded-concurrency parallel execution
 *   - supervisor          — plan generation, validation, execution
 */

import { chatCompletion } from '@/lib/llm'
import { getDb } from '@/lib/mongo/mongo'
import { ObjectId } from 'mongodb'
import { getExecutionBudget } from '@/lib/permissions'

import { completeTask, createTask, failTask, updateTaskStatus } from './taskManager'
import { createMessage } from './messageBus'
import { getSharedContext, updateSharedContext } from './contextManager'
import { topologicalSort } from './dependencyResolver'
import { scheduleParallel, type SchedulerConfig } from './scheduler'
import {
  executeSupervisorPlan,
  generateSupervisorPlan,
  listAvailableAgents,
  validateSupervisorPlan,
} from './supervisor'
import {
  decideRecovery,
  DEFAULT_RETRY_POLICY,
  evaluateTaskOutput,
  isReviewExhausted,
  retryTaskWithFeedback,
} from './evaluator'
import {
  createApprovalRequest,
} from './approvalManager'
import type {
  AgentExecutionContext,
  NodeExecutionResult,
  OrchestrationRequest,
  OrchestrationResult,
  ResolvedNode,
} from './types'
import type { Agent } from '@/lib/mongo/agent'
import type { AgentTask } from '@/lib/mongo/agentTasks'
import type { WorkflowGraph, WorkflowNode } from '@/lib/mongo/workflow'

/**
 * Default scheduler configuration for parallel runs.
 */
const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxConcurrentTasks: 5,
  maxRunDurationMs: 300_000, // 5 minutes
  maxMessagesPerRun: 500,
}

/**
 * Execute one workflow run.
 *
 * Steps:
 *   1. Load the agent and its workflow graph (validate ownership).
 *   2. Create a workflow run record.
 *   3. Resolve each node to its agent, topologically sort (cycle check).
 *   4. Sequential mode: execute nodes one at a time in topological order.
 *   5. Parallel mode: create all tasks up front, then run them through the
 *      bounded-concurrency scheduler.
 *   6. Return the orchestration result.
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
  const budget = await getExecutionBudget(userId)
  if (graph.nodes.length > budget.maxTasksPerRun) {
    throw new Error(
      `Workflow exceeds the maximum of ${budget.maxTasksPerRun} tasks per run`,
    )
  }

  // ── Find a critic / fact-checker agent for quality evaluation (Phase 9) ──
  const allAgents = await db
    .collection('agents')
    .find({ userId }, { projection: { userApiKey: 0 } })
    .toArray() as unknown as Agent[]
  const criticAgent =
    allAgents.find(
      (a) =>
        (a.role || '').toLowerCase() === 'critic' ||
        (a.role || '').toLowerCase() === 'fact_checker',
    ) || null

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

  // ── 3. Resolve nodes to agents and validate graph ────────────────────
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
  const isCancelled = async () =>
    Boolean(
      await db.collection('workflow_runs').findOne({
        _id: runResult.insertedId,
        userId,
        status: 'cancelled',
      }),
    )

  // ── 5. Execute nodes ────────────────────────────────────────────────
  const previousResults: Record<string, unknown> = {}
  let tasksCompleted = 0
  let tasksFailed = 0
  let messagesCreated = 0
  let finalOutput: unknown = null

  if (mode === 'parallel') {
    const result = await executeParallel(
      userId,
      runId,
      resolved,
      orderedIds,
      graph.edges || [],
      input,
      previousResults,
      sharedContext,
      budget,
      () =>
        db.collection('agent_messages').countDocuments({ userId, workflowRunId: runId }),
      isCancelled,
    )
    tasksCompleted = result.completed
    tasksFailed = result.failed
    messagesCreated = result.messagesCreated
    finalOutput = result.finalOutput
  } else if (mode === 'supervisor') {
    const supervisorResult = await executeSupervisorMode(
      userId,
      runId,
      agent,
      input,
    )
    tasksCompleted = supervisorResult.completed
    tasksFailed = supervisorResult.failed
    messagesCreated = supervisorResult.messagesCreated
    finalOutput = supervisorResult.finalOutput
  } else {
    // Sequential mode (Phase 6) with evaluation + recovery (Phase 9 + 10)
    // and human approval checkpoints (Phase 11).
    for (const nodeId of orderedIds) {
      if (await isCancelled()) {
        finalOutput = { error: 'Workflow cancelled' }
        break
      }
      if (Date.now() - startedAt >= budget.maxRunDurationMs) {
        finalOutput = { error: 'Execution duration budget exceeded' }
        break
      }
      const currentMessageCount = await db.collection('agent_messages').countDocuments({
        userId,
        workflowRunId: runId,
      })
      if (currentMessageCount >= budget.maxMessagesPerRun) {
        finalOutput = { error: 'Execution message budget exceeded' }
        break
      }
      const resolvedNode = resolved.find((r) => r.node.id === nodeId)
      if (!resolvedNode) continue

      // ── Skip already-completed tasks (resume after approval pause) ──
      const existingTask = await db
        .collection('agent_tasks')
        .find({ userId, workflowRunId: runId, title: resolvedNode.node.name })
        .sort({ createdAt: -1 })
        .limit(1)
        .toArray()
        .then((rows) => rows[0])

      if (existingTask && existingTask.status === 'completed') {
        previousResults[nodeId] = existingTask.output
        continue
      }

      // ── Human approval checkpoint (Phase 11) ────────────────────────
      if (resolvedNode.agent?.humanApprovalRequired) {
        // If there's already a pending approval for this task, wait for it.
        const pending = await db
          .collection('approval_requests')
          .findOne({
            userId,
            workflowRunId: runId,
            taskId: existingTask?._id ?? '',
            status: 'pending',
          })

        if (!pending && existingTask?._id) {
          // Create the approval request and pause the run.
          await createApprovalRequest({
            userId,
            workflowRunId: runId,
            taskId: String(existingTask._id),
            requestedByAgentId: resolvedNode.agent._id,
            title: `Approve output from "${resolvedNode.node.name}"`,
            description: resolvedNode.node.description || 'Human approval required before this agent output is used.',
            payload: { nodeId, previousResults },
          })

          await db
            .collection('workflow_runs')
            .updateOne(
              { _id: runResult.insertedId, userId },
              { $set: { status: 'paused', updatedAt: new Date() } },
            )

          return {
            runId,
            status: 'paused',
            output: finalOutput,
            tasksCompleted,
            tasksFailed,
            messagesCreated,
            durationMs: Date.now() - startedAt,
          }
        }

        if (pending) {
          // Run is paused waiting for this approval; stop here.
          return {
            runId,
            status: 'paused',
            output: finalOutput,
            tasksCompleted,
            tasksFailed,
            messagesCreated,
            durationMs: Date.now() - startedAt,
          }
        }
      }

      // ── Execute the node (returns taskId for retry/recovery) ─────────
      const { taskId, result: nodeResult } = await executeTaskBodyWithId(
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
        // ── Critic evaluation (Phase 9) ─────────────────────────────
        if (criticAgent && nodeResult.output) {
          const reviewCycle = 0
          const evaluation = await evaluateTaskOutput(
            userId,
            runId,
            taskId,
            criticAgent,
            nodeResult.output,
            input,
            reviewCycle,
          )
          messagesCreated += 1

          if (!evaluation.passed && !isReviewExhausted(reviewCycle)) {
            // Revise based on critic feedback (max review cycles enforced).
            const revision = await retryTaskWithFeedback(
              taskId,
              userId,
              runId,
              resolvedNode.agent,
              evaluation.feedback,
              input,
              previousResults,
            )

            if (revision.ok) {
              previousResults[nodeId] = revision.output
              messagesCreated += 1
              await updateSharedContext(userId, runId, {
                intermediateResults: { [nodeId]: revision.output },
              })
              finalOutput = revision.output
              tasksCompleted += 1
              continue
            } else {
              // Revision failed — fall through to failure handling.
              tasksFailed += 1
              finalOutput = {
                error: revision.error,
                failedNode: nodeId,
                evaluation: { passed: false, scores: evaluation.scores },
              }
              break
            }
          } else if (!evaluation.passed) {
            // Review cycles exhausted.
            tasksFailed += 1
            finalOutput = {
              error: 'Review cycles exhausted',
              failedNode: nodeId,
              evaluation: { passed: false, scores: evaluation.scores },
            }
            break
          }
        }

        tasksCompleted += 1
        await updateSharedContext(userId, runId, {
          intermediateResults: { [nodeId]: nodeResult.output },
        })
        finalOutput = nodeResult.output
      } else {
        // ── Failure recovery (Phase 10) ─────────────────────────────
        const taskForRecovery: AgentTask = {
          _id: taskId,
          userId,
          workflowRunId: runId,
          agentId: resolvedNode.agent?._id ?? 'system',
          title: resolvedNode.node.name,
          description: resolvedNode.node.description || '',
          input: previousResults,
          status: 'failed',
          dependsOnTaskIds: [],
          retryCount: 0,
          maxRetries: resolvedNode.agent?.maxRetryCount ?? 3,
          createdAt: new Date(),
          updatedAt: new Date(),
          error: nodeResult.error,
        }

        const recovery = decideRecovery(
          taskForRecovery,
          nodeResult.error ?? 'Unknown error',
          DEFAULT_RETRY_POLICY,
        )

        if (recovery.action === 'retry' || recovery.action === 'fallback') {
          // Retry the same task (or fallback agent/model).
          const fallbackAgent =
            recovery.action === 'fallback' && recovery.fallbackAgentId
              ? allAgents.find((a) => String(a._id) === recovery.fallbackAgentId) ??
                resolvedNode.agent
              : resolvedNode.agent

          const retryResult = await retryTaskWithFeedback(
            taskId,
            userId,
            runId,
            fallbackAgent,
            [nodeResult.error ?? 'Unknown error'],
            input,
            previousResults,
          )

          if (retryResult.ok) {
            previousResults[nodeId] = retryResult.output
            messagesCreated += 1
            await updateSharedContext(userId, runId, {
              intermediateResults: { [nodeId]: retryResult.output },
            })
            finalOutput = retryResult.output
            tasksCompleted += 1
            continue
          } else {
            tasksFailed += 1
            finalOutput = {
              error: retryResult.error,
              failedNode: nodeId,
            }
            break
          }
        } else {
          tasksFailed += 1
          finalOutput = {
            error: recovery.reason ?? nodeResult.error,
            failedNode: nodeId,
          }
          // A failed node stops the sequential chain (per Phase 6 acceptance).
          break
        }
      }
    }
  }

  // ── 6. Finalise the run ─────────────────────────────────────────────
  const status =
    (await isCancelled())
      ? 'cancelled'
      : tasksFailed > 0
        ? 'failed'
        : tasksCompleted === orderedIds.length
          ? 'completed'
          : 'failed'
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
    payload: { tasksCompleted, tasksFailed, messagesCreated, durationMs, mode },
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

/**
 * Execute all nodes in parallel with bounded concurrency.
 *
 * All tasks are created up front with their `dependsOnTaskIds` derived from
 * the workflow edges. The scheduler then runs eligible tasks concurrently,
 * respecting the concurrency limit and run-level timeout.
 */
async function executeParallel(
  userId: string,
  workflowRunId: string,
  resolved: ResolvedNode[],
  orderedIds: string[],
  edges: Array<{ source: string; target: string; label?: string }>,
  originalInput: string,
  previousResults: Record<string, unknown>,
  sharedContext: AgentExecutionContext['sharedContext'],
  budget: {
    maxRunDurationMs: number
    maxMessagesPerRun: number
  },
  getMessageCount: () => Promise<number>,
  isCancelled: () => Promise<boolean>,
): Promise<{
  completed: number
  failed: number
  messagesCreated: number
  finalOutput: unknown
}> {
  // ── 5a. Create all tasks up front (in topological order so dependencies
  //      already exist when we wire dependsOnTaskIds) ──────────────────
  const taskIdByNodeId = new Map<string, string>()

  for (const nodeId of orderedIds) {
    const resolvedNode = resolved.find((r) => r.node.id === nodeId)
    if (!resolvedNode) continue

    const { node, agent } = resolvedNode

    // Gather the task IDs of this node's dependencies (incoming edges).
    const dependsOnTaskIds: string[] = []
    for (const edge of edges) {
      if (edge.target === node.id) {
        const depTaskId = taskIdByNodeId.get(edge.source)
        if (depTaskId) dependsOnTaskIds.push(depTaskId)
      }
    }

    const task = await createTask({
      userId,
      workflowRunId,
      agentId: agent?._id ?? 'system',
      title: node.name,
      description: node.description || '',
      input: {},
      dependsOnTaskIds,
      maxRetries: 3,
    })

    taskIdByNodeId.set(node.id, String(task._id))
  }

  // ── 5c. Build schedulable tasks ────────────────────────────────────
  const schedulableTasks = resolved.map(({ node, agent }) => {
    const taskId = taskIdByNodeId.get(node.id)!
    // Collect the task IDs this node depends on (from incoming edges).
    const dependsOnTaskIds: string[] = []
    for (const edge of edges) {
      if (edge.target === node.id) {
        const depTaskId = taskIdByNodeId.get(edge.source)
        if (depTaskId) dependsOnTaskIds.push(depTaskId)
      }
    }

    return {
      id: taskId,
      dependsOnTaskIds,
      execute: async () => {
        return runNodeExecution(
          taskId,
          userId,
          workflowRunId,
          { node, agent },
          originalInput,
          previousResults,
          sharedContext,
        )
      },
    }
  })

  // ── 5d. Run through bounded-concurrency scheduler ──────────────────
  const schedule = await scheduleParallel(schedulableTasks, {
    ...DEFAULT_SCHEDULER_CONFIG,
    maxRunDurationMs: budget.maxRunDurationMs,
    maxMessagesPerRun: budget.maxMessagesPerRun,
    getMessageCount,
    isCancelled,
  })

  // ── 5e. Collect results into previousResults ───────────────────────
  let messagesCreated = 0
  let finalOutput: unknown = null

  for (const { node } of resolved) {
    const taskId = taskIdByNodeId.get(node.id)!
    const result = schedule.results.get(taskId)
    if (!result) continue

    messagesCreated += result.messages?.length ?? 0
    previousResults[node.id] = result.output

    if (result.ok) {
      finalOutput = result.output
    } else {
      finalOutput = { error: result.error, failedNode: node.id }
    }
  }

  return {
    completed: schedule.completed,
    failed: schedule.failed + schedule.cancelled.length,
    messagesCreated,
    finalOutput,
  }
}

/**
 * Supervisor mode: generate a plan from the natural-language request,
 * validate it, then execute the tasks via the bounded-concurrency scheduler.
 */
async function executeSupervisorMode(
  userId: string,
  workflowRunId: string,
  agent: Agent,
  input: string,
): Promise<{
  completed: number
  failed: number
  messagesCreated: number
  finalOutput: unknown
}> {
  // ── List available agents for plan selection ───────────────────────
  const agentSummaries = await listAvailableAgents(userId)

  // ── Generate the plan ──────────────────────────────────────────────
  const plan = await generateSupervisorPlan(userId, input, agentSummaries)

  // ── Validate the plan ──────────────────────────────────────────────
  const validation = validateSupervisorPlan(plan, agentSummaries)
  if (!validation.valid) {
    throw new Error(`Supervisor plan invalid: ${validation.errors.join('; ')}`)
  }

  // ── Load full agent documents (needed for execution) ───────────────
  const db = await getDb()
  const agents = await db
    .collection('agents')
    .find({ userId }, { projection: { userApiKey: 0 } })
    .toArray() as unknown as Agent[]

  // ── Execute the plan ───────────────────────────────────────────────
  const result = await executeSupervisorPlan(
    userId,
    workflowRunId,
    plan,
    agents,
  )

  // ── Persist the plan and objective to shared context ───────────────
  await updateSharedContext(userId, workflowRunId, {
    variables: {
      supervisorObjective: plan.objective,
      supervisorCompletionCriteria: plan.completionCriteria,
    },
  })

  return result
}

/**
 * Create a task record for a node and execute it as an agent turn.
 *
 * Used by sequential mode. Creates the task, then delegates to
 * `runNodeExecution` for the actual agent turn.
 */
/**
 * Create a task record for a node and execute it as an agent turn.
 *
 * Returns both the task id (for retry/recovery) and the execution result.
 * Used by sequential mode.
 */
async function executeTaskBodyWithId(
  userId: string,
  workflowRunId: string,
  { node, agent }: ResolvedNode,
  originalInput: string,
  previousResults: Record<string, unknown>,
  sharedContext: AgentExecutionContext['sharedContext'],
): Promise<{ taskId: string; result: NodeExecutionResult }> {
  const task = await createTask({
    userId,
    workflowRunId,
    agentId: agent?._id ?? 'system',
    title: node.name,
    description: node.description || '',
    input: previousResults,
    dependsOnTaskIds: [],
    maxRetries: agent?.maxRetryCount ?? 3,
  })

  const taskId = String(task._id)
  const result = await runNodeExecution(
    taskId,
    userId,
    workflowRunId,
    { node, agent },
    originalInput,
    previousResults,
    sharedContext,
  )

  return { taskId, result }
}

/**
 * Run a single node's agent turn against an already-created task.
 *
 * Sets task to running → builds prompt → calls LLM → writes shared
 * context → emits result message → completes/fails task.
 */
async function runNodeExecution(
  taskId: string,
  userId: string,
  workflowRunId: string,
  { node, agent }: ResolvedNode,
  originalInput: string,
  previousResults: Record<string, unknown>,
  sharedContext: AgentExecutionContext['sharedContext'],
): Promise<NodeExecutionResult> {
  await updateTaskStatus(taskId, userId, workflowRunId, {
    status: 'running',
    startedAt: true,
  })

  const start = Date.now()

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
      await failTask(taskId, userId, workflowRunId, error)
      await createMessage({
        userId,
        workflowId: workflowRunId,
        workflowRunId,
        fromAgentId: agent?._id ?? 'system',
        toAgentId: undefined,
        taskId,
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
      taskId,
      type: 'result',
      text: output,
      payload: { nodeId: node.id, provider: completion.provider, model: completion.model },
    })

    await completeTask(taskId, userId, workflowRunId, output)

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
    await failTask(taskId, userId, workflowRunId, message)
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
