import type { NextRequest } from 'next/server'

import { getSessionTokenFromCookies, verifyJwt } from '@/lib/auth/jwt'
import { authorizeExecution, checkOwnership } from '@/lib/permissions'
import { auditWorkflowExecute } from '@/lib/audit'
import { orchestrate } from '@/lib/orchestration/orchestrator'
import { orchestrationRequestSchema } from '@/lib/validation/orchestrationSchemas'

export const maxDuration = 60

async function getAuthenticatedUserId(): Promise<string | null> {
  const token = await getSessionTokenFromCookies()
  if (!token) return null
  try {
    return verifyJwt(token).sub
  } catch {
    return null
  }
}

/**
 * POST /api/orchestrate — execute a workflow as a multi-agent run.
 *
 * Body: { agentId, input, mode? }
 *   - agentId: the agent whose workflow graph will be executed
 *   - input:   the original user request
 *   - mode:    'sequential' | 'parallel' | 'supervisor' (default 'sequential')
 *
 * Returns the orchestration result (run id, status, output, task/message
 * counts, duration).
 */
export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId()
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const parsed = orchestrationRequestSchema.safeParse(body)
  if (!parsed.success) {
    return new Response(JSON.stringify({
      error: 'Invalid orchestration request',
      issues: parsed.error.issues,
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const { agentId, input, mode } = parsed.data

  // ── Permission check ───────────────────────────────────────────────
  const permission = await authorizeExecution(userId, 'canExecute')
  if (!permission.allowed) {
    return new Response(JSON.stringify({ error: permission.reason }), {
      status: permission.status ?? 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // ── Ownership: agent must belong to the caller ─────────────────────
  const owned = await checkOwnership('agents', agentId, userId)
  if (!owned.allowed) {
    return new Response(JSON.stringify({ error: owned.reason }), {
      status: owned.status ?? 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const startedAt = Date.now()
    const result = await orchestrate({ agentId, input, userId, mode: mode ?? 'sequential' })
    const durationMs = Date.now() - startedAt

    // ── Audit log ────────────────────────────────────────────────────
    await auditWorkflowExecute({
      userId,
      workflowId: agentId,
      runId: result.runId,
      mode,
      status: result.status,
      durationMs,
      agentId,
    })

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Orchestration failed'

    // ── Audit log for failure ────────────────────────────────────────
    await auditWorkflowExecute({
      userId,
      workflowId: agentId,
      mode,
      status: 'failed',
      agentId,
    })

    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
