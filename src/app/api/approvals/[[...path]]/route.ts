import type { NextRequest } from 'next/server'

import { type DispatchContext } from '@/lib/api/routeDispatch'

import * as handler from './handler'

/**
 * `/api/approvals` catch-all:
 *
 *   POST /api/approvals/:approvalId/approve   (body: { response?, respondedBy? })
 *   POST /api/approvals/:approvalId/reject    (body: { response?, respondedBy? })
 *   POST /api/approvals/:approvalId/edit      (body: { response, respondedBy?, editedPayload? })
 */

async function run(
  method: string,
  request: NextRequest,
  ctx: DispatchContext,
): Promise<Response> {
  const { path = [] } = await ctx.params
  return await handler.handle(request, method, path)
}

export function POST(request: NextRequest, ctx: DispatchContext) {
  return run('POST', request, ctx)
}

export function GET(request: NextRequest, ctx: DispatchContext) {
  return run('GET', request, ctx)
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
