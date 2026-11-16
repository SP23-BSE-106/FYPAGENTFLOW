import type { NextRequest } from 'next/server'

import { type DispatchContext } from '@/lib/api/routeDispatch'

import * as handler from './handler'

/**
 * `/api/runs` catch-all:
 *
 *   GET/POST   /api/runs
 *   GET/POST   /api/runs/:runId            (POST body: { action: 'cancel'|'resume' })
 *   GET        /api/runs/:runId/tasks
 *   GET/POST   /api/runs/:runId/tasks/:taskId/retry
 *   GET/POST   /api/runs/:runId/messages
 *   GET        /api/runs/:runId/messages/:messageId
 *   GET/POST   /api/runs/:runId/evaluations
 *   GET        /api/runs/:runId/approvals
 */

async function run(
  method: string,
  request: NextRequest,
  ctx: DispatchContext,
): Promise<Response> {
  const { path = [] } = await ctx.params
  return await handler.handle(request, method, path)
}

export function GET(request: NextRequest, ctx: DispatchContext) {
  return run('GET', request, ctx)
}

export function POST(request: NextRequest, ctx: DispatchContext) {
  return run('POST', request, ctx)
}

export function PUT(request: NextRequest, ctx: DispatchContext) {
  return run('PUT', request, ctx)
}

export function PATCH(request: NextRequest, ctx: DispatchContext) {
  return run('PATCH', request, ctx)
}

export function DELETE(request: NextRequest, ctx: DispatchContext) {
  return run('DELETE', request, ctx)
}
