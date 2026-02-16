"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";

export function useFiles(folderId?: number | null, page: number = 1, limit: number = 50) {
  return useQuery({
    queryKey: ["files", folderId ?? "root", page, limit],
    queryFn: () => api.getFiles(folderId, page, limit),
  });
}

export function useUpdateFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number;
      data: { folderId?: number | null; originalName?: string };
    }) => api.updateFile(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

export function useDeleteFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => api.deleteFile(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

export function useReorderFiles() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ folderId, orderedIds }: { folderId: number | null; orderedIds: number[] }) =>
      api.reorderFiles(folderId, orderedIds),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["files", variables.folderId ?? "root"] });
    },
  });
}
