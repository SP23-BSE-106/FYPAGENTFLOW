"use client";

import * as React from "react";
import Link from "next/link";
import {
  Play, Loader2, Activity, List, MessageSquare,
  Shield, AlertTriangle, CheckCircle, XCircle, Zap, RefreshCw,
} from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Textarea } from "@/components/ui/Textarea";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/Table";
import { Modal } from "@/components/ui/Modal";

type Agent = {
  _id: string;
  name: string;
  role?: string;
  status?: string;
  capabilities?: Array<{ name: string; description?: string }>;
};

type OrchestrationTask = {
  _id?: string;
  id?: string;
  title: string;
  agentId?: string;
  status: string;
  durationMs?: number;
  error?: string;
};

type OrchestrationMessage = {
  _id?: string;
  id?: string;
  type: string;
  fromAgentId?: string;
  toAgentId?: string;
  text?: string;
  payload?: unknown;
  createdAt: string | Date;
};

type OrchestrationEvent = {
  _id?: string;
  type: string;
  agentId?: string;
  payload?: unknown;
  createdAt: string | Date;
};

type OrchestrationResult = {
  runId: string;
  status: string;
  output?: unknown;
  tasksCompleted: number;
  tasksFailed: number;
  messagesCreated: number;
  durationMs: number;
  tasks?: OrchestrationTask[];
  messages?: OrchestrationMessage[];
  events?: OrchestrationEvent[];
};

type Mode = "sequential" | "parallel" | "supervisor";

const MODES: Array<{ id: Mode; label: string; description: string; icon: React.FC<{ className?: string }> }> = [
  { id: "sequential", label: "Sequential", description: "Agents run one after another in order.", icon: List },
  { id: "parallel", label: "Parallel", description: "Independent agents run concurrently.", icon: Zap },
  { id: "supervisor", label: "Supervisor", description: "AI breaks the request into a task plan.", icon: Shield },
];

function getStatusColor(status: string): string {
  switch (status) {
    case "completed": return "bg-emerald-500/10 border-emerald-500/20 text-emerald-400";
    case "failed": return "bg-red-500/10 border-red-500/20 text-red-400";
    case "running": return "bg-accent/10 border-accent/20 text-accent animate-pulse";
    case "pending": return "bg-surface-light border-border text-foreground";
    case "waiting": return "bg-amber-500/10 border-amber-500/20 text-amber-400";
    case "retrying": return "bg-orange-500/10 border-orange-500/20 text-orange-400";
    case "paused": return "bg-sky-500/10 border-sky-500/20 text-sky-400";
    default: return "bg-surface-light border-border text-foreground";
  }
}

export default function OrchestratePage() {
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [loadingAgents, setLoadingAgents] = React.useState(true);

  const [input, setInput] = React.useState("");
  const [mode, setMode] = React.useState<Mode>("sequential");
  const [isRunning, setIsRunning] = React.useState(false);
  const [runResult, setRunResult] = React.useState<OrchestrationResult | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [polling, setPolling] = React.useState(false);
  const [approvalModal, setApprovalModal] = React.useState<{ approvalId: string; runId: string; title: string; description: string; payload?: unknown } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/agents", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (!cancelled) setAgents(Array.isArray(data) ? data : []);
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoadingAgents(false); });
    return () => { cancelled = true; };
  }, []);

  const handleRun = async () => {
    if (!input.trim()) return;
    const agentId = agents[0]?._id || "";
    if (!agentId) {
      setRunError("No agents available. Create one first.");
      return;
    }
    setIsRunning(true);
    setRunError(null);
    setRunResult(null);

    try {
      const res = await fetch("/api/orchestrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ agentId, input, mode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRunError(data.error || "Orchestration failed.");
        return;
      }
      setRunResult(data);
      setPolling(true);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Failed to run workflow.");
    } finally {
      setIsRunning(false);
    }
  };

  React.useEffect(() => {
    if (!polling || !runResult?.runId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/runs/${runResult.runId}/events`, {
          credentials: "include",
        });
        if (res.ok) {
          const events = await res.json();
          setRunResult((prev: OrchestrationResult | null) => (prev ? { ...prev, events } : prev));
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [polling, runResult?.runId]);

  const handleApproval = async (action: "approve" | "reject" | "edit", editedPayload?: unknown) => {
    if (!approvalModal) return;
    const { approvalId } = approvalModal;
    const endpoint = action === "edit"
      ? `/api/approvals/${approvalId}/edit`
      : `/api/approvals/${approvalId}/${action}`;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          response: action === "edit" ? "Edited by user" : "",
          respondedBy: "user",
          ...(action === "edit" ? { editedPayload } : {}),
        }),
      });
      if (res.ok) {
        setApprovalModal(null);
        if (runResult?.runId) {
          const runRes = await fetch(`/api/runs/${runResult.runId}`, { credentials: "include" });
          if (runRes.ok) {
            const runData = await runRes.json();
            setRunResult((prev: OrchestrationResult | null) => (prev ? { ...prev, ...runData } : prev));
          }
        }
      } else {
        alert("Failed to process approval.");
      }
    } catch {
      alert("Approval failed.");
    }
  };

  if (loadingAgents) {
    return (
      <DashboardLayout>
        <div className="flex h-screen items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-accent" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-8 select-none text-left max-w-6xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-h1 font-bold text-foreground flex items-center gap-2">
              <Zap className="h-5 w-5 text-accent" />
              Multi-Agent Orchestration
            </h2>
            <p className="text-xs text-muted">
              Run workflows with multiple cooperating agents. Choose sequential, parallel, or supervisor mode.
            </p>
          </div>
          <Link href="/dashboard/agents">
            <Button variant="secondary" size="sm">
              Manage Agents
            </Button>
          </Link>
        </div>

        {runError && (
          <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {runError}
          </div>
        )}

        <Card className="p-6">
          <div className="space-y-5">
            <div className="space-y-1">
              <CardTitle className="text-xs font-bold text-foreground uppercase tracking-wider">
                Execute Workflow
              </CardTitle>
              <CardDescription className="text-[10px]">
                Select an agent, enter your request, and choose an execution mode.
              </CardDescription>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
              <div className="space-y-2">
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                  Agent
                </label>
                <select
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30"
                  value={agents[0]?._id || ""}
                  disabled
                >
                  {agents.map((a) => (
                    <option key={a._id} value={a._id}>
                      {a.name} ({a.role || "general"})
                    </option>
                  ))}
                </select>
                {agents.length === 0 && (
                  <p className="text-[10px] text-red-400">No agents found. Create one first.</p>
                )}
              </div>

              <div className="space-y-2 lg:col-span-2">
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                  Your Request
                </label>
                <Textarea
                  placeholder="e.g., Review this company policy and identify compliance risks."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  rows={3}
                  className="text-xs"
                  disabled={isRunning}
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                  Execution Mode
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setMode(m.id)}
                      className={
                        mode === m.id
                          ? "flex flex-col items-center gap-1.5 p-2.5 rounded-lg border border-accent bg-accent-muted/20 text-accent text-xs transition-all"
                          : "flex flex-col items-center gap-1.5 p-2.5 rounded-lg border border-border/60 text-muted text-xs hover:border-accent/20 transition-all"
                      }
                    >
                      <m.icon className="h-4 w-4" />
                      <span className="font-semibold">{m.label}</span>
                      <span className="text-[9px] opacity-70">{m.description}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-end">
                <Button
                  onClick={handleRun}
                  isLoading={isRunning}
                  disabled={isRunning || !agents.length || !input.trim()}
                  className="w-full"
                >
                  {isRunning ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Running…
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Play className="h-4 w-4 mr-2" />
                      Execute Workflow
                    </span>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </Card>

        {runResult && (
          <div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              {[
                { label: "Status", value: runResult.status },
                { label: "Tasks Completed", value: runResult.tasksCompleted },
                { label: "Tasks Failed", value: runResult.tasksFailed },
                { label: "Messages", value: runResult.messagesCreated },
                { label: "Duration", value: `${runResult.durationMs} ms` },
              ].map((stat, i) => {
                const statusColor = runResult.status === "completed" ? "text-emerald-400" :
                  runResult.status === "failed" ? "text-red-400" :
                  runResult.status === "paused" ? "text-sky-400" : "text-muted";
                return (
                  <Card key={i} className="p-4">
                    <div className="text-[10px] font-bold text-muted uppercase tracking-wider mb-1">
                      {stat.label}
                    </div>
                    <div className={"text-lg font-bold " + statusColor}>
                      {stat.value}
                    </div>
                  </Card>
                );
              })}
            </div>

            <Card className="p-5">
              <div className="flex items-center justify-between mb-4">
                <CardTitle className="text-xs font-bold text-foreground uppercase tracking-wider">
                  Final Output
                </CardTitle>
                <Badge variant={
                  runResult.status === "completed" ? "success" :
                  runResult.status === "failed" ? "error" : "warning"
                }>
                  {runResult.status.charAt(0).toUpperCase() + runResult.status.slice(1)}
                </Badge>
              </div>
              <div className="rounded-lg border border-border bg-surface p-4 text-[11px] font-mono text-foreground/90 overflow-x-auto">
                {typeof runResult.output === "string"
                  ? runResult.output
                  : JSON.stringify(runResult.output, null, 2)}
              </div>
            </Card>

            {(runResult.tasks?.length ?? 0) > 0 && (
              <Card className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <CardTitle className="text-xs font-bold text-foreground uppercase tracking-wider">
                    Tasks
                  </CardTitle>
                  <Badge variant="info">{runResult.tasks?.length ?? 0}</Badge>
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Task</TableHead>
                        <TableHead>Agent</TableHead>
                        <TableHead className="text-center">Status</TableHead>
                        <TableHead className="text-right">Duration</TableHead>
                        <TableHead>Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(runResult.tasks || []).map((task: OrchestrationTask) => (
                        <TableRow key={task._id || task.id}>
                          <TableCell className="text-[11px] font-medium text-foreground">
                            {task.title}
                          </TableCell>
                          <TableCell className="text-[11px] text-muted">{task.agentId || "system"}</TableCell>
                          <TableCell className="text-center text-[11px]">
                            <Badge variant="secondary" className={getStatusColor(task.status)}>
                              {task.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right text-[11px] tabular-nums text-muted">
                            {task.durationMs ? `${task.durationMs}ms` : "—"}
                          </TableCell>
                          <TableCell className="text-[11px] text-red-400 max-w-[200px] truncate">
                            {task.error || "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Card>
            )}

            {(runResult.messages?.length ?? 0) > 0 && (
              <Card className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <CardTitle className="text-xs font-bold text-foreground uppercase tracking-wider">
                    Agent Messages
                  </CardTitle>
                  <Badge variant="info">{runResult.messages?.length ?? 0}</Badge>
                </div>
                <div className="space-y-3">
                  {(runResult.messages || []).map((msg: OrchestrationMessage) => (
                    <div
                      key={msg._id || msg.id}
                      className="rounded-lg border border-border/50 bg-surface p-3 text-xs"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0.5">
                          {msg.type}
                        </Badge>
                        <span className="text-[9px] text-muted">{msg.fromAgentId || "system"}</span>
                        {msg.toAgentId && (
                          <span className="text-[9px] text-accent">→ {msg.toAgentId}</span>
                        )}
                        <span className="ml-auto text-[9px] text-muted">
                          {new Date(msg.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="text-[11px] text-foreground/90 leading-relaxed">
                        {msg.text || JSON.stringify(msg.payload || {})}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {(runResult.events?.length ?? 0) > 0 && (
              <Card className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <CardTitle className="text-xs font-bold text-foreground uppercase tracking-wider">
                    Live Timeline
                  </CardTitle>
                  <Button size="sm" onClick={() => setPolling(!polling)}>
                    {polling ? (
                      <span className="flex items-center gap-2">
                        <span className="h-3.5 w-3.5 rounded-full border-2 border-current">​</span>
                        Stop Polling
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                        Live Polling
                      </span>
                    )}
                  </Button>
                </div>
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {(runResult.events || []).map((evt: OrchestrationEvent) => (
                    <div
                      key={evt._id || evt.type + evt.createdAt}
                      className="flex items-start gap-3 p-2 rounded-lg border border-transparent hover:border-border/50 transition-colors"
                    >
                      <div className="flex items-center gap-1 text-[10px] text-muted mt-0.5 shrink-0">
                        <Activity className="h-3 w-3" />
                        <span className="text-[9px]">{new Date(evt.createdAt).toLocaleTimeString()}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-semibold text-foreground truncate">{evt.type}</span>
                          {evt.agentId && (
                            <Badge variant="secondary" className="text-[9px] px-1.5 py-0.5">
                              {evt.agentId}
                            </Badge>
                          )}
                        </div>
                        {!!evt.payload && (
                          <div className="text-[10px] text-muted mt-1 leading-relaxed">
                            {typeof evt.payload === "string"
                              ? (evt.payload as string)
                              : JSON.stringify(evt.payload as Record<string, unknown>)}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {(runResult.status === "paused") && (
              <div className="mt-4">
                <Button onClick={() => {
                  setApprovalModal({
                    approvalId: runResult.runId,
                    runId: runResult.runId,
                    title: "Workflow Paused",
                    description: "The workflow is waiting for your approval to continue.",
                    payload: runResult.output,
                  });
                }}
                className="flex-1 bg-sky-500/10 border-sky-500/20 text-sky-400 hover:bg-sky-500/20"
              >
                Review Pending Approval
                </Button>
              </div>
            )}
          </div>
        )}

        {!runResult && (
          <Card className="p-12 text-center border-dashed border-border/60">
            <Activity className="h-12 w-12 text-muted mx-auto mb-4" />
            <h3 className="font-bold text-foreground text-sm">No runs yet</h3>
            <p className="text-xs text-muted mt-1 max-w-xs mx-auto">
              Create an agent, then run a multi-agent workflow here. You&apos;ll see tasks, messages, and the full execution timeline.
            </p>
          </Card>
        )}

        <Modal
          isOpen={!!approvalModal}
          onClose={() => setApprovalModal(null)}
          title={approvalModal?.title || "Approval Required"}
          description={approvalModal?.description}
          size="lg"
        >
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-surface p-3 text-xs text-foreground/90">
              {typeof approvalModal?.payload === "string"
                ? approvalModal.payload
                : JSON.stringify(approvalModal?.payload || {}, null, 2)}
            </div>
            <div className="flex gap-3">
              <Button
                onClick={() => handleApproval("approve")}
                className="flex-1 bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20"
              >
                <CheckCircle className="h-4 w-4 mr-2" />
                Approve
              </Button>
              <Button
                onClick={() => handleApproval("reject")}
                className="flex-1 bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20"
              >
                <XCircle className="h-4 w-4 mr-2" />
                Reject
              </Button>
              <Button
                onClick={() => handleApproval("edit", approvalModal?.payload)}
                className="flex-1 bg-accent/10 border-accent/20 text-accent hover:bg-accent/20"
              >
                <MessageSquare className="h-4 w-4 mr-2" />
                Edit & Approve
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </DashboardLayout>
  );
}
