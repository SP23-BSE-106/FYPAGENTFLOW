import { z } from 'zod'

export const supervisorTaskSchema = z.object({
  temporaryId: z.string().min(1),
  agentId: z.string().min(1),
  description: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  expectedOutput: z.string().min(1),
})

export const supervisorPlanSchema = z.object({
  objective: z.string().min(1),
  tasks: z.array(supervisorTaskSchema).min(1),
  completionCriteria: z.array(z.string().min(1)).min(1),
})

export const orchestrationRequestSchema = z.object({
  agentId: z.string().min(1),
  input: z.string().trim().min(1),
  mode: z.enum(['sequential', 'parallel', 'supervisor']).default('sequential'),
})
