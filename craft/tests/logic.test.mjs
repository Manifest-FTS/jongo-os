import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, validDate, dailyLimit, chicagoInstant, validateBooking, previewSeries, canManage, canBook, needsOnboarding, overviewStats, bookingStatus, reportingRange, report, csv, checkoutErrors, DEMO_NOW } from '../dist/golf-lab/logic.js';
import { createFixtureAdapter } from '../dist/golf-lab/fixtures.js';
import { golfLabContentSchemas } from '../dist/golf-lab/schemas.js';

const fixtures = createFixtureAdapter();
const member = fixtures.members[0], instructor = fixtures.members.at(-1);
const actor = { id: member.id, role: 'member' }, coach = { id: instructor.id, role: 'instructor' };
const draft = (patch = {}) => ({ id: 'test', memberId: member.id, date: '2026-11-02', start: 18, hours: 1, bay: 1, status: 'booked', ...patch });
const validate = (patch, rows = []) => validateBooking(draft(patch), rows, member, actor);

test('calendar arithmetic is host-timezone independent and handles leap days', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(validDate('2026-02-30'), false);
  assert.throws(() => addDays('bad', 1));
});
test('winter/summer daily boundaries match approved website', () => {
  for (const [date, limit] of [['2026-04-30', 1], ['2026-05-01', 2], ['2026-10-31', 2], ['2026-11-01', 1]]) assert.equal(dailyLimit(date), limit);
});
test('Chicago UTC conversion observes both standard and daylight offsets', () => {
  assert.equal(chicagoInstant('2026-11-02', 8), DEMO_NOW);
  assert.equal(chicagoInstant('2026-07-02', 8), Date.parse('2026-07-02T13:00:00Z'));
});
test('rejects DST gaps and repeated hours rather than silently selecting offset', () => {
  assert.equal(chicagoInstant('2026-03-08', 2), null);
  assert.equal(chicagoInstant('2026-11-01', 1), null);
  assert.equal(chicagoInstant('2026-11-01', 2), Date.parse('2026-11-01T08:00:00Z'));
});
test('valid member reservation is accepted; malformed and overnight rejected', () => {
  assert.deepEqual(validate({}), []);
  for (const patch of [{ bay: 5 }, { bay: NaN }, { start: 23, hours: 2 }, { hours: 0 }, { hours: 1.5 }, { date: '2026-02-30' }]) assert.ok(validate(patch).length);
});
test('half-open conflicts permit adjacency, reject overlap, ignore cancellations', () => {
  const rows = [draft({ id: 'other', memberId: 'm2', start: 17 })];
  assert.deepEqual(validate({}, rows), []);
  assert.ok(validate({ start: 17 }, rows).some(error => error.includes('Bay conflict')));
  assert.deepEqual(validate({ start: 17 }, [{ ...rows[0], status: 'cancelled' }]), []);
});
test('daily quota spans all bays and excludes cancelled/self edit', () => {
  assert.ok(validate({}, [draft({ id: 'earlier', start: 10, bay: 4 })]).some(error => error.includes('Daily limit')));
  assert.deepEqual(validate({}, [draft()]), []);
  assert.deepEqual(validate({}, [draft({ id: 'cancelled', status: 'cancelled' })]), []);
});
test('cannot double-book account on a different bay', () => {
  assert.ok(validate({}, [draft({ id: 'parallel', bay: 3 })]).some(error => error.includes('overlapping reservation')));
});
test('summer allows two hours while winter rejects two, without admin bypass', () => {
  const summer = draft({ date: '2026-05-02', hours: 2 });
  assert.deepEqual(validateBooking(summer, [], member, actor, Date.parse('2026-05-01T13:00:00Z'), '2026-05-01'), []);
  assert.ok(validate({ hours: 2 }).some(error => error.includes('Daily limit')));
  assert.ok(validateBooking(draft({ hours: 2 }), [], member, { id: 'a1', role: 'admin' }).some(error => error.includes('Daily limit')));
});
test('individual 7-day window is inclusive; junior only 1 day', () => {
  assert.deepEqual(validate({ date: '2026-11-09' }), []);
  assert.ok(validate({ date: '2026-11-10' }).some(error => error.includes('7 days')));
  const junior = fixtures.members[2], juniorActor = { id: junior.id, role: 'member' };
  assert.deepEqual(validateBooking(draft({ memberId: junior.id, date: '2026-11-03' }), [], junior, juniorActor), []);
  assert.ok(validateBooking(draft({ memberId: junior.id, date: '2026-11-04' }), [], junior, juniorActor).some(error => error.includes('1 days')));
});
test('future start required at fixed clock; inactive/waiver/junior/family prerequisites enforced', () => {
  assert.ok(validate({ start: 8 }).some(error => error.includes('future')));
  for (const [patch, message] of [[{ active: false }, 'inactive'], [{ waiver: false }, 'waiver'], [{ tier: 'junior', approved: false }, 'approval'], [{ tier: 'family', individualSponsor: undefined }, 'Individual']]) {
    assert.ok(validateBooking(draft(), [], { ...member, ...patch }, actor).some(error => error.includes(message)));
  }
});
test('roles cannot edit others; administrator may, instructor stays own', () => {
  assert.equal(canManage(actor, draft({ memberId: 'm2' })), false);
  assert.equal(canManage({ id: 'a1', role: 'admin' }, draft()), true);
  assert.equal(canManage(coach, draft()), false);
  assert.ok(validateBooking(draft(), [], member, coach).some(error => error.includes('role')));
  assert.ok(validate({ memberId: 'm2' }).some(error => error.includes('role')));
});
test('weekly instructor series is finite and reveals conflicting dates without overwrite', () => {
  const candidate = draft({ memberId: instructor.id, bay: 2 });
  const result = previewSeries(candidate, 4, fixtures.bookings, instructor, coach);
  assert.equal(result.length, 4);
  assert.deepEqual(result.map(row => row.booking.date), ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']);
  assert.equal(result.filter(row => row.errors.some(error => error.includes('Bay conflict'))).length, 2);
  assert.equal(result.filter(row => !row.errors.length).length, 2);
  assert.equal(fixtures.bookings.length, 8);
  assert.throws(() => previewSeries(candidate, 500, [], instructor, coach));
});
test('member cannot create instructor recurrence', () => {
  assert.ok(previewSeries(draft(), 2, [], member, actor).every(row => row.errors.length));
});
test('instructor proposal is bounded to 90 days, and cannot bypass waiver/access', () => {
  const candidate = draft({ memberId: instructor.id, date: addDays('2026-11-02', 90) });
  assert.deepEqual(validateBooking(candidate, [], instructor, coach), []);
  assert.ok(validateBooking({ ...candidate, date: addDays(candidate.date, 1) }, [], instructor, coach).some(error => error.includes('90 days')));
  assert.ok(validateBooking(candidate, [], { ...instructor, waiver: false }, coach).some(error => error.includes('waiver')));
});
test('completion is scheduled end, cancellation always wins', () => {
  const past = draft({ date: '2026-11-01' });
  assert.equal(bookingStatus(past), 'completed');
  assert.equal(bookingStatus({ ...past, status: 'cancelled' }), 'cancelled');
  assert.equal(bookingStatus(draft()), 'booked');
});
test('week is Monday-based and month is calendar bounded', () => {
  assert.deepEqual(reportingRange('2026-11-01', 'week'), { from: '2026-10-26', to: '2026-11-02' });
  assert.deepEqual(reportingRange('2026-12-20', 'month'), { from: '2026-12-01', to: '2027-01-01' });
});
test('monthly report partitions hours, excludes prior month and supports account filter', () => {
  const result = report(fixtures.bookings, '2026-11-01', '2026-12-01');
  assert.deepEqual(result.totals, { booked: 5, completed: 3, cancelled: 1 });
  assert.equal(Object.values(result.totals).reduce((a, b) => a + b), result.rows.reduce((a, row) => a + row.hours, 0));
  assert.deepEqual(report(fixtures.bookings, '2026-11-01', '2026-12-01', 'm1').totals, { booked: 1, completed: 1, cancelled: 1 });
});
test('weekly report and empty report have exact totals', () => {
  assert.deepEqual(report(fixtures.bookings, '2026-11-02', '2026-11-09').totals, { booked: 4, completed: 0, cancelled: 1 });
  assert.deepEqual(report([], '2026-11-02', '2026-11-09').totals, { booked: 0, completed: 0, cancelled: 0 });
});
test('CSV escapes quotes and formula starts and retains cancelled status', () => {
  const text = csv([draft({ id: '=1+1', memberId: 'a"b', status: 'cancelled' })]);
  assert.ok(text.includes('"\'=1+1"'));
  assert.ok(text.includes('"a""b"'));
  assert.ok(text.includes('"cancelled"'));
  assert.equal(text.split('\r\n').length, 2);
});
test('checkout has no payment action and enforces agreement, sponsor, approval', () => {
  assert.deepEqual(checkoutErrors('monthly', true, false, false), []);
  assert.ok(checkoutErrors('monthly', false, false, false).length);
  assert.ok(checkoutErrors('family', true, false, false).length);
  assert.ok(checkoutErrors('junior', true, false, false).length);
  assert.ok(checkoutErrors('unknown', true, true, true).length);
});
test('fixture adapters are independent; content schemas never represent operations', () => {
  const a = createFixtureAdapter(), b = createFixtureAdapter(); a.bookings.pop();
  assert.equal(b.bookings.length, 8);
  assert.deepEqual(golfLabContentSchemas.map(item => item.name), ['golfLabNotice', 'golfLabHelp']);
  assert.ok(golfLabContentSchemas.every(item => item.type === 'document' && item.schemaVersion === 1));
});
test('unpaid and pending billing reject bookings even with active access and an admin actor', () => {
  for (const billingStatus of ['unpaid', 'pending', 'past_due', 'suspended']) {
    const account = { ...member, active: true, billingStatus };
    assert.equal(canBook(account), false);
    for (const identity of [actor, { id: 'a1', role: 'admin' }]) assert.ok(validateBooking(draft(), [], account, identity).some(error => error.includes('paid membership')));
  }
});
test('medical suspension is paid but not bookable or unpaid onboarding', () => {
  const medical = fixtures.members.find(row => row.accessReason === 'medical');
  assert.equal(medical.billingStatus, 'active');
  assert.equal(needsOnboarding(medical), false);
  assert.equal(canBook(medical), false);
  assert.ok(validateBooking(draft({ memberId: medical.id }), [], medical, { id: medical.id, role: 'member' }).some(error => error.includes('inactive')));
  assert.ok(fixtures.members.every(row => ['unpaid', 'pending', 'active', 'past_due', 'suspended'].includes(row.billingStatus)));
});
test('overview counts bookings not hours, cancels excluded, week/month include future dates, YTD ends today', () => {
  const rows = [
    draft({ id: 'now', start: 8, hours: 2 }), draft({ id: 'ended', start: 7 }),
    draft({ id: 'cancel', start: 8, status: 'cancelled' }),
    draft({ id: 'sun', date: '2026-11-08', hours: 2 }), draft({ id: 'next-week', date: '2026-11-09' }),
    draft({ id: 'month-end', date: '2026-11-30' }), draft({ id: 'next-month', date: '2026-12-01' }),
    draft({ id: 'jan', date: '2026-01-01' }), draft({ id: 'last-year', date: '2025-12-31' })
  ];
  assert.deepEqual(overviewStats(rows), { 'Practicing Now': 1, 'Total Booked Today': 2, 'Booked This Week': 3, 'Booked This Month': 5, 'YTD Bookings': 3 });
  assert.equal(overviewStats(rows, '2026-11-02', DEMO_NOW + 2 * 3600000)['Practicing Now'], 0);
  assert.equal(overviewStats(rows, '2026-11-02', DEMO_NOW - 1)['Practicing Now'], 1);
  assert.equal(overviewStats(rows, '2026-11-02', Date.parse('2026-11-03T00:00:00Z'))['Practicing Now'], 0);
});
test('overview Chicago calendar ranges cross years, weeks and leap-month boundaries', () => {
  const rows = [draft({ date: '2027-01-01' }), draft({ date: '2026-12-31' }), draft({ date: '2027-01-03' }), draft({ date: '2027-01-04' })];
  assert.deepEqual(overviewStats(rows, '2027-01-01', chicagoInstant('2027-01-01', 8)), { 'Practicing Now': 0, 'Total Booked Today': 1, 'Booked This Week': 3, 'Booked This Month': 3, 'YTD Bookings': 1 });
  assert.equal(overviewStats([draft({ date: '2028-02-29' }), draft({ date: '2028-03-01' })], '2028-02-01')['Booked This Month'], 1);
});