import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GolfLabDemo } from '../dist/golf-lab/index.js';
import { DEMO_NOW, bookingStatus, clockNow, clockToday, editableBooking, overviewStats, setLiveClock, validateBooking } from '../dist/golf-lab/logic.js';

const NOW = Date.parse('2027-03-04T20:00:00Z'); // 14:00 Chicago, Thursday 4 March 2027 (winter)
const member = { id: 'u1', name: 'Grace Hopper', email: 'grace@example.test', tier: 'individual', active: true, waiver: true, approved: true, billingStatus: 'active', billing: '$199/month \u00b7 1-year commitment' };
const bays = [{ id: 'golf-lab-bay-1', displayNumber: 1, name: 'The Fairway' }, { id: 'golf-lab-bay-2', displayNumber: 2, name: 'The Approach' }];
const actions = { commitBookings: async () => ({ ok: true }), saveBay: async () => ({ ok: true }), saveProfile: async () => ({ ok: true }), requestEmailChange: async () => ({ ok: true }), billingPortal: async () => ({}), signOut: async () => {} };
const live = (extra = {}) => ({ snapshot: { now: NOW, members: [member], bookings: [{ id: 'b1', memberId: 'u1', date: '2027-03-05', start: 18, hours: 1, bay: 2, status: 'booked' }], bays }, actions, selfId: 'u1', contactEmail: 'team@example.test', details: { u1: { phone: '847-555-0100', planLabel: 'Individual \u2013 Monthly', price: '$199 / month', statusLabel: 'Active', started: 'Nov 13, 2026', commitmentEnd: 'Nov 13, 2027', waiverAccepted: 'Nov 13, 2026' } }, ...extra });

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
  const admin = live({ selfId: 'a-real', snapshot: { now: NOW, members: [member, { ...member, id: 'u2', name: 'Alan Turing', email: 'alan@example.test' }], bookings: [], bays }, details: {} });
  const html = renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'admin', initialView: 'members', live: admin }));
  assert.ok(html.includes('Grace Hopper') && html.includes('Alan Turing') && !html.includes('Alex Morgan'));
  const overview = renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'admin', initialView: 'overview', live: admin }));
  assert.ok(overview.includes('The Fairway') && overview.includes('The Approach') && !overview.includes('The Launch'));
  setLiveClock(null);
});
