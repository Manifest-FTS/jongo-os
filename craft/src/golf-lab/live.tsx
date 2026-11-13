"use client";
import { createContext, useContext } from 'react';
import type { Bay } from './inventory.js';
import type { Booking, Member } from './logic.js';

/** What the server knows right now. `now` is fixed per snapshot so the server render and the browser agree on the time. */
export type LiveSnapshot = { now: number; members: Member[]; bookings: Booking[]; bays: Bay[] };
/** Extra facts about an account that the fixtures never had. Present for the signed-in member, or for every account when an admin views. */
export type LiveDetail = { phone: string | null; planLabel: string | null; price: string | null; statusLabel: string; started: string | null; commitmentEnd: string | null; waiverAccepted: string | null; stripeUrl?: string };
export type LiveCommit = { created: Booking[]; modified: Booking[] };
export type LiveResult<T = LiveSnapshot> = { ok: true; snapshot: T } | { ok: false; errors: string[] };

/** Operations the host performs against its own database. Every one is checked again on the server; the screen only asks. */
export type LiveActions = {
  commitBookings: (change: LiveCommit) => Promise<LiveResult>;
  saveBay: (input: { number?: number; name: string }) => Promise<LiveResult>;
  saveProfile: (input: { name: string; phone: string }) => Promise<LiveResult>;
  billingPortal: () => Promise<{ url?: string; error?: string }>;
  signOut: () => Promise<void>;
};
export type LiveConfig = {
  snapshot: LiveSnapshot;
  actions: LiveActions;
  /** The signed-in account (members and instructors); admins act for the whole team. */
  selfId: string;
  details: Record<string, LiveDetail>;
  contactEmail: string;
  waiver?: { title: string; version: string };
  /** A one-time line shown at the top of the first screen, e.g. a welcome. */
  notice?: string;
};

const LiveContext = createContext<LiveRuntime | null>(null);
export const LiveProvider = LiveContext.Provider;
/** The config plus a way for a screen to hand back the fresh snapshot a save returned. */
export type LiveRuntime = LiveConfig & { apply: (snapshot: LiveSnapshot) => void };
/** Null in the preview (fixtures, simulated saves); a runtime when the host supplies real data. */
export const useLive = (): LiveRuntime | null => useContext(LiveContext);
