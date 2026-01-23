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
import {
  ArrowLeft,
  Bot,
  Bug,
  Cloud,
  Cpu,
  Download,
  FolderTree,
  Lock,
  PlayCircle,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Zap,
} from "lucide-react";

const highlights = [
  {
    title: "Zero-knowledge encryption",
    description:
      "AES-256-GCM happens in your browser. Keys stay local unless you opt into Cloud Key Backup.",
    icon: ShieldCheck,
  },
  {
    title: "Cloud Key Backup (opt-in)",
    description:
      "Password-locked key sync. We encrypt the key with your account password using PBKDF2 + AES-256-GCM before storing it.",
    icon: Cloud,
  },
  {
    title: "Discord embeds",
    description:
      "Shared videos/images display as playable embeds on Discord. Dimensions are auto-detected during upload for correct aspect ratio.",
    icon: PlayCircle,
  },
  {
    title: "Multi-bot parallelism",
    description:
      "Unlimited DISCORD_TOKEN_* bots work together with automatic load balancing and least-busy selection.",
    icon: Bot,
  },
  {
    title: "Live progress & ETA",
    description:
      "Real-time upload/download progress with speed calculation, ETA, and instant cancellation.",
    icon: Download,
  },
  {
    title: "Folders, shares, ZIP export",
    description:
      "Organize into folders, move files freely, share links publicly, and download folders as ZIP after client-side decryption.",
    icon: FolderTree,
  },
  {
    title: "Worker-accelerated transfers",
    description:
      "Web Workers keep the UI responsive while chunking & encrypting. Worker count is configurable per device.",
    icon: Cpu,
  },
  {
    title: "Bug reporting",
    description:
      "Built-in bug report form at /bug-report. Reports are stored in database with browser info for easier debugging.",
    icon: Bug,
  },
  {
    title: "Mobile friendly",
    description:
      "Responsive layout with touch controls, slide-out navigation, and bulk selection for managing files on the go.",
    icon: Smartphone,
  },
  {
    title: "200% vibe coded",
    description:
      "Built with mass cursor-tabbing, mass prompting, and mass amounts of coffee. Don't trust, verify. (should be safe but yk)",
    icon: Sparkles,
  },
];

const workflow = [
  "File is split into ~8MB chunks in the browser using Web Workers for non-blocking operation.",
  "Each chunk is encrypted with AES-256-GCM using a unique IV. Your password never leaves the browser.",
  "Encrypted chunks are batched and uploaded to Discord via multiple bots in parallel.",
  "Discord stores chunks as message attachments. Only references (message IDs, URLs) are saved in SQLite.",
  "Downloads fetch encrypted parts in parallel (6 concurrent by default), then decrypt client-side.",
  "ZIP downloads bundle multiple files - each decrypted in browser before adding to archive.",
  "Optional Cloud Key Backup: key is password-verified, AES-256-GCM encrypted with PBKDF2 (100k), uploaded, and auto-restored after login when missing locally.",
];

const configHints = [
  "SMTP_HOST/PORT/USER/PASS + EMAIL_FROM enable signup and reset emails (tested with OVH Zimbra).",
  "Settings > Encryption: manage the key, choose PBKDF2 tier (50k-300k), and toggle password-verified Cloud Key Backup.",
  "Settings > General: adjust Web Worker count per device and toggle the debug overlay. All preferences live in localStorage.",
  "Add unlimited bots: DISCORD_TOKEN, DISCORD_TOKEN_2, DISCORD_TOKEN_3... to scale parallel transfers.",
  "MAX_FILE_SIZE limits uploads; UPLOAD_BATCH_SIZE controls chunks per Discord message; DOWNLOAD_CONCURRENCY controls parallel part fetches (default 6).",
];

const keyBackupNotes = [
  "Opt-in only: your encryption key stays in localStorage until you enable sync in Settings > Encryption.",
  "Password check runs before saving so the key cannot be encrypted with a wrong credential.",
  "Key is encrypted client-side with AES-256-GCM; PBKDF2 (100k, SHA-256) derives the wrapping key from your account password.",
  "Server keeps only the encrypted blob and salt - no plaintext password or key is stored.",
  "Auto-restore after login when no local key is found; disabling backup deletes the server copy immediately.",
];

export default function InfoPage() {
  return (
    <div className="min-h-screen bg-muted/30 text-foreground">
      <Header />

      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Project info
            </p>
            <h1 className="text-2xl font-semibold sm:text-3xl">
              Understand how Discordrive works
            </h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              A self-hosted drive that uses Discord as free cloud storage. Encryption/decryption stays in your
              browser, with optional password-locked Cloud Key Backup for multi-device use. Settings are split
              into General & Encryption tabs for worker tuning, key management, and PBKDF2 strength.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary">
              <Link href="/" className="inline-flex items-center gap-2">
                <ArrowLeft className="h-4 w-4" />
                Back to files
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/bug-report" className="inline-flex items-center gap-2">
                <Bug className="h-4 w-4" />
                Report a bug
              </Link>
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Key capabilities</CardTitle>
            <CardDescription>What you get out of the box.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              {highlights.map((item) => (
                <div
                  key={item.title}
                  className="flex gap-3 rounded-lg border bg-muted/40 p-3 sm:p-4"
                >
                  <item.icon className="mt-0.5 h-5 w-5 text-primary" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {item.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How it works</CardTitle>
            <CardDescription>End-to-end encrypted file flow.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm font-medium">
              <Zap className="h-4 w-4 text-primary" />
              <span>Browser-side encryption, multi-bot fan-out, parallel download, and client-side decryption.</span>
            </div>
            <ul className="space-y-2 text-sm text-muted-foreground leading-relaxed">
              {workflow.map((step) => (
                <li key={step} className="flex gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
                  <span>{step}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cloud Key Backup</CardTitle>
            <CardDescription>Password-locked, opt-in key sync for multi-device use.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm font-medium">
              <Lock className="h-4 w-4 text-primary" />
              <span>Encryption key is wrapped with your account password before it ever touches the server.</span>
            </div>
            <ul className="space-y-2 text-sm text-muted-foreground leading-relaxed">
              {keyBackupNotes.map((note) => (
                <li key={note} className="flex gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Technical stack</CardTitle>
            <CardDescription>Built with modern web technologies.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="space-y-2">
                <p className="font-medium">Backend</p>
                <ul className="space-y-1 text-muted-foreground">
                  <li>Express.js API server</li>
                  <li>Discord.js for bot management</li>
                  <li>SQLite (better-sqlite3) database</li>
                  <li>Nodemailer SMTP for signup/reset emails</li>
                  <li>Multer for file uploads</li>
                </ul>
              </div>
              <div className="space-y-2">
                <p className="font-medium">Frontend</p>
                <ul className="space-y-1 text-muted-foreground">
                  <li>Next.js with React</li>
                  <li>WebCrypto API for encryption</li>
                  <li>Web Workers for parallel processing</li>
                  <li>Tailwind CSS + Radix UI</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Configuration quick hits</CardTitle>
            <CardDescription>Adjust the stack without touching the code.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {configHints.map((hint) => (
                <div
                  key={hint}
                  className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground leading-relaxed"
                >
                  {hint}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/">Open file manager</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
