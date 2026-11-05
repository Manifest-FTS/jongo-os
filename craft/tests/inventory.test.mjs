import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureAdapter, createBayFixtures, updateInventory, resolveBay, bayReservations, validateBooking, previewSeries, overviewStats, report, DEMO_NOW, DEMO_TODAY } from '../dist/golf-lab/logic.js';
const admin = { id: 'a1', role: 'admin' };

test('inventory fixtures are per instance; identity/number stable across rename and reorder', () => {
  const first = createFixtureAdapter(), second = createFixtureAdapter();
  assert.equal(first.bays.length, 4);
  first.bays[0].name = 'Local only';
  assert.notEqual(first.bays[0].name, second.bays[0].name);
  const renamed = updateInventory(admin, [...second.bays].reverse(), 'North Studio', second.bays[0].id);
  assert.equal(resolveBay(renamed, 1).id, second.bays[0].id);
  assert.equal(resolveBay(renamed, 1).name, 'North Studio');
  assert.deepEqual(bayReservations(resolveBay(renamed, 1), first.bookings, '2026-11-03').map(row => row.id), ['b1']);
  assert.deepEqual(first.bookings, second.bookings);
});
test('automatic numbers use highest existing number not array length and IDs are unique', () => {
  const bays = createBayFixtures();
  const fifth = updateInventory(admin, bays, 'Bay Five');
  const sixth = updateInventory(admin, fifth, 'Bay Six');
  assert.deepEqual(sixth.map(bay => bay.displayNumber), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(sixth.map(bay => bay.id)).size, 6);
  assert.equal(updateInventory(admin, [{ id: 'opaque', displayNumber: 9, name: 'Nine' }], 'Ten').at(-1).displayNumber, 10);
  assert.equal(bays.length, 4);
});
test('inventory refuses members/instructors, blank/long/duplicate names and identity/number collisions', () => {
  const bays = createBayFixtures();
  for (const role of ['member', 'instructor']) assert.throws(() => updateInventory({ id: 'm1', role }, bays, 'New'), /Only admins/);
  for (const name of ['', '   ', 'x'.repeat(61), ' the FAIRWAY ']) assert.throws(() => updateInventory(admin, bays, name));
  assert.throws(() => updateInventory(admin, bays, 'New', undefined, bays[0].id), /collision/);
  assert.throws(() => updateInventory(admin, [...bays, { ...bays[0], id: 'other' }], 'New'), /collision/);
  assert.throws(() => updateInventory(admin, bays, 'New', 'missing'), /not found/);
  const renamed = updateInventory(admin, bays, '  North   Studio  ', bays[0].id);
  assert.equal(renamed[0].name, 'North Studio');
  assert.equal(renamed[0].displayNumber, bays[0].displayNumber);
});
test('fifth bay validates, retains conflicts and cancellations and refuses missing inventory', () => {
  const adapter = createFixtureAdapter(), bays = updateInventory(admin, adapter.bays, 'New Studio');
  const member = adapter.members[0], actor = { id: member.id, role: 'member' };
  const booking = { id: 'new', memberId: member.id, date: DEMO_TODAY, start: 19, hours: 1, bay: 5, status: 'booked' };
  const validate = (row, existing = [], inventory = bays) => validateBooking(row, existing, member, actor, DEMO_NOW, DEMO_TODAY, inventory);
  assert.deepEqual(validate(booking), []);
  assert.ok(validate({ ...booking, bay: 6 }).length);
  assert.ok(validate(booking, [], []).length);
  const other = { ...booking, id: 'other', memberId: 'm2' };
  assert.ok(validate(booking, [other]).some(error => error.includes('Bay conflict')));
  assert.deepEqual(validate(booking, [{ ...other, status: 'cancelled' }]), []);
  const renamed = updateInventory(admin, bays, 'Renamed Studio', bays.at(-1).id);
  assert.ok(validate(booking, [other], renamed).some(error => error.includes('Bay conflict')));
  assert.deepEqual(validate({ ...booking, start: 20 }, [other]), []);
});
test('recurrence on added bay shares conflict checks; counts are reservations not attendance', () => {
  const adapter = createFixtureAdapter(), bays = updateInventory(admin, adapter.bays, 'Teaching Studio');
  const instructor = adapter.members.find(row => row.id === 'i1'), actor = { id: 'i1', role: 'instructor' };
  const candidate = { id: 'series', memberId: 'i1', date: DEMO_TODAY, start: 19, hours: 2, bay: 5, status: 'booked' };
  const conflict = { ...candidate, id: 'existing', memberId: 'm1', date: '2026-11-09' };
  const preview = previewSeries(candidate, 4, [conflict], instructor, actor, bays);
  assert.deepEqual(preview.map(row => !!row.errors.length), [false, true, false, false]);
  const accepted = preview.filter(row => !row.errors.length).map(row => row.booking);
  assert.equal(overviewStats(accepted)['Total Booked Today'], 1);
  assert.equal(report(accepted, '2026-11-01', '2026-12-01').totals.booked, 6);
  assert.equal(bayReservations(bays.at(-1), [...accepted, { ...conflict, status: 'cancelled' }], '2026-11-09').length, 0);
});