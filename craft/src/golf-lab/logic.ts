export type Role = 'member' | 'admin' | 'instructor';
export { calendarExport, icsEscape, icsFold } from './calendar-export.js';
export type { CalendarSelection } from './calendar-export.js';
import { assertInventory, createBayFixtures, resolveBay, type Bay } from './inventory.js';
export { createBayFixtures, resolveBay, bayLabel, updateInventory, bayReservations } from './inventory.js';
export type { Bay } from './inventory.js';
export { createFixtureAdapter } from './fixtures.js';
export type BillingStatus = 'unpaid' | 'pending' | 'active' | 'past_due' | 'suspended';
export type Member = { id: string; name: string; email: string; tier: 'individual' | 'family' | 'junior' | 'instructor'; active: boolean; waiver: boolean; approved: boolean; individualSponsor?: string; billingStatus: BillingStatus; accessReason?: 'medical' | 'billing'; billing: string };
export type Booking = { id: string; memberId: string; date: string; start: number; hours: number; bay: number; status: 'booked' | 'cancelled'; seriesId?: string };
export type Actor = { id: string; role: Role };
export const DEMO_TODAY = '2026-11-02';
export const DEMO_NOW = Date.parse('2026-11-02T14:00:00Z');
// The preview runs on a frozen fixture clock. A live deployment sets the real moment once per snapshot, so server and browser agree on what "now" is.
let liveNow: number | null = null;
export function setLiveClock(now: number | null): void { liveNow = now; }
export const clockNow = (): number => liveNow ?? DEMO_NOW;
const chicagoDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
export const clockToday = (): string => liveNow === null ? DEMO_TODAY : chicagoDay.format(liveNow);
export const TIME_ZONE = 'America/Chicago';
/** Configurable fixture bounds, not approved production instructor policy. */
export const INSTRUCTOR_MAX_HOURS = 12;
export const INSTRUCTOR_HORIZON_DAYS = 90;
export function validDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T12:00:00Z')) && new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) === date;
}
export function addDays(date: string, days: number): string {
  if (!validDate(date) || !Number.isInteger(days)) throw new Error('Invalid calendar date');
  const value = new Date(date + 'T12:00:00Z'); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10);
}
export function dayDifference(a: string, b: string): number { return (Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86400000; }
/** Reject DST gaps and repeated wall times instead of silently shifting/choosing an offset. */
export function chicagoInstant(date: string, hour: number): number | null {
  if (!validDate(date) || !Number.isInteger(hour) || hour < 0 || hour > 24) return null;
  if (hour === 24) return chicagoInstant(addDays(date, 1), 0);
  const wall = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const candidates = [5, 6].map(offset => wall + offset * 3600000).filter(instant => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}` === date && Number(parts.hour) === hour;
  });
  return candidates.length === 1 ? candidates[0] : null;
}
export function dailyLimit(date: string): number { const month = Number(date.slice(5, 7)); return month >= 5 && month <= 10 ? 2 : 1; }
export function canManage(actor: Actor, booking: Booking): boolean { return actor.role === 'admin' || (actor.id === booking.memberId && ['member', 'instructor'].includes(actor.role)); }
export function needsOnboarding(member: Member): boolean { return member.billingStatus === 'unpaid' || member.billingStatus === 'pending'; }
export function canBook(member: Member): boolean { return member.active && member.billingStatus === 'active'; }
export function validateBooking(candidate: Booking, bookings: readonly Booking[], member: Member, actor: Actor, now = clockNow(), today = clockToday(), bays: readonly Bay[] = createBayFixtures()): string[] {
  const errors: string[] = [];
  try { assertInventory(bays); } catch { return ['Invalid bay inventory. Contact admin.']; }
  if (!['member', 'admin', 'instructor'].includes(actor.role) || !canManage(actor, candidate) || candidate.memberId !== member.id || (actor.role === 'instructor' && member.tier !== 'instructor') || (actor.role === 'member' && member.tier === 'instructor')) errors.push('This role cannot book for that account.');
  if (candidate.status !== 'booked') errors.push('New reservations must be booked.');
  const maxHours = member.tier === 'instructor' ? INSTRUCTOR_MAX_HOURS : 2;
  if (!validDate(candidate.date) || !Number.isInteger(candidate.start) || candidate.start < 0 || candidate.start > 23 || !Number.isInteger(candidate.hours) || candidate.hours < 1 || candidate.hours > maxHours || candidate.start + candidate.hours > 24 || !resolveBay(bays, candidate.bay)) return [...errors, `Choose a valid date, bay and 1–${maxHours} whole hours within one day.`];
  const start = chicagoInstant(candidate.date, candidate.start), end = chicagoInstant(candidate.date, candidate.start + candidate.hours);
  if (start === null || end === null || end - start !== candidate.hours * 3600000) errors.push('DST transition: choose another time; ambiguous or shifted hours are not supported.');
  if (start !== null && start <= now) errors.push('Choose a future start time.');
  if (!member.active) errors.push('Membership access is inactive. Contact admin.');
  if (member.billingStatus !== 'active') errors.push('An active paid membership is required before booking. Complete onboarding or contact admin.');
  if (!member.waiver) errors.push('A current waiver is required before booking.');
  if (member.tier === 'junior' && !member.approved) errors.push('Junior membership requires approval.');
  if (member.tier === 'family' && !member.individualSponsor) errors.push('Family add-on requires an Individual membership.');
  const instructor = member.tier === 'instructor';
  const window = instructor ? INSTRUCTOR_HORIZON_DAYS : member.tier === 'junior' ? 1 : 7;
  if (dayDifference(candidate.date, today) < 0 || dayDifference(candidate.date, today) > window) errors.push(`Advance booking limit: ${window} days.${instructor ? ' Proposed instructor policy.' : ''}`);
  const live = bookings.filter(row => row.status !== 'cancelled' && row.id !== candidate.id);
  if (live.some(row => row.date === candidate.date && row.bay === candidate.bay && row.start < candidate.start + candidate.hours && candidate.start < row.start + row.hours)) errors.push('Bay conflict. Choose another bay or time; existing bookings are never displaced.');
  if (live.some(row => row.date === candidate.date && row.memberId === member.id && row.start < candidate.start + candidate.hours && candidate.start < row.start + row.hours)) errors.push('This account already has an overlapping reservation.');
  const used = live.filter(row => row.memberId === member.id && row.date === candidate.date).reduce((sum, row) => sum + row.hours, 0);
  if (!instructor && used + candidate.hours > dailyLimit(candidate.date)) errors.push(`Daily limit: ${dailyLimit(candidate.date)} hour(s) across all bays. Winter Nov–Apr: 1; summer May–Oct: 2.`);
  return errors;
}
export function previewSeries(candidate: Booking, count: number, bookings: readonly Booking[], member: Member, actor: Actor, bays: readonly Bay[] = createBayFixtures()): { booking: Booking; errors: string[] }[] {
  if (!Number.isInteger(count) || count < 2 || count > Math.floor(INSTRUCTOR_HORIZON_DAYS / 7) + 1 || !validDate(candidate.date)) throw new Error('Series must contain valid weekly occurrences within the proposed 90-day horizon.');
  const staged = [...bookings];
  return Array.from({ length: count }, (_, index) => {
    const booking = { ...candidate, id: `${candidate.id}-${index}`, date: addDays(candidate.date, index * 7), seriesId: candidate.id };
    const errors = actor.role === 'member' || member.tier !== 'instructor' ? ['Only instructors/admin may create instructor series.'] : validateBooking(booking, staged, member, actor, clockNow(), clockToday(), bays);
    if (!errors.length) staged.push(booking);
    return { booking, errors };
  });
}
export type ChangeScope = 'one' | 'following';
export type ScheduleCandidate = { booking: Booking; before?: Booking; errors: string[] };
export type ScheduleStage = { candidates: ScheduleCandidate[]; errors: string[]; action: 'save' | 'cancel' };
export function editableBooking(row: Booking, now = clockNow()): boolean {
  const start = chicagoInstant(row.date, row.start);
  return row.status === 'booked' && start !== null && start > now;
}
/** Inclusive end date. Reject invalid bounds, never silently truncate an out-of-range request. */
export function previewWeekly(candidate: Booking, until: string, bookings: readonly Booking[], member: Member, actor: Actor, bays: readonly Bay[] = createBayFixtures()): ScheduleStage {
  if (!validDate(candidate.date) || !validDate(until) || until < candidate.date) return { action: 'save', candidates: [], errors: ['Choose a valid end date on or after the start date (inclusive).'] };
  if (dayDifference(candidate.date, clockToday()) < 0 || dayDifference(until, clockToday()) > INSTRUCTOR_HORIZON_DAYS) return { action: 'save', candidates: [], errors: ['The entire series must be within the proposed 90-day instructor preview horizon.'] };
  if (actor.role === 'member' || member.tier !== 'instructor') return { action: 'save', candidates: [], errors: ['Only instructors/admin may create instructor series.'] };
  const rows = Array.from({ length: Math.floor(dayDifference(until, candidate.date) / 7) + 1 }, (_, index) => ({ ...candidate, id: `${candidate.id}-${index}`, seriesId: candidate.id, date: addDays(candidate.date, index * 7) }));
  return stageCandidates(rows, bookings, member, actor, bays);
}
function stageCandidates(rows: Booking[], bookings: readonly Booking[], member: Member, actor: Actor, bays: readonly Bay[], before: Booking[] = []): ScheduleStage {
  // Keep old occurrences present until a replacement validates; a skipped conflict retains its old slot.
  let working = [...bookings];
  const candidates = rows.map(booking => {
    const original = before.find(row => row.id === booking.id);
    const errors = validateBooking(booking, working, member, actor, clockNow(), clockToday(), bays);
    if (!original && working.some(row => row.id === booking.id)) errors.push('Reservation identity already exists.');
    if (!errors.length) working = [...working.filter(row => row.id !== booking.id), booking];
    return { booking, before: original, errors };
  });
  return { action: 'save', candidates, errors: [] };
}
function scopedRows(bookings: readonly Booking[], target: Booking, scope: ChangeScope): Booking[] {
  return bookings.filter(row => row.id === target.id || (scope === 'following' && !!target.seriesId && row.seriesId === target.seriesId && row.memberId === target.memberId && (row.date > target.date || (row.date === target.date && row.start >= target.start))));
}
/** Existing dates shift together; no records are removed or extra occurrences silently added. */
export function stageScheduleChange(bookings: readonly Booking[], targetId: string, scope: ChangeScope, actor: Actor, members: readonly Member[], patch?: Pick<Booking, 'date' | 'start' | 'hours' | 'bay'>, bays: readonly Bay[] = createBayFixtures()): ScheduleStage {
  const action = patch ? 'save' : 'cancel';
  const fail = (message: string): ScheduleStage => ({ action, candidates: [], errors: [message] });
  if (!['one', 'following'].includes(scope)) return fail('Select an explicit change scope.');
  const target = bookings.find(row => row.id === targetId);
  if (!target || !canManage(actor, target)) return fail('This role cannot change that reservation.');
  const member = members.find(row => row.id === target.memberId);
  if (!member || (actor.role === 'instructor' && member.tier !== 'instructor')) return fail('Unknown or unauthorized account.');
  if (!editableBooking(target)) {
    if (!patch && target.status === 'cancelled') return { action, candidates: [], errors: [] };
    return fail('Past, started, completed and cancelled records are read-only.');
  }
  if (patch && !validDate(patch.date)) return fail('Choose a valid date.');
  const originals = scopedRows(bookings, target, scope).filter(row => editableBooking(row));
  if (!patch) return { action, errors: [], candidates: originals.map(before => ({ before, booking: { ...before, status: 'cancelled' }, errors: [] })) };
  const delta = dayDifference(patch.date, target.date);
  return stageCandidates(originals.map(row => ({ ...row, date: addDays(row.date, delta), start: patch.start, hours: patch.hours, bay: patch.bay })), bookings, member, actor, bays, originals);
}
const isConflict = (error: string) => error.startsWith('Bay conflict.') || error === 'This account already has an overlapping reservation.';
/** Pure atomic local commit. Revalidate against the supplied current fixture state before changing anything. */
export function applyScheduleStage(bookings: readonly Booking[], stage: ScheduleStage, actor: Actor, members: readonly Member[], bays: readonly Bay[] = createBayFixtures(), skipConflicts = false): Booking[] {
  if (stage.errors.length) throw new Error(stage.errors.join(' '));
  let working = [...bookings];
  let changed = 0;
  for (const candidate of stage.candidates) {
    const { booking, before } = candidate;
    const current = working.find(row => row.id === booking.id);
    // Replaying the exact cancellation is a no-op, not a stale-preview failure.
    if (stage.action === 'cancel' && before && current?.status === 'cancelled' && JSON.stringify(current) === JSON.stringify(booking) && JSON.stringify({ ...before, status: 'cancelled' }) === JSON.stringify(booking)) {
      if (!canManage(actor, current) || !members.some(row => row.id === current.memberId && (actor.role !== 'instructor' || row.tier === 'instructor'))) throw new Error('Unauthorized cancellation.');
      continue;
    }
    if (before ? !current || JSON.stringify(current) !== JSON.stringify(before) : !!current) throw new Error('Schedule changed since preview. Review again; nothing was saved.');
    if (!canManage(actor, booking) || (before && (booking.memberId !== before.memberId || booking.seriesId !== before.seriesId || !editableBooking(before)))) throw new Error('Unauthorized or historical change. Nothing was saved.');
    const member = members.find(row => row.id === booking.memberId);
    if (!member || (actor.role === 'instructor' && member.tier !== 'instructor')) throw new Error('Unauthorized account.');
    if (stage.action === 'cancel') {
      if (!before || booking.status !== 'cancelled' || booking.date !== before.date || booking.start !== before.start || booking.hours !== before.hours || booking.bay !== before.bay) throw new Error('Invalid cancellation.');
    } else {
      if (!before && booking.seriesId && (actor.role === 'member' || member.tier !== 'instructor')) throw new Error('Only instructors/admin may create instructor series.');
      const errors = validateBooking(booking, working, member, actor, clockNow(), clockToday(), bays);
      if (errors.length) {
        if (skipConflicts && errors.every(isConflict)) continue;
        throw new Error(errors.join(' '));
      }
    }
    working = [...working.filter(row => row.id !== booking.id), { ...booking }];
    changed++;
  }
  if (stage.action === 'save' && stage.candidates.length && !changed) throw new Error('No available changes. Nothing was saved.');
  return working;
}
export function bookingStatus(booking: Booking, now = clockNow()): 'booked' | 'completed' | 'cancelled' {
  if (booking.status === 'cancelled') return 'cancelled';
  const end = chicagoInstant(booking.date, booking.start + booking.hours);
  return end !== null && end <= now ? 'completed' : 'booked';
}
export function reportingRange(date: string, period: 'week' | 'month'): { from: string; to: string } {
  if (!validDate(date)) throw new Error('Invalid reporting date');
  if (period === 'week') { const weekday = new Date(date + 'T12:00:00Z').getUTCDay(); const from = addDays(date, -((weekday + 6) % 7)); return { from, to: addDays(from, 7) }; }
  const from = date.slice(0, 7) + '-01'; const d = new Date(from + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); return { from, to: d.toISOString().slice(0, 10) };
}
export function report(bookings: readonly Booking[], from: string, to: string, memberId = '', now = clockNow()) {
  const rows = bookings.filter(row => row.date >= from && row.date < to && (!memberId || row.memberId === memberId));
  const totals = { booked: 0, completed: 0, cancelled: 0 };
  rows.forEach(row => { totals[bookingStatus(row, now)] += row.hours; });
  return { rows, totals };
}
/** Counts reservations, not duration or verified attendance. Date periods are half-open in Chicago. */
export function overviewStats(bookings: readonly Booking[], today = clockToday(), now = clockNow()) {
  const live = bookings.filter(row => row.status !== 'cancelled');
  const week = reportingRange(today, 'week'), month = reportingRange(today, 'month');
  const count = (from: string, to: string) => live.filter(row => row.date >= from && row.date < to).length;
  return {
    'Practicing Now': live.filter(row => { const start = chicagoInstant(row.date, row.start), end = chicagoInstant(row.date, row.start + row.hours); return start !== null && end !== null && start <= now && now < end; }).length,
    'Total Booked Today': count(today, addDays(today, 1)),
    'Booked This Week': count(week.from, week.to),
    'Booked This Month': count(month.from, month.to),
    'YTD Bookings': count(today.slice(0, 4) + '-01-01', addDays(today, 1))
  };
}
/** Quoted CSV cell; a leading = + - @ tab or CR is neutralised so a spreadsheet never runs it as a formula. */
export const csvCell = (value: string | number): string => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
export function csv(bookings: readonly Booking[], now = clockNow()): string {
  return [['Booking ID', 'Account ID', 'Chicago date', 'Start hour', 'Bay', 'Hours', 'Status'], ...bookings.map(row => [row.id, row.memberId, row.date, row.start, row.bay, row.hours, bookingStatus(row, now)])].map(row => row.map(csvCell).join(',')).join('\r\n');
}
/** Hours per account for a set of reservations, split by the same mutually exclusive statuses as the report totals. */
export function hoursByAccount(bookings: readonly Booking[], now = clockNow()): { memberId: string; booked: number; completed: number; cancelled: number }[] {
  const rows = new Map<string, { memberId: string; booked: number; completed: number; cancelled: number }>();
  for (const row of bookings) {
    const entry = rows.get(row.memberId) ?? { memberId: row.memberId, booked: 0, completed: 0, cancelled: 0 };
    entry[bookingStatus(row, now)] += row.hours;
    rows.set(row.memberId, entry);
  }
  return [...rows.values()];
}
export type MemberFilter = 'all' | 'current' | 'not-current';
/** Current = access on and paid; everything else (suspended, unpaid, overdue, left) is not current. */
export const isCurrentMember = (member: Member): boolean => member.active && member.billingStatus === 'active';
export const memberStatusLabel = (member: Member): string => !member.active ? 'Inactive' : !member.waiver ? 'Waiver needed' : 'Active';
export function filterMembers<T extends Member>(members: readonly T[], filter: MemberFilter): T[] {
  return members.filter(member => filter === 'all' || (filter === 'current') === isCurrentMember(member));
}
/** Name, email, membership and status for the chosen group: the list to paste into an email program. */
export function memberEmailsCsv(members: readonly Member[], filter: MemberFilter = 'all'): string {
  return [['Name', 'Email', 'Membership', 'Status', 'Billing'], ...filterMembers(members, filter).map(member => [member.name, member.email, member.tier, memberStatusLabel(member), member.billingStatus])].map(row => row.map(csvCell).join(',')).join('\r\n');
}
export const PLANS = [
  { id: 'monthly', label: 'Individual · committed', price: '$199 / month', terms: '12-month commitment. Monthly collection; not cancel-anytime.' },
  { id: 'annual', label: 'Individual · annual', price: '$2,199 / year', terms: 'Paid upfront annually. Renewal terms require final agreement.' },
  { id: 'flexible', label: 'Individual · flexible', price: '$289 / month', terms: 'No annual commitment. Cancellation effective date requires final policy.' },
  { id: 'family', label: 'Family add-on', price: '$85 / month', terms: 'Requires an active Individual membership. Separate bookings.' },
  { id: 'junior', label: 'Junior · approval required', price: '$1,800 / year', terms: 'Annual upfront payment after approval. 1-day advance booking; guardian agreement.' }
] as const;
export function checkoutErrors(plan: string, waiver: boolean, individual: boolean, juniorApproval: boolean): string[] {
  return [...(!PLANS.some(item => item.id === plan) ? ['Select a registered plan.'] : []), ...(!waiver ? ['Review the illustrative waiver and terms.'] : []), ...(plan === 'family' && !individual ? ['Family add-on requires an active Individual membership.'] : []), ...(plan === 'junior' && !juniorApproval ? ['Junior approval and guardian review are required.'] : [])];
}