# TODO

## Milestone 1: Communication foundation (implementation plan) — DONE

- [x] Inspect current MongoDB usage (collections + schema/types)
- [x] Extend `Agent` type with roles + capabilities (`src/lib/mongo/agent.ts`)
- [x] Add MongoDB collection type definitions (agentTasks, agentMessages, sharedContexts, executionEvents, agentEvaluations, approvalRequests)
- [x] Add lazy index creation (`src/lib/mongo/indices.ts`)
- [x] Extend `/api/dev/init-collections` to create the 6 new collections
- [x] API persistence (`src/app/api/runs/[[...path]]` route + handler)
- [x] Agent capabilities CRUD (`src/app/api/agents/capabilities/handler.ts`)
- [x] Index migration notes (`doc/MULTI_AGENT_DB_INDEXES.md`)
- [x] `tsc --noEmit` passes; eslint clean on new files

## Milestone 2: Sequential multi-agent execution — DONE

- [x] Orchestration types (`src/lib/orchestration/types.ts`)
  - OrchestrationRequest, OrchestrationResult, AgentExecutionContext, NodeExecutionResult, ResolvedNode
- [x] Dependency resolver (`src/lib/orchestration/dependencyResolver.ts`)
  - topologicalSort (Kahn's algorithm), hasCycle
- [x] Context manager (`src/lib/orchestration/contextManager.ts`)
  - getSharedContext, updateSharedContext, addDecision
- [x] Message bus (`src/lib/orchestration/messageBus.ts`)
  - createMessage, listMessages
- [x] Task manager (`src/lib/orchestration/taskManager.ts`)
  - createTask, updateTaskStatus, completeTask, failTask, listTasks
- [x] Orchestrator engine (`src/lib/orchestration/orchestrator.ts`)
  - `orchestrate()` — load agent/workflow → create run → topological sort → execute nodes sequentially → persist tasks/messages/context/events → finalise run
  - Each node receives `{ originalInput, previousResults, sharedContext, relevantMessages }` (Phase 6 input shape)
  - Agent system prompt + LLM call via existing `chatCompletion` with provider fallback
- [x] API endpoint (`src/app/api/orchestrate/route.ts`)
  - POST /api/orchestrate — { agentId, input, mode? } → runs orchestration
- [x] `tsc --noEmit` passes; eslint clean on new files

## Milestone 3: Parallel execution — NEXT

- [ ] Task scheduler with bounded concurrency
- [ ] Independent branch detection + aggregator behavior
- [ ] Parallel visualization in the sandbox

## Later milestones

- Supervisor delegation, critic/fact-checker, retries/fallback,
  human approval, live execution monitor, production hardening
