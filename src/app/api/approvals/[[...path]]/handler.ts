import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'

import { getDb } from '@/lib/mongo/mongo'
import { getSessionTokenFromCookies, verifyJwt } from '@/lib/auth/jwt'
import {
  approveApproval,
  rejectApproval,
  editApproval,
} from '@/lib/orchestration/approvalManager'

async function getAuthenticatedUserId(): Promise<string | null> {
  const token = await getSessionTokenFromCookies()
  if (!token) return null
  try {
    return verifyJwt(token).sub
  } catch {
    return null
  }
}

function isValidId(id: string): boolean {
  return ObjectId.isValid(id)
}

/**
 * `/api/approvals` handler:
 *
 *   GET    /api/approvals                      — list pending approvals (query: ?runId=...)
 *   POST   /api/approvals/:approvalId/approve
 *   POST   /api/approvals/:approvalId/reject
 *   POST   /api/approvals/:approvalId/edit
 */

export async function handle(
  request: NextRequest,
  method: string,
  path: string[],
): Promise<Response> {
  const userId = await getAuthenticatedUserId()
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = await getDb()

  // GET /api/approvals — list pending approvals (optionally filtered by runId)
  if (path.length === 0 && method === 'GET') {
    const url = new URL(request.url)
    const runId = url.searchParams.get('runId')

    const filter: Record<string, unknown> = { userId, status: 'pending' }
    if (runId && isValidId(runId)) filter.workflowRunId = runId

    const approvals = await db
      .collection('approval_requests')
      .find(filter)
      .sort({ createdAt: 1 })
      .toArray()

    return NextResponse.json(approvals)
  }

  // POST /api/approvals/:approvalId/approve | reject | edit
  if (path.length === 1 && method === 'POST') {
    const [approvalId] = path
    if (!isValidId(approvalId)) {
      return NextResponse.json({ error: 'Invalid approval ID' }, { status: 400 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const { response, respondedBy, editedPayload } = body

    const [action] = path
    switch (action) {
      case 'approve': {
        const result = await approveApproval(approvalId, userId, response, respondedBy)
        if (!result) {
          return NextResponse.json({ error: 'Approval request not found' }, { status: 404 })
        }
        return NextResponse.json({ ok: true, status: 'approved', approval: result })
      }
      case 'reject': {
        const result = await rejectApproval(approvalId, userId, response, respondedBy)
        if (!result) {
          return NextResponse.json({ error: 'Approval request not found' }, { status: 404 })
        }
        return NextResponse.json({ ok: true, status: 'rejected', approval: result })
      }
      case 'edit': {
        const result = await editApproval(
          approvalId,
          userId,
          typeof response === 'string' ? response : '',
          respondedBy,
          editedPayload,
        )
        if (!result) {
          return NextResponse.json({ error: 'Approval request not found' }, { status: 404 })
        }
        return NextResponse.json({ ok: true, status: 'edited', approval: result })
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
