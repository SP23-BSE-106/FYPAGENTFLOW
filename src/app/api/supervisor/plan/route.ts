import type { NextRequest } from 'next/server'

import { getSessionTokenFromCookies, verifyJwt } from '@/lib/auth/jwt'
import {
  generateSupervisorPlan,
  listAvailableAgents,
  validateSupervisorPlan,
} from '@/lib/orchestration/supervisor'

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
 * POST /api/supervisor/plan
 *
 * Generate a supervisor execution plan from a natural-language request
 * WITHOUT executing it. Returns the plan plus validation results so the
 * user can preview and approve before running.
 *
 * Body: { input, agentId? }
 *   - input:   the natural-language request
 *   - agentId: optional id of the supervisor agent to use
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

  const { input } = body
  if (!input || typeof input !== 'string' || !input.trim()) {
    return new Response(JSON.stringify({ error: 'input is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const agents = await listAvailableAgents(userId)
    const plan = await generateSupervisorPlan(userId, input, agents)
    const validation = validateSupervisorPlan(plan, agents)

    return new Response(
      JSON.stringify({
        plan,
        validation,
        agents,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Plan generation failed'
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
