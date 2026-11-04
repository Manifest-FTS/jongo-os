"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSiteEvents, type SiteEventKind } from "@/components/useSiteEvents";

type Props = {
  siteId: string;
  /** Which changes refresh the page; all when omitted. */
  kinds?: SiteEventKind[];
  /** Safety-net refresh while live updates are working. */
  connectedIntervalMs?: number;
  /** Refresh interval when live updates are unavailable (the old behaviour). */
  fallbackIntervalMs?: number;
};

/**
 * Re-renders the page when the server says this app changed, instead of on a
 * fixed timer. Keeps a slow timer as a safety net, and the old faster one only
 * if live updates can't connect. Never refreshes a hidden tab.
 */
export default function LiveRefresh({ siteId, kinds, connectedIntervalMs = 120_000, fallbackIntervalMs = 15_000 }: Props) {
  const router = useRouter();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshSoon = () => {
    // Several events in a row (a deploy's steps) make one refresh.
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      if (document.visibilityState === "visible") router.refresh();
    }, 800);
  };

  const { connected } = useSiteEvents(siteId, refreshSoon, kinds);

  useEffect(() => {
    const intervalMs = connected ? connectedIntervalMs : fallbackIntervalMs;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [connected, connectedIntervalMs, fallbackIntervalMs, router]);

  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current);
  }, []);

  return null;
}
