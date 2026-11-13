"use client";
import { useState } from 'react';
import { Badge, Button, Dialog } from '../shell.js';
import { addDays, clockToday, validDate, type Member } from './logic.js';
import { useLive, type LiveDetail, type LiveResult } from './live.js';

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
