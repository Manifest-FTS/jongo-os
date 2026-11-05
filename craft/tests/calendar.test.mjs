import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BookingDateControls, BookingEditor, GolfLabSpecimens } from '../dist/golf-lab/index.js';
import { calendarExport, icsEscape, icsFold, createFixtureAdapter, DEMO_NOW } from '../dist/golf-lab/logic.js';
const fixtures = createFixtureAdapter(), admin = { id: 'a1', role: 'admin' }, member = { id: 'm1', role: 'member' }, instructor = { id: 'i1', role: 'instructor' };
const exportFor = (actor, selection, rows = fixtures.bookings) => calendarExport(rows, fixtures.members, fixtures.bays, actor, selection, DEMO_NOW, DEMO_NOW);
const unfold = value => value.replace(/\r\n /g, '');
test('schedule restores a labeled native date with existing week and today controls', () => {
  const html = renderToStaticMarkup(createElement(BookingDateControls, { date: '2026-11-02', onChange() {} }));
  assert.match(html, /<label>Choose day<input aria-label="Choose day" type="date"/);
  assert.match(html, /value="2026-11-02"/);
  for (const label of ['Previous week', 'Next week', 'Today', 'craft-calendar-controls']) assert.ok(html.includes(label));
  assert.ok(!html.includes('craft-date-')); assert.ok(!html.includes('aria-haspopup'));
});
test('native booking date retains required eligibility bounds and styleguide uses native dates', () => {
  const html = renderToStaticMarkup(createElement(BookingEditor, { actor: member, members: fixtures.members, bookings: fixtures.bookings, bays: fixtures.bays, date: '2026-11-02', onClose() {}, onSave() {} }));
  assert.match(html, /<label>Date<input aria-label="Date" type="date" required=""/);
  assert.match(html, /min="2026-11-02" max="2026-11-09"/);
  for (const label of ['Bay', 'Start time', 'Duration']) assert.ok(html.includes(`aria-label="${label}"`));
  const specimen = renderToStaticMarkup(createElement(GolfLabSpecimens));
  assert.match(specimen, /<label>Specimen day<input aria-label="Specimen day" type="date"/);
  assert.ok(specimen.includes('Downloaded snapshots do not sync')); assert.ok(!specimen.includes('craft-date-'));
});
test('ICS escaping prevents injected properties and escapes comma semicolon backslash and newline', () => {
  assert.equal(icsEscape('a,b;c\\d\r\nEND:VEVENT\nX'), 'a\\,b\\;c\\\\d\\nEND:VEVENT\\nX');
});
test('ICS folding is lossless UTF-8 with 75-octet lines including continuation spaces', () => {
  const source = 'SUMMARY:' + 'é🏌️; '.repeat(80), folded = icsFold(source);
  assert.equal(unfold(folded), source);
  for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
});
test('member export is own future only even when given all fixture rows and broad range', () => {
  const result = exportFor(member, { from: '2026-10-01', to: '2027-02-01' });
  assert.ok(result.count > 0); assert.ok(unfold(result.content).includes('Alex Morgan'));
  for (const name of ['Sam Rivera', 'Derek Domaleski', '@example.invalid']) assert.ok(!result.content.includes(name));
  assert.equal(exportFor(member, { bookingId: fixtures.bookings.find(row => row.memberId === 'i1').id }).count, 0);
  assert.throws(() => exportFor(member, { seriesId: 'series' }), /Members cannot/);
});
test('instructor cannot export other identities and own series excludes cancelled and started', () => {
  const rows = [0, 1, 2].map(index => ({ id: 's-' + index, memberId: 'i1', date: index === 0 ? '2026-11-01' : '2026-11-09', start: 15 + index, hours: 1, bay: 1, status: index === 2 ? 'cancelled' : 'booked', seriesId: 's' }));
  rows.push({ ...rows[1], id: 'other', memberId: 'm1' });
  const result = exportFor(instructor, { seriesId: 's' }, rows);
  assert.equal(result.count, 1); assert.match(unfold(result.content), /Derek Domaleski/); assert.ok(!result.content.includes('Alex Morgan'));
});
test('admin selected day/week includes history across named bays but excludes cancelled and exclusive end', () => {
  const result = exportFor(admin, { from: '2026-11-01', to: '2026-11-02' });
  assert.equal(result.count, fixtures.bookings.filter(row => row.date === '2026-11-01' && row.status !== 'cancelled').length);
  assert.match(unfold(result.content), /includes history/); assert.match(unfold(result.content), /The Turn/);
  assert.ok(!result.content.includes('ATTENDEE')); assert.ok(!result.content.includes('mailto:'));
});
test('UTC DTSTART DTEND respect Chicago winter summer and DST dates with no floating-time ambiguity', () => {
  const rows = ['2026-01-12', '2026-07-13', '2026-03-08', '2026-11-01'].map((date, index) => ({ id: 'utc-' + index, memberId: 'i1', date, start: 15, hours: 6, bay: 1, status: 'booked' }));
  const text = unfold(exportFor(admin, { from: '2026-01-01', to: '2027-01-01' }, rows).content);
  for (const date of ['20260112T210000Z', '20260713T200000Z', '20260308T200000Z', '20261101T210000Z']) assert.ok(text.includes('DTSTART:' + date));
  assert.match(text, /DTEND:20260113T030000Z/); assert.match(text, /DTSTAMP:20261102T140000Z/);
  assert.ok(!text.includes('TZID')); assert.ok(!text.includes('RRULE'));
});
test('stable per-booking UID survives edits and bay rename/reorder while UTC times change', () => {
  const row = { id: 'stable-id', memberId: 'i1', date: '2026-11-09', start: 15, hours: 6, bay: 1, status: 'booked' };
  const before = exportFor(instructor, { bookingId: row.id }, [row]).content;
  const after = calendarExport([{ ...row, start: 14 }], fixtures.members, [...fixtures.bays].reverse().map(bay => ({ ...bay, name: 'Renamed' })), instructor, { bookingId: row.id }, DEMO_NOW, DEMO_NOW).content;
  assert.equal(before.match(/UID:[^\r]+/)[0], after.match(/UID:[^\r]+/)[0]); assert.notEqual(before, after); assert.match(unfold(after), /Renamed/);
});
test('ICS has CRLF envelope and empty ranges are valid with zero events; unauthorized/invalid ranges fail', () => {
  const result = exportFor(admin, { from: '2028-01-01', to: '2028-01-02' });
  assert.equal(result.count, 0); assert.ok(result.content.endsWith('END:VCALENDAR\r\n')); assert.ok(!/(?<!\r)\n/.test(result.content));
  assert.throws(() => exportFor({ id: 'unknown', role: 'instructor' }, { from: '2026-11-01', to: '2026-12-01' }), /Unauthorized/);
  assert.throws(() => exportFor(admin, { from: '2026-02-30', to: '2026-12-01' }), /valid/);
});
test('invalid DST wall time or internal transition fails export rather than shifting', () => {
  for (const [date, start, hours] of [['2026-03-08', 2, 1], ['2026-11-01', 1, 1], ['2026-03-08', 0, 4]]) {
    assert.throws(() => exportFor(admin, { from: date, to: '2027-01-01' }, [{ id: 'bad', memberId: 'i1', date, start, hours, bay: 1, status: 'booked' }]), /Invalid reservation/);
  }
});