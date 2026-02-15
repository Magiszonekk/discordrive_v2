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
  Stethoscope,
  Loader2,
} from "lucide-react";
import {
  useHealthcheckScans,
  useHealthcheckProgress,
  useStartScan,
  useCancelScan,
  useDeleteScan,
  useUnhealthyFiles,
  useDiagnose,
} from "@/hooks/useHealthcheck";
import type { HealthcheckScanListItem, HealthcheckUnhealthyFile, DiagnoseResponse } from "@/lib/api";

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

// Diagnose panel
function DiagnosePanel() {
  const diagnose = useDiagnose();
  const [result, setResult] = useState<DiagnoseResponse | null>(null);

  const handleDiagnose = async () => {
    try {
      const data = await diagnose.mutateAsync({ sampleSize: 5 });
      setResult(data);
    } catch {
      // error handled by mutation
    }
  };

  const diagnosisColor = (diagnosis: string) => {
    if (diagnosis.startsWith("FILES_OK")) return "text-green-500";
    if (diagnosis.startsWith("MIXED")) return "text-yellow-500";
    return "text-red-500";
  };

  const layerIcon = (success: boolean) =>
    success ? <CheckCircle2 className="size-4 text-green-500 shrink-0" /> : <XCircle className="size-4 text-red-500 shrink-0" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Stethoscope className="size-5" />
          Diagnose
        </CardTitle>
        <CardDescription>
          Test a small sample of parts through each layer (Discord API, URL resolution, HTTP check) to pinpoint failures.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          onClick={handleDiagnose}
          disabled={diagnose.isPending}
          variant="outline"
        >
          {diagnose.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Stethoscope className="size-4" />
          )}
          {diagnose.isPending ? "Diagnosing..." : "Run Diagnostic"}
        </Button>

        {diagnose.isError && (
          <div className="text-sm text-red-500">
            {(diagnose.error as Error)?.message || "Diagnostic failed"}
          </div>
        )}

        {result && (
          <div className="space-y-4">
            {/* Diagnosis */}
            <div className={`text-sm font-semibold ${diagnosisColor(result.diagnosis)}`}>
              {result.diagnosis}
            </div>

            {/* Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
              <div className="text-center">
                <div className="text-muted-foreground">Sampled</div>
                <div className="text-lg font-semibold">{result.summary.totalSampled}</div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">Messages Found</div>
                <div className="text-lg font-semibold">{result.summary.messagesFound}</div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">URLs Resolved</div>
                <div className="text-lg font-semibold">{result.summary.urlsResolved}</div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">Fresh URLs OK</div>
                <div className="text-lg font-semibold text-green-500">{result.summary.freshUrlsHealthy}</div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">Cached URLs OK</div>
                <div className="text-lg font-semibold">{result.summary.cachedUrlsHealthy}</div>
              </div>
            </div>

            {/* Per-part results */}
            <div className="space-y-2">
              {result.results.map((r, i) => (
                <div key={i} className="border rounded-lg p-3 text-sm space-y-1">
                  <div className="font-medium text-muted-foreground">
                    Part #{r.partNumber} (file {r.fileId}, msg {r.messageId})
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                    <div className="flex items-center gap-2">
                      {layerIcon(r.messageFetch.success)}
                      <span>Message fetch{r.messageFetch.success ? ` (${r.messageFetch.attachmentCount} attachments)` : `: ${r.messageFetch.error}`}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {layerIcon(r.urlResolution.success)}
                      <span>URL resolution{!r.urlResolution.success && r.urlResolution.error ? `: ${r.urlResolution.error}` : ""}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {layerIcon(r.freshUrlCheck.success)}
                      <span>Fresh URL{r.freshUrlCheck.httpStatus ? ` (HTTP ${r.freshUrlCheck.httpStatus})` : r.freshUrlCheck.error ? `: ${r.freshUrlCheck.error}` : ": n/a"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {layerIcon(r.cachedUrlCheck.success)}
                      <span>Cached URL{r.cachedUrlCheck.httpStatus ? ` (HTTP ${r.cachedUrlCheck.httpStatus})` : r.cachedUrlCheck.error ? `: ${r.cachedUrlCheck.error}` : ""}</span>
                    </div>
                  </div>
                  {r.urlResolution.freshUrl && (
                    <div className="mt-1 pl-1">
                      <a
                        href={r.urlResolution.freshUrl as string}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-400 hover:text-blue-300 underline break-all"
                      >
                        Download fresh URL
                      </a>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
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

        {/* Diagnose Panel */}
        <DiagnosePanel />

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
