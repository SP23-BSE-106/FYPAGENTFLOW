/**
 * Zod validation schemas for orchestration requests (Milestone 7).
 *
 * Provides runtime validation for API request bodies, complementing
 * TypeScript's compile-time type checking.
 */

import { z } from 'zod'

export const orchestrationRequestSchema = z.object({
  agentId: z.string().min(1, 'agentId is required'),
  input: z.string().min(1, 'input is required'),
  mode: z.enum(['sequential', 'parallel', 'supervisor']).optional(),
})

export type OrchestrationRequestInput = z.infer<
  typeof orchestrationRequestSchema
>

/** Schema for validating a supervisor-generated execution plan. */
export const supervisorPlanSchema = z.object({
  objective: z.string().min(1, 'objective is required'),
  tasks: z
    .array(
      z.object({
        temporaryId: z.string().min(1),
        agentId: z.string().min(1),
        description: z.string().min(1),
        dependsOn: z.array(z.string()).default([]),
        expectedOutput: z.string().min(1),
      }),
    )
    .min(1, 'at least one task is required')
    .max(10, 'maximum 10 tasks allowed'),
  completionCriteria: z.array(z.string()).default([]),
})

export type SupervisorPlanInput = z.infer<typeof supervisorPlanSchema>
