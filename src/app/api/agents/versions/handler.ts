import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'

import { getDb } from '@/lib/mongo/mongo'
import { getSessionTokenFromCookies, verifyJwt } from '@/lib/auth/jwt'
import { ensureAgentVersionsIndex } from '@/lib/agentVersionStore'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = await getSessionTokenFromCookies()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let userId: string
  try {
    userId = verifyJwt(token).sub
  } catch {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
  }

  const { id } = await params
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid agent ID' }, { status: 400 })
  }

  const db = await getDb()
  const agent = await db.collection('agents').findOne({ _id: new ObjectId(id), userId })
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const limit = Math.min(100, Math.max(1, Number(request.nextUrl.searchParams.get('limit')) || 20))
  await ensureAgentVersionsIndex(db)
  const versions = await db
    .collection('agent_versions')
    .find({ userId, agentId: id })
    .sort({ version: -1 })
    .limit(limit)
    .toArray()

  return NextResponse.json(versions)
}
