# TODO

## Milestone 1: Communication foundation — DONE

- [x] Agent roles & capabilities (`AgentRole`, `AgentCapability`) on `Agent` type
- [x] MongoDB collection types: agentTasks, agentMessages, sharedContexts, executionEvents, agentEvaluations, approvalRequests
- [x] Lazy index creation (`src/lib/mongo/indices.ts`)
- [x] Dev endpoint extended to create new collections
- [x] API persistence: `/api/runs/[[...path]]` (runs, tasks, messages, evaluations, approvals, events)
- [x] Agent capabilities CRUD (`/api/agents/:id/capabilities`)
- [x] Index migration notes (`doc/MULTI_AGENT_DB_INDEXES.md`)

## Milestone 2: Sequential multi-agent execution — DONE

- [x] Orchestration types, dependency resolver, context manager, message bus, task manager
- [x] Orchestrator engine — sequential execution via `executeTaskBody`
- [x] API endpoint `POST /api/orchestrate` — { agentId, input, mode? }

## Milestone 3: Parallel execution — DONE

- [x] Task scheduler — bounded concurrency, dependency-aware, run-level timeout
- [x] Parallel execution path in orchestrator
- [x] `POST /api/orchestrate` supports `mode: 'parallel'`

## Milestone 4: Supervisor orchestration — DONE

- [x] Supervisor plan types, agent discovery, plan generation, validation, execution
- [x] Supervisor mode integrated into orchestrator (`mode: 'supervisor'`)
- [x] API endpoint `POST /api/supervisor/plan` — generate + validate plan (preview/approval)

## Milestone 5: Evaluation and recovery — DONE

- [x] Critic/fact-checker evaluation (accuracy, relevance, completeness, groundedness)
- [x] Critic agent discovery (role: 'critic' or 'fact_checker')
- [x] Evaluation integrated into sequential mode with revision on failure
- [x] Max review cycles (3) to prevent infinite debates
- [x] Retry/fallback recovery (decideRecovery, retryTaskWithFeedback)
- [x] RetryPolicy (maxRetries, backoffMs, retryableErrors, fallbackAgentId, fallbackModel)

## Milestone 6: Human approval and monitoring — DONE

- [x] Approval manager — create, approve, reject, edit approval requests
- [x] Approval checkpoints in orchestrator — pauses run when agent requires human approval
- [x] Resume after approval — skips already-completed tasks
- [x] API endpoints: POST /api/approvals/:id/approve, /reject, /edit
- [x] API endpoint: GET /api/approvals (list pending, filter by runId)
- [x] Live execution timeline: GET /api/runs/:runId/events
- [x] Workflow pause/resume status tracking

## Milestone 7: Production hardening — DONE

- [x] Audit logging utility (`src/lib/audit.ts`) — fire-and-forget audit events
- [x] Permission checks (`src/lib/permissions.ts`) — ownership, permissions, rate limits, budgets
- [x] Execution budgets per user (maxRunsPerHour, maxRunDurationMs, maxTasksPerRun, maxMessagesPerRun)
- [x] User settings extended with permissions + executionBudget fields
- [x] Zod validation schemas (`src/lib/validation/orchestrationSchemas.ts`)
- [x] `POST /api/orchestrate` enforces permissions, ownership, budgets, audit logging
- [x] Production build passes (`next build`)

## Implementation Complete

All 7 milestones from the implementation plan are complete. The repository is at:
https://github.com/SP23-BSE-106/FYPAGENTFLOW.git (branch: main)
