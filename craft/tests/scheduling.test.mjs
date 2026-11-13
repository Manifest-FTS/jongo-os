import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, applyScheduleStage, bookingStatus, chicagoInstant, createFixtureAdapter, csv, DEMO_NOW, DEMO_TODAY, editableBooking, INSTRUCTOR_HORIZON_DAYS, INSTRUCTOR_MAX_HOURS, previewWeekly, report, stageScheduleChange, updateInventory, validateBooking } from '../dist/golf-lab/logic.js';

const fixtures = createFixtureAdapter(), coach = { id: 'i1', role: 'instructor' }, admin = { id: 'a1', role: 'admin' }, actor = { id: 'm1', role: 'member' };
const instructor = fixtures.members.find(row => row.id === coach.id), member = fixtures.members[0];
const draft = (patch = {}) => ({ id: 'weekly', memberId: 'i1', date: DEMO_TODAY, start: 15, hours: 6, bay: 1, status: 'booked', ...patch });
const validate = (row, account = instructor, who = coach, existing = [], now = DEMO_NOW, today = DEMO_TODAY) => validateBooking(row, existing, account, who, now, today, fixtures.bays);
const weekly = (until = '2027-01-02', existing = [], row = draft()) => previewWeekly(row, until, existing, instructor, coach, fixtures.bays);
const apply = (rows, stage, skip = false, who = coach, members = fixtures.members, bays = fixtures.bays) => applyScheduleStage(rows, stage, who, members, bays, skip);
const change = (rows, id, scope, patch, who = coach) => stageScheduleChange(rows, id, scope, who, fixtures.members, patch, fixtures.bays);
const series = () => apply([], weekly());
const patch = (overrides = {}) => ({ date: DEMO_TODAY, start: 14, hours: 6, bay: 2, ...overrides });

test('6h instructor events accepted; ordinary members and admin member bookings retain seasonal caps', () => {
  assert.deepEqual(validate(draft()), []);
  assert.equal(INSTRUCTOR_MAX_HOURS, 12);
  assert.deepEqual(validate(draft({ start: 12, hours: 12 })), []);
  assert.ok(validate(draft({ hours: 13 })).length);
  assert.ok(validate(draft({ start: 19, hours: 6 })).length);
  assert.deepEqual(validate(draft({ start: 23, hours: 1 })), []);
  for (const who of [actor, admin]) {
    assert.ok(validate(draft({ memberId: member.id }), member, who).length);
    assert.ok(validate(draft({ memberId: member.id, hours: 2 }), member, who).some(error => error.includes('Daily limit: 1')));
    assert.deepEqual(validate(draft({ memberId: member.id, date: '2027-05-03', hours: 2 }), member, who, [], Date.parse('2027-05-03T13:00:00Z'), '2027-05-03'), []);
    assert.ok(validate(draft({ memberId: member.id, date: '2027-05-03', hours: 3 }), member, who, [], Date.parse('2027-05-03T13:00:00Z'), '2027-05-03').length);
  }
});
test('Derek Monday 15–21 inclusive series represents two months, not eight-count limited', () => {
  const stage = weekly('2027-01-04');
  assert.deepEqual(stage.errors, []);
  assert.equal(stage.candidates.length, 10);
  assert.equal(stage.candidates.at(-1).booking.date, '2027-01-04');
  assert.equal(weekly('2027-01-03').candidates.length, 9);
  assert.equal(weekly(DEMO_TODAY).candidates.length, 1);
  assert.ok(stage.candidates.every(row => !row.errors.length && row.booking.start === 15 && row.booking.hours === 6 && row.booking.seriesId === 'weekly'));
  assert.equal(new Set(stage.candidates.map(row => row.booking.id)).size, 10);
});
test('inclusive horizon allows boundary, rejects beyond even non-occurrence end dates and invalid bounds', () => {
  assert.equal(INSTRUCTOR_HORIZON_DAYS, 90);
  assert.equal(weekly(addDays(DEMO_TODAY, 90)).candidates.length, 13);
  for (const until of [addDays(DEMO_TODAY, 91), '2026-11-01', '2026-02-30', 'invalid', '']) assert.ok(weekly(until).errors.length);
  assert.ok(weekly('2027-01-02', [], draft({ date: '2026-02-30' })).errors.length);
  assert.ok(validate(draft({ date: addDays(DEMO_TODAY, 91) })).some(error => error.includes('90 days')));
  const junior = fixtures.members.find(row => row.tier === 'junior');
  assert.ok(validate(draft({ memberId: member.id, hours: 1, date: addDays(DEMO_TODAY, 8) }), member, actor).some(error => error.includes('7 days')));
  assert.ok(validate(draft({ memberId: junior.id, hours: 1, date: addDays(DEMO_TODAY, 4) }), junior, { id: junior.id, role: 'member' }).some(error => error.includes('3 days')));
});
test('DST gaps/repeated hours and internal transitions cannot be scheduled or skipped', () => {
  assert.equal(chicagoInstant('2027-03-14', 2), null);
  assert.equal(chicagoInstant('2026-11-01', 1), null);
  for (const date of ['2027-03-14', '2026-11-01']) {
    const errors = validate(draft({ date, start: 0, hours: 6 }), instructor, coach, [], Date.parse(addDays(date, -1) + 'T12:00:00Z'), addDays(date, -1));
    assert.ok(errors.some(error => error.includes('DST')));
  }
});
test('same-account overlap across bays rejected; cancelled rows ignore occupancy and member daily quota', () => {
  const row = draft({ id: 'old', bay: 4 });
  assert.ok(validate(draft(), instructor, coach, [row]).some(error => error.includes('overlapping')));
  assert.deepEqual(validate(draft(), instructor, coach, [{ ...row, status: 'cancelled' }]), []);
  const memberRow = draft({ memberId: 'm1', hours: 1, id: 'old' });
  assert.deepEqual(validate(draft({ memberId: 'm1', hours: 1 }), member, actor, [{ ...memberRow, status: 'cancelled' }]), []);
});
test('creation reveals conflicts and explicit skip is required, with no mutation or displaced reservations', () => {
  const existing = [draft({ id: 'occupied', memberId: 'm2', date: '2026-11-09', hours: 1 })], original = structuredClone(existing);
  const stage = weekly('2026-11-16', existing);
  assert.equal(stage.candidates.filter(row => row.errors.length).length, 1);
  assert.throws(() => apply(existing, stage), /Bay conflict/);
  assert.deepEqual(existing, original);
  const result = apply(existing, stage, true);
  assert.equal(result.length, 3);
  assert.deepEqual(result.find(row => row.id === 'occupied'), original[0]);
  assert.ok(!result.some(row => row.id === 'weekly-1'));
});
test('conflicting future edit fails atomically; explicit skips retain original schedule and stable series identity', () => {
  const rows = series();
  rows.push(draft({ id: 'occupied', memberId: 'm2', date: '2026-11-16', start: 14, hours: 1, bay: 2 }));
  const original = structuredClone(rows), stage = change(rows, 'weekly-1', 'following', patch({ date: '2026-11-09' }));
  assert.equal(stage.candidates.length, 8);
  assert.equal(stage.candidates.filter(row => row.errors.length).length, 1);
  assert.throws(() => apply(rows, stage), /Bay conflict/);
  assert.deepEqual(rows, original);
  const result = apply(rows, stage, true);
  assert.deepEqual(result.find(row => row.id === 'weekly-2'), original.find(row => row.id === 'weekly-2'));
  assert.deepEqual(result.find(row => row.id === 'weekly-0'), original.find(row => row.id === 'weekly-0'));
  assert.equal(result.find(row => row.id === 'weekly-1').bay, 2);
  assert.deepEqual(result.map(row => row.id).sort(), rows.map(row => row.id).sort());
  assert.ok(result.filter(row => row.id.startsWith('weekly-')).every(row => row.seriesId === 'weekly' && row.memberId === 'i1'));
});
test('single edit preserves identity/grouping; future date shift retains count and old excluded rows', () => {
  const rows = series(), one = apply(rows, change(rows, 'weekly-1', 'one', patch({ date: '2026-11-10' })));
  assert.equal(one.find(row => row.id === 'weekly-1').date, '2026-11-10');
  assert.deepEqual(one.filter(row => row.id !== 'weekly-1').sort((a,b) => a.id.localeCompare(b.id)), rows.filter(row => row.id !== 'weekly-1').sort((a,b) => a.id.localeCompare(b.id)));
  const following = apply(rows, change(rows, 'weekly-1', 'following', patch({ date: '2026-11-10' })));
  assert.equal(following.length, rows.length);
  assert.equal(following.find(row => row.id === 'weekly-2').date, '2026-11-17');
  assert.deepEqual(following.find(row => row.id === 'weekly-0'), rows[0]);
});
test('single/following cancellation idempotent; started/completed/cancelled records immutable', () => {
  const rows = series();
  rows.push(draft({ id: 'history', date: '2026-10-26', seriesId: 'weekly' }), draft({ id: 'started', start: 7, hours: 6, seriesId: 'weekly' }), draft({ id: 'already-cancelled', date: '2026-12-07', seriesId: 'weekly', status: 'cancelled' }));
  const original = structuredClone(rows);
  const cancellation = change(rows, 'weekly-1', 'one');
  const one = apply(rows, cancellation);
  assert.equal(one.filter(row => row.status === 'cancelled').length, 2);
  assert.deepEqual(apply(one, change(one, 'weekly-1', 'one')), one);
  assert.deepEqual(apply(one, cancellation), one);
  assert.throws(() => apply(one, cancellation, false, actor), /Unauthorized/);
  const following = apply(rows, change(rows, 'weekly-1', 'following'));
  assert.deepEqual(apply(following, change(rows, 'weekly-1', 'following')), following);
  for (const id of ['history', 'started', 'already-cancelled', 'weekly-0']) assert.deepEqual(following.find(row => row.id === id), original.find(row => row.id === id));
  for (const id of ['history', 'started', 'already-cancelled']) {
    assert.equal(editableBooking(rows.find(row => row.id === id)), false);
    assert.ok(change(rows, id, 'one', patch()).errors.length);
  }
  assert.ok(change(rows, 'history', 'one').errors.length);
  assert.ok(change(rows, 'started', 'following').errors.length);
  assert.equal(following.filter(row => row.id.startsWith('weekly-') && row.status === 'cancelled').length, 8);
});
test('member/instructor ownership, admin instructor scheduling and identity collision protection', () => {
  const rows = series(), other = draft({ id: 'other-coach', memberId: 'i2', seriesId: 'weekly' });
  const members = [...fixtures.members, { ...instructor, id: 'i2' }];
  assert.ok(change(rows, 'weekly-0', 'one', patch(), actor).errors.length);
  assert.ok(stageScheduleChange([other], other.id, 'one', coach, members, patch()).errors.length);
  assert.ok(previewWeekly(draft({ memberId: member.id }), '2026-11-09', [], member, actor).errors.length);
  assert.ok(validate(draft(), instructor, { id: 'i1', role: 'member' }).some(error => error.includes('role')));
  assert.equal(apply(rows, change(rows, 'weekly-0', 'one', patch(), admin), false, admin).length, rows.length);
  assert.throws(() => apply(rows, weekly()), /identity|Schedule changed/);
  assert.ok(change(rows, 'weekly-0', 'all', patch()).errors.length);
  const tampered = change(rows, 'weekly-0', 'one', patch()); tampered.candidates[0].booking.memberId = 'i2';
  assert.throws(() => apply(rows, tampered, false, admin, members), /Unauthorized/);
  const cross = stageScheduleChange([...rows, other], 'weekly-0', 'following', coach, members, patch());
  assert.ok(cross.candidates.every(row => row.booking.memberId === 'i1'));
});
test('inactive/unpaid accounts and invalid future changes cannot be bypassed with skip or admin', () => {
  const rows = series();
  for (const account of [{ ...instructor, active: false }, { ...instructor, billingStatus: 'unpaid' }, { ...instructor, waiver: false }]) {
    const members = fixtures.members.map(row => row.id === account.id ? account : row);
    for (const who of [coach, admin]) assert.throws(() => apply(rows, change(rows, 'weekly-0', 'following', patch(), who), true, who, members), /inactive|paid membership|waiver/);
  }
  for (const changes of [patch({ date: 'invalid' }), patch({ hours: 13 }), patch({ start: 22 }), patch({ date: '2027-01-10' })]) assert.throws(() => apply(rows, change(rows, 'weekly-0', 'following', changes), true), /valid|90 days/);
  assert.equal(rows[0].start, 15);
});
test('stale previews fail atomically including new occupancy; skipped slots cannot be reused by later changes', () => {
  const rows = series(), stage = change(rows, 'weekly-0', 'following', patch());
  const stale = rows.map(row => row.id === 'weekly-3' ? { ...row, start: 16 } : row), original = structuredClone(stale);
  assert.throws(() => apply(stale, stage), /Schedule changed/);
  assert.deepEqual(stale, original);
  const occupied = [...rows, draft({ id: 'late-conflict', memberId: 'm2', start: 14, hours: 1, bay: 2 })];
  assert.throws(() => apply(occupied, stage), /Bay conflict/);
  assert.deepEqual(occupied[0], rows[0]);
  const shifting = change(rows, 'weekly-0', 'following', patch({ date: '2026-11-09', bay: 1, start: 15 }));
  assert.ok(shifting.candidates.some(row => row.errors.length));
  const skipped = apply(rows, shifting, true);
  assert.deepEqual(skipped.find(row => row.id === 'weekly-0'), rows[0]);
  assert.equal(skipped.find(row => row.id === 'weekly-8').date, '2027-01-04');
});
test('inventory IDs stable through rename/reorder; recurrence uses displayNumber, not labels/indexes', () => {
  const bays = updateInventory(admin, fixtures.bays, 'Teaching Room'), renamed = updateInventory(admin, bays, 'Renamed Teaching Room', bays.at(-1).id).reverse();
  assert.equal(renamed[0].id, bays.at(-1).id);
  const stage = previewWeekly(draft({ bay: 5 }), '2026-11-16', [], instructor, coach, renamed);
  assert.equal(apply([], stage, false, coach, fixtures.members, renamed).length, 3);
  assert.ok(previewWeekly(draft({ bay: 6 }), '2026-11-16', [], instructor, coach, renamed).candidates.every(row => row.errors.length));
});
test('reports/CSV partition cancelled and completed scheduled totals after future cancellation', () => {
  const rows = series(), historical = draft({ id: 'history', date: '2026-11-01', seriesId: 'weekly' });
  const result = apply([...rows, historical], change([...rows, historical], 'weekly-1', 'following'));
  assert.equal(bookingStatus(historical), 'completed');
  assert.deepEqual(report(result, '2026-11-01', '2026-12-01', 'i1').totals, { booked: 6, completed: 6, cancelled: 24 });
  const later = report(result, '2026-11-01', '2027-02-01', 'i1', Date.parse('2027-02-01T14:00:00Z'));
  assert.deepEqual(later.totals, { booked: 0, completed: 12, cancelled: 48 });
  assert.equal(later.rows.reduce((sum,row) => sum + row.hours, 0), Object.values(later.totals).reduce((sum,hours) => sum + hours, 0));
  assert.ok(csv(result).includes('"cancelled"'));
  assert.deepEqual(result.find(row => row.id === 'history'), historical);
});