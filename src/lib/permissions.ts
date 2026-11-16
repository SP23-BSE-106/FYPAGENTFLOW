/**
 * Permission and execution-budget checks (implementation plan Phase 15 +
 * Milestone 7).
 *
 * Provides helpers to enforce cross-user isolation, per-user rate limits,
 * and execution budgets. All checks are best-effort: they fail closed
 * (deny) when the database is unreachable, and they never throw — they
 * return a result object the caller can turn into an HTTP response.
 */

import { getDb } from '@/lib/mongo/mongo'
import { rateLimit } from '@/lib/rateLimit'
import type { UserSettings } from '@/lib/mongo/userSettings'
import { ObjectId, type Document, type Filter } from 'mongodb'

/** Result of a permission check. */
export type PermissionResult = {
  allowed: boolean
  reason?: string
  status?: number
}

/** Result of an execution-budget check. */
export type BudgetResult = {
  allowed: boolean
  reason?: string
  status?: number
  remaining?: number
}

/** Default budgets when none are configured in user settings. */
const DEFAULT_BUDGETS: Required<NonNullable<UserSettings['executionBudget']>> = {
  maxRunsPerHour: 60,
  maxRunDurationMs: 300_000,
  maxTasksPerRun: 50,
  maxMessagesPerRun: 500,
}

export async function getExecutionBudget(
  userId: string,
): Promise<Required<NonNullable<UserSettings['executionBudget']>>> {
  const db = await getDb()
  const settings = (await db.collection('workspace_settings').findOne({ userId })) as
    | UserSettings
    | null
    | undefined

  return {
    maxRunsPerHour: settings?.executionBudget?.maxRunsPerHour ?? DEFAULT_BUDGETS.maxRunsPerHour,
    maxRunDurationMs: settings?.executionBudget?.maxRunDurationMs ?? DEFAULT_BUDGETS.maxRunDurationMs,
    maxTasksPerRun: settings?.executionBudget?.maxTasksPerRun ?? DEFAULT_BUDGETS.maxTasksPerRun,
    maxMessagesPerRun: settings?.executionBudget?.maxMessagesPerRun ?? DEFAULT_BUDGETS.maxMessagesPerRun,
  }
}

/**
 * Check that a resource (agent, workflow, run, message, task) belongs to the
 * calling user. Prevents cross-user data access.
 *
 * @param db - MongoDB database handle
 * @param collection - collection name
 * @param resourceId - id of the resource
 * @param userId - calling user's id
 */
export async function checkOwnership(
  db: Awaited<ReturnType<typeof getDb>>,
  collection: string,
  resourceId: string,
  userId: string,
): Promise<PermissionResult> {
  const ids: (string | ObjectId)[] = [resourceId]
  if (ObjectId.isValid(resourceId)) ids.push(new ObjectId(resourceId))
  const resource = await db
    .collection(collection)
    .findOne({ _id: { $in: ids }, userId } as Filter<Document>)
  if (!resource) {
    return { allowed: false, reason: 'Resource not found or not owned by you', status: 404 }
  }
  return { allowed: true }
}

/**
 * Check a specific permission flag for a user. Missing flags default to
 * allowed (true).
 */
export async function checkPermission(
  userId: string,
  flag: keyof NonNullable<UserSettings['permissions']>,
): Promise<PermissionResult> {
  const db = await getDb()
  const settings = (await db.collection('workspace_settings').findOne({ userId })) as
    | (UserSettings & { permissions?: UserSettings['permissions'] })
    | null
    | undefined

  const enabled = settings?.permissions?.[flag] ?? true
  if (!enabled) {
    return {
      allowed: false,
      reason: `Permission '${flag}' is disabled for your workspace`,
      status: 403,
    }
  }
  return { allowed: true }
}

/**
 * Check rate limits for a scoped key (e.g. `execute:userId`).
 */
export function checkRateLimit(key: string, opts: { windowMs: number; max: number }) {
  return rateLimit(key, opts)
}

/**
 * Check execution budgets for a user. Returns allowed=false if any budget
 * is exceeded. Also checks the per-hour run rate limit.
 */
export async function checkExecutionBudget(userId: string): Promise<BudgetResult> {
  const budget = await getExecutionBudget(userId)

  // ── Rate limit: max runs per hour ──────────────────────────────────
  const rl = checkRateLimit(`budget:runs:${userId}`, {
    windowMs: 60_000 * 60,
    max: budget.maxRunsPerHour,
  })
  if (!rl.ok) {
    return {
      allowed: false,
      reason: `Hourly run limit exceeded (${budget.maxRunsPerHour}/hour). Try again later.`,
      status: 429,
      remaining: 0,
    }
  }

  return { allowed: true, remaining: rl.remaining ?? 0 }
}

/**
 * Combine a permission check and budget check into one result.
 */
export async function authorizeExecution(
  userId: string,
  permissionFlag: keyof NonNullable<UserSettings['permissions']> = 'canExecute',
): Promise<PermissionResult & BudgetResult> {
  const permission = await checkPermission(userId, permissionFlag)
  if (!permission.allowed) {
    return { ...permission, remaining: undefined }
  }

  const budget = await checkExecutionBudget(userId)
  if (!budget.allowed) {
    return { ...budget, reason: budget.reason, status: budget.status }
  }

  return { allowed: true, remaining: budget.remaining }
}
