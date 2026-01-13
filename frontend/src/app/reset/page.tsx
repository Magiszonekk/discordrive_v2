"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/providers/AuthProvider";
import { Loader2, LockKeyhole } from "lucide-react";
import Link from "next/link";

export default function ResetPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ResetContent />
    </Suspense>
  );
}

function ResetContent() {
  const search = useSearchParams();
  const token = search.get("token") || "";
  const router = useRouter();
  const { confirmPasswordReset } = useAuth();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!token) {
      setError("Brak tokenu resetu w URL.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await confirmPasswordReset(token, password);
      setMessage("Hasło zaktualizowane. Możesz się zalogować.");
      setTimeout(() => router.push("/"), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset nie powiódł się");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-muted/30">
      <div className="max-w-md w-full space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <LockKeyhole className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-lg font-semibold">Reset password</h1>
            <p className="text-sm text-muted-foreground">
              {token ? "Set a new password using the link from your email." : "Missing token in the URL."}
            </p>
          </div>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {message && <p className="text-sm text-green-600">{message}</p>}

          <Button type="submit" className="w-full" disabled={loading || !token}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Update password
          </Button>
        </form>

        <Button asChild variant="secondary" className="w-full">
          <Link href="/">Back to app</Link>
        </Button>
      </div>
    </main>
  );
}

function PageSkeleton() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-muted/30">
      <div className="max-w-md w-full space-y-4 rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <LockKeyhole className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-lg font-semibold">Reset password</h1>
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        </div>
      </div>
    </main>
  );
}
