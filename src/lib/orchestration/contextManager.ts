/**
 * Shared execution-context manager (implementation plan Phase 3).
 *
 * Reads and writes the shared run context stored in the `shared_contexts`
 * collection. Every agent in a run reads from and writes to the same context,
 * so intermediate results and decisions are visible to downstream agents.
 */

import { getDb } from '@/lib/mongo/mongo'
import { ensureSharedContextsIndex } from '@/lib/mongo/indices'
import type { SharedContext, SharedContextDecision } from '@/lib/mongo/sharedContexts'

/** Fetch the shared context for a run, creating it if it does not exist. */
export async function getSharedContext(
  userId: string,
  workflowRunId: string,
): Promise<SharedContext> {
  const db = await getDb()
  await ensureSharedContextsIndex(db)

  const existing = await db.collection('shared_contexts').findOne({
    userId,
    workflowRunId,
  })

  if (existing) return existing as unknown as SharedContext

  const now = new Date()
  const context: SharedContext = {
    userId,
    workflowRunId,
    variables: {},
    documents: [],
    intermediateResults: {},
    decisions: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  }

  await db.collection('shared_contexts').insertOne(context as unknown as import('mongodb').Document)
  return context
}

/**
 * Merge updates into the shared context and bump the version.
 *
 * Only the fields provided are changed; everything else is preserved.
 */
export async function updateSharedContext(
  userId: string,
  workflowRunId: string,
  updates: Partial<{
    originalInput: string
    variables: Record<string, unknown>
    documents: string[]
    intermediateResults: Record<string, unknown>
    finalResult: unknown
  }>,
  decision?: Omit<SharedContextDecision, 'createdAt'>,
): Promise<SharedContext> {
  const db = await getDb()

  const context = await getSharedContext(userId, workflowRunId)

  const merged: SharedContext = {
    ...context,
    ...updates,
    version: context.version + 1,
    updatedAt: new Date(),
    intermediateResults: {
      ...context.intermediateResults,
      ...(updates.intermediateResults || {}),
    },
    variables: { ...context.variables, ...(updates.variables || {}) },
    documents: updates.documents ?? context.documents,
  }

  if (decision) {
    merged.decisions = [
      ...context.decisions,
      { ...decision, createdAt: new Date() },
    ]
  }

  await db
    .collection('shared_contexts')
    .updateOne(
      { userId, workflowRunId },
      { $set: merged },
    )

  return merged
}

/** Record a decision made by an agent in the shared context. */
export async function addDecision(
  userId: string,
  workflowRunId: string,
  agentId: string,
  decision: string,
  reason?: string,
): Promise<void> {
  await updateSharedContext(userId, workflowRunId, {}, {
    agentId,
    decision,
    reason,
  })
}
