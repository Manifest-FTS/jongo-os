"use client";
import { useState } from 'react';
import { Badge, Button, Card, Tabs } from '../shell.js';
import { billingSections } from './billing.js';
import { useLive } from './live.js';
import type { Member, Role } from './logic.js';

const CONTACT_NOTE = 'To change or end your membership, contact the team. A request cannot bypass a commitment.';

/** Membership & billing with the member's real plan, payments and agreements. Money is handled in Stripe; this screen only shows it and hands over to Stripe's secure portal. */
export function LiveBillingView({ role, member, members = [] }: { role: Role; member?: Member; members?: Member[] }) {
  const live = useLive();
  const sections = billingSections(role);
  const [tab, setTab] = useState(sections[0].id), [message, setMessage] = useState(''), [opening, setOpening] = useState(false);
  if (!live) return null;
  const detail = member ? live.details[member.id] : undefined;
  async function openPortal() {
    setOpening(true); setMessage('');
    try {
      const result = await live!.actions.billingPortal();
      if (result.url) { window.location.assign(result.url); return; }
      setMessage(result.error ?? 'Billing is not available right now. Please try again shortly.');
    } catch { setMessage('Billing is not available right now. Please try again shortly.'); }
    setOpening(false);
  }
  const count = (status: Member['billingStatus']) => members.filter(item => item.billingStatus === status).length;
  const attention = members.filter(item => item.billingStatus === 'past_due' || item.billingStatus === 'suspended' || item.billingStatus === 'unpaid');
  return <>
    <div className="craft-page-heading"><div><p className="craft-overline">Membership &amp; billing</p>{member && <p>{member.name} · {detail?.statusLabel ?? member.billingStatus}</p>}</div></div>
    <Tabs label="Billing sections" items={sections} value={tab} onChange={next => { setTab(next); setMessage(''); }}>
      {role === 'member' && member && tab === 'membership' && <Card title="Your membership">
        {member.billingStatus === 'past_due' && <p className="craft-callout">Your latest payment did not go through. Update your payment method so your access is not interrupted.</p>}
        <dl className="craft-details">{([['Plan', detail?.planLabel ?? 'None'], ['Price', detail?.price ?? '\u2014'], ['Status', detail?.statusLabel ?? member.billingStatus], ['Started', detail?.started ?? '\u2014'], ['Commitment ends', detail?.commitmentEnd ?? 'No commitment']] as [string, string][]).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <p className="craft-muted">Card payments include a processing fee, shown on your receipt.</p>
      </Card>}
      {role === 'member' && member && tab === 'payment' && <Card title="Payment methods & invoices">
        <p>Your card, receipts and invoices live in Stripe&apos;s secure billing portal. No card details are ever entered on this site.</p>
        <Button className="craft-primary" onClick={() => void openPortal()} disabled={opening}>{opening ? 'Opening\u2026' : 'Open secure billing portal \u2197'}</Button>
        <p role="status">{message}</p>
      </Card>}
      {role === 'member' && member && tab === 'agreements' && <Card title="Commitment & agreements">
        <dl className="craft-details"><div><dt>Commitment ends</dt><dd>{detail?.commitmentEnd ?? 'No commitment'}</dd></div><div><dt>Waiver and agreement</dt><dd>{detail?.waiverAccepted ? `Accepted ${detail.waiverAccepted}${live.waiver ? ` (${live.waiver.version})` : ''}` : 'Not on file'}</dd></div></dl>
        <p>{CONTACT_NOTE}</p><a className="craft-button" href={`mailto:${live.contactEmail}?subject=${encodeURIComponent('Membership change request')}`}>Contact the team ↗</a>
      </Card>}
      {role === 'instructor' && <Card title="Instructor agreement"><p>Contact the team about your agreement. Instructors cannot grant billing or access exceptions.</p></Card>}
      {role === 'admin' && tab === 'membership' && <Card title="Membership plans"><div className="craft-stats">{([['Active', count('active')], ['Payment needed', count('past_due')], ['Paused', count('suspended')], ['Not started', count('unpaid') + count('pending')]] as [string, number][]).map(([label, value]) => <Card title={label} key={label}><h2>{value}</h2></Card>)}</div><p className="craft-muted">Members pick and pay for a plan on the website. Prices are charged through Stripe.</p></Card>}
      {role === 'admin' && tab === 'payment' && <Card title="Billing / payment status"><p>Payments, refunds and receipts are managed in Stripe. Booking access follows the payment status shown here.</p><a className="craft-button" href="https://dashboard.stripe.com/" target="_blank" rel="noopener noreferrer">Open Stripe dashboard ↗</a>
        <h3>Needs attention</h3>{attention.length ? <div className="craft-list">{attention.map(item => <div className="craft-list-row" key={item.id}><div><strong>{item.name}</strong><p>{item.email}</p></div><Badge tone="amber">{live.details[item.id]?.statusLabel ?? item.billingStatus}</Badge></div>)}</div> : <p>Everyone is current.</p>}</Card>}
      {role === 'admin' && tab === 'agreements' && <Card title="Commitments & overrides"><p>Commitment end dates are shown for each member in Members. Medical leave, pauses and other exceptions change billing, access and the commitment separately: make the billing change in Stripe and record the access decision with the team. This screen does not pause or extend anything by itself.</p>
        <div className="craft-list">{members.filter(item => live.details[item.id]?.commitmentEnd).map(item => <div className="craft-list-row" key={item.id}><div><strong>{item.name}</strong><p>{live.details[item.id]?.planLabel}</p></div><Badge>{live.details[item.id]?.commitmentEnd}</Badge></div>)}</div></Card>}
    </Tabs>
  </>;
}
