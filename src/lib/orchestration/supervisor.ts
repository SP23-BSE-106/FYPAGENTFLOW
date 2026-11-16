/**
 * Supervisor agent and dynamic delegation (implementation plan Phase 8).
 *
 * A supervisor analyses a natural-language request, breaks it into subtasks,
 * selects agents by capability, and produces a structured execution plan.
 * The plan is validated before execution, then run through the bounded
 * concurrency scheduler.
 *
 * Modules it composes:
 *   - taskManager         — task lifecycle
 *   - messageBus          — structured agent-to-agent messages
 *   - contextManager      — shared run context
 *   - scheduler           — bounded-concurrency execution
 */

import { chatCompletion } from '@/lib/llm'
import { getDb } from '@/lib/mongo/mongo'

import { createTask } from './taskManager'
import { scheduleParallel, type SchedulerConfig } from './scheduler'
import type { NodeExecutionResult } from './types'
import type { Agent } from '@/lib/mongo/agent'
import { supervisorPlanSchema } from '@/lib/validation/orchestrationSchemas'

/** Max number of tasks a supervisor plan may contain. */
const MAX_SUPERVISOR_TASKS = 10

/** Default scheduler config for supervisor-driven runs. */
const SUPERVISOR_SCHEDULER_CONFIG: SchedulerConfig = {
  maxConcurrentTasks: 5,
  maxRunDurationMs: 300_000, // 5 minutes
  maxMessagesPerRun: 500,
}

/* ───────────────────────── plan types ───────────────────────── */

/** One task in a supervisor-generated execution plan. */
export type SupervisorPlanTask = {
  /** Client-side id used to wire dependencies before real task ids exist. */
  temporaryId: string
  /** id of the agent that should perform this task. */
  agentId: string
  /** Human-readable description of the work. */
  description: string
  /** temporaryIds of tasks this task depends on. */
  dependsOn: string[]
  /** Description of the expected output. */
  expectedOutput: string
}

/** A supervisor-generated execution plan. */
export type SupervisorPlan = {
  objective: string
  tasks: SupervisorPlanTask[]
  completionCriteria: string[]
}

/** Result of validating a plan against the available agents. */
export type PlanValidation = {
  valid: boolean
  errors: string[]
}

/** Summary of an agent, shown in a plan preview. */
export type AgentSummary = {
  id: string
  name: string
  role?: string
  capabilities: string[]
}

/* ─────────────────────── agent discovery ────────────────────── */

/** List the caller's agents with their capabilities for plan selection. */
export async function listAvailableAgents(
  userId: string,
): Promise<AgentSummary[]> {
  const db = await getDb()
  const agents = await db
    .collection('agents')
    .find({ userId }, { projection: { userApiKey: 0 } })
    .sort({ createdAt: -1 })
    .toArray()

  return (agents as unknown as Agent[]).map((agent) => ({
    id: String(agent._id),
    name: agent.name,
    role: agent.role,
    capabilities: (agent.capabilities || []).map((cap) => cap.name),
  }))
}

/* ─────────────────────── plan generation ────────────────────── */

/**
 * Ask the supervisor agent (or the default inference provider) to break the
 * user's request into a structured execution plan.
 *
 * The LLM is instructed to return JSON matching the SupervisorPlan schema.
 * Agent selection is capability-based: the plan may only reference agents
 * that exist in the caller's workspace.
 */
export async function generateSupervisorPlan(
  userId: string,
  input: string,
  agents: AgentSummary[],
): Promise<SupervisorPlan> {
  // Build a capability catalogue for the LLM to choose from.
  const capabilityCatalogue = agents
    .map(
      (a) =>
        `- ${a.name} (${a.id}) [role: ${a.role || 'general'}]${
          a.capabilities.length
            ? ` capabilities: ${a.capabilities.join(', ')}`
            : ''
        }`,
    )
    .join('\n') ||
    'No agents configured. Create agents first.'

  const system = `You are a supervisor agent in the AgentFlow multi-agent platform.

Your job is to break a user's request into a structured execution plan.
You must return ONLY valid JSON matching this schema:

{
  "objective": "string - restated goal of the whole request",
  "tasks": [
    {
      "temporaryId": "string - unique id like 't1', 't2', ...",
      "agentId": "string - id of an agent from the list below",
      "description": "string - what this agent should do",
      "dependsOn": ["string"] - temporaryIds of tasks this depends on,
      "expectedOutput": "string - what success looks like"
    }
  ],
  "completionCriteria": ["string"] - how to know the whole request is done
}

Rules:
- Pick agents from the capability catalogue below by matching their
  capabilities to each task.
- temporaryId values must be unique (t1, t2, t3...).
- dependsOn must only reference temporaryIds of earlier tasks (no cycles).
- Keep the task count at or below ${MAX_SUPERVISOR_TASKS}.
- Do not invent agent ids — use only ids from the catalogue.
- Return valid JSON only, no markdown fences, no extra text.

Available agents:
${capabilityCatalogue}`

  const completion = await chatCompletion({
    system,
    prompt: `User request: ${input}\n\nGenerate the execution plan as JSON.`,
    maxTokens: 2048,
    temperature: 0.3,
    timeoutMs: 30_000,
  })

  if (!completion.ok) {
    const failures = completion.failures
      ?.map((f) => `${f.provider}: ${f.message}`)
      .join('; ')
    throw new Error(
      `Supervisor could not generate a plan: ${failures || 'no provider answered'}`,
    )
  }

  const plan = parseSupervisorPlan(completion.text)
  return plan
}

/** Parse and lightly normalize a supervisor plan from LLM output text. */
function parseSupervisorPlan(text: string): SupervisorPlan {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // Try to extract a JSON block from fenced output.
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) {
      throw new Error('Supervisor response was not valid JSON.')
    }
    try {
      raw = JSON.parse(match[0])
    } catch {
      throw new Error('Supervisor response was not valid JSON.')
    }
  }

  const parsed = supervisorPlanSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Supervisor plan validation failed: ${parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')}`)
  }
  return parsed.data
}

/* ─────────────────────── plan validation ────────────────────── */

/**
 * Validate a supervisor plan against the available agents.
 *
 * Checks:
 *   - every referenced agentId exists and belongs to the caller
 *   - every dependsOn references a known temporaryId
 *   - no dependency cycles
 *   - task count within limits
 */
export function validateSupervisorPlan(
  plan: SupervisorPlan,
  agents: AgentSummary[],
): PlanValidation {
  const errors: string[] = []
  const agentIds = new Set(agents.map((a) => a.id))
  const temporaryIds = new Set(plan.tasks.map((t) => t.temporaryId))

  // Task count limit.
  if (plan.tasks.length === 0) {
    errors.push('Plan must contain at least one task.')
  }
  if (plan.tasks.length > MAX_SUPERVISOR_TASKS) {
    errors.push(
      `Plan exceeds maximum of ${MAX_SUPERVISOR_TASKS} tasks (${plan.tasks.length} requested).`,
    )
  }

  // Unique temporaryIds.
  const seenIds = new Set<string>()
  for (const task of plan.tasks) {
    if (seenIds.has(task.temporaryId)) {
      errors.push(`Duplicate temporaryId "${task.temporaryId}".`)
    }
    seenIds.add(task.temporaryId)

    // Agent exists.
    if (!task.agentId || !agentIds.has(task.agentId)) {
      errors.push(
        `Task "${task.temporaryId}" references unknown agent "${task.agentId}".`,
      )
    }

    // Dependencies reference known tasks.
    for (const dep of task.dependsOn) {
      if (!temporaryIds.has(dep)) {
        errors.push(
          `Task "${task.temporaryId}" depends on unknown task "${dep}".`,
        )
      }
      // No self-dependency.
      if (dep === task.temporaryId) {
        errors.push(`Task "${task.temporaryId}" depends on itself.`)
      }
    }
  }

  // Cycle detection over the temporary-id graph.
  if (hasPlanCycle(plan.tasks)) {
    errors.push('Plan contains a dependency cycle.')
  }

  return { valid: errors.length === 0, errors }
}

/** Detect cycles in the plan's dependency graph (DFS). */
function hasPlanCycle(tasks: SupervisorPlanTask[]): boolean {
  const byId = new Map(tasks.map((t) => [t.temporaryId, t]))
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const dfs = (id: string): boolean => {
    if (visited.has(id)) return false
    if (visiting.has(id)) return true // back edge = cycle
    const task = byId.get(id)
    if (!task) return false
    visiting.add(id)
    for (const dep of task.dependsOn) {
      if (dfs(dep)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }

  for (const task of tasks) {
    if (dfs(task.temporaryId)) return true
  }
  return false
}

/* ─────────────────────── plan execution ─────────────────────── */

/**
 * Execute a validated supervisor plan.
 *
 * Creates tasks in dependency order, wires dependsOnTaskIds, then runs them
 * through the bounded-concurrency scheduler. Returns the orchestration
 * result shape.
 */
export async function executeSupervisorPlan(
  userId: string,
  workflowRunId: string,
  plan: SupervisorPlan,
  agents: Agent[],
): Promise<{
  completed: number
  failed: number
  messagesCreated: number
  finalOutput: unknown
}> {
  const agentById = new Map(agents.map((a) => [String(a._id), a]))
  const taskIdByTempId = new Map<string, string>()

  // ── Create tasks in dependency order ───────────────────────────────
  // Sort so dependencies are created before dependents.
  const ordered = [...plan.tasks].sort((a, b) => {
    return a.dependsOn.includes(b.temporaryId) ? 1 : b.dependsOn.includes(a.temporaryId) ? -1 : 0
  })

  for (const task of ordered) {
    const agent = agentById.get(task.agentId) ?? null
    const dependsOnTaskIds: string[] = []
    for (const depTempId of task.dependsOn) {
      const depTaskId = taskIdByTempId.get(depTempId)
      if (depTaskId) dependsOnTaskIds.push(depTaskId)
    }

    const created = await createTask({
      userId,
      workflowRunId,
      agentId: agent?._id ?? 'system',
      title: task.description.slice(0, 120),
      description: task.description,
      input: {},
      dependsOnTaskIds,
      maxRetries: 3,
    })

    taskIdByTempId.set(task.temporaryId, String(created._id))
  }

  // ── Build schedulable tasks ────────────────────────────────────────
  const schedulableTasks = plan.tasks.map((task) => {
    const taskId = taskIdByTempId.get(task.temporaryId)!
    const agent = agentById.get(task.agentId) ?? null

    return {
      id: taskId,
      dependsOnTaskIds: task.dependsOn
        .map((d) => taskIdByTempId.get(d))
        .filter((id): id is string => Boolean(id)),
      execute: async () => {
        // Build a minimal node-like descriptor for execution.
        const node = {
          id: task.temporaryId,
          name: task.description.slice(0, 80),
          type: 'supervisor_task' as const,
          description: task.description,
          config: {},
        }

        return runSupervisorNode(
          taskId,
          userId,
          workflowRunId,
          { node, agent },
          task.expectedOutput,
        )
      },
    }
  })

  // ── Run via bounded-concurrency scheduler ──────────────────────────
  const schedule = await scheduleParallel(
    schedulableTasks,
    SUPERVISOR_SCHEDULER_CONFIG,
  )

  // ── Collect results ────────────────────────────────────────────────
  let messagesCreated = 0
  let finalOutput: unknown = null

  for (const task of plan.tasks) {
    const taskId = taskIdByTempId.get(task.temporaryId)!
    const result = schedule.results.get(taskId)
    if (!result) continue

    messagesCreated += result.messages?.length ?? 0

    if (result.ok) {
      finalOutput = {
        ...(typeof finalOutput === 'object' && finalOutput !== null
          ? finalOutput
          : {}),
        [task.temporaryId]: result.output,
      }
    } else {
      finalOutput = {
        ...(typeof finalOutput === 'object' && finalOutput !== null
          ? finalOutput
          : {}),
        [task.temporaryId]: { error: result.error },
      }
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
 * Execute a single supervisor-plan task node.
 *
 * Builds a prompt from the task description and expected output, calls the
 * LLM, writes the result to shared context, and emits a result message.
 */
async function runSupervisorNode(
  taskId: string,
  userId: string,
  workflowRunId: string,
  { node, agent }: { node: { id: string; name: string; description: string; type: string; config?: Record<string, unknown> }; agent: Agent | null },
  expectedOutput: string,
): Promise<NodeExecutionResult> {
  const { createMessage } = await import('./messageBus')
  const { updateSharedContext } = await import('./contextManager')
  const { completeTask, failTask } = await import('./taskManager')
  const start = Date.now()

  try {
    const system = `You are a worker agent executing a supervisor-assigned task.

Task: ${node.description}
Expected output: ${expectedOutput}

Produce the result directly. Do not ask questions. Do not delegate.`
    const prompt = `Complete the task described above and produce the expected output.`

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
      payload: {
        nodeId: node.id,
        provider: completion.provider,
        model: completion.model,
      },
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
