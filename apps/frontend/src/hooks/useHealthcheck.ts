"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";
import { API_BASE } from "@/lib/api";
import { getAuthToken } from "@/lib/auth-storage";

export function useHealthcheckScans() {
  return useQuery({
    queryKey: ["healthcheck-scans"],
    queryFn: () => api.getHealthcheckScans(),
  });
}

export function useHealthcheckScan(scanId: number | null) {
  return useQuery({
    queryKey: ["healthcheck-scan", scanId],
    queryFn: () => api.getHealthcheckScan(scanId!),
    enabled: scanId !== null,
  });
}

export function useUnhealthyFiles(scanId: number | null) {
  return useQuery({
    queryKey: ["healthcheck-files", scanId],
    queryFn: () => api.getUnhealthyFiles(scanId!),
    enabled: scanId !== null,
  });
}

export interface HealthcheckProgress {
  type: string;
  scanId: number;
  status: string;
  totalParts: number;
  checkedParts: number;
  healthyParts: number;
  unhealthyParts: number;
  errorParts: number;
  percent: number;
  etaMs: number | null;
  partsPerSecond: number;
}

export function useHealthcheckProgress(scanId: number | null) {
  const [progress, setProgress] = useState<HealthcheckProgress | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (scanId === null) {
      setProgress(null);
      setIsConnected(false);
      return;
    }

    const token = getAuthToken();
    const url = `${API_BASE}/healthcheck/scan/${scanId}/progress${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => setIsConnected(true);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setProgress(data);

        // When scan finishes, invalidate queries to refresh data
        if (['completed', 'cancelled', 'error'].includes(data.type || data.status)) {
          queryClient.invalidateQueries({ queryKey: ["healthcheck-scans"] });
          queryClient.invalidateQueries({ queryKey: ["healthcheck-scan", scanId] });
          queryClient.invalidateQueries({ queryKey: ["healthcheck-files", scanId] });
          es.close();
          setIsConnected(false);
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      setIsConnected(false);
      es.close();
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      setIsConnected(false);
    };
  }, [scanId, queryClient]);

  return { progress, isConnected };
}

export function useStartScan() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      scope: 'all' | 'folder' | 'file' | 'sample';
      scopeId?: number;
      samplePercent?: number;
      concurrency?: number;
    }) => api.startHealthcheckScan(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["healthcheck-scans"] });
    },
  });
}

export function useCancelScan() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (scanId: number) => api.cancelHealthcheckScan(scanId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["healthcheck-scans"] });
    },
  });
}

export function useDeleteScan() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (scanId: number) => api.deleteHealthcheckScan(scanId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["healthcheck-scans"] });
    },
  });
}
