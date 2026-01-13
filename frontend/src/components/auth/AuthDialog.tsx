"use client";

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, Mail, ShieldCheck, User as UserIcon } from "lucide-react";
import { useAuth } from "@/providers/AuthProvider";

type AuthMode = "login" | "register" | "reset";

interface AuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AuthDialog({ open, onOpenChange }: AuthDialogProps) {
  const { login, register, requestPasswordReset, confirmPasswordReset } = useAuth();
  const [mode, setMode] = useState<AuthMode>("login");
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  const title = useMemo(() => {
    if (mode === "register") return "Create an account";
    if (mode === "reset") return "Reset password";
    return "Log in";
  }, [mode]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") {
        await login(email.trim(), password);
        onOpenChange(false);
      } else if (mode === "register") {
        await register({ username: username.trim(), email: email.trim(), password });
        setMode("login");
      } else {
        if (resetToken.trim()) {
          await confirmPasswordReset(resetToken.trim(), password);
          setMode("login");
        } else {
          await requestPasswordReset(email.trim());
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const showPassword = mode !== "reset" || Boolean(resetToken.trim());
  const showUsername = mode === "register";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <div className="flex gap-2 text-xs text-muted-foreground pt-1">
            <Button variant={mode === "login" ? "secondary" : "ghost"} size="sm" className="h-7 px-2" onClick={() => setMode("login")} disabled={loading}>
              Log in
            </Button>
            <Button variant={mode === "register" ? "secondary" : "ghost"} size="sm" className="h-7 px-2" onClick={() => setMode("register")} disabled={loading}>
              Register
            </Button>
            <Button variant={mode === "reset" ? "secondary" : "ghost"} size="sm" className="h-7 px-2" onClick={() => setMode("reset")} disabled={loading}>
              Reset
            </Button>
          </div>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          {mode !== "reset" && (
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  className="pl-8"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
            </div>
          )}

          {mode === "reset" && (
            <div className="space-y-2">
              <Label htmlFor="reset-email">Email (for reset link)</Label>
              <div className="relative">
                <Mail className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="reset-email"
                  type="email"
                  autoComplete="email"
                  className="pl-8"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required={!resetToken.trim()}
                />
              </div>
            </div>
          )}

          {mode === "reset" && (
            <div className="space-y-2">
              <Label htmlFor="token">Reset token (from email)</Label>
              <Input
                id="token"
                value={resetToken}
                onChange={(e) => setResetToken(e.target.value)}
                placeholder="Paste token to set a new password"
              />
            </div>
          )}

          {showUsername && (
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <div className="relative">
                <UserIcon className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  className="pl-8"
                  required
                />
              </div>
            </div>
          )}

          {showPassword && (
            <div className="space-y-2">
              <Label htmlFor="password">{mode === "reset" && !resetToken ? "New password (after token)" : "Password"}</Label>
              <Input
                id="password"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required={mode !== "reset" || !!resetToken.trim()}
              />
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            {mode === "reset" ? (
              <span>Request a link or paste your reset token to set a new password.</span>
            ) : (
              <span className="flex items-center gap-1">
                <ShieldCheck className="h-4 w-4" />
                Email verification is required after registration.
              </span>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {mode === "login" && "Log in"}
            {mode === "register" && "Register"}
            {mode === "reset" && (resetToken ? "Set new password" : "Send reset link")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
