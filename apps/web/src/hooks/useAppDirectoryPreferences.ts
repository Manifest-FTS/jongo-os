/**
 * Per-user saved view preferences for the Apps directory.
 * Persisted in localStorage keyed by user ID so different users on the same
 * device have independent view states.
 * Falls back gracefully when localStorage is unavailable (SSR, private mode).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import type { ResourceType } from "@/lib/resource-types";

export type AppDirectoryPreferences = {
  resourceTypeFilter: ResourceType | "all";
  statusFilter: "all" | "healthy" | "degraded" | "error" | "unknown";
  view: "list" | "grid";
};

const DEFAULTS: AppDirectoryPreferences = {
  resourceTypeFilter: "all",
  statusFilter: "all",
  view: "list"
};

function storageKey(userId: string | undefined): string {
  const safeId = userId?.replace(/[^a-z0-9_-]/gi, "") ?? "anon";
  return `jongo:app-directory-prefs:${safeId}`;
}

function readPrefs(userId: string | undefined): AppDirectoryPreferences {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return DEFAULTS;

    const parsed = JSON.parse(raw) as Partial<AppDirectoryPreferences>;
    return {
      resourceTypeFilter: parsed.resourceTypeFilter ?? DEFAULTS.resourceTypeFilter,
      statusFilter: parsed.statusFilter ?? DEFAULTS.statusFilter,
      view: parsed.view ?? DEFAULTS.view
    };
  } catch {
    return DEFAULTS;
  }
}

function writePrefs(userId: string | undefined, prefs: AppDirectoryPreferences): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(prefs));
  } catch {
    // Ignore write failures (private mode, storage full, SSR)
  }
}

export function useAppDirectoryPreferences(userId: string | undefined) {
  const [prefs, setPrefsState] = useState<AppDirectoryPreferences>(DEFAULTS);
  const [ready, setReady] = useState(false);

  // Read on mount (client-only to avoid SSR mismatch)
  useEffect(() => {
    setPrefsState(readPrefs(userId));
    setReady(true);
  }, [userId]);

  const setPrefs = useCallback(
    (update: Partial<AppDirectoryPreferences>) => {
      setPrefsState((prev) => {
        const next = { ...prev, ...update };
        writePrefs(userId, next);
        return next;
      });
    },
    [userId]
  );

  return { prefs, setPrefs, ready };
}
