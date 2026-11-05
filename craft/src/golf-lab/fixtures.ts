import type { Booking, Member } from './logic.js';
import { createBayFixtures, type Bay } from './inventory.js';
/** Operational fixtures are deliberately separate from CMS documents. No storage/network adapter. */
export interface GolfLabFixtureAdapter { members: Member[]; bookings: Booking[]; bays: Bay[] }
export function createFixtureAdapter(): GolfLabFixtureAdapter {
  return {
    bays: createBayFixtures(),
    members: [
      { id: 'm1', name: 'Alex Morgan', email: 'alex@example.invalid', tier: 'individual', active: true, waiver: true, approved: true, billingStatus: 'active', billing: '$199/mo · commitment through Nov 1, 2027' },
      { id: 'm2', name: 'Sam Rivera', email: 'sam@example.invalid', tier: 'family', individualSponsor: 'm1', active: true, waiver: true, approved: true, billingStatus: 'active', billing: '$85/mo · Individual sponsor Alex' },
      { id: 'm3', name: 'Taylor Junior', email: 'guardian@example.invalid', tier: 'junior', active: true, waiver: true, approved: true, billingStatus: 'active', billing: '$1,800 annually · approval recorded' },
      { id: 'm4', name: 'Casey Lee', email: 'casey@example.invalid', tier: 'individual', active: false, waiver: true, approved: true, billingStatus: 'active', accessReason: 'medical', billing: 'Medical leave · paid membership · access suspended separately' },
      { id: 'm5', name: 'Jordan Park', email: 'jordan@example.invalid', tier: 'individual', active: true, waiver: false, approved: true, billingStatus: 'active', billing: '$289/mo flexible · waiver needed' },
      { id: 'm6', name: 'Riley Chen', email: 'riley@example.invalid', tier: 'individual', active: false, waiver: false, approved: true, billingStatus: 'unpaid', billing: 'Choose a membership to get started' },
      { id: 'm7', name: 'Avery Brooks', email: 'avery@example.invalid', tier: 'individual', active: false, waiver: true, approved: true, billingStatus: 'pending', billing: 'Payment confirmation pending · booking unavailable' },
      { id: 'm8', name: 'Quinn Davis', email: 'quinn@example.invalid', tier: 'individual', active: false, waiver: true, approved: true, billingStatus: 'past_due', accessReason: 'billing', billing: 'Payment overdue · contact the team' },
      { id: 'm9', name: 'Jamie Reed', email: 'jamie@example.invalid', tier: 'individual', active: false, waiver: true, approved: true, billingStatus: 'suspended', accessReason: 'billing', billing: 'Billing suspended · review required' },
      { id: 'i1', name: 'Derek Domaleski', email: 'derek@example.invalid', tier: 'instructor', active: true, waiver: true, approved: true, billingStatus: 'active', billing: 'Instructor agreement · fictional account, no automated fees' }
    ],
    bookings: [
      { id: 'b1', memberId: 'm1', date: '2026-11-03', start: 17, hours: 1, bay: 1, status: 'booked' },
      { id: 'b2', memberId: 'm2', date: '2026-11-02', start: 18, hours: 1, bay: 2, status: 'booked' },
      { id: 'b3', memberId: 'i1', date: '2026-11-02', start: 16, hours: 2, bay: 4, status: 'booked' },
      { id: 'b4', memberId: 'm1', date: '2026-11-01', start: 10, hours: 1, bay: 1, status: 'booked' },
      { id: 'b5', memberId: 'i1', date: '2026-11-01', start: 14, hours: 2, bay: 3, status: 'booked' },
      { id: 'b6', memberId: 'm1', date: '2026-11-04', start: 18, hours: 1, bay: 2, status: 'cancelled' },
      { id: 'b7', memberId: 'm2', date: '2026-11-09', start: 18, hours: 1, bay: 2, status: 'booked' },
      { id: 'b8', memberId: 'i1', date: '2026-10-30', start: 13, hours: 2, bay: 4, status: 'booked' }
    ]
  };
}