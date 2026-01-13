"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Bug, Send, CheckCircle, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { API_BASE } from "@/lib/api";

interface BrowserInfo {
  userAgent: string;
  language: string;
  platform: string;
  screenWidth: number;
  screenHeight: number;
  colorDepth: number;
  timezone: string;
}

function getBrowserInfo(): BrowserInfo {
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    colorDepth: window.screen.colorDepth,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export default function BugReportPage() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [stepsToReproduce, setStepsToReproduce] = useState("");
  const [expectedBehavior, setExpectedBehavior] = useState("");
  const [actualBehavior, setActualBehavior] = useState("");
  const [errorLogs, setErrorLogs] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [reportId, setReportId] = useState<number | null>(null);

  // Auto-collect browser info
  const [browserInfo, setBrowserInfo] = useState<BrowserInfo | null>(null);

  useEffect(() => {
    setBrowserInfo(getBrowserInfo());
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim() || !description.trim()) {
      toast.error("Tytuł i opis są wymagane");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch(`${API_BASE}/bugs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          stepsToReproduce: stepsToReproduce.trim() || null,
          expectedBehavior: expectedBehavior.trim() || null,
          actualBehavior: actualBehavior.trim() || null,
          browserInfo: browserInfo ? JSON.stringify(browserInfo, null, 2) : null,
          systemInfo: `Screen: ${browserInfo?.screenWidth}x${browserInfo?.screenHeight}, Platform: ${browserInfo?.platform}`,
          errorLogs: errorLogs.trim() || null,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Failed to submit bug report");
      }

      setReportId(data.report.id);
      setSubmitted(true);
      toast.success("Zgłoszenie błędu zostało wysłane!");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Nie udało się wysłać zgłoszenia");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="mx-auto w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center">
            <CheckCircle className="w-8 h-8 text-green-500" />
          </div>
          <h1 className="text-2xl font-bold">Dziękujemy za zgłoszenie!</h1>
          <p className="text-muted-foreground">
            Twoje zgłoszenie błędu (#{reportId}) zostało zapisane. Zajmiemy się nim najszybciej jak to możliwe.
          </p>
          <div className="flex gap-4 justify-center">
            <Button variant="outline" onClick={() => {
              setSubmitted(false);
              setTitle("");
              setDescription("");
              setStepsToReproduce("");
              setExpectedBehavior("");
              setActualBehavior("");
              setErrorLogs("");
              setReportId(null);
            }}>
              Zgłoś kolejny błąd
            </Button>
            <Link href="/">
              <Button>
                <ArrowLeft className="w-4 h-4 mr-2" />
                Wróć do aplikacji
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto p-6 space-y-8">
        <div className="flex items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-lg">
              <Bug className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Zgłoś błąd</h1>
              <p className="text-sm text-muted-foreground">Pomóż nam ulepszyć Discordrive</p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="title">Tytuł *</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Krótki opis problemu"
              maxLength={200}
              required
            />
            <p className="text-xs text-muted-foreground">{title.length}/200</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Opis problemu *</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Opisz szczegółowo co się stało..."
              rows={4}
              maxLength={5000}
              required
            />
            <p className="text-xs text-muted-foreground">{description.length}/5000</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="steps">Kroki do odtworzenia (opcjonalne)</Label>
            <Textarea
              id="steps"
              value={stepsToReproduce}
              onChange={(e) => setStepsToReproduce(e.target.value)}
              placeholder="1. Kliknij w...&#10;2. Następnie...&#10;3. Pojawia się błąd..."
              rows={3}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="expected">Oczekiwane zachowanie</Label>
              <Textarea
                id="expected"
                value={expectedBehavior}
                onChange={(e) => setExpectedBehavior(e.target.value)}
                placeholder="Co powinno się stać?"
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="actual">Faktyczne zachowanie</Label>
              <Textarea
                id="actual"
                value={actualBehavior}
                onChange={(e) => setActualBehavior(e.target.value)}
                placeholder="Co się faktycznie stało?"
                rows={2}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="logs">Logi błędów (opcjonalne)</Label>
            <Textarea
              id="logs"
              value={errorLogs}
              onChange={(e) => setErrorLogs(e.target.value)}
              placeholder="Wklej logi z konsoli przeglądarki (F12 → Console)..."
              rows={3}
              className="font-mono text-xs"
            />
          </div>

          <div className="bg-muted/50 rounded-lg p-4 space-y-2">
            <p className="text-sm font-medium">Automatycznie zbierane informacje:</p>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>Przeglądarka: {browserInfo?.userAgent.substring(0, 80)}...</p>
              <p>Ekran: {browserInfo?.screenWidth}x{browserInfo?.screenHeight}</p>
              <p>Platforma: {browserInfo?.platform}</p>
              <p>Strefa czasowa: {browserInfo?.timezone}</p>
            </div>
          </div>

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? (
              <>Wysyłanie...</>
            ) : (
              <>
                <Send className="w-4 h-4 mr-2" />
                Wyślij zgłoszenie
              </>
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
