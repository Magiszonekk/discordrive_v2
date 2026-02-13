"use client";

import { useState } from "react";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  ArrowLeft,
  Activity,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Play,
  Zap,
  Square,
  Trash2,
  FileWarning,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  useHealthcheckScans,
  useHealthcheckProgress,
  useStartScan,
  useCancelScan,
  useDeleteScan,
  useUnhealthyFiles,
} from "@/hooks/useHealthcheck";
import type { HealthcheckScanListItem, HealthcheckUnhealthyFile } from "@/lib/api";

function formatDuration(ms: number | null | undefined): string {
  if (!ms) return "-";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleString();
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="size-4 text-green-500" />;
    case "running":
      return <Activity className="size-4 text-blue-500 animate-pulse" />;
    case "cancelled":
      return <AlertTriangle className="size-4 text-yellow-500" />;
    case "error":
      return <XCircle className="size-4 text-red-500" />;
    default:
      return <Activity className="size-4 text-muted-foreground" />;
  }
}

function HealthPercent({ percent }: { percent: number }) {
  const color =
    percent >= 99.9 ? "text-green-500" :
    percent >= 95 ? "text-yellow-500" :
    "text-red-500";
  return <span className={`font-bold ${color}`}>{percent.toFixed(2)}%</span>;
}

// Active scan progress panel
function ActiveScanPanel({ scanId }: { scanId: number }) {
  const { progress } = useHealthcheckProgress(scanId);
  const cancelScan = useCancelScan();

  if (!progress) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-5 animate-pulse" />
            Connecting...
          </CardTitle>
        </CardHeader>
      </Card>
    );
  }

  const isRunning = progress.status === "running" || progress.type === "progress";
  const isDone = ["completed", "cancelled", "error"].includes(progress.status) ||
    ["completed", "cancelled", "error"].includes(progress.type);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {isDone ? (
            <>
              <StatusIcon status={progress.status || progress.type} />
              Scan {progress.status || progress.type}
            </>
          ) : (
            <>
              <Activity className="size-5 text-blue-500 animate-pulse" />
              Scanning CDN...
            </>
          )}
        </CardTitle>
        <CardDescription>
          {progress.checkedParts} / {progress.totalParts} chunks checked
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress value={progress.percent} className="h-3" />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground">Healthy</div>
            <div className="text-lg font-semibold text-green-500">{progress.healthyParts}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Unhealthy</div>
            <div className="text-lg font-semibold text-red-500">{progress.unhealthyParts}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Errors</div>
            <div className="text-lg font-semibold text-yellow-500">{progress.errorParts}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Speed</div>
            <div className="text-lg font-semibold">{progress.partsPerSecond}/s</div>
          </div>
        </div>

        {isRunning && progress.etaMs && (
          <div className="text-sm text-muted-foreground">
            ETA: {formatDuration(progress.etaMs)}
          </div>
        )}

        {isRunning && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => cancelScan.mutate(scanId)}
            disabled={cancelScan.isPending}
          >
            <Square className="size-4" />
            Cancel Scan
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// Unhealthy files list for a completed scan
function UnhealthyFilesList({ scanId }: { scanId: number }) {
  const { data, isLoading } = useUnhealthyFiles(scanId);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading results...</div>;
  if (!data?.files?.length) return null;

  const toggle = (fileId: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileWarning className="size-5 text-red-500" />
          Unhealthy Files ({data.files.length})
        </CardTitle>
        <CardDescription>
          Files with missing or inaccessible chunks on Discord CDN
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {data.files.map((file: HealthcheckUnhealthyFile) => (
            <div key={file.fileId} className="border rounded-lg p-3">
              <button
                className="flex items-center gap-2 w-full text-left"
                onClick={() => toggle(file.fileId)}
              >
                {expanded.has(file.fileId)
                  ? <ChevronDown className="size-4 shrink-0" />
                  : <ChevronRight className="size-4 shrink-0" />
                }
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{file.fileName}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatSize(file.fileSize)} &middot; {file.missingParts}/{file.totalParts} chunks missing
                  </div>
                </div>
                <span className="text-sm font-semibold text-red-500 shrink-0">
                  {file.missingParts} missing
                </span>
              </button>
              {expanded.has(file.fileId) && (
                <div className="mt-2 pl-6 text-sm text-muted-foreground">
                  Missing chunk numbers: {file.missingPartNumbers.join(", ")}
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Scan history table
function ScanHistory({
  scans,
  onSelect,
  selectedScanId,
}: {
  scans: HealthcheckScanListItem[];
  onSelect: (id: number) => void;
  selectedScanId: number | null;
}) {
  const deleteScan = useDeleteScan();

  if (!scans.length) {
    return (
      <div className="text-sm text-muted-foreground text-center py-8">
        No scans yet. Run your first healthcheck above.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {scans.map((scan) => (
        <div
          key={scan.id}
          className={`border rounded-lg p-3 cursor-pointer transition-colors hover:bg-accent/50 ${
            selectedScanId === scan.id ? "border-primary bg-accent/30" : ""
          }`}
          onClick={() => onSelect(scan.id)}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <StatusIcon status={scan.status} />
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {scan.scope === "sample" ? `Sample ${scan.samplePercent}%` : scan.scope === "all" ? "Full scan" : `${scan.scope} #${scan.scopeId}`}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatDate(scan.startedAt || scan.createdAt)}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div className="text-right">
                <div className="text-sm">
                  <HealthPercent percent={scan.healthPercent} />
                </div>
                <div className="text-xs text-muted-foreground">
                  {scan.checkedParts}/{scan.totalParts}
                </div>
              </div>
              {scan.status !== "running" && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteScan.mutate(scan.id);
                  }}
                  disabled={deleteScan.isPending}
                >
                  <Trash2 className="size-4 text-muted-foreground" />
                </Button>
              )}
            </div>
          </div>
          {scan.unhealthyParts > 0 && (
            <div className="mt-1 text-xs text-red-500">
              {scan.unhealthyParts} unhealthy + {scan.errorParts} errors
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function HealthPage() {
  const { data: scansData, isLoading } = useHealthcheckScans();
  const startScan = useStartScan();
  const [activeScanId, setActiveScanId] = useState<number | null>(null);
  const [selectedScanId, setSelectedScanId] = useState<number | null>(null);

  const scans = scansData?.scans || [];
  const runningScan = scans.find((s) => s.status === "running");
  const currentActiveScanId = activeScanId || runningScan?.id || null;

  const handleStartScan = async (scope: "all" | "sample", samplePercent?: number) => {
    try {
      const result = await startScan.mutateAsync({
        scope,
        samplePercent,
      });
      setActiveScanId(result.scanId);
      setSelectedScanId(result.scanId);
    } catch {
      // error handled by mutation
    }
  };

  // If active scan completed, show its results
  const viewScanId = selectedScanId || (scans.length > 0 ? scans[0]?.id : null);
  const viewScan = scans.find((s) => s.id === viewScanId);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {/* Navigation */}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/">
              <ArrowLeft className="size-4" />
              Back
            </Link>
          </Button>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="size-6" />
            CDN Healthcheck
          </h1>
        </div>

        {/* Control Panel */}
        <Card>
          <CardHeader>
            <CardTitle>Start Scan</CardTitle>
            <CardDescription>
              Verify that your file chunks are still accessible on Discord CDN.
              HEAD requests are used to check each chunk without downloading data.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            <Button
              onClick={() => handleStartScan("sample", 5)}
              disabled={!!currentActiveScanId || startScan.isPending}
            >
              <Zap className="size-4" />
              Quick Check (5%)
            </Button>
            <Button
              variant="outline"
              onClick={() => handleStartScan("all")}
              disabled={!!currentActiveScanId || startScan.isPending}
            >
              <Play className="size-4" />
              Full Scan
            </Button>
            {startScan.isError && (
              <div className="text-sm text-red-500 self-center">
                {(startScan.error as Error)?.message || "Failed to start scan"}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Active Scan Progress */}
        {currentActiveScanId && (
          <ActiveScanPanel scanId={currentActiveScanId} />
        )}

        {/* Results for selected scan */}
        {viewScan && viewScan.status === "completed" && viewScan.unhealthyParts > 0 && (
          <UnhealthyFilesList scanId={viewScan.id} />
        )}

        {/* Summary card for selected completed scan */}
        {viewScan && viewScan.status === "completed" && viewScan.unhealthyParts === 0 && viewScan.checkedParts > 0 && (
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <CheckCircle2 className="size-8 text-green-500" />
              <div>
                <div className="font-semibold text-green-500">All chunks healthy</div>
                <div className="text-sm text-muted-foreground">
                  {viewScan.checkedParts} chunks verified &middot; {formatDate(viewScan.completedAt)}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Scan History */}
        <Card>
          <CardHeader>
            <CardTitle>Scan History</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-sm text-muted-foreground">Loading...</div>
            ) : (
              <ScanHistory
                scans={scans}
                onSelect={setSelectedScanId}
                selectedScanId={viewScanId}
              />
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
