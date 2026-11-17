import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GolfLabDemo } from '../dist/golf-lab/index.js';
import { LiveProvider } from '../dist/golf-lab/live.js';
import { CancelCard, FamilyPanel, TeamCancel } from '../dist/golf-lab/membership-ending.js';
import { DEMO_NOW, bookingStatus, clockNow, clockToday, editableBooking, overviewStats, setLiveClock, validateBooking } from '../dist/golf-lab/logic.js';

const NOW = Date.parse('2027-03-04T20:00:00Z'); // 14:00 Chicago, Thursday 4 March 2027 (winter)
const member = { id: 'u1', name: 'Grace Hopper', email: 'grace@example.test', tier: 'individual', active: true, waiver: true, approved: true, billingStatus: 'active', billing: '$199/month \u00b7 1-year commitment' };
const bays = [{ id: 'golf-lab-bay-1', displayNumber: 1, name: 'The Fairway' }, { id: 'golf-lab-bay-2', displayNumber: 2, name: 'The Approach' }];
const actions = { commitBookings: async () => ({ ok: true }), saveBay: async () => ({ ok: true }), saveProfile: async () => ({ ok: true }), requestEmailChange: async () => ({ ok: true }), setAccess: async () => ({ ok: true }), extendCommitment: async () => ({ ok: true }), inviteMember: async () => ({ ok: true }), addInstructor: async () => ({ ok: true }), addFamilyMember: async () => ({ ok: true }), revokeFamilyInvite: async () => ({ ok: true }), cancelMembership: async () => ({ ok: true }), withdrawCancellation: async () => ({ ok: true }), billingPortal: async () => ({}), signOut: async () => {} };
const DETAILS = { u1: { phone: '847-555-0100', planLabel: 'Individual \u2013 Monthly', price: '$199 / month', statusLabel: 'Active', started: 'Nov 13, 2026', commitmentEnd: 'Nov 13, 2027', waiverAccepted: 'Nov 13, 2026' } };
const live = (extra = {}) => ({ snapshot: { now: NOW, members: [member], bookings: [{ id: 'b1', memberId: 'u1', date: '2027-03-05', start: 18, hours: 1, bay: 2, status: 'booked' }], bays, details: DETAILS }, actions, selfId: 'u1', contactEmail: 'team@example.test', ...extra });

test('the live clock replaces the frozen fixture day for every default, and switching it off restores the fixture day', () => {
  assert.equal(clockNow(), DEMO_NOW);
  setLiveClock(NOW);
  try {
    assert.equal(clockNow(), NOW);
    assert.equal(clockToday(), '2027-03-04');
    assert.equal(bookingStatus({ id: 'x', memberId: 'u1', date: '2027-03-04', start: 9, hours: 1, bay: 1, status: 'booked' }), 'completed');
    assert.equal(editableBooking({ id: 'x', memberId: 'u1', date: '2027-03-05', start: 9, hours: 1, bay: 1, status: 'booked' }), true);
    assert.equal(editableBooking({ id: 'x', memberId: 'u1', date: '2027-03-04', start: 9, hours: 1, bay: 1, status: 'booked' }), false);
    assert.equal(overviewStats([{ id: 'x', memberId: 'u1', date: '2027-03-04', start: 13, hours: 2, bay: 1, status: 'booked' }])['Practicing Now'], 1);
    const candidate = { id: 'n', memberId: 'u1', date: '2027-03-05', start: 18, hours: 1, bay: 1, status: 'booked' };
    assert.deepEqual(validateBooking(candidate, [], member, { id: 'u1', role: 'member' }, undefined, undefined, bays), []);
    assert.match(validateBooking({ ...candidate, date: '2027-03-12' }, [], member, { id: 'u1', role: 'member' }, undefined, undefined, bays).join(' '), /Advance booking limit: 7 days/);
  } finally { setLiveClock(null); }
  assert.equal(clockToday(), '2026-11-02');
});

test('live mode shows the real account, never the fixture people, and says nothing is simulated', () => {
  const html = renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'member', initialView: 'member', live: live({ notice: 'Welcome to The Golf Lab.' }) }));
  assert.ok(html.includes('Grace Hopper') && html.includes('Welcome to The Golf Lab.') && html.includes('Sign out'));
  assert.ok(!html.includes('Alex Morgan') && !html.includes('example.invalid') && !html.includes('Design system'));
  assert.ok(html.includes('2027-03-05') && html.includes('The Approach'), 'own upcoming session is listed with its real bay');
  const profile = renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'member', initialView: 'profile', live: live() }));
  assert.ok(profile.includes('value="Grace Hopper"') && profile.includes('value="847-555-0100"') && profile.includes('Save details') && profile.includes('disabled') && profile.includes('Change your email address') && profile.includes('Send confirmation'));
  const booking = renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'member', initialView: 'booking', live: live() }));
  assert.ok(!/local memory|simulated|reset on reload/i.test(booking), 'no simulation wording on the live booking screen');
  assert.ok(booking.includes('2027-03-04') && booking.includes('The Fairway'));
  setLiveClock(null);
});

test('live billing shows the plan, commitment and waiver, and hands payment to the billing portal', () => {
  const html = renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'member', initialView: 'billing', live: live() }));
  assert.ok(html.includes('Individual \u2013 Monthly') && html.includes('$199 / month') && html.includes('Nov 13, 2027'));
  assert.ok(!/Payment not connected|Simulate|No card details are collected/.test(html));
  setLiveClock(null);
});

test('live admin sees every account the host sent, with real membership facts in the list and no fixture accounts', () => {
  const admin = live({ selfId: 'a-real', snapshot: { now: NOW, members: [member, { ...member, id: 'u2', name: 'Alan Turing', email: 'alan@example.test' }], bookings: [], bays, details: {} } });
  const html = renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'admin', initialView: 'members', live: admin }));
  assert.ok(html.includes('Grace Hopper') && html.includes('Alan Turing') && !html.includes('Alex Morgan'));
  const overview = renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'admin', initialView: 'overview', live: admin }));
  assert.ok(overview.includes('The Fairway') && overview.includes('The Approach') && !overview.includes('The Launch'));
  setLiveClock(null);
});

test('the team can invite Junior and Family members; the Junior window is three days', () => {
  const admin = live({ selfId: 'a-real', snapshot: { now: NOW, members: [member], bookings: [], bays, details: {} } });
  assert.ok(renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'admin', initialView: 'members', live: admin })).includes('Invite Junior or Family member'));
  assert.ok(!renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'admin', initialView: 'instructors', live: admin })).includes('Invite Junior or Family member'));
  assert.ok(renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'admin', initialView: 'instructors', live: admin })).includes('Add instructor') && !renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'admin', initialView: 'members', live: admin })).includes('Add instructor'), 'the team adds instructors from the Instructors screen only');
  assert.ok(!renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'member', initialView: 'profile', live: live() })).includes('Invite Junior'));
  setLiveClock(NOW);
  try {
    const junior = { ...member, id: 'j1', tier: 'junior' };
    const candidate = { id: 'n', memberId: 'j1', date: '2027-03-07', start: 18, hours: 1, bay: 1, status: 'booked' };
    assert.deepEqual(validateBooking(candidate, [], junior, { id: 'j1', role: 'member' }, undefined, undefined, bays), [], 'three days ahead is inside the window');
    assert.match(validateBooking({ ...candidate, date: '2027-03-08' }, [], junior, { id: 'j1', role: 'member' }, undefined, undefined, bays).join(' '), /Advance booking limit: 3 days/);
  } finally { setLiveClock(null); }
});

const CANCEL = { applies: true, scheduled: false, canRequest: true, endsOn: 'Nov 13, 2027', message: 'Your commitment runs through Nov 13, 2027. Cancel by Nov 10, 2027; there are no refunds after a renewal.' };
const FAMILY = [
  { id: 'f1', name: 'Sam Hopper', email: 'sam@example.test', statusLabel: 'Active', invited: false, cancel: { ...CANCEL, endsOn: 'Dec 13, 2026', message: 'Your membership renews on Dec 13, 2026. Cancel by Dec 10, 2026 to end it on that date.' } },
  { id: 'f2', name: 'Lee Hopper', email: 'lee@example.test', statusLabel: 'Invited', invited: true, cancel: { applies: false, scheduled: false, canRequest: false, endsOn: null, message: '' } },
  { id: 'f3', name: 'Kim Hopper', email: 'kim@example.test', statusLabel: 'Active', invited: false, cancel: { ...CANCEL, scheduled: true, canRequest: false, message: 'Scheduled to end on Dec 13, 2026.' } }
];
const inLive = (node, detail) => renderToStaticMarkup(createElement(LiveProvider, { value: { ...live(), details: { u1: { ...DETAILS.u1, ...detail } }, apply: () => {} } }, node));

test('a member can cancel at the end of the term, or take a scheduled cancellation back; nothing shows when there is no subscription', () => {
  const ask = inLive(createElement(CancelCard, { member, detail: { ...DETAILS.u1, cancel: CANCEL } }), { cancel: CANCEL });
  assert.ok(ask.includes('Cancel membership') && ask.includes('no refunds after a renewal') && !ask.includes('Keep my membership'));
  const scheduled = inLive(createElement(CancelCard, { member, detail: { ...DETAILS.u1, cancel: { ...CANCEL, scheduled: true, canRequest: false, message: 'Scheduled to end on Nov 13, 2027.' } } }), {});
  assert.ok(scheduled.includes('Keep my membership') && !scheduled.includes('>Cancel membership</button>'));
  const late = inLive(createElement(CancelCard, { member, detail: { ...DETAILS.u1, cancel: { ...CANCEL, canRequest: false, message: 'The cancellation deadline was Nov 10.' } } }), {});
  assert.ok(late.includes('deadline was Nov 10') && !late.includes('>Cancel membership</button>'));
  assert.equal(inLive(createElement(CancelCard, { member, detail: { ...DETAILS.u1, cancel: { ...CANCEL, applies: false } } }), {}), '');
});

test('family members: each is listed with what can be done, and removing one is said not to affect the sponsor', () => {
  const html = inLive(createElement(FamilyPanel, { detail: { ...DETAILS.u1, family: FAMILY, canAddFamily: true, familyLimit: 5 } }), {});
  assert.ok(html.includes('Sam Hopper') && html.includes('>Remove<') && html.includes('Send link again') && html.includes('Withdraw invitation') && html.includes('>Keep<'));
  assert.ok(html.includes('never affects your membership') && html.includes('Add a family member') && html.includes('required'));
  const full = inLive(createElement(FamilyPanel, { detail: { ...DETAILS.u1, family: FAMILY, canAddFamily: false, familyLimit: 5 } }), {});
  assert.ok(full.includes('limit of 5 family members') && !full.includes('Add a family member'));
});

test('the team can cancel with a note, or remove a scheduled cancellation', () => {
  const form = inLive(createElement(TeamCancel, { member, detail: { ...DETAILS.u1, cancel: CANCEL } }), {});
  assert.ok(form.includes('Reason for the cancellation') && form.includes('Cancel at the end of the term') && form.includes('disabled'));
  const scheduled = inLive(createElement(TeamCancel, { member, detail: { ...DETAILS.u1, cancel: { ...CANCEL, scheduled: true, canRequest: false, message: 'Scheduled to end on Nov 13, 2027.' } } }), {});
  assert.ok(scheduled.includes('Remove the cancellation') && !scheduled.includes('Reason for the cancellation'));
});

test('the member home says what the client asked for, and uses the site logo when the host supplies one', () => {
  const home = renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'member', initialView: 'member', live: live({ logoSrc: '/assets/brand/logo.png' }) }));
  assert.ok(home.includes('A little more time on your game') && home.includes('Great possibilities.') && home.includes('Book your next session'));
  assert.ok(!home.includes('Your space to focus') && !home.includes('Find your next session') && !home.includes('NEXT<br'));
  assert.ok(home.includes('class="craft-hero-logo"') && home.includes('src="/assets/brand/logo.png"'));
  const booking = renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'member', initialView: 'booking', live: live() }));
  assert.ok(booking.includes('Book your next session') && !booking.includes('Your next great session'));
  const billing = renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'member', initialView: 'billing', live: live({ snapshot: { ...live().snapshot, details: { u1: { ...DETAILS.u1, family: [], canAddFamily: true, familyLimit: 5 } } } }) }));
  assert.ok(billing.includes('Family members'), 'an Individual member gets a Family members tab');
  assert.ok(!renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'member', initialView: 'billing', live: live() })).includes('Family members'));
});