"use client";

import Link from "next/link";
import { Activity, HardDrive, Info, LogIn, LogOut, Menu, Settings, User as UserIcon } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Settings as SettingsPanel } from "../settings/Settings";
import { AuthDialog } from "../auth/AuthDialog";
import { useAuth } from "@/providers/AuthProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface HeaderProps {
  onMenuClick?: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const { user, logout } = useAuth();

  return (
    <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-14 items-center px-3 sm:px-4 gap-2 sm:gap-4">
        {/* Mobile menu button */}
        {onMenuClick && (
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden h-10 w-10"
            onClick={onMenuClick}
          >
            <Menu className="h-5 w-5" />
            <span className="sr-only">Open menu</span>
          </Button>
        )}

        <div className="flex items-center gap-2">
          <HardDrive className="h-5 w-5 sm:h-6 sm:w-6 text-primary" />
          <h1 className="text-base sm:text-lg font-semibold">Discordrive</h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 px-3 gap-2">
                  <UserIcon className="h-4 w-4" />
                  <span className="hidden sm:inline">{user.username}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>
                  <div className="flex flex-col">
                    <span className="font-medium">{user.username}</span>
                    <span className="text-xs text-muted-foreground truncate">{user.email}</span>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2 text-destructive" onClick={logout}>
                  <LogOut className="h-4 w-4" />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button variant="outline" size="sm" className="h-9 px-3 gap-1.5 sm:gap-2" onClick={() => setAuthOpen(true)}>
              <LogIn className="h-4 w-4" />
              <span className="hidden sm:inline">Log in</span>
              <span className="sm:hidden">Auth</span>
            </Button>
          )}
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 cursor-pointer"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="h-4 w-4" />
            <span className="sr-only">Settings</span>
          </Button>
          <Button asChild variant="outline" size="icon" className="h-9 w-9">
            <Link href="/health" title="CDN Healthcheck">
              <Activity className="h-4 w-4" />
              <span className="sr-only">CDN Healthcheck</span>
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="h-9 px-3">
            <Link href="/info" className="flex items-center gap-1.5 sm:gap-2">
              <Info className="h-4 w-4" />
              <span className="hidden sm:inline">Project info</span>
              <span className="sm:hidden">Info</span>
            </Link>
          </Button>
          <ThemeToggle />
        </div>
      </div>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <SettingsPanel />
        </DialogContent>
      </Dialog>
      <AuthDialog open={authOpen} onOpenChange={setAuthOpen} />
    </header>
  );
}
