"use client";
import { useId, useState } from 'react';
import { Badge, Button, Dialog } from '../shell.js';
import { DEMO_NOW, DEMO_TODAY, chicagoInstant, type Actor, type Booking } from './logic.js';
import { bayLabel, bayReservations, updateInventory, type Bay } from './inventory.js';
import { hourLabel } from './booking.js';

/** Shared across schedule, management overview and the style guide. No member identities. */
export function BayCard({ bay, bookings, date = DEMO_TODAY, onSelect, onEdit }: { bay: Bay; bookings: Booking[]; date?: string; onSelect?: () => void; onEdit?: () => void }) {
  const rows = bayReservations(bay, bookings, date);
  const occupied = rows.some(row => { const start = chicagoInstant(row.date, row.start), end = chicagoInstant(row.date, row.start + row.hours); return start !== null && end !== null && start <= DEMO_NOW && end > DEMO_NOW; });
  const next = rows.find(row => (chicagoInstant(row.date, row.start) ?? 0) > DEMO_NOW);
  return <section className="craft-bay-card" aria-label={bayLabel(bay)}>
    <div className="craft-bay-top"><span className="craft-bay-number">{String(bay.displayNumber).padStart(2, '0')}</span><Badge tone={occupied ? 'amber' : 'green'}>{occupied ? 'Scheduled now' : 'No session now'}</Badge></div>
    <p className="craft-overline">Simulator bay {bay.displayNumber}</p><h3>{bay.name}</h3>
    <div className="craft-bay-detail"><strong>{rows.length} {rows.length === 1 ? 'reservation' : 'reservations'}</strong><span>{rows.reduce((total, row) => total + row.hours, 0)} scheduled {rows.reduce((total, row) => total + row.hours, 0) === 1 ? 'hour' : 'hours'} · {date}</span></div>
    <p className="craft-muted">{next ? `Next reserved · ${hourLabel(next.start)}` : 'No upcoming reservations this day'}<br />Scheduled time, not verified attendance.</p>
    <div className="craft-actions">{onSelect && <Button onClick={onSelect} aria-label={`View schedule for ${bayLabel(bay)}`}>View schedule ↗</Button>}{onEdit && <Button onClick={onEdit} aria-label={`Rename ${bayLabel(bay)}`}>Rename bay</Button>}</div>
  </section>;
}
export function BayCards({ bays, bookings, date, onSelect }: { bays: Bay[]; bookings: Booking[]; date?: string; onSelect?: (bay: Bay) => void }) {
  return <div className="craft-bays">{bays.map(bay => <BayCard key={bay.id} bay={bay} bookings={bookings} date={date} onSelect={onSelect ? () => onSelect(bay) : undefined} />)}</div>;
}
export function BayManagement({ actor, bays, bookings, onUpdate }: { actor: Actor; bays: Bay[]; bookings: Booking[]; onUpdate: (bays: Bay[]) => void }) {
  const [editor, setEditor] = useState<{ bay?: Bay } | null>(null), [notice, setNotice] = useState('');
  if (actor.role !== 'admin') return <p>Only admins may manage bay inventory.</p>;
  return <><div className="craft-page-heading"><div><p className="craft-overline">Bay Management</p><h1>Room to grow.</h1><p>{bays.length} simulator bays · stable numbers, names with personality.</p></div><Button className="craft-primary" onClick={() => setEditor({})}>＋ Add bay</Button></div>
    <p className="craft-muted">Names can change. Bay numbers and internal IDs cannot. No deletion is offered; reservation history stays linked. Changes live in this workspace only and reset on reload.</p>
    <p role="status">{notice}</p><div className="craft-bays">{bays.map(bay => <BayCard key={bay.id} bay={bay} bookings={bookings} onEdit={() => setEditor({ bay })} />)}</div>
    {editor && <BayNameForm key={editor.bay?.id ?? 'new'} bay={editor.bay} onClose={() => setEditor(null)} onSave={name => { const updated = updateInventory(actor, bays, name, editor.bay?.id); onUpdate(updated); setNotice(`${editor.bay ? 'Name updated' : bayLabel(updated.at(-1)!) + ' added'} in local memory only. Existing reservations are unchanged.`); setEditor(null); }} />}
  </>;
}
export function BayNameForm({ bay, onClose, onSave }: { bay?: Bay; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(bay?.name ?? ''), [error, setError] = useState('');
  const errorId = useId();
  return <Dialog title={bay ? `Rename Bay ${bay.displayNumber}` : 'Add simulator bay'} onClose={onClose}><form className="craft-form" onSubmit={event => { event.preventDefault(); try { onSave(name); } catch (issue) { setError(issue instanceof Error ? issue.message : 'Unable to update inventory.'); } }}>
    <p>{bay ? `Stable number: ${bay.displayNumber}. Reservations keep their original link.` : 'The next sequential number and a new stable internal ID are assigned automatically.'}</p>
    <label>Bay name<input required maxLength={60} value={name} onChange={event => { setName(event.target.value); setError(''); }} aria-invalid={!!error} aria-describedby={error ? errorId : undefined} /></label>
    {error && <p className="craft-error" role="alert" id={errorId}>{error}</p>}
    <div className="craft-actions"><Button onClick={onClose}>Cancel</Button><Button type="submit" className="craft-primary">{bay ? 'Save name' : 'Add bay'}</Button></div>
  </form></Dialog>;
}