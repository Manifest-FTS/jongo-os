"use client";
import { createContext, useContext } from 'react';
import type { Bay } from './inventory.js';
import type { Booking, Member } from './logic.js';

/** What the server knows right now. `now` is fixed per snapshot so the server render and the browser agree on the time. */
export type LiveSnapshot = { now: number; members: Member[]; bookings: Booking[]; bays: Bay[]; details: Record<string, LiveDetail> };
/** A pause on booking that the team set. It is separate from billing: the plan stays paid. */
export type LiveHold = { kind: 'medical' | 'other'; note: string; until: string | null };
/** Extra facts about an account that the fixtures never had. Present for the signed-in member, or for every account when the team views. */
export type LiveDetail = { phone: string | null; planLabel: string | null; price: string | null; statusLabel: string; started: string | null; commitmentEnd: string | null; commitmentEndDate?: string | null; waiverAccepted: string | null; stripeUrl?: string; hold?: LiveHold | null; history?: string[] };
export type LiveInvite = { kind: 'junior' | 'family'; name: string; email: string; sponsorId: string };
export type LiveAccessInput = { hold: 'medical' | 'other' | null; note: string; until: string };
export type LiveCommit = { created: Booking[]; modified: Booking[] };
export type LiveResult<T = LiveSnapshot> = { ok: true; snapshot: T } | { ok: false; errors: string[] };

/** Operations the host performs against its own database. Every one is checked again on the server; the screen only asks. */
export type LiveActions = {
  commitBookings: (change: LiveCommit) => Promise<LiveResult>;
  saveBay: (input: { number?: number; name: string }) => Promise<LiveResult>;
  saveProfile: (input: { name: string; phone: string }) => Promise<LiveResult>;
  /** Starts a confirmed change of the sign-in email: the host emails a link to the current address first. */
  requestEmailChange: (email: string) => Promise<{ ok: true } | { ok: false; errors: string[] }>;
  /** Team only. Suspend or restore booking for one account, with a reason that is recorded. */
  setAccess: (memberId: string, input: LiveAccessInput) => Promise<LiveResult>;
  /** Team only. Move a member's commitment end date later, with a reason that is recorded. */
  extendCommitment: (memberId: string, input: { until: string; note: string }) => Promise<LiveResult>;
  /** Team only. Approve a Junior or Family member by emailing them a link to finish and pay. */
  inviteMember: (input: LiveInvite) => Promise<LiveResult>;
  billingPortal: () => Promise<{ url?: string; error?: string }>;
  signOut: () => Promise<void>;
};
export type LiveConfig = {
  snapshot: LiveSnapshot;
  actions: LiveActions;
  /** The signed-in account (members and instructors); admins act for the whole team. */
  selfId: string;
  contactEmail: string;
  waiver?: { title: string; version: string };
  /** A one-time line shown at the top of the first screen, e.g. a welcome. */
  notice?: string;
};

const LiveContext = createContext<LiveRuntime | null>(null);
export const LiveProvider = LiveContext.Provider;
/** The config plus a way for a screen to hand back the fresh snapshot a save returned. */
export type LiveRuntime = LiveConfig & { details: Record<string, LiveDetail>; apply: (snapshot: LiveSnapshot) => void };
/** Null in the preview (fixtures, simulated saves); a runtime when the host supplies real data. */
export const useLive = (): LiveRuntime | null => useContext(LiveContext);
