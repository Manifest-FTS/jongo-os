import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GolfLabDemo, ProfileView, createFixtureAdapter } from '../dist/golf-lab/index.js';
import { csvCell, filterMembers, hoursByAccount, isCurrentMember, memberEmailsCsv, memberStatusLabel, report } from '../dist/golf-lab/logic.js';

const { members, bookings } = createFixtureAdapter();
const people = members.filter(member => member.tier !== 'instructor');

test('current means paid with access on; everyone else is not current, and the two groups never overlap', () => {
  const current = filterMembers(people, 'current'), notCurrent = filterMembers(people, 'not-current');
  assert.deepEqual(current.map(member => member.id), ['m1', 'm2', 'm3', 'm5']);
  assert.equal(current.length + notCurrent.length, people.length);
  assert.ok(current.every(isCurrentMember) && !notCurrent.some(isCurrentMember));
  assert.equal(filterMembers(people, 'all').length, people.length);
  assert.deepEqual([memberStatusLabel(members[0]), memberStatusLabel(members[3]), memberStatusLabel(members[4])], ['Active', 'Inactive', 'Waiver needed']);
});

test('the email export lists name, email, membership and status for the chosen group, with spreadsheet-safe cells', () => {
  const lines = memberEmailsCsv(people, 'current').split('\r\n');
  assert.equal(lines[0], '"Name","Email","Membership","Status","Billing"');
  assert.equal(lines.length, 1 + 4);
  assert.equal(lines[1], '"Alex Morgan","alex@example.invalid","individual","Active","active"');
  assert.ok(memberEmailsCsv(people, 'not-current').includes('"Casey Lee"') && !memberEmailsCsv(people, 'not-current').includes('Alex Morgan'));
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  const hostile = memberEmailsCsv([{ ...people[0], name: '+cmd|calc', email: '@evil' }], 'all');
  assert.ok(hostile.includes(`"'+cmd|calc","'@evil"`));
});

test('hours by account add up to the report totals, split by the same statuses', () => {
  const result = report(bookings, '2026-11-01', '2026-12-01');
  const rows = hoursByAccount(result.rows);
  for (const status of ['booked', 'completed', 'cancelled']) assert.equal(rows.reduce((sum, row) => sum + row[status], 0), result.totals[status], status);
  assert.deepEqual(rows.map(row => row.memberId).sort(), [...new Set(result.rows.map(row => row.memberId))].sort());
  assert.deepEqual(hoursByAccount([]), []);
});

test('the members screen offers the group filter and the email export; the reports screen shows hours by account', () => {
  const members = renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'admin', initialView: 'members' }));
  for (const text of ['Export emails (CSV)', 'Current (paid, access on)', 'Not current', 'Everyone']) assert.ok(members.includes(text), text);
  const reports = renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: 'admin', initialView: 'reports' }));
  assert.ok(reports.includes('Hours by account') && reports.includes('Reservation ledger'));
});

test('a member sees a Profile page with their details and terms, and nobody else gets one', () => {
  const profile = renderToStaticMarkup(createElement(GolfLabDemo, { initialView: 'profile' }));
  for (const text of ['Your profile', 'Alex Morgan', 'alex@example.invalid', 'Membership terms', '7 days in advance', 'Winter (Nov', 'Membership &amp; billing', 'href="/portal/profile?account=m1"']) assert.ok(profile.includes(text), text);
  assert.ok(!profile.includes('Export emails'));
  assert.ok(renderToStaticMarkup(createElement(ProfileView, { member: members.find(member => member.id === 'm3') })).includes('1 day in advance'));
  assert.ok(renderToStaticMarkup(createElement(ProfileView, { member: members.find(member => member.id === 'm5') })).includes('Required before booking'));
  for (const role of ['admin', 'instructor']) assert.ok(!renderToStaticMarkup(createElement(GolfLabDemo, { initialRole: role, initialView: 'profile' })).includes('Your profile'), role);
});
