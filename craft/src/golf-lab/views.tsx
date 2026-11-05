"use client";
import { useState } from 'react';
import { Badge, Button, Card, Dialog } from '../shell.js';
import { bookingStatus, canBook, csv, DEMO_TODAY, needsOnboarding, overviewStats, report, reportingRange, type Actor, type Booking, type Member } from './logic.js';
import { hourLabel } from './booking.js';
import { BillingView, type MembershipSelector } from './billing.js';
import { BayCards } from './bays.js';
import { bayLabel, createBayFixtures, resolveBay, type Bay } from './inventory.js';
import { CalendarDownload } from './calendar-download.js';
import { editableBooking, validDate } from './logic.js';

export function OverviewCards({ stats }: { stats: ReturnType<typeof overviewStats> }) {
  return <div className="craft-stats craft-overview-stats">{Object.entries(stats).map(([label, count]) => <Card title={label} key={label}><h2>{count}</h2>{label === 'Practicing Now' && <span className="craft-muted" title="Current reservations, not verified attendance. Start inclusive, end exclusive.">Scheduled sessions ⓘ</span>}</Card>)}</div>;
}
export function AdminOverview({ bookings, bays = createBayFixtures(), onSchedule }: { bookings: Booking[]; bays?: Bay[]; onSchedule?: () => void }) {
  return <><div className="craft-page-heading"><div><p className="craft-overline">Overview</p><h1>Your lab, at a glance.</h1><p>Reservations across {bays.length} bays. Chicago calendar periods.</p></div><Button className="craft-primary" onClick={onSchedule}>View bay schedule ↗</Button></div><OverviewCards stats={overviewStats(bookings)} /><BayCards bays={bays} bookings={bookings} /><Card title="Keep practice moving"><p>Manage your members, review billing requests, and plan the week ahead.</p><div className="craft-actions"><a href="/admin/members">Members ↗</a><a href="/admin/instructors">Instructors ↗</a><a href="/admin/reports">Reservation reports ↗</a></div></Card></>;
}
export function Onboarding({ member, membershipSelector, summaryOnly = false }: { member: Member; membershipSelector?: MembershipSelector; summaryOnly?: boolean }) {
  return <section aria-label="Membership onboarding"><div className="craft-page-heading"><div><p className="craft-overline">Your membership</p><h1>{needsOnboarding(member) ? 'Choose your next chapter.' : 'Let’s review your access.'}</h1><p>{member.billing}</p></div><Badge tone="amber">{member.billingStatus === 'active' ? 'Access suspended' : member.billingStatus}</Badge></div><p className="craft-callout">{member.accessReason === 'medical' ? 'Your paid membership and medical access suspension are separate. Contact the team to review your return.' : 'Booking becomes available only after payment confirmation and access approval.'}</p>{needsOnboarding(member) && !summaryOnly ? <BillingView role="member" member={member} membershipSelector={membershipSelector} /> : <a className="craft-button" href={summaryOnly ? '#platform-billing' : `/portal/billing?account=${member.id}`}>Review membership & billing ↗</a>}</section>;
}

export function MemberHome({ actor, members, bookings, bays = createBayFixtures(), onBook }: { actor: Actor; members: Member[]; bookings: Booking[]; bays?: Bay[]; onBook: () => void }) {
  const member = members.find(row => row.id === actor.id) ?? members[0];
  const personal = bookings.filter(row => row.memberId === member.id).sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
  return <>
    <div className="craft-hero"><div><p className="craft-overline">A little more time on your game</p><h1>Good practice.<br /><em>Great possibilities.</em></h1><p>Your space to focus, build confidence, and make the next shot count.</p>{canBook(member) ? <Button className="craft-lime" onClick={onBook}>Find your next session ↗</Button> : <p>{member.accessReason === 'medical' ? 'Medical leave · paid membership, access suspended. Contact the team to return.' : 'Booking unavailable · review your membership.'}</p>}</div><div className="craft-hero-art" aria-hidden="true"><div /><span>THE<br />NEXT<br />SHOT.</span></div></div>
    <div className="craft-stats"><Card title="Your membership"><Badge tone={member.active ? 'green' : 'amber'}>{member.active ? 'Active access' : 'Access suspended'}</Badge><h2>{member.tier}</h2><p>{member.billing}</p><Badge>{member.billingStatus}</Badge></Card><Card title="Booking window"><h2>{member.tier === 'junior' ? '1 day' : member.tier === 'instructor' ? '90 days*' : '7 days'}</h2><p>{member.tier === 'instructor' ? '*Instructor policy under review.' : 'Advance reservations · separate bookings for family add-ons.'}</p></Card><Card title="This season"><h2>1 hour / day</h2><p>Winter · November–April.<br />Summer May–October: 2h/day.</p><Badge tone={member.waiver ? 'green' : 'amber'}>{member.waiver ? 'Waiver on file' : 'Waiver required'}</Badge></Card></div>
    <Card title="Your sessions / upcoming & history"><div className="craft-list">{personal.map(row => <div className="craft-list-row" key={row.id}><div><strong>{row.date}</strong><p>{hourLabel(row.start)} · {row.hours}h · {resolveBay(bays, row.bay) ? bayLabel(resolveBay(bays, row.bay)!) : `Bay ${row.bay}`}</p>{editableBooking(row) && <CalendarDownload actor={actor} bookings={bookings} members={members} bays={bays} selection={{ bookingId: row.id }} label="Add to calendar (.ics)" filename={`golf-lab-session-${row.date}.ics`} />}</div><Badge tone={bookingStatus(row) === 'cancelled' ? 'amber' : 'green'}>{bookingStatus(row)}</Badge></div>)}{!personal.length && <p>No sessions yet. Choose a day to begin.</p>}</div><p className="craft-muted">“Completed” means the scheduled end has passed, not verified attendance. Calendar files include own future sessions only; importing does not sync changes or cancellations.</p></Card>
  </>;
}
export function MembersView({ members, bookings, instructors = false }: { members: Member[]; bookings: Booking[]; instructors?: boolean }) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState<Member | null>(null);
  return <><div className="craft-page-heading"><div><p className="craft-overline">{instructors ? 'Instructors' : 'Members'}</p><h1>{instructors ? 'The people behind progress.' : 'Know your community.'}</h1><p>{instructors ? 'Instructor agreements and assigned reservations.' : 'Membership, access and account details.'}</p></div><Badge>{members.length} accounts</Badge></div>
    <label className="craft-search">Search {instructors ? 'instructors' : 'members'}<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name or membership" /></label>
    <Card><div className="craft-list">{members.filter(member => `${member.name} ${member.tier}`.toLowerCase().includes(query.toLowerCase())).map(member => <div key={member.id} className="craft-member-row"><span className="craft-avatar" aria-hidden="true">{member.name.split(' ').map(word => word[0]).slice(0, 2).join('')}</span><div><strong>{member.name}</strong><p>{member.tier} · {member.email}</p></div><Badge tone={member.active && member.waiver ? 'green' : 'amber'}>{!member.active ? 'Inactive' : !member.waiver ? 'Waiver needed' : 'Active'}</Badge><Button onClick={() => setSelected(member)}>View details ↗</Button></div>)}{!members.some(member => `${member.name} ${member.tier}`.toLowerCase().includes(query.toLowerCase())) && <p>No matching accounts. Try another name.</p>}</div></Card>
    {selected && <Dialog title={selected.name} onClose={() => setSelected(null)}><p>{selected.email}</p><Badge>{selected.tier}</Badge><h3>Membership & billing</h3><p>{selected.billing}</p><p>Billing: {selected.billingStatus} · Access: {selected.active ? 'active' : 'suspended'} · Waiver: {selected.waiver ? 'accepted' : 'not accepted'}</p><p>No real contract, payment or waiver record exists.</p><h3>Reservations / activity</h3>{bookings.filter(row => row.memberId === selected.id).map(row => <p key={row.id}>{row.date} · Bay {row.bay} · {row.hours}h · {bookingStatus(row)}</p>)}<p className="craft-callout">No attendance, manual hour overrides or automated instructor charges.</p></Dialog>}
  </>;
}
export function ReportsView({ bookings, members }: { bookings: Booking[]; members: Member[] }) {
  const [period, setPeriod] = useState<'week' | 'month'>('week'), [date, setDate] = useState(DEMO_TODAY), [member, setMember] = useState('');
  const [downloadNotice, setDownloadNotice] = useState('');
  const range = reportingRange(date, period), result = report(bookings, range.from, range.to, member);
  function download() {
    const url = URL.createObjectURL(new Blob([csv(result.rows)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `golf-lab-reservations-${range.from}-${period}.csv`; link.hidden = true;
    document.body.appendChild(link); link.click(); link.remove();
    // Let browsers consume the blob before releasing it (immediate revocation can race downloads).
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloadNotice(`CSV prepared: ${result.rows.length} reservations. Browser download requested.`);
  }
  return <><div className="craft-page-heading"><div><p className="craft-overline">A clear picture, not an invoice</p><h1>Time, thoughtfully tracked.</h1><p>Reservation hours only. Completed is not attendance. No rates or automated charges.</p></div><Button className="craft-primary" onClick={download}>Download CSV ↓</Button></div>
    <div className="craft-toolbar craft-filters"><label>Period<select value={period} onChange={event => setPeriod(event.target.value as 'week' | 'month')}><option value="week">Week · Monday–Sunday</option><option value="month">Calendar month</option></select></label><label>Within date<input aria-label="Within date" type="date" value={date} onChange={event => { if (validDate(event.target.value)) setDate(event.target.value); }} /></label><label>Account<select value={member} onChange={event => setMember(event.target.value)}><option value="">All members & instructors</option>{members.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></div>
    <p>{range.from} inclusive → {range.to} exclusive · America/Chicago booking dates.</p>
    <p role="status" className="craft-muted">{downloadNotice}</p>
    <div className="craft-stats">{(['booked', 'completed', 'cancelled'] as const).map(status => <Card title={`${status} hours`} key={status}><h2>{result.totals[status]}<small> h</small></h2><p>{status === 'booked' ? 'Future or in-progress reservations.' : status === 'completed' ? 'Scheduled end passed. Not actual usage.' : 'Retained history; excluded from completed.'}</p></Card>)}</div>
    <Card title="Reservation ledger">{result.rows.length ? <div className="craft-table-scroll"><table className="craft-table"><caption>Reservation hours · mutually exclusive statuses</caption><thead><tr><th>Date</th><th>Account</th><th>Bay</th><th>Hours</th><th>Status</th></tr></thead><tbody>{result.rows.map(row => <tr key={row.id}><td>{row.date}</td><td>{members.find(item => item.id === row.memberId)?.name}</td><td>{row.bay}</td><td>{row.hours}</td><td><Badge>{bookingStatus(row)}</Badge></td></tr>)}</tbody></table></div> : <p>No reservations in this period. CSV still includes the header.</p>}</Card>
  </>;
}