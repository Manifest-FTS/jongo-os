"use client";
import { useState } from 'react';
import { Badge, Button, Card, Dialog } from '../shell.js';
import type { Member } from './logic.js';
import { useLive, type LiveDetail, type LiveFamilyMember, type LiveResult } from './live.js';

/** Shared by the cancellation and family screens: run one host action, show what happened, and hand back the fresh snapshot. */
function useRun() {
  const live = useLive();
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  async function run(task: () => Promise<LiveResult>, success: string, after?: () => void) {
    setBusy(true); setMessage('');
    try {
      const result = await task();
      if (result.ok) { live!.apply(result.snapshot); setMessage(success); after?.(); } else setMessage(result.errors.join(' '));
    } catch { setMessage('Unable to save. Try again.'); }
    setBusy(false);
  }
  return { live, message, busy, run };
}

/** A member ends their own membership at the end of the term: it stays active until then and nothing is billed after. */
export function CancelCard({ member, detail }: { member: Member; detail?: LiveDetail }) {
  const { live, message, busy, run } = useRun();
  const [confirm, setConfirm] = useState(false);
  const cancel = detail?.cancel;
  if (!live || !cancel?.applies) return null;
  return <Card title="Cancel membership">
    <p>{cancel.message}</p>
    {cancel.scheduled
      ? <Button disabled={busy} onClick={() => void run(() => live.actions.withdrawCancellation(member.id), 'Your membership will continue.')}>Keep my membership</Button>
      : cancel.canRequest && <Button onClick={() => setConfirm(true)}>Cancel membership</Button>}
    <p role="status">{message}</p>
    {confirm && <Dialog title="Cancel your membership?" onClose={() => setConfirm(false)}>
      <p>{cancel.message}</p>
      <p>You keep full access until {cancel.endsOn}. You will not be charged again after that date. You can change your mind any time before then.</p>
      <div className="craft-actions"><Button onClick={() => setConfirm(false)}>Keep my membership</Button><Button className="craft-primary" disabled={busy} onClick={() => void run(() => live.actions.cancelMembership(member.id, {}), 'Cancellation scheduled.', () => setConfirm(false))}>Cancel at the end of the term</Button></div>
    </Dialog>}
  </Card>;
}

/** An Individual member adds and manages family members. Each pays their own add-on, so removing one never touches the sponsor's membership. */
export function FamilyPanel({ detail }: { detail?: LiveDetail }) {
  const { live, message, busy, run } = useRun();
  const [name, setName] = useState(''), [email, setEmail] = useState(''), [removing, setRemoving] = useState<LiveFamilyMember | null>(null);
  if (!live) return null;
  const family = detail?.family ?? [];
  return <Card title="Family members">
    <p>Add family members to your membership. Each one gets an email link to read the agreement and pay for their own Family Member Add-on, then books on their own. The add-on renews monthly and can be removed at any time. Removing or canceling it never affects your membership. If your membership ends, family add-ons end at their next billing date.</p>
    <div className="craft-list">
      {family.map(person => <div className="craft-list-row" key={person.id}>
        <div><strong>{person.name}</strong><p>{person.email}</p>{person.cancel.scheduled && <p className="craft-muted">{person.cancel.message}</p>}</div>
        <div className="craft-actions"><Badge tone={person.invited ? 'amber' : 'green'}>{person.statusLabel}</Badge>
          {person.invited && <><Button disabled={busy} onClick={() => void run(() => live.actions.addFamilyMember({ name: person.name, email: person.email }), `Invitation sent again to ${person.email}.`)}>Send link again</Button><Button disabled={busy} onClick={() => void run(() => live.actions.revokeFamilyInvite(person.id), 'Invitation withdrawn.')}>Withdraw invitation</Button></>}
          {!person.invited && person.cancel.scheduled && <Button disabled={busy} onClick={() => void run(() => live.actions.withdrawCancellation(person.id), `${person.name} will stay.`)}>Keep</Button>}
          {!person.invited && !person.cancel.scheduled && person.cancel.canRequest && <Button disabled={busy} onClick={() => setRemoving(person)}>Remove</Button>}
        </div>
      </div>)}
      {!family.length && <p>No family members yet.</p>}
    </div>
    {detail?.canAddFamily
      ? <form className="craft-form" onSubmit={event => { event.preventDefault(); void run(() => live.actions.addFamilyMember({ name, email }), `Invitation sent to ${email}.`, () => { setName(''); setEmail(''); }); }}>
        <h3>Add a family member</h3>
        <label>Their name<input value={name} maxLength={120} required onChange={event => setName(event.target.value)} /></label>
        <label>Their email (their sign-in)<input type="email" value={email} maxLength={254} required onChange={event => setEmail(event.target.value)} /></label>
        <Button type="submit" className="craft-primary" disabled={busy}>{busy ? 'Sending\u2026' : 'Send invitation'}</Button>
      </form>
      : <p className="craft-muted">You have reached the limit of {detail?.familyLimit ?? 5} family members. Remove one to add another.</p>}
    <p role="status">{message}</p>
    {removing && <Dialog title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}>
      <p>{removing.cancel.message}</p>
      <p>Their add-on stays active until then and they are not charged again after that date. Your own membership is not affected.</p>
      <div className="craft-actions"><Button onClick={() => setRemoving(null)}>Keep {removing.name}</Button><Button className="craft-primary" disabled={busy} onClick={() => void run(() => live.actions.cancelMembership(removing.id, {}), `${removing.name} will be removed at the end of the term.`, () => setRemoving(null))}>Remove at the end of the term</Button></div>
    </Dialog>}
  </Card>;
}

/** The team ends a membership for someone who asked by email. Needs a reason; recorded with who did it. */
export function TeamCancel({ member, detail }: { member: Member; detail: LiveDetail }) {
  const { live, message, busy, run } = useRun();
  const [note, setNote] = useState('');
  const cancel = detail.cancel;
  if (!live || !cancel?.applies) return null;
  return <>
    <h3>Cancel membership</h3>
    <p>{cancel.message}</p>
    {cancel.scheduled
      ? <Button disabled={busy} onClick={() => void run(() => live.actions.withdrawCancellation(member.id), 'Cancellation removed.')}>Remove the cancellation</Button>
      : cancel.canRequest && <form className="craft-form" onSubmit={event => { event.preventDefault(); void run(() => live.actions.cancelMembership(member.id, { note }), 'Cancellation scheduled.', () => setNote('')); }}>
        <label>Reason for the cancellation<textarea value={note} onChange={event => setNote(event.target.value)} placeholder="Who asked, and how (for example: emailed on Nov 12)" /></label>
        <Button type="submit" disabled={busy || note.trim().length < 8}>Cancel at the end of the term</Button>
      </form>}
    <p role="status">{message}</p>
  </>;
}
