"use client";

import { useMemo, useState } from "react";
import { Share2, Copy, ExternalLink, Trash2, Loader2, Link2, Check, Shield, AlertTriangle, Video } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShareResourceType } from "@/types";
import { useShareLinks, useCreateShareLink, useDeleteShareLink } from "@/hooks/useShares";
import { getSharePublicUrl } from "@/lib/api";
import { toast } from "sonner";
import { Separator } from "@/components/ui/separator";
import { encryptKeyWithPassword, getStoredKey, toUrlSafeBase64 } from "@/lib/crypto-client";
import { Label } from "@/components/ui/label";

interface ShareDialogProps {
  resourceType: ShareResourceType;
  resourceId: number;
  resourceName: string;
  mimeType?: string | null;
  mediaWidth?: number | null;
  mediaHeight?: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareDialog({ resourceType, resourceId, resourceName, mimeType, mediaWidth, mediaHeight, open, onOpenChange }: ShareDialogProps) {
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [revokeAllPending, setRevokeAllPending] = useState(false);
  const [sharePassword, setSharePassword] = useState("");
  const [embedKey, setEmbedKey] = useState(false);
  const [allowEmbed, setAllowEmbed] = useState(true);
  const [lastCreatedLink, setLastCreatedLink] = useState<string | null>(null);
  const [lastCreatedId, setLastCreatedId] = useState<number | null>(null);

  // Check if this is a media file that can have embeds
  const isMediaFile = resourceType === "file" && mimeType && (mimeType.startsWith("video/") || mimeType.startsWith("image/"));

  // Use dimensions from file (captured during upload)
  const hasDimensions = mediaWidth != null && mediaHeight != null;
  const shareQuery = useShareLinks(
    { type: resourceType, id: resourceId },
    { enabled: open }
  );
  const createShare = useCreateShareLink();
  const deleteShare = useDeleteShareLink();

  const shares = shareQuery.data ?? [];

  const resourceLabel = useMemo(() => (resourceType === "file" ? "file" : "folder"), [resourceType]);

  const handleCreateShare = async () => {
    try {
      const key = getStoredKey();
      if (!key) {
        toast.error("Brak klucza szyfrującego w przeglądarce");
        return;
      }

      const cryptoApi = typeof window !== "undefined" && window.crypto ? window.crypto : null;
      const secret = embedKey
        ? (() => {
            if (!cryptoApi) {
              throw new Error("Brak wsparcia crypto w przeglądarce");
            }
            const bytes = new Uint8Array(16);
            cryptoApi.getRandomValues(bytes);
            const base64 = btoa(String.fromCharCode(...bytes));
            return toUrlSafeBase64(base64);
          })()
        : sharePassword.trim();

      if (!secret) {
        toast.error("Podaj hasło do share albo włącz osadzenie klucza w linku");
        return;
      }

      const { encryptedKey, salt } = await encryptKeyWithPassword(key, secret);

      // Dimensions are passed from file (captured during upload) - backend will also fall back to file dimensions
      const payload =
        resourceType === "file"
          ? { fileId: resourceId, encryptedKey, encryptedKeySalt: salt, keyWrapMethod: "pbkdf2-aes-gcm-100k", requirePassword: !embedKey, allowInsecure: embedKey, urlKey: embedKey ? secret : null, mediaWidth: mediaWidth ?? null, mediaHeight: mediaHeight ?? null, allowEmbed }
          : { folderId: resourceId, encryptedKey, encryptedKeySalt: salt, keyWrapMethod: "pbkdf2-aes-gcm-100k", requirePassword: !embedKey, allowInsecure: embedKey, urlKey: embedKey ? secret : null, mediaWidth: null, mediaHeight: null, allowEmbed };

      const share = await createShare.mutateAsync(payload);
      const baseUrl = getSharePublicUrl(share.token);
      const fullUrl = embedKey ? `${baseUrl}?k=${encodeURIComponent(secret)}` : baseUrl;
      setLastCreatedLink(fullUrl);
      setLastCreatedId(share.id);

      // Auto-copy to clipboard for embedded key links
      if (embedKey) {
        try {
          await navigator.clipboard.writeText(fullUrl);
          toast.success("Link z kluczem utworzony i skopiowany do schowka!", { duration: 5000 });
        } catch {
          toast.success("Link z kluczem utworzony - skopiuj go poniżej!", { duration: 5000 });
        }
      } else {
        toast.success("Link utworzony - wymaga hasła");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create share link");
    }
  };

  const handleCopy = async (share: { id: number; token: string; allowInsecure?: boolean; urlKey?: string | null }) => {
    const baseUrl = getSharePublicUrl(share.token);
    const url = share.allowInsecure && share.urlKey
      ? `${baseUrl}?k=${encodeURIComponent(share.urlKey)}`
      : (lastCreatedLink && lastCreatedId === share.id ? lastCreatedLink : baseUrl);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(share.id);
      toast.success("Link copied to clipboard");
      setTimeout(() => setCopiedId((current) => (current === share.id ? null : current)), 2000);
    } catch {
      toast.error("Failed to copy link");
    }
  };

  const handleOpenLink = (share: { token: string; allowInsecure?: boolean; urlKey?: string | null }) => {
    const baseUrl = getSharePublicUrl(share.token);
    const url = share.allowInsecure && share.urlKey
      ? `${baseUrl}?k=${encodeURIComponent(share.urlKey)}`
      : baseUrl;
    window.open(url, "_blank");
  };

  const handleDelete = async (shareId: number) => {
    try {
      await deleteShare.mutateAsync({ id: shareId, resource: { type: resourceType, id: resourceId } });
      toast.success("Share link revoked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke link");
    }
  };

  const handleRevokeAll = async () => {
    if (!shares.length) return;
    setRevokeAllPending(true);
    try {
      await Promise.all(
        shares.map((share) =>
          deleteShare.mutateAsync({ id: share.id, resource: { type: resourceType, id: resourceId } })
        )
      );
      toast.success("All share links revoked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke all links");
    } finally {
      setRevokeAllPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-5 w-5" />
            Share {resourceType === "file" ? "File" : "Folder"}
          </DialogTitle>
          <DialogDescription>
            Generate secure public links for <span className="font-medium text-foreground">{resourceName}</span>.
            Anyone with the link can download this {resourceLabel}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Shield className="h-4 w-4 text-primary" />
              Dostęp do share
            </div>
            <Label htmlFor="share-password" className="text-xs text-muted-foreground">
              Podaj hasło (bezpieczniej) lub włącz osadzenie klucza w linku (mniej bezpieczne).
            </Label>
            <Input
              id="share-password"
              type="password"
              value={sharePassword}
              onChange={(e) => setSharePassword(e.target.value)}
              placeholder="Hasło do share"
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={embedKey}
                onChange={(e) => setEmbedKey(e.target.checked)}
                className="h-4 w-4"
              />
              <span>Osadź klucz w linku (bez pytania o hasło)</span>
            </label>
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5" />
              <span>Osadzony klucz oznacza, że każdy z linkiem pobierze plik bez hasła. Używaj tylko dla niekrytycznych danych.</span>
            </div>
            {isMediaFile && embedKey && (
              <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={allowEmbed}
                    onChange={(e) => setAllowEmbed(e.target.checked)}
                    className="h-4 w-4"
                  />
                  <Video className="h-4 w-4 text-primary" />
                  <span>Włącz embed (podgląd w Discord/social media)</span>
                </label>
                {hasDimensions ? (
                  <div className="text-xs text-muted-foreground">
                    Wymiary: {mediaWidth}×{mediaHeight}px
                  </div>
                ) : (
                  <div className="text-xs text-amber-400">
                    Wymiary niedostępne (plik uploadowany przed wprowadzeniem tej funkcji)
                  </div>
                )}
              </div>
            )}
            {lastCreatedLink && (
              <div className="rounded-md border border-green-500/50 bg-green-500/10 p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-green-400">
                  <Check className="h-4 w-4" />
                  Link utworzony!
                </div>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={lastCreatedLink}
                    className="font-mono text-xs flex-1"
                  />
                  <Button
                    variant="secondary"
                    size="icon"
                    className="shrink-0"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(lastCreatedLink);
                        toast.success("Link skopiowany!");
                      } catch {
                        toast.error("Nie udało się skopiować");
                      }
                    }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>

          <Button
            onClick={handleCreateShare}
            disabled={createShare.isPending}
            className="w-full"
          >
            {createShare.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Creating link...
              </>
            ) : (
              <>
                <Link2 className="h-4 w-4 mr-2" />
                Create new share link
              </>
            )}
          </Button>

          <Separator />

          {shareQuery.isLoading ? (
            <div className="py-6 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading share links...
            </div>
          ) : shares.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No share links yet. Create one to get started.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={handleRevokeAll}
                  disabled={revokeAllPending}
                >
                  {revokeAllPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4 mr-2" />
                  )}
                  Revoke all links
                </Button>
              </div>
              {shares.map((share) => {
                // For insecure shares with stored urlKey, show full URL with key
                const baseUrl = getSharePublicUrl(share.token);
                const url = share.allowInsecure && share.urlKey
                  ? `${baseUrl}?k=${encodeURIComponent(share.urlKey)}`
                  : baseUrl;
                return (
                  <div
                    key={share.id}
                    className="rounded-md border p-3 space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>Created {new Date(share.createdAt).toLocaleString()}</span>
                      <span>Accessed {share.accessCount} {share.accessCount === 1 ? "time" : "times"}</span>
                    </div>
                    <div className="flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.08em]">
                      {share.requirePassword && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-foreground/80">Password required</span>
                      )}
                      {share.allowInsecure && (
                        <span className="rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">Key in link</span>
                      )}
                    </div>

                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input readOnly value={url} className="font-mono text-xs" />
                      <div className="flex gap-2">
                        <Button
                          variant="secondary"
                          size="icon"
                          className="shrink-0"
                          onClick={() => handleCopy(share)}
                        >
                          {copiedId === share.id ? (
                            <Check className="h-4 w-4" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          className="shrink-0"
                          onClick={() => handleOpenLink(share)}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleDelete(share.id)}
                        disabled={deleteShare.isPending}
                      >
                        {deleteShare.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4 mr-2" />
                        )}
                        Revoke
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
