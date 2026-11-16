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

## Milestone 4: Supervisor orchestration — NEXT

- [ ] Supervisor agent that generates structured execution plans from natural language
- [ ] Plan validation (cycle detection, capability matching, permission checks)
- [ ] Dynamic delegation / reassignment

## Later milestones

- Critic/fact-checker agents, retries/fallback, human approval,
  live execution monitor, production hardening
