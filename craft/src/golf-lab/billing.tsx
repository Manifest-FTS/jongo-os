"use client";
import { useState, type ReactNode } from 'react';
import { Badge, Button, Card, Tabs } from '../shell.js';
import { checkoutErrors, needsOnboarding, PLANS, type Role, type Member } from './logic.js';
import { Dialog } from '../shell.js';
import { validDate } from './logic.js';

export type MembershipSelectorProps = { plan: typeof PLANS[number]['id']; onPlanChange: (plan: typeof PLANS[number]['id']) => void; onContinue: () => void };
export type MembershipSelector = (props: MembershipSelectorProps) => ReactNode;

export function billingSections(role: Role) {
  return role === 'admin' ? [{ id: 'membership', label: 'Membership plans' }, { id: 'payment', label: 'Billing / payment status' }, { id: 'agreements', label: 'Commitments & overrides' }]
    : role === 'instructor' ? [{ id: 'agreements', label: 'Instructor agreement' }]
    : [{ id: 'membership', label: 'Membership' }, { id: 'payment', label: 'Payment methods & invoices' }, { id: 'agreements', label: 'Commitment & agreements' }];
}

export function BillingView({ role, member, membershipSelector, specimen = false }: { role: Role; member?: Member; membershipSelector?: MembershipSelector; specimen?: boolean }) {
  const sections = billingSections(role);
  const [tab, setTab] = useState(sections[0].id);
  const activeTab = sections.some(section => section.id === tab) ? tab : sections[0].id;
  const [plan, setPlan] = useState<typeof PLANS[number]['id']>('monthly'), [waiver, setWaiver] = useState(false), [individual, setIndividual] = useState(false), [approved, setApproved] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const changePlan: MembershipSelectorProps['onPlanChange'] = next => {
    setPlan(next); setOutcome('idle'); setWaiver(false); setIndividual(false); setApproved(false); setNotice(''); setErrors([]); setFeedback('');
    if (!specimen) setReviewOpen(true);
  };
  const [outcome, setOutcome] = useState('idle'), [errors, setErrors] = useState<string[]>([]), [notice, setNotice] = useState('');
  const [reason, setReason] = useState(''), [resume, setResume] = useState('2026-12-02'), [exception, setException] = useState<{ reason: string; resume: string } | null>(null);
  const selected = PLANS.find(item => item.id === plan)!;
  const [feedback, setFeedback] = useState('');
  return <>
    <div className="craft-page-heading"><div><p className="craft-overline">Membership & billing</p><p>Payment not connected. No card details are collected.</p>{member && <p>{member.name} · Billing: {member.billingStatus} · {member.billing}</p>}</div></div>
    <Tabs label="Billing sections" items={sections} value={activeTab} onChange={next => { setTab(next); setReviewOpen(false); setFeedback(''); }}>
    {activeTab === 'membership' && <>
    <div className="craft-review-bar"><div><strong>{selected.label}</strong><span>{selected.price} · Review before continuing</span></div><Button className="craft-primary" aria-haspopup="dialog" onClick={() => setReviewOpen(true)}>{specimen ? 'Demonstrate checkout drawer' : 'Review & agree'} ↗</Button></div>
    {specimen && <p className="craft-muted">Shared checkout specimen: opens on the right, or as a scrollable bottom sheet on mobile. Plan selection opens it directly in the portal and management billing.</p>}
    {membershipSelector ? <div className="craft-host-membership">{membershipSelector({ plan, onPlanChange: changePlan, onContinue: () => setReviewOpen(true) })}</div> : <p className="craft-callout">The host membership selector is not configured. Payment remains disconnected.</p>}
    {member && needsOnboarding(member) && <Card title="Membership status"><p>{member.billingStatus === 'pending' ? 'Payment confirmation is pending. No active subscription or booking access is claimed.' : 'No paid membership is active. Choose a plan above to review the onboarding flow.'}</p></Card>}
    </>}
    {activeTab === 'payment' && <Card title={role === 'admin' ? 'Billing / payment status' : 'Payment methods & invoices'}>
      <p>{member ? `Billing status: ${member.billingStatus}. ${member.billing}` : 'Select a member in the member directory to review their fixture billing status. No provider ledger is connected.'}</p>
      {role === 'member' && member && needsOnboarding(member) ? <p>{member.billingStatus === 'pending' ? 'Payment confirmation is pending. No active subscription or booking access is claimed.' : 'No paid membership is active. Return to Membership to review onboarding.'} No saved payment method or invoice history is claimed.</p>
        : role === 'member' ? <><p>Payment methods and invoice history would be managed through an authenticated provider portal, not a card form here.</p><Button onClick={() => setFeedback('Payment not connected. A server-created, authenticated card / invoice portal session would open here. No provider request was made.')}>Manage card & invoices</Button></> : <p>Payment collection and membership access are separate. This preview cannot charge, refund, reconcile or manage a member’s card.</p>}
      <p>No metered invoices, rates, attendance or manual hour adjustments.</p>
    </Card>}
    {activeTab === 'agreements' && <>
      <Card title={role === 'instructor' ? 'Instructor agreement' : 'Commitment & agreements'}>
        <p>{member ? member.billing : role === 'instructor' ? 'Instructor agreement details require team review. No automated fees.' : 'Select a member in the member directory to review their commitment and waiver fixture status.'}</p>
        <p>{member && !needsOnboarding(member) ? `Waiver fixture status: ${member.waiver ? 'on file' : 'required'}.` : 'No active membership agreement is claimed.'} No real contract, payment or legal acceptance record exists.</p>
        <p>Only dates explicitly present in the account summary are fixture dates. Renewal dates, signed terms and cancellation effective dates are not connected; do not infer them from the plan being considered.</p>
        <p>Cancellation and plan changes require review of your actual commitment and effective date. A request cannot bypass a commitment or medical access suspension.</p>
        {role === 'member' && member && !needsOnboarding(member) && <Button onClick={() => setFeedback('Cancellation request only. An admin must review the commitment and effective date. No subscription was cancelled or request persisted.')}>Request plan change / cancellation</Button>}
        {role === 'member' && member && needsOnboarding(member) && <p>Complete onboarding in Membership first; there is no confirmed subscription to cancel here.</p>}
        {role === 'instructor' && <p>Contact the team about your agreement. Instructors cannot grant billing or access exceptions.</p>}
      </Card>
      {role === 'admin' && <Card title="Billing & access exceptions"><p>Medical leave is not a one-click billing pause. Billing treatment, access suspension, resume date and commitment extension must be reviewed separately, reconciled with the provider and audited.</p>
        <div className="craft-form"><label>Required review reason<textarea value={reason} onChange={event => setReason(event.target.value)} placeholder="Describe a sample scenario; no medical or personal information" /></label><label>Requested resume date<input aria-label="Requested resume date" type="date" min="2026-11-03" value={resume} onChange={event => setResume(event.target.value)} /></label><p>Review access suspension, billing collection and commitment extension separately. This page records only a local request; no provider action or final extension date is claimed.</p><Button disabled={reason.trim().length < 8 || !validDate(resume) || resume <= '2026-11-02'} onClick={() => setException({ reason: reason.trim(), resume })}>Record review request</Button>{exception && <p role="status">Local review request: {exception.reason} · proposed resume {exception.resume}. Billing/access unchanged. Real approval, audit storage and reconciliation are not implemented.</p>}</div>
      </Card>}
    </>}
    </Tabs>
    {reviewOpen && activeTab === 'membership' && role !== 'instructor' && <CheckoutReviewDrawer onClose={() => setReviewOpen(false)}>
      <Card><Badge tone="green">{selected.label}</Badge><h2>{selected.price}</h2><p>{selected.terms}</p><p>Individual/family: 7 days ahead. Junior: 1 day. Winter 1h/day; summer 2h/day. Chicago time.</p>
        <p className="craft-callout">Fees, refunds, renewals and cancellation notice are pending final policy/legal review. No processing surcharge is modeled or charged.</p>
        <div className="craft-form">{plan === 'family' && <label className="craft-check"><input type="checkbox" checked={individual} onChange={event => setIndividual(event.target.checked)} />Simulate verified active Individual sponsor</label>}
          {plan === 'junior' && <label className="craft-check"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />Simulate prior admin approval & guardian review (not self-approval in production)</label>}
          <details><summary>Read illustrative waiver & agreement</summary><p>Illustrative text only, not a legal waiver. Indoor golf involves risk. Production requires counsel-approved full text, explicit guardian authority where applicable, versioned terms and an auditable acceptance record. This checkbox records no legal signature.</p></details>
          <label className="craft-check"><input type="checkbox" checked={waiver} onChange={event => setWaiver(event.target.checked)} />I reviewed the illustrative waiver and the selected price/commitment. No legal acceptance is stored.</label>
          <label>Simulated payment result<select value={outcome === 'failed' ? 'failed' : 'success'} onChange={event => setOutcome(event.target.value === 'failed' ? 'failed' : 'idle')}><option value="success">Success scenario</option><option value="failed">Declined scenario</option></select></label>
          {!!errors.length && <div className="craft-error" role="alert">{errors.map(error => <p key={error}>{error}</p>)}</div>}
          <Button className="craft-primary" onClick={() => { const findings = checkoutErrors(plan, waiver, individual, approved); setErrors(findings); if (!findings.length) { if (outcome === 'failed') { setNotice('Simulated decline. No payment, membership or waiver was created.'); } else { setOutcome('complete'); const message = `Simulated success for ${selected.price}. No money collected, account created or legal waiver stored. Booking remains locked until real payment confirmation is implemented.`; setNotice(message); } } }}>Simulate checkout ↗</Button>
          <p role="status">{notice}</p>{outcome === 'complete' && <Badge tone="green">Reviewed · no subscription created</Badge>}
        </div>
      </Card>
    </CheckoutReviewDrawer>}
    {feedback && <Dialog title="Payment not connected" onClose={() => setFeedback('')}><p>{feedback}</p><Button onClick={() => setFeedback('')}>Close</Button></Dialog>}
  </>;
}

/** Same native-modal checkout surface for portal, admin billing and specimens. */
export function CheckoutReviewDrawer({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return <Dialog title="Review & agree" variant="drawer" onClose={onClose}>{children}</Dialog>;
}