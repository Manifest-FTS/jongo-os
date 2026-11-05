import { chicagoInstant, DEMO_NOW, editableBooking, validDate, type Actor, type Booking, type Member } from './logic.js';
import { bayLabel, resolveBay, type Bay } from './inventory.js';

export type CalendarSelection = { from?: string; to?: string; bookingId?: string; seriesId?: string };
export function icsEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replace(/\r\n|\r|\n/g, '\\n').replaceAll(';', '\\;').replaceAll(',', '\\,');
}
/** RFC 5545: fold at 75 UTF-8 octets, including each continuation's leading space. */
export function icsFold(line: string): string {
  let result = '', chunk = '', bytes = 0;
  for (const character of line) {
    const size = new TextEncoder().encode(character).length;
    if (bytes + size > 75) { result += chunk + '\r\n'; chunk = ' '; bytes = 1; }
    chunk += character; bytes += size;
  }
  return result + chunk;
}
const timestamp = (instant: number) => new Date(instant).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
/** Local download snapshot, never a subscription/sync/invitation. Personal exports are own future only.
 * Admin range exports include noncancelled past/in-progress reservations and are labeled as history. */
export function calendarExport(bookings: readonly Booking[], members: readonly Member[], bays: readonly Bay[], actor: Actor, selection: CalendarSelection, now = DEMO_NOW, stamp = Date.now()): { content: string; count: number } {
  if (!['admin', 'member', 'instructor'].includes(actor.role) || (actor.role !== 'admin' && !members.some(member => member.id === actor.id && (actor.role === 'instructor' ? member.tier === 'instructor' : member.tier !== 'instructor')))) throw new Error('Unauthorized calendar export.');
  const range = selection.from !== undefined || selection.to !== undefined;
  if (range && (!selection.from || !selection.to || !validDate(selection.from) || !validDate(selection.to) || selection.from >= selection.to)) throw new Error('Choose a valid exclusive calendar range.');
  if (!range && !selection.bookingId && !selection.seriesId) throw new Error('Select a reservation, series or date range.');
  if (selection.seriesId && actor.role === 'member') throw new Error('Members cannot export instructor series.');
  const rows = bookings.filter(row => row.status !== 'cancelled' && (actor.role === 'admin' || row.memberId === actor.id)
    && (actor.role === 'admin' && range ? true : editableBooking(row, now))
    && (!range || row.date >= selection.from! && row.date < selection.to!)
    && (!selection.bookingId || row.id === selection.bookingId) && (!selection.seriesId || row.seriesId === selection.seriesId))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start || a.id.localeCompare(b.id));
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jongo Craft//Golf Lab calendar snapshot//EN', 'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${icsEscape(actor.role === 'admin' && range ? 'Golf Lab schedule (includes history; cancelled excluded)' : 'Golf Lab own future sessions')}`];
  for (const row of rows) {
    const start = chicagoInstant(row.date, row.start), end = chicagoInstant(row.date, row.start + row.hours), bay = resolveBay(bays, row.bay);
    if (start === null || end === null || end <= start || end - start !== row.hours * 3600000 || !bay) throw new Error('Invalid reservation time or bay. No calendar was downloaded.');
    const name = members.find(member => member.id === row.memberId)?.name ?? 'Account';
    const uid = Array.from(new TextEncoder().encode(row.id), byte => byte.toString(16).padStart(2, '0')).join('');
    lines.push('BEGIN:VEVENT', `UID:booking-${uid}@golf-lab.craft.invalid`, `DTSTAMP:${timestamp(stamp)}`, `DTSTART:${timestamp(start)}`, `DTEND:${timestamp(end)}`,
      `SUMMARY:${icsEscape(`The Golf Lab · ${bayLabel(bay)} · ${name}`)}`, `LOCATION:${icsEscape(`The Golf Lab · ${bayLabel(bay)}`)}`,
      `DESCRIPTION:${icsEscape(`Reservation snapshot. America/Chicago local time; exported as UTC. ${actor.role === 'admin' && range ? 'Includes selected-range history; not attendance.' : 'Own future reservation only.'} Importing does not sync later changes or cancellations. No email or provider request.`)}`,
      'STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return { count: rows.length, content: lines.map(icsFold).join('\r\n') + '\r\n' };
}