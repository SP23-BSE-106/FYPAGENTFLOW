"use client";

import * as React from "react";
import {
  Shield, Activity, RefreshCw, Loader2, CheckCircle,
  XCircle, MessageSquare, AlertTriangle, ExternalLink
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/Table";
import { Modal } from "@/components/ui/Modal";
import { Textarea } from "@/components/ui/Textarea";

type Approval = {
  _id: string;
  userId: string;
  workflowRunId: string;
  taskId: string;
  requestedByAgentId: string;
  title: string;
  description: string;
  payload?: Record<string, unknown> | null;
  status: "pending" | "approved" | "rejected" | "edited" | "expired";
  response?: string;
  respondedBy?: string;
  createdAt: string | Date;
  respondedAt?: string | Date;
};

function statusVariant(status: string): "default" | "secondary" | "outline" | "success" | "warning" | "error" | "info" | "accent" {
  switch (status) {
    case "pending": return "warning";
    case "approved": return "success";
    case "rejected": return "error";
    case "edited": return "warning";
    case "expired": return "secondary";
    default: return "secondary";
  }
}

function statusClassName(status: string): string {
  switch (status) {
    case "pending": return "bg-sky-500/10 border-sky-500/20 text-sky-400 animate-pulse";
    case "approved": return "bg-emerald-500/10 border-emerald-500/20 text-emerald-400";
    case "rejected": return "bg-red-500/10 border-red-500/20 text-red-400";
    case "edited": return "bg-amber-500/10 border-amber-500/20 text-amber-400";
    case "expired": return "bg-surface-light border-border text-foreground";
    default: return "bg-surface-light border-border text-foreground";
  }
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = React.useState<Approval[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [polling, setPolling] = React.useState(false);
  const [selectedApproval, setSelectedApproval] = React.useState<Approval | null>(null);
  const [editResponse, setEditResponse] = React.useState("");

  // ── Load pending approvals ─────────────────────────────────────────────
  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/approvals", {
          credentials: "include",
        });
        if (!res.ok) throw new Error("Failed to load approvals.");
        const data = await res.json();
        if (!cancelled) setApprovals(Array.isArray(data) ? data : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // ── Poll for new approvals ─────────────────────────────────────────────
  React.useEffect(() => {
    if (!polling) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/approvals", { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          setApprovals(Array.isArray(data) ? data : []);
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [polling]);

  // ── Approve / reject / edit ────────────────────────────────────────────
  const handleDecision = async (action: "approve" | "reject" | "edit") => {
    if (!selectedApproval) return;
    const { _id: approvalId } = selectedApproval;

    const endpoint = action === "edit"
      ? `/api/approvals/${approvalId}/edit`
      : `/api/approvals/${approvalId}/${action}`;

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          response: action === "edit" ? editResponse : "",
          respondedBy: "user",
          ...(action === "edit" ? { editedPayload: selectedApproval.payload } : {}),
        }),
      });

      if (res.ok) {
        setSelectedApproval(null);
        setEditResponse("");
        // Refresh list
        const res2 = await fetch("/api/approvals", { credentials: "include" });
        if (res2.ok) {
          const data = await res2.json();
          setApprovals(Array.isArray(data) ? data : []);
        }
      } else {
        alert("Failed to process approval.");
      }
    } catch {
      alert("Approval failed.");
    }
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex h-screen items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-accent" />
        </div>
      </DashboardLayout>
    );
  }

  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending");

  return (
    <DashboardLayout>
      <div className="space-y-8 select-none text-left max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-h1 font-bold text-foreground flex items-center gap-2">
              <Shield className="h-5 w-5 text-accent" />
              Human Approvals
            </h2>
            <p className="text-xs text-muted">
              Review, approve, reject, or edit outputs that require your sign-off before a workflow can continue.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => setPolling(!polling)}
          >
            {polling ? (
              <>
                <StopIcon className="h-3.5 w-3.5 mr-1.5" />
                Stop Polling
              </>
            ) : (
              <>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Live Polling
              </>
            )}
          </Button>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <Card className="p-4">
            <div className="text-[10px] font-bold text-muted uppercase tracking-wider">Pending</div>
            <div className="mt-1 text-xl font-bold text-sky-400">{pending.length}</div>
          </Card>
          <Card className="p-4">
            <div className="text-[10px] font-bold text-muted uppercase tracking-wider">Approved</div>
            <div className="mt-1 text-xl font-bold text-emerald-400">{decided.filter((a) => a.status === "approved").length}</div>
          </Card>
          <Card className="p-4">
            <div className="text-[10px] font-bold text-muted uppercase tracking-wider">Rejected</div>
            <div className="mt-1 text-xl font-bold text-red-400">{decided.filter((a) => a.status === "rejected").length}</div>
          </Card>
          <Card className="p-4">
            <div className="text-[10px] font-bold text-muted uppercase tracking-wider">Total</div>
            <div className="mt-1 text-xl font-bold text-foreground">{approvals.length}</div>
          </Card>
        </div>

        {/* Empty state */}
        {approvals.length === 0 && (
          <Card className="p-12 text-center border-dashed border-border/60">
            <Activity className="h-12 w-12 text-muted mx-auto mb-4" />
            <h3 className="font-bold text-foreground text-sm">No approval requests</h3>
            <p className="text-xs text-muted mt-1 max-w-xs mx-auto">
              When a workflow pauses for human approval, requests will appear here.
            </p>
          </Card>
        )}

        {/* Pending approvals */}
        {pending.length > 0 && (
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <CardTitle className="text-xs font-bold text-foreground uppercase tracking-wider">
                Pending Approval
              </CardTitle>
              <Badge variant="warning">{pending.length} awaiting decision</Badge>
            </div>
            <div className="space-y-4">
              {pending.map((approval) => (
                <ApprovalCard
                  key={approval._id}
                  approval={approval}
                  onSelect={setSelectedApproval}
                />
              ))}
            </div>
          </Card>
        )}

        {/* History */}
        {decided.length > 0 && (
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <CardTitle className="text-xs font-bold text-foreground uppercase tracking-wider">
                Decision History
              </CardTitle>
              <Badge variant="secondary">{decided.length}</Badge>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-center">Decision</TableHead>
                    <TableHead className="text-right">Responded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {decided.map((approval) => (
                    <TableRow key={approval._id}>
                      <TableCell className="text-[11px] font-medium text-foreground">
                        {approval.title}
                      </TableCell>
                      <TableCell className="text-[11px] text-muted">{approval.requestedByAgentId}</TableCell>
                      <TableCell className="text-center text-[11px]">
                        <Badge variant={approval.status === "approved" ? "success" : "error"}>
                          {approval.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-[11px] text-muted">
                        {approval.respondedAt ? new Date(approval.respondedAt).toLocaleString() : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}
      </div>

      {/* Approval Action Modal */}
      <Modal
        isOpen={!!selectedApproval}
        onClose={() => setSelectedApproval(null)}
        title={selectedApproval?.title || "Approval Required"}
        description={selectedApproval?.description}
        size="lg"
      >
        <div className="space-y-5">
          {/* Payload preview */}
          <div className="rounded-lg border border-border bg-surface p-4 text-xs text-foreground/90 overflow-x-auto">
            {typeof selectedApproval?.payload === "string"
              ? selectedApproval.payload
              : JSON.stringify(selectedApproval?.payload || {}, null, 2)}
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <Button
              onClick={() => handleDecision("approve")}
              className="flex-1 bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20"
            >
              <CheckCircle className="h-4 w-4 mr-2" />
              Approve
            </Button>
            <Button
              onClick={() => handleDecision("reject")}
              className="flex-1 bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20"
            >
              <XCircle className="h-4 w-4 mr-2" />
              Reject
            </Button>
          </div>

          {/* Edit option */}
          <div className="border-t border-border/40 pt-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] font-semibold text-muted">Edit & Approve</span>
              <Textarea
                value={editResponse}
                onChange={(e) => setEditResponse(e.target.value)}
                placeholder="Add your notes or modifications…"
                rows={2}
                className="text-[10px] flex-1"
              />
            </div>
            <Button
              onClick={() => handleDecision("edit")}
              className="w-full bg-accent/10 border-accent/20 text-accent hover:bg-accent/20"
            >
              <MessageSquare className="h-4 w-4 mr-2" />
              Submit Edited Output
            </Button>
          </div>
        </div>
      </Modal>
    </DashboardLayout>
  );
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
    </svg>
  );
}

function ApprovalCard({ approval, onSelect }: { approval: Approval; onSelect: (a: Approval) => void }) {
  return (
    <div
      onClick={() => onSelect(approval)}
      className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:border-accent/30 hover:bg-accent/5 transition-colors cursor-pointer"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="outline" className="text-[9px] px-1.5 py-0.5">
            {approval.title}
          </Badge>
          <span className="text-[9px] text-muted">
            {new Date(approval.createdAt).toLocaleString()}
          </span>
        </div>
        <div className="text-[10px] text-foreground/90 leading-relaxed line-clamp-2">
          {approval.description}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[9px] text-muted">Task: {approval.taskId}</span>
          <span className="text-[9px] text-muted">Agent: {approval.requestedByAgentId}</span>
        </div>
      </div>
      <Badge variant={statusVariant(approval.status)} className={cn("text-[10px]", statusClassName(approval.status))}>
        {approval.status.charAt(0).toUpperCase() + approval.status.slice(1)}
      </Badge>
      <ExternalLink className="h-4 w-4 text-muted ml-2" />
    </div>
  );
}
