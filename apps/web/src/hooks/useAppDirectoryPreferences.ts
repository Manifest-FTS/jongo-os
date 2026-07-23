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
  resourceTypeFilters: ResourceType[];
  statusFilters: Array<"healthy" | "degraded" | "error" | "unknown">;
  stagingFilter: "all" | "only_staging" | "exclude_staging";
  view: "list" | "grid";
};

const DEFAULTS: AppDirectoryPreferences = {
  resourceTypeFilters: [],
  statusFilters: [],
  stagingFilter: "all",
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
    const legacyResourceType = (parsed as Partial<{ resourceTypeFilter: ResourceType | "all" }>).resourceTypeFilter;
    const legacyStatus = (parsed as Partial<{ statusFilter: "all" | "healthy" | "degraded" | "error" | "unknown" }>).statusFilter;

    const resourceTypeFilters = Array.isArray(parsed.resourceTypeFilters)
      ? parsed.resourceTypeFilters.filter((value): value is ResourceType => typeof value === "string")
      : (legacyResourceType && legacyResourceType !== "all" ? [legacyResourceType] : []);

    const statusFilters = Array.isArray(parsed.statusFilters)
      ? parsed.statusFilters.filter(
          (value): value is "healthy" | "degraded" | "error" | "unknown" =>
            value === "healthy" || value === "degraded" || value === "error" || value === "unknown"
        )
      : (legacyStatus && legacyStatus !== "all" ? [legacyStatus] : []);

    return {
      resourceTypeFilters,
      statusFilters,
      stagingFilter: parsed.stagingFilter ?? DEFAULTS.stagingFilter,
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
