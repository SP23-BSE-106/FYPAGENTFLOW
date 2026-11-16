"use strict";
/**
 * Task scheduler for parallel multi-agent execution (implementation plan
 * Phase 7).
 *
 * Executes a set of tasks with bounded concurrency, respecting task
 * dependencies. A task only starts once all of its `dependsOnTaskIds`
 * have completed successfully. If a dependency fails or is cancelled,
 * the dependent task is skipped (cancelled) rather than executed.
 *
 * Also enforces a run-level timeout: if the total elapsed time exceeds
 * `maxRunDurationMs`, remaining unstarted tasks are cancelled.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduleParallel = scheduleParallel;
/**
 * Run tasks with bounded concurrency and dependency awareness.
 *
 * - Tasks whose dependencies all completed become eligible.
 * - At most `maxConcurrentTasks` run at the same time.
 * - If any dependency failed or was cancelled, the dependent task is
 *   marked cancelled (not executed).
 * - If the run-level timeout is hit, all remaining tasks are cancelled.
 */
async function scheduleParallel(tasks, config) {
    const results = new Map();
    const completed = new Set();
    const failed = new Set();
    const cancelled = new Set();
    const active = new Set();
    const startTime = Date.now();
    const taskMap = new Map();
    for (const t of tasks)
        taskMap.set(t.id, t);
    const remaining = new Set(tasks.map((t) => t.id));
    const depsBlocked = (id) => {
        const task = taskMap.get(id);
        return task.dependsOnTaskIds.some((dep) => failed.has(dep) || cancelled.has(dep));
    };
    const depsMet = (id) => {
        const task = taskMap.get(id);
        return task.dependsOnTaskIds.every((dep) => completed.has(dep));
    };
    while (remaining.size > 0 || active.size > 0) {
        if (config.isCancelled && (await config.isCancelled())) {
            for (const id of remaining)
                cancelled.add(id);
            remaining.clear();
            break;
        }
        // ── Run-level timeout ────────────────────────────────────────────
        if (Date.now() - startTime > config.maxRunDurationMs) {
            for (const id of remaining)
                cancelled.add(id);
            remaining.clear();
            break;
        }
        if (config.getMessageCount && (await config.getMessageCount()) >= config.maxMessagesPerRun) {
            for (const id of remaining)
                cancelled.add(id);
            remaining.clear();
            break;
        }
        // ── Cancel tasks whose dependencies failed or were cancelled ─────
        for (const id of [...remaining]) {
            if (depsBlocked(id)) {
                cancelled.add(id);
                remaining.delete(id);
                results.set(id, {
                    nodeId: id,
                    ok: false,
                    error: 'dependency_failed',
                    durationMs: 0,
                });
            }
        }
        // ── Find eligible tasks (all deps completed) ─────────────────────
        const ready = [...remaining].filter((id) => depsMet(id));
        // ── Start tasks up to the concurrency limit ──────────────────────
        const slots = config.maxConcurrentTasks - active.size;
        const toStart = ready.slice(0, slots);
        for (const id of toStart) {
            remaining.delete(id);
            const promise = (async () => {
                try {
                    const result = await taskMap.get(id).execute();
                    results.set(id, result);
                    if (result.ok)
                        completed.add(id);
                    else
                        failed.add(id);
                }
                catch (error) {
                    failed.add(id);
                    results.set(id, {
                        nodeId: id,
                        ok: false,
                        error: String(error),
                        durationMs: 0,
                    });
                }
            })();
            active.add(promise);
            promise.finally(() => active.delete(promise));
        }
        // ── Wait for progress ────────────────────────────────────────────
        if (toStart.length === 0) {
            if (active.size === 0)
                break; // nothing can run and nothing is running
            await Promise.race([...active]);
        }
        else {
            // Yield to let the just-started promises begin executing.
            await Promise.resolve();
        }
    }
    return {
        completed: completed.size,
        failed: failed.size,
        cancelled: [...cancelled],
        results,
    };
}
