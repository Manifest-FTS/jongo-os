"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Live updates for one app: calls `onEvent` when the server says something
 * about it changed. One EventSource per app per tab, shared by every component
 * that listens, so a page with several live parts still holds one connection.
 *
 * `connected` lets callers keep a slow fallback timer while live updates work
 * and their old, faster one when they don't (blocked by a proxy, offline).
 */
export type SiteEventKind = "operation" | "backup" | "restore" | "staging" | "settings";
type Listener = (kind: SiteEventKind) => void;
type Channel = { source: EventSource; listeners: Set<Listener>; statusListeners: Set<(connected: boolean) => void>; connected: boolean };

const channels = new Map<string, Channel>();

function open(siteId: string): Channel {
  const existing = channels.get(siteId);
  if (existing) return existing;
  const source = new EventSource(`/api/sites/${encodeURIComponent(siteId)}/events`);
  const channel: Channel = { source, listeners: new Set(), statusListeners: new Set(), connected: false };
  const setConnected = (value: boolean) => {
    if (channel.connected === value) return;
    channel.connected = value;
    channel.statusListeners.forEach((listener) => listener(value));
  };
  source.onopen = () => setConnected(true);
  // EventSource reconnects by itself; report the gap so callers fall back.
  source.onerror = () => setConnected(false);
  source.addEventListener("site", (message) => {
    let kind: SiteEventKind = "settings";
    try {
      kind = (JSON.parse((message as MessageEvent).data) as { kind?: SiteEventKind }).kind ?? "settings";
    } catch {
      // Unknown payload: treat as a generic change.
    }
    channel.listeners.forEach((listener) => listener(kind));
  });
  channels.set(siteId, channel);
  return channel;
}

function release(siteId: string, channel: Channel) {
  if (channel.listeners.size === 0 && channel.statusListeners.size === 0) {
    channel.source.close();
    channels.delete(siteId);
  }
}

export function useSiteEvents(
  siteId: string | null | undefined,
  onEvent: (kind: SiteEventKind) => void,
  kinds?: SiteEventKind[]
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const kindKey = kinds?.join(",") ?? "";

  useEffect(() => {
    if (!siteId || typeof EventSource === "undefined") return;
    const wanted = kindKey ? new Set(kindKey.split(",")) : null;
    const channel = open(siteId);
    const listener: Listener = (kind) => {
      if (!wanted || wanted.has(kind)) handler.current(kind);
    };
    channel.listeners.add(listener);
    channel.statusListeners.add(setConnected);
    setConnected(channel.connected);
    return () => {
      channel.listeners.delete(listener);
      channel.statusListeners.delete(setConnected);
      release(siteId, channel);
    };
  }, [siteId, kindKey]);

  return { connected };
}
