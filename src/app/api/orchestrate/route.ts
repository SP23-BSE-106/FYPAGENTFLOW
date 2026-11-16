import type { NextRequest } from 'next/server'

import { getDb } from '@/lib/mongo/mongo'
import { getSessionTokenFromCookies, verifyJwt } from '@/lib/auth/jwt'
import { orchestrate } from '@/lib/orchestration/orchestrator'

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

  const { agentId, input, mode = 'sequential' } = body
  if (!agentId || typeof agentId !== 'string') {
    return new Response(JSON.stringify({ error: 'agentId is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (!input || typeof input !== 'string' || !input.trim()) {
    return new Response(JSON.stringify({ error: 'input is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const db = await getDb()
  const workspaceSettings = await db.collection('workspace_settings').findOne({ userId })
  const permissions = workspaceSettings?.permissions || {}
  if (permissions.canExecute === false) {
    return new Response(
      JSON.stringify({ error: 'Execution permission is disabled for this workspace.' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )
  }

  try {
    const result = await orchestrate({ agentId, input, userId, mode })
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Orchestration failed'
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
