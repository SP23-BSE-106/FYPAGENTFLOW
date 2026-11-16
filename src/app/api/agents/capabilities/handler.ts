import { NextRequest, NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import crypto from 'node:crypto'

import { getDb } from '@/lib/mongo/mongo'
import { getSessionTokenFromCookies, verifyJwt } from '@/lib/auth/jwt'

/**
 * POST   /api/agents/:id/capabilities   — add a capability to an agent
 * DELETE /api/agents/:id/capabilities/:capabilityId — remove a capability
 *
 * Mirrors the existing agents `[id]` handler: reads are scoped to the
 * caller's own workspace (`userId`), and the encrypted API key is never
 * returned.
 */

async function getAuthenticatedUserId(): Promise<string | null> {
  const token = await getSessionTokenFromCookies()
  if (!token) return null
  try {
    return verifyJwt(token).sub
  } catch {
    return null
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid agent ID' }, { status: 400 })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { name, description, inputSchema, outputSchema } = body
  if (typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'capability name is required' }, { status: 400 })
  }
  if (typeof description !== 'string' || !description.trim()) {
    return NextResponse.json({ error: 'capability description is required' }, { status: 400 })
  }

  const db = await getDb()
  const agent = await db.collection('agents').findOne({ _id: new ObjectId(id), userId })
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  const capability = {
    id: crypto.randomBytes(8).toString('hex'),
    name: name.trim(),
    description: description.trim(),
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  }

  const capabilities = Array.isArray(agent.capabilities) ? agent.capabilities : []
  capabilities.push(capability)

  const result = await db
    .collection('agents')
    .findOneAndUpdate(
      { _id: new ObjectId(id), userId },
      { $set: { capabilities, updatedAt: new Date() } },
      { returnDocument: 'after', projection: { userApiKey: 0 } },
    )

  if (!result) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  return NextResponse.json(result, { status: 200 })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; capabilityId: string }> },
) {
  const userId = await getAuthenticatedUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id, capabilityId } = await params
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid agent ID' }, { status: 400 })
  }

  const db = await getDb()
  const agent = await db.collection('agents').findOne({ _id: new ObjectId(id), userId })
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  const capabilities = Array.isArray(agent.capabilities) ? agent.capabilities : []
  const filtered = capabilities.filter((cap) => cap.id !== capabilityId)
  if (filtered.length === capabilities.length) {
    return NextResponse.json({ error: 'Capability not found' }, { status: 404 })
  }

  const result = await db
    .collection('agents')
    .findOneAndUpdate(
      { _id: new ObjectId(id), userId },
      { $set: { capabilities: filtered, updatedAt: new Date() } },
      { returnDocument: 'after', projection: { userApiKey: 0 } },
    )

  if (!result) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  return NextResponse.json(result)
}
