# TODO

## Milestone 1: Communication foundation (implementation plan) — DONE

- [x] Agent roles & capabilities (`AgentRole`, `AgentCapability`) on `Agent` type
- [x] MongoDB collection types: agentTasks, agentMessages, sharedContexts, executionEvents, agentEvaluations, approvalRequests
- [x] Lazy index creation (`src/lib/mongo/indices.ts`)
- [x] Dev endpoint extended to create new collections
- [x] API persistence: `/api/runs/[[...path]]` (runs, tasks, messages, evaluations, approvals)
- [x] Agent capabilities CRUD (`/api/agents/:id/capabilities`)
- [x] Index migration notes (`doc/MULTI_AGENT_DB_INDEXES.md`)

## Milestone 2: Sequential multi-agent execution — DONE

- [x] Orchestration types (`src/lib/orchestration/types.ts`)
- [x] Dependency resolver (`src/lib/orchestration/dependencyResolver.ts`) — topological sort + cycle detection
- [x] Context manager (`src/lib/orchestration/contextManager.ts`) — shared run context
- [x] Message bus (`src/lib/orchestration/messageBus.ts`) — structured agent messages
- [x] Task manager (`src/lib/orchestration/taskManager.ts`) — task lifecycle
- [x] Orchestrator engine (`src/lib/orchestration/orchestrator.ts`) — sequential execution via `executeTaskBody`
- [x] API endpoint `POST /api/orchestrate` — { agentId, input, mode? }

## Milestone 3: Parallel execution — DONE

- [x] Task scheduler (`src/lib/orchestration/scheduler.ts`) — bounded concurrency, dependency-aware, run-level timeout
- [x] Parallel execution path in orchestrator — creates all tasks up front, wires dependsOnTaskIds from edges, runs via `scheduleParallel`
- [x] Aggregator behavior — nodes with multiple dependencies wait for all to complete
- [x] `SchedulerConfig` — maxConcurrentTasks, maxRunDurationMs, maxMessagesPerRun
- [x] `POST /api/orchestrate` supports `mode: 'parallel'`
- [x] `tsc --noEmit` passes; eslint clean on new files

## Milestone 4: Supervisor orchestration — DONE

- [x] Supervisor plan types (`src/lib/orchestration/supervisor.ts`) — SupervisorPlan, SupervisorPlanTask, PlanValidation
- [x] Agent discovery (`listAvailableAgents`) — lists caller's agents with capabilities
- [x] Plan generation (`generateSupervisorPlan`) — LLM breaks request into structured plan
- [x] Plan validation (`validateSupervisorPlan`) — agent IDs, deps, cycles, task limits
- [x] Plan execution (`executeSupervisorPlan`) — creates tasks, wires deps, runs via scheduler
- [x] Supervisor mode integrated into orchestrator (`mode: 'supervisor'`)
- [x] API endpoint `POST /api/supervisor/plan` — generate + validate plan without executing (preview/approval)

## Milestone 5: Evaluation and recovery — DONE

- [x] Evaluator (`src/lib/orchestration/evaluator.ts`) — critic/fact-checker evaluation (accuracy, relevance, completeness, groundedness)
- [x] Critic agent discovery — finds agent with role 'critic' or 'fact_checker'
- [x] Evaluation integrated into sequential mode — after each task, critic scores output; if below 0.7 threshold, triggers revision
- [x] Max review cycles (3) — prevents infinite debate loops
- [x] Retry/fallback (`decideRecovery`, `retryTaskWithFeedback`) — retry same agent, fallback agent/model, or stop
- [x] Retry policy — maxRetries, backoffMs, retryableErrors, fallbackAgentId, fallbackModel
- [x] Feedback messages emitted for each retry/revision
- [x] `tsc --noEmit` passes; eslint clean on new files

## Milestone 6: Human approval and monitoring — NEXT

- [ ] Approval requests (pause/resume workflows)
- [ ] Live execution timeline (GET /api/runs/:runId/events)
- [ ] Approve/reject/edit endpoints
- [ ] Run analytics

## Later milestones

- Production hardening (rate limits, audit logs, permission checks)
