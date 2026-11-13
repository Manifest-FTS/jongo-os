"use client";
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Badge, Button, Card, Dialog } from '../shell.js';
import { addDays, applyScheduleStage, bookingStatus, canBook, canManage, editableBooking, clockToday, INSTRUCTOR_MAX_HOURS, INSTRUCTOR_HORIZON_DAYS, previewWeekly, reportingRange, stageScheduleChange, validateBooking, type ChangeScope, type ScheduleStage, type Actor, type Booking, type Member } from './logic.js';
import { bayLabel, createBayFixtures, resolveBay, type Bay } from './inventory.js';
import { BayCards } from './bays.js';
import { CalendarDownload } from './calendar-download.js';
import { validDate } from './logic.js';
import { useLive } from './live.js';

/** A save may finish later (a server round trip) and may hand back what went wrong. */
export type SaveResult = void | string[] | Promise<void | string[]>;

export const hourLabel = (hour: number) => hour === 24 ? '12:00 AM (day end)' : `${hour % 12 || 12}:00 ${hour < 12 ? 'AM' : 'PM'}`;
export function BookingDateControls({ date, onChange }: { date: string; onChange: (date: string) => void }) {
  return <div className="craft-toolbar craft-calendar-controls"><Button aria-label="Previous week" onClick={() => onChange(addDays(date, -7))}>← Week</Button><label>Choose day<input aria-label="Choose day" type="date" value={date} onChange={event => { if (validDate(event.target.value)) onChange(event.target.value); }} /></label><Button aria-label="Next week" onClick={() => onChange(addDays(date, 7))}>Week →</Button><Button onClick={() => onChange(clockToday())}>Today</Button></div>;
}
export function BookingEditor({ actor, members, bookings, bays = createBayFixtures(), initial, seed, scope = 'one', date, onClose, onSave }: {
  actor: Actor; members: Member[]; bookings: Booking[]; bays?: Bay[]; initial?: Booking; seed?: Booking; date: string;
  scope?: ChangeScope;
  onClose: () => void; onSave: (rows: Booking[]) => SaveResult;
}) {
  const live = useLive();
  const defaultMember = actor.role === 'admin' ? (members.find(item => canBook(item) && item.tier !== 'instructor') ?? members[0])?.id ?? '' : actor.id;
  const [draft, setDraft] = useState<Booking>(initial ?? seed ?? { id: `demo-${crypto.randomUUID()}`, memberId: defaultMember, date, start: 18, hours: 1, bay: bays[0]?.displayNumber ?? 0, status: 'booked' });
  const [weekly, setWeekly] = useState(false), [until, setUntil] = useState(addDays(date, 56)), [skip, setSkip] = useState(false);
  const [errors, setErrors] = useState<string[]>([]), [preview, setPreview] = useState<ScheduleStage | null>(null), [busy, setBusy] = useState(false);
  const member = members.find(item => item.id === draft.memberId)!;
  const resetReview = () => { setPreview(null); setErrors([]); setSkip(false); };
  const update = (patch: Partial<Booking>) => { setDraft({ ...draft, ...patch }); resetReview(); };
  const canRepeat = !initial && actor.role !== 'member' && member.tier === 'instructor';
  const needsReview = !!initial || (weekly && canRepeat);
  const previewRows = () => {
    try {
      const result = initial ? stageScheduleChange(bookings, initial.id, scope, actor, members, draft, bays) : previewWeekly(draft, until, bookings, member, actor, bays);
      setPreview(result); setErrors(result.errors); return result;
    }
    catch (error) { setErrors([error instanceof Error ? error.message : 'Invalid series']); return null; }
  };
  function finish(rows: Booking[]) {
    const result = onSave(rows);
    if (result && typeof (result as Promise<void | string[]>).then === 'function') {
      setBusy(true);
      (result as Promise<void | string[]>).then(problems => { setBusy(false); if (problems?.length) setErrors(problems); }, () => { setBusy(false); setErrors(['Unable to save. Try again.']); });
    } else if (Array.isArray(result) && result.length) setErrors(result);
  }
  function submit() {
    if (busy) return;
    if (needsReview) {
      if (!preview) { previewRows(); setErrors(['Review every candidate below, then confirm. Nothing has changed.']); return; }
      try { finish(applyScheduleStage(bookings, preview, actor, members, bays, skip)); }
      catch (error) { setErrors([error instanceof Error ? error.message : 'Unable to save.']); }
      return;
    }
    try { const stage: ScheduleStage = { action: 'save', errors: [], candidates: [{ booking: draft, errors: validateBooking(draft, bookings, member, actor, undefined, undefined, bays) }] }; finish(applyScheduleStage(bookings, stage, actor, members, bays)); }
    catch (error) { setErrors([error instanceof Error ? error.message : 'Unable to save.']); }
  }
  return <Dialog title={initial ? scope === 'following' ? 'Edit this and following' : 'Edit this occurrence' : 'Reserve your next session'} onClose={onClose}>
    <p className="craft-muted">{live ? 'America/Chicago. Your booking is checked and saved when you confirm.' : 'America/Chicago · simulated scheduling in local memory, not a connected booking service. Resets on reload or leaving.'}</p>
    {initial && <p className="craft-callout">{scope === 'following' ? 'Applies to this and following eligible occurrences. Date changes shift their dates together; the number of occurrences stays unchanged.' : 'Editing this occurrence only; the rest of the series stays unchanged.'} Started, completed and cancelled records are preserved.</p>}
    <form onSubmit={event => { event.preventDefault(); submit(); }} className="craft-form">
      {actor.role === 'admin' && <label>Book for<select aria-label="Book for" disabled={!!initial} value={draft.memberId} onChange={event => { update({ memberId: event.target.value, hours: 1 }); setWeekly(false); }}>{members.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <div className="craft-form-grid"><label>Date<input aria-label="Date" type="date" required value={draft.date} min={clockToday()} max={addDays(clockToday(), member.tier === 'instructor' ? INSTRUCTOR_HORIZON_DAYS : member.tier === 'junior' ? 1 : 7)} onChange={event => update({ date: event.target.value })} /></label>
        <label>Bay<select aria-label="Bay" value={draft.bay} onChange={event => update({ bay: Number(event.target.value) })}>{bays.map(bay => <option key={bay.id} value={bay.displayNumber}>{bayLabel(bay)}</option>)}</select></label>
        <label>Start time<select aria-label="Start time" value={draft.start} onChange={event => update({ start: Number(event.target.value) })}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}</select></label>
        <label>Duration<select aria-label="Duration" value={draft.hours} onChange={event => update({ hours: Number(event.target.value) })}>{Array.from({ length: member.tier === 'instructor' ? INSTRUCTOR_MAX_HOURS : 2 }, (_, index) => index + 1).map(hours => <option key={hours} value={hours} disabled={draft.start + hours > 24}>{hours} {hours === 1 ? 'hour' : 'hours'}</option>)}</select></label></div>
      <p className="craft-muted">Ends at {hourLabel(draft.start + draft.hours)} · {draft.hours} scheduled hours</p>
      <p className="craft-callout">{member.tier === 'instructor' ? `Up to ${INSTRUCTOR_MAX_HOURS} whole hours, or local day end. The 12-hour ceiling is a configurable prototype bound. Proposed ${INSTRUCTOR_HORIZON_DAYS}-day instructor horizon, not client-approved policy.` : `${member.tier === 'junior' ? '1-day' : '7-day'} advance · Nov–Apr 1 hour/day · May–Oct 2 hours/day, across all bays.`}</p>
      {canRepeat && <><label className="craft-check"><input type="checkbox" checked={weekly} onChange={event => { setWeekly(event.target.checked); setPreview(null); }} />Repeat weekly (instructor series)</label>
        {weekly && <div><label>Repeat until (inclusive)<input aria-label="Repeat until (inclusive)" type="date" required value={until} min={draft.date} max={addDays(clockToday(), INSTRUCTOR_HORIZON_DAYS)} onChange={event => { setUntil(event.target.value); resetReview(); }} /></label><small>Weekly on the start date's weekday. End date is included when it falls on that weekday.</small></div>}
      </>}
      {needsReview && <><Button onClick={previewRows}>Preview dates & conflicts</Button>{preview && <SchedulePreview stage={preview} />}<label className="craft-check"><input type="checkbox" checked={skip} onChange={event => setSkip(event.target.checked)} />Explicitly skip conflicted dates; old occurrences keep their original schedule. Policy errors cannot be skipped.</label></>}
      {!!errors.length && <div role="alert" className="craft-error">{errors.map(error => <p key={error}>{error}</p>)}</div>}
      <div className="craft-toolbar"><Button onClick={onClose}>Close without saving</Button><Button type="submit" className="craft-primary" disabled={busy}>{busy ? 'Saving…' : needsReview ? initial ? 'Confirm reviewed changes' : 'Confirm reviewed series' : 'Save booking'} ↗</Button></div>
    </form>
  </Dialog>;
}

function SchedulePreview({ stage }: { stage: ScheduleStage }) {
  return <div className="craft-series" aria-label="Schedule change preview"><p>{stage.candidates.length} candidate occurrence(s) · {stage.candidates.filter(row => row.errors.length).length} with issues. Nothing changes until confirmation.</p>{stage.candidates.map(row => <div key={row.booking.id}><strong>{row.booking.date} · {hourLabel(row.booking.start)}–{hourLabel(row.booking.start + row.booking.hours)} · Bay {row.booking.bay}</strong><Badge tone={row.errors.length ? 'amber' : 'green'}>{row.errors.length ? 'Conflict / invalid' : stage.action === 'cancel' ? 'Will cancel' : 'Available'}</Badge>{row.before && <p>Was {row.before.date} · {hourLabel(row.before.start)}–{hourLabel(row.before.start + row.before.hours)} · Bay {row.before.bay}. {row.errors.length ? 'Original retained if explicitly skipped.' : 'Same occurrence ID retained.'}</p>}{row.errors.map(error => <p key={error}>{error}</p>)}</div>)}</div>;
}

function ScheduleScopeDialog({ target, action, actor, members, bookings, bays, onClose, onEdit, onSave }: { target: Booking; action: 'edit' | 'cancel'; actor: Actor; members: Member[]; bookings: Booking[]; bays: Bay[]; onClose: () => void; onEdit: (scope: ChangeScope) => void; onSave: (rows: Booking[]) => SaveResult }) {
  const live = useLive();
  const [scope, setScope] = useState<ChangeScope | ''>(''), [preview, setPreview] = useState<ScheduleStage | null>(null), [error, setError] = useState('');
  return <Dialog title={action === 'edit' ? 'Choose edit scope' : 'Cancel reservations'} onClose={onClose}><form className="craft-form" onSubmit={event => { event.preventDefault(); if (!scope) { setError('Choose an explicit scope first.'); return; } if (action === 'edit') { onEdit(scope); return; } if (!preview) { setPreview(stageScheduleChange(bookings, target.id, scope, actor, members, undefined, bays)); return; } try { const result = onSave(applyScheduleStage(bookings, preview, actor, members, bays)); if (result && typeof (result as Promise<void | string[]>).then === 'function') (result as Promise<void | string[]>).then(problems => { if (problems?.length) setError(problems.join(' ')); }); else if (Array.isArray(result) && result.length) setError(result.join(' ')); } catch (issue) { setError(issue instanceof Error ? issue.message : 'Unable to cancel.'); } }}>
    <p>{live ? '' : 'Simulated local changes only. '}Past, started, completed and cancelled records remain read-only; cancellation retains records and scheduled hours for reporting.</p>
    <fieldset><legend>Apply to</legend><label className="craft-check"><input type="radio" name="scope" checked={scope === 'one'} onChange={() => { setScope('one'); setPreview(null); setError(''); }} />This occurrence</label>{target.seriesId && <label className="craft-check"><input type="radio" name="scope" checked={scope === 'following'} onChange={() => { setScope('following'); setPreview(null); setError(''); }} />This and following</label>}</fieldset>
    {preview && <><SchedulePreview stage={preview} />{!!preview.errors.length && <p role="alert" className="craft-error">{preview.errors.join(' ')}</p>}</>}{error && <p role="alert" className="craft-error">{error}</p>}
    <div className="craft-actions"><Button onClick={onClose}>Close without changes</Button><Button type="submit" className={action === 'cancel' ? 'craft-danger' : 'craft-primary'}>{action === 'edit' ? 'Continue to edit' : preview ? 'Confirm reviewed cancellation' : 'Preview cancellation'}</Button></div>
  </form></Dialog>;
}

export function BookingCalendar({ actor, members, bookings, bays = createBayFixtures(), onUpdate }: { actor: Actor; members: Member[]; bookings: Booking[]; bays?: Bay[]; onUpdate: (rows: Booking[]) => SaveResult }) {
  const live = useLive();
  const [date, setDate] = useState(clockToday()), [mobileBay, setMobileBay] = useState(bays[0]?.displayNumber ?? 0);
  const [editor, setEditor] = useState<{ booking?: Booking; scope?: ChangeScope } | null>(null), [detail, setDetail] = useState<Booking | null>(null);
  const [scopeAction, setScopeAction] = useState<{ booking: Booking; action: 'edit' | 'cancel' } | null>(null);
  const [notice, setNotice] = useState('');
  const week = reportingRange(date, 'week');
  const member = members.find(row => row.id === actor.id);
  const blocked = actor.role !== 'admin' && (!member || !canBook(member));
  const occupied = (bay: number, hour: number) => bookings.find(row => row.status !== 'cancelled' && row.date === date && row.bay === bay && row.start <= hour && row.start + row.hours > hour);
  const own = (row: Booking) => canManage(actor, row);
  function slot(bay: number, hour: number) {
    const row = occupied(bay, hour);
    return <Button key={`${bay}-${hour}`} className={`craft-slot ${row ? 'craft-slot-booked' : ''} ${row && row.memberId === actor.id ? 'craft-slot-own' : ''}`} aria-label={`${date} Bay ${bay}, ${hourLabel(hour)}: ${row ? own(row) ? 'view reservation' : 'occupied' : 'available'}`} onClick={() => {
      if (row) { if (own(row)) setDetail(row); else setNotice('Occupied. Other members’ identities are private.'); }
      else setEditor({ booking: { id: `demo-${crypto.randomUUID()}`, memberId: actor.role === 'admin' ? (members.find(item => canBook(item) && item.tier !== 'instructor') ?? members[0])?.id ?? '' : actor.id, date, start: hour, hours: 1, bay, status: 'booked' } });
    }}>{row ? own(row) ? actor.role === 'admin' ? members.find(member => member.id === row.memberId)?.name.replace(' (fictional)', '') : 'Your session' : 'Occupied' : <><span className="craft-mobile-time">{hourLabel(hour)} · </span>Available <span aria-hidden="true">＋</span></>}</Button>;
  }
  if (blocked) return <Card title="Booking unavailable"><p>Complete membership onboarding or contact the team to review access.</p><a href={`/portal/billing?account=${actor.id}`}>Review membership & billing</a></Card>;
  return <>
    <div className="craft-page-heading"><div><p className="craft-overline">Make time for your game</p><h1>Your next great session.</h1><p>{bays.length} bays. One clear calendar. All times Chicago.</p></div><Button className="craft-primary" disabled={!bays.length} onClick={() => setEditor({})}>＋ New booking</Button></div>
    <BookingDateControls date={date} onChange={setDate} />
    {actor.role !== 'member' && <div className="craft-actions"><CalendarDownload actor={actor} bookings={bookings} members={members} bays={bays} selection={{ from: date, to: addDays(date, 1) }} label={actor.role === 'admin' ? 'Download all-bay day schedule .ics' : 'Download my day schedule .ics'} filename={`golf-lab-${actor.role}-day-${date}.ics`} /><CalendarDownload actor={actor} bookings={bookings} members={members} bays={bays} selection={week} label={actor.role === 'admin' ? 'Download all-bay week schedule .ics' : 'Download my week schedule .ics'} filename={`golf-lab-${actor.role}-week-${week.from}.ics`} /><p className="craft-muted">{actor.role === 'admin' ? 'All bays, including selected-range past/in-progress sessions. Cancelled excluded. Admin-only names.' : 'Only your own future sessions; started, past and cancelled excluded.'} File import only; no calendar sync.</p></div>}
    <BayCards bays={bays} bookings={bookings} date={date} onSelect={bay => { setMobileBay(bay.displayNumber); setNotice(`${bayLabel(bay)} selected. Choose a slot in the day schedule below.`); }} />
    <div className="craft-week" aria-label="Week selector">{Array.from({ length: 7 }, (_, index) => addDays(week.from, index)).map(day => <Button key={day} aria-pressed={date === day} onClick={() => setDate(day)}><span>{new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}</span><strong>{Number(day.slice(8))}</strong><small>{bookings.filter(row => row.date === day && row.status !== 'cancelled').length} sessions</small></Button>)}</div>
    <div className="craft-toolbar"><p><Badge tone="green">Your booking</Badge> <Badge>Occupied / private</Badge></p><label className="craft-mobile-filter">Mobile bay<select value={mobileBay} onChange={event => setMobileBay(Number(event.target.value))}>{bays.map(bay => <option key={bay.id} value={bay.displayNumber}>{bayLabel(bay)}</option>)}</select></label></div>
    <p role="status" className="craft-muted">{notice || (live ? `${date} · Select an available slot.` : `${date} · Select an available slot. Changes are local to this workspace and reset on reload or leaving.`)}</p>
    <div className="craft-calendar-scroll" tabIndex={0} role="region" aria-label="Scrollable day schedule"><div className="craft-grid" role="group" aria-label={`${bays.length} bay day schedule ${date}`} style={{ '--craft-bay-count': bays.length } as CSSProperties}><div className="craft-grid-head">Chicago</div>{bays.map(bay => <div className="craft-grid-head" key={bay.id}>{bayLabel(bay)}</div>)}
      {Array.from({ length: 24 }, (_, hour) => <div className="craft-grid-row" key={hour}><div className="craft-time">{hourLabel(hour)}</div>{bays.map(bay => slot(bay.displayNumber, hour))}</div>)}
    </div></div>
    <div className="craft-mobile-schedule"><Card title={`${resolveBay(bays, mobileBay) ? bayLabel(resolveBay(bays, mobileBay)!) : 'Choose bay'} · ${date}`}>{Array.from({ length: 24 }, (_, hour) => <div className="craft-mobile-row" key={hour}><span>{hourLabel(hour)}</span>{slot(mobileBay, hour)}</div>)}</Card></div>
    {editor && <BookingEditor actor={actor} members={members} bookings={bookings} bays={bays} date={date} scope={editor.scope} seed={editor.booking} initial={editor.booking && bookings.some(row => row.id === editor.booking?.id) ? editor.booking : undefined} key={editor.booking?.id ?? 'new'} onClose={() => setEditor(null)} onSave={async rows => { const problems = await onUpdate(rows); if (Array.isArray(problems) && problems.length) return problems; setNotice(live ? 'Booking saved.' : 'Reviewed reservations saved in local memory only. Skipped occurrences and history unchanged.'); setEditor(null); }} />}
    {detail && <Dialog title="Session details" onClose={() => setDetail(null)}><p>{detail.date} · {hourLabel(detail.start)}–{hourLabel(detail.start + detail.hours)} · {detail.hours}h · {resolveBay(bays, detail.bay) ? bayLabel(resolveBay(bays, detail.bay)!) : `Bay ${detail.bay}`}</p><Badge>{bookingStatus(detail)}</Badge><p>{members.find(member => member.id === detail.memberId)?.name}</p><p>{detail.seriesId ? 'Weekly series · choose this occurrence or this and following when changing.' : 'Single reservation'}</p>
      {editableBooking(detail) && own(detail) && <div className="craft-actions"><Button onClick={() => { setScopeAction({ booking: detail, action: 'edit' }); setDetail(null); }}>Edit reservation</Button><Button className="craft-danger" onClick={() => { setScopeAction({ booking: detail, action: 'cancel' }); setDetail(null); }}>Cancel reservation</Button></div>}
      {editableBooking(detail) && own(detail) && <div className="craft-actions"><CalendarDownload actor={actor} bookings={bookings} members={members} bays={bays} selection={{ bookingId: detail.id }} label="Add to calendar (.ics)" filename={`golf-lab-session-${detail.date}.ics`} />{actor.role !== 'member' && detail.seriesId && <CalendarDownload actor={actor} bookings={bookings} members={members} bays={bays} selection={{ seriesId: detail.seriesId }} label="Download future series .ics" filename={`golf-lab-series-${detail.date}.ics`} />}</div>}
      {!editableBooking(detail) && <p>Historical, started and cancelled records are read-only; no attendance or hour overrides.</p>}
    </Dialog>}
    {scopeAction && <ScheduleScopeDialog target={scopeAction.booking} action={scopeAction.action} actor={actor} members={members} bookings={bookings} bays={bays} onClose={() => setScopeAction(null)} onEdit={scope => { setEditor({ booking: scopeAction.booking, scope }); setScopeAction(null); }} onSave={async rows => { const problems = await onUpdate(rows); if (Array.isArray(problems) && problems.length) return problems; setScopeAction(null); setNotice(live ? 'Reservation cancelled.' : 'Reservations cancelled in local memory only. Retained as cancelled hours; history unchanged.'); }} />}
  </>;
}