"use client";
import { useState } from 'react';
import { Badge, Button, Card, Dialog } from '../shell.js';
import { addDays, bookingWindowDays, clockToday, validDate, type BookingWindows, type Member } from './logic.js';
import { useLive, type LiveDetail, type LiveResult, type LiveTeamStatus } from './live.js';
import { TeamCancel } from './membership-ending.js';

/** What the team can do about one account: suspend or restore booking, move the commitment end, and see what was done before. Every change records who and why. */
export function MemberControls({ member, detail }: { member: Member; detail: LiveDetail }) {
  const live = useLive();
  const [kind, setKind] = useState<'medical' | 'other'>('medical'), [note, setNote] = useState(''), [until, setUntil] = useState('');
  const [extendTo, setExtendTo] = useState(''), [extendNote, setExtendNote] = useState('');
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  if (!live || member.tier === 'instructor') return null;
  const hold = detail.hold, end = detail.commitmentEndDate;
  async function run(task: () => Promise<LiveResult>, success: string, reset: () => void) {
    setBusy(true); setMessage('');
    try {
      const result = await task();
      if (result.ok) { live!.apply(result.snapshot); setMessage(success); reset(); } else setMessage(result.errors.join(' '));
    } catch { setMessage('Unable to save. Try again.'); }
    setBusy(false);
  }
  const clean = () => { setNote(''); setUntil(''); setExtendTo(''); setExtendNote(''); };
  return <>
    <h3>Access</h3>
    {hold ? <>
      <p className="craft-callout">Booking is suspended ({hold.kind === 'medical' ? 'medical leave' : 'other reason'}){hold.until ? ` until ${hold.until}` : ''}. {hold.note}</p>
      <Button disabled={busy} onClick={() => void run(() => live.actions.setAccess(member.id, { hold: null, note: 'Access restored', until: '' }), 'Access restored.', clean)}>Restore access</Button>
    </> : <form className="craft-form" onSubmit={event => { event.preventDefault(); void run(() => live.actions.setAccess(member.id, { hold: kind, note, until }), 'Access suspended.', clean); }}>
      <label>Reason<select value={kind} onChange={event => setKind(event.target.value as 'medical' | 'other')}><option value="medical">Medical leave</option><option value="other">Other</option></select></label>
      <label>Note for the record<textarea value={note} onChange={event => setNote(event.target.value)} placeholder="Why, in a sentence. No medical details." /></label>
      <label>Resume on (optional)<input type="date" value={until} min={addDays(clockToday(), 1)} onChange={event => { if (!event.target.value || validDate(event.target.value)) setUntil(event.target.value); }} /></label>
      <Button type="submit" disabled={busy || note.trim().length < 8}>Suspend access</Button>
    </form>}
    <p className="craft-muted">Suspending stops booking only. The plan keeps billing and the commitment dates do not move: make any billing change in Stripe, and extend the commitment below if the member is owed the time.</p>
    {end && <form className="craft-form" onSubmit={event => { event.preventDefault(); void run(() => live.actions.extendCommitment(member.id, { until: extendTo, note: extendNote }), 'Commitment extended.', clean); }}>
      <h3>Commitment</h3>
      <label>New end date (now {detail.commitmentEnd})<input type="date" value={extendTo} min={addDays(end, 1)} onChange={event => { if (!event.target.value || validDate(event.target.value)) setExtendTo(event.target.value); }} /></label>
      <label>Note for the record<textarea value={extendNote} onChange={event => setExtendNote(event.target.value)} placeholder="Why the commitment is extended" /></label>
      <Button type="submit" disabled={busy || !extendTo || extendNote.trim().length < 8}>Extend commitment</Button>
    </form>}
    <p role="status">{message}</p>
    <TeamCancel member={member} detail={detail} />
    {!!detail.history?.length && <><h3>Recent changes</h3><ul className="craft-muted">{detail.history.map(line => <li key={line}>{line}</li>)}</ul></>}
  </>;
}

/** The team approves a Junior or Family member by sending them a link; they finish and pay there. */
export function InviteDialog({ members, onClose }: { members: Member[]; onClose: () => void }) {
  const live = useLive();
  const [kind, setKind] = useState<'junior' | 'family'>('junior'), [name, setName] = useState(''), [email, setEmail] = useState('');
  const sponsors = members.filter(item => item.tier === 'individual' && item.active && item.billingStatus === 'active');
  const [sponsorId, setSponsorId] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [sent, setSent] = useState(false);
  if (!live) return null;
  async function send() {
    setBusy(true); setMessage('');
    try {
      const result = await live!.actions.inviteMember({ kind, name, email, sponsorId: kind === 'family' ? sponsorId || sponsors[0]?.id || '' : '' });
      if (result.ok) { live!.apply(result.snapshot); setSent(true); setMessage(`Invitation sent to ${email}. They finish and pay from the link; it works for 14 days.`); }
      else setMessage(result.errors.join(' '));
    } catch { setMessage('Unable to send. Try again.'); }
    setBusy(false);
  }
  return <Dialog title="Invite a Junior or Family member" onClose={onClose}>
    <form className="craft-form" onSubmit={event => { event.preventDefault(); void send(); }}>
      <p>Sending the invitation is the approval. The link takes them to the agreement and to payment, and the membership starts when they pay.</p>
      <label>Membership<select value={kind} onChange={event => { setKind(event.target.value as 'junior' | 'family'); setSent(false); setMessage(''); }}><option value="junior">Junior · $1,800 / year (parent or guardian pays)</option><option value="family">Family member add-on · $85 / month</option></select></label>
      <label>{kind === 'junior' ? 'Junior member name' : 'Family member name'}<input value={name} maxLength={120} required onChange={event => setName(event.target.value)} /></label>
      <label>{kind === 'junior' ? 'Parent or guardian email (their sign-in)' : 'Their email (their sign-in)'}<input type="email" value={email} maxLength={254} required onChange={event => setEmail(event.target.value)} /></label>
      {kind === 'family' && <label>Individual member they join<select value={sponsorId || sponsors[0]?.id || ''} onChange={event => setSponsorId(event.target.value)} required>{sponsors.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      {kind === 'family' && !sponsors.length && <p className="craft-callout">There is no active Individual member to attach a family member to.</p>}
      <p role="status">{message}</p>
      <div className="craft-actions"><Button onClick={onClose}>{sent ? 'Done' : 'Cancel'}</Button><Button type="submit" className="craft-primary" disabled={busy || (kind === 'family' && !sponsors.length)}>{busy ? 'Sending\u2026' : sent ? 'Send again' : 'Send invitation'}</Button></div>
    </form>
  </Dialog>;
}

/** The team adds an instructor or another team member: no payment or invitation, they just sign in with an emailed link. Instructors see only their own schedule; team members see everything. */
export function InstructorDialog({ onClose, role = 'instructor' }: { onClose: () => void; role?: 'instructor' | 'admin' }) {
  const live = useLive();
  const [name, setName] = useState(''), [email, setEmail] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [added, setAdded] = useState(false);
  if (!live) return null;
  async function add() {
    setBusy(true); setMessage('');
    try {
      const result = await live!.actions.addInstructor({ name, email, role });
      if (result.ok) { live!.apply(result.snapshot); setAdded(true); setMessage(`${name} can now sign in at the member login with ${email}. We emailed them how.`); setName(''); setEmail(''); }
      else setMessage(result.errors.join(' '));
    } catch { setMessage('Unable to add. Try again.'); }
    setBusy(false);
  }
  return <Dialog title={role === 'admin' ? 'Add a team member' : 'Add an instructor'} onClose={onClose}>
    <form className="craft-form" onSubmit={event => { event.preventDefault(); void add(); }}>
      <p>{role === 'admin' ? 'Team members sign in with their email and have full access: members, bookings, bays, billing, reports and settings, and they can add other team members and instructors.' : 'Instructors sign in with their email, book their own sessions and weekly blocks, and see their own schedule. They cannot see members, billing or reports.'}</p>
      <label>Name<input value={name} maxLength={120} required onChange={event => { setName(event.target.value); setAdded(false); }} /></label>
      <label>Email (their sign-in)<input type="email" value={email} maxLength={254} required onChange={event => { setEmail(event.target.value); setAdded(false); }} /></label>
      <p role="status">{message}</p>
      <div className="craft-actions"><Button onClick={onClose}>{added ? 'Done' : 'Cancel'}</Button><Button type="submit" className="craft-primary" disabled={busy}>{busy ? 'Adding\u2026' : role === 'admin' ? 'Add team member' : 'Add instructor'}</Button></div>
    </form>
  </Dialog>;
}

/** The team sets how many days ahead each kind of account may book. Saved for everyone, and checked again on the server. */
export function BookingWindowsForm() {
  const live = useLive();
  const [values, setValues] = useState({ member: String(bookingWindowDays('individual')), junior: String(bookingWindowDays('junior')), instructor: String(bookingWindowDays('instructor')) });
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  if (!live) return null;
  const change = (key: keyof BookingWindows) => (event: { target: { value: string } }) => { setValues({ ...values, [key]: event.target.value }); setMessage(''); };
  async function save() {
    const next = { member: Number(values.member), junior: Number(values.junior), instructor: Number(values.instructor) };
    setBusy(true); setMessage('');
    try {
      const result = await live!.actions.saveBookingWindows(next);
      if (result.ok) { live!.apply(result.snapshot); setMessage('Saved. New limits apply to every booking from now on; sessions already booked are not changed.'); }
      else setMessage(result.errors.join(' '));
    } catch { setMessage('Unable to save. Try again.'); }
    setBusy(false);
  }
  const field = (key: keyof BookingWindows, label: string) => <label>{label}<input type="number" inputMode="numeric" min={1} max={90} step={1} required value={values[key]} onChange={change(key)} /></label>;
  return <section aria-label="Booking windows">
    <h2>Booking windows</h2>
    <p className="craft-muted">How many days ahead each kind of account may book. An instructor's weekly blocks must also end inside their window.</p>
    <form className="craft-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="craft-form-grid">{field('member', 'Members and family (days)')}{field('junior', 'Juniors (days)')}{field('instructor', 'Instructors (days)')}</div>
      <p role="status">{message}</p>
      <div className="craft-actions"><Button type="submit" className="craft-primary" disabled={busy}>{busy ? 'Saving\u2026' : 'Save booking windows'}</Button></div>
    </form>
  </section>;
}

const TEAM_TONE: Record<LiveTeamStatus, 'green' | 'amber' | 'neutral'> = { active: 'green', suspended: 'amber', removed: 'neutral' };
const TEAM_LABEL: Record<LiveTeamStatus, string> = { active: 'Active', suspended: 'Suspended', removed: 'Removed' };

/** Suspend, restore or remove an instructor or team member. Suspending signs them out; removing also cancels their upcoming sessions. History is always kept. */
export function TeamAccountControls({ id, name, status, self = false }: { id: string; name: string; status: LiveTeamStatus; self?: boolean }) {
  const live = useLive();
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false);
  if (!live) return null;
  async function run(action: 'suspend' | 'restore' | 'remove', done: string) {
    setBusy(true); setMessage('');
    try {
      const result = await live!.actions.setTeamAccess(id, action);
      if (result.ok) { live!.apply(result.snapshot); setMessage(done); setConfirming(false); } else { setMessage(result.errors.join(' ')); setConfirming(false); }
    } catch { setMessage('Unable to save. Try again.'); }
    setBusy(false);
  }
  if (self) return <div><p className="craft-muted">This is your account. Another team member can change your access.</p></div>;
  return <div>
    <div className="craft-actions">
      {status === 'active' && <Button disabled={busy} onClick={() => void run('suspend', `${name} is suspended and signed out.`)}>Suspend</Button>}
      {status !== 'active' && <Button disabled={busy} onClick={() => void run('restore', `${name} can sign in again.`)}>Restore</Button>}
      {status !== 'removed' && <Button disabled={busy} onClick={() => setConfirming(true)}>Remove</Button>}
    </div>
    <p role="status">{message}</p>
    {confirming && <Dialog title={`Remove ${name}?`} onClose={() => setConfirming(false)}>
      <p>They are signed out at once and cannot sign in. Their upcoming sessions are cancelled; past sessions and history are kept. You can restore them later.</p>
      <div className="craft-actions"><Button onClick={() => setConfirming(false)}>Keep</Button><Button className="craft-primary" disabled={busy} onClick={() => void run('remove', `${name} was removed.`)}>{busy ? 'Removing\u2026' : 'Remove'}</Button></div>
    </Dialog>}
  </div>;
}

/** Who has full access, so nobody has to guess. Each email address has one role. */
export function TeamView() {
  const live = useLive();
  const [adding, setAdding] = useState(false);
  if (!live) return null;
  const people = live.team, active = people.filter(person => person.status === 'active').length;
  return <>
    <div className="craft-page-heading"><div><p className="craft-overline">Team</p><h1>Team</h1></div><Badge>{active} active</Badge></div>
    <div className="craft-actions"><Button className="craft-primary" onClick={() => setAdding(true)}>+ Add team member</Button></div>
    <p className="craft-muted">Everyone here has full access: members, bookings, bays, billing, reports and settings. Each email address can have only one role, so someone who is also an instructor needs a second address, for example name+coach@yourdomain.com.</p>
    <Card><div className="craft-list">{people.map(person => <div key={person.id} className="craft-member-row">
      <span className="craft-avatar" aria-hidden="true">{person.name.split(' ').map(word => word[0]).slice(0, 2).join('')}</span>
      <div><strong>{person.name}{person.self ? ' (you)' : ''}</strong><p>{person.email}{person.addedBy ? ` · added by ${person.addedBy}` : ''}</p></div>
      <Badge tone={TEAM_TONE[person.status]}>{TEAM_LABEL[person.status]}</Badge>
      <TeamAccountControls id={person.id} name={person.name} status={person.status} self={person.self} />
    </div>)}</div></Card>
    {adding && <InstructorDialog role="admin" onClose={() => setAdding(false)} />}
  </>;
}
