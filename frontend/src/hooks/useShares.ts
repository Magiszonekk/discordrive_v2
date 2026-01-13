"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShareLink, ShareResourceType } from "@/types";
import * as api from "@/lib/api";

interface ShareResource {
  type: ShareResourceType;
  id: number;
}

export function useShareLinks(resource?: ShareResource, options?: { enabled?: boolean }) {
  const enabled = !!resource && (options?.enabled ?? true);

  return useQuery<ShareLink[]>({
    queryKey: resource ? ["shares", resource.type, resource.id] : ["shares", "none"],
    queryFn: async () => {
      if (!resource) return [];
      if (resource.type === "file") {
        return api.getFileShares(resource.id);
      }
      return api.getFolderShares(resource.id);
    },
    enabled,
  });
}

export function useCreateShareLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { fileId?: number; folderId?: number; encryptedKey: string; encryptedKeySalt: string; keyWrapMethod?: string; requirePassword?: boolean; allowInsecure?: boolean; urlKey?: string | null; mediaWidth?: number | null; mediaHeight?: number | null; allowEmbed?: boolean }) =>
      api.createShareLink(params),
    onSuccess: (_data, variables) => {
      if (variables.fileId != null) {
        queryClient.invalidateQueries({ queryKey: ["shares", "file", variables.fileId] });
      }
      if (variables.folderId != null) {
        queryClient.invalidateQueries({ queryKey: ["shares", "folder", variables.folderId] });
      }
    },
  });
}

export function useDeleteShareLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { id: number; resource?: ShareResource }) => api.deleteShareLink(params.id),
    onSuccess: (_data, variables) => {
      const { resource } = variables;
      if (resource) {
        queryClient.invalidateQueries({ queryKey: ["shares", resource.type, resource.id] });
      }
    },
  });
}
