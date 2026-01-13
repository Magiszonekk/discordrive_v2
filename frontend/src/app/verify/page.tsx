"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { API_BASE } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck, XCircle } from "lucide-react";

export default function VerifyPage() {
  return (
    <Suspense fallback={<VerifySkeleton />}>
      <VerifyContent />
    </Suspense>
  );
}

function VerifyContent() {
  const search = useSearchParams();
  const token = search.get("token");
  const [status, setStatus] = useState<"pending" | "success" | "error">("pending");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    const run = async () => {
      if (!token) {
        setStatus("error");
        setMessage("Missing verification token.");
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/auth/verify?token=${encodeURIComponent(token)}`);
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          setStatus("success");
          setMessage(data.message || "Your account has been verified. You can log in now.");
        } else {
          setStatus("error");
          setMessage(data.message || data.error || "Verification failed.");
        }
      } catch (err) {
        setStatus("error");
        setMessage(err instanceof Error ? err.message : "Verification failed.");
      }
    };
    run();
  }, [token]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-muted/30">
      <div className="max-w-md w-full space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3">
          {status === "success" ? (
            <ShieldCheck className="h-6 w-6 text-green-600" />
          ) : status === "error" ? (
            <XCircle className="h-6 w-6 text-destructive" />
          ) : (
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          )}
          <div>
            <h1 className="text-lg font-semibold">Email verification</h1>
            <p className="text-sm text-muted-foreground">Confirming your account…</p>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">{message || "Hang tight while we verify your token."}</p>

        <div className="flex gap-2">
          <Button asChild variant="secondary" className="flex-1" disabled={status === "pending"}>
            <Link href="/">Back to app</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}

function VerifySkeleton() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-muted/30">
      <div className="max-w-md w-full space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <div>
            <h1 className="text-lg font-semibold">Email verification</h1>
            <p className="text-sm text-muted-foreground">Checking token…</p>
          </div>
        </div>
      </div>
    </main>
  );
}
