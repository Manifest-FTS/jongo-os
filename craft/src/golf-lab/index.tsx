"use client";
import { useEffect, useState } from 'react';
import { Badge, Button, Card, CraftShell, type CraftPlugin } from '../shell.js';
import { BookingCalendar, BookingDateControls, BookingEditor } from './booking.js';
import { BillingView, type MembershipSelector } from './billing.js';
export type { MembershipSelector, MembershipSelectorProps } from './billing.js';
import { createFixtureAdapter } from './fixtures.js';
import { AdminOverview, MemberHome, MembersView, ProfileView, ReportsView, Onboarding, OverviewCards } from './views.js';
import { canBook, needsOnboarding, overviewStats, setLiveClock, validDate, type Actor, type Booking, type Role } from './logic.js';
import { BayCards, BayManagement } from './bays.js';
import { CalendarDownload } from './calendar-download.js';
import { LiveProvider, type LiveConfig, type LiveSnapshot } from './live.js';
import { LiveBillingView } from './live-billing.js';
export type { LiveActions, LiveCommit, LiveConfig, LiveDetail, LiveResult, LiveSnapshot } from './live.js';
export { CalendarDownload } from './calendar-download.js';
export { BayCard, BayCards, BayManagement, BayNameForm } from './bays.js';
export { BillingView, CheckoutReviewDrawer, billingSections } from './billing.js';
export { createFixtureAdapter } from './fixtures.js';
export type { GolfLabFixtureAdapter } from './fixtures.js';
export { golfLabContentSchemas } from './schemas.js';
export { OverviewCards, Onboarding, ProfileView } from './views.js';
export { BookingCalendar, BookingDateControls, BookingEditor } from './booking.js';

/** Local fixture identity only unless `live` is given; the mounting server must keep the preview gate default-off. With `live`, the screens run on the host's real data and every change goes to the host first. */
export function GolfLabDemo({ initialView = 'member', initialRole = 'member', accountId = 'm1', membershipSelector, live }: { initialView?: string; initialRole?: Role; accountId?: string; membershipSelector?: MembershipSelector; live?: LiveConfig }) {
  // One clock for server and browser: the moment the snapshot was taken (or the frozen fixture day).
  setLiveClock(live ? live.snapshot.now : null);
  const [adapter, setAdapter] = useState(() => live ? { members: live.snapshot.members, bookings: live.snapshot.bookings, bays: live.snapshot.bays } : createFixtureAdapter());
  const [activeView, setActiveView] = useState(initialView);
  useEffect(() => {
    const back = () => setActiveView(location.pathname.split('/')[2] || (initialRole === 'member' ? 'member' : 'overview'));
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, [initialRole]);
  const role = initialRole;
  const apply = (snapshot: LiveSnapshot) => { setLiveClock(snapshot.now); setAdapter({ members: snapshot.members, bookings: snapshot.bookings, bays: snapshot.bays }); };
  const commit = async (next: Booking[]): Promise<void | string[]> => {
    if (!live) { setAdapter({ ...adapter, bookings: next }); return; }
    const before = new Map(adapter.bookings.map(row => [row.id, row]));
    const created = next.filter(row => !before.has(row.id));
    const modified = next.filter(row => { const old = before.get(row.id); return !!old && (old.date !== row.date || old.start !== row.start || old.hours !== row.hours || old.bay !== row.bay || old.status !== row.status); });
    if (!created.length && !modified.length) return;
    const result = await live.actions.commitBookings({ created, modified });
    if (!result.ok) return result.errors;
    apply(result.snapshot);
  };
  const member = adapter.members.find(row => row.id === (live ? live.selfId : accountId) && row.tier !== 'instructor') ?? adapter.members.find(row => row.tier !== 'instructor') ?? adapter.members[0];
  const actor: Actor = { role, id: role === 'admin' ? 'a1' : role === 'instructor' ? (live ? live.selfId : 'i1') : member.id };
  const base = role === 'member' ? '/portal' : '/admin';
  const query = live ? '' : `?account=${role === 'instructor' ? 'i1' : role === 'admin' ? 'a1' : member.id}`;
  const href = (id: string) => `${base}${id === 'overview' || id === 'member' ? '' : '/' + id}${query}`;
  const titles = role === 'admin' ? [['overview', 'Overview'], ['booking', 'Bay schedule'], ['bays', 'Bay Management'], ['members', 'Members'], ['instructors', 'Instructors'], ['reports', 'Reports'], ['billing', 'Billing & overrides']] : role === 'instructor' ? [['booking', 'My schedule']] : [['member', 'Overview'], ...(canBook(member) ? [['booking', 'Book a bay']] : []), ['profile', 'Profile'], ['billing', 'Membership & billing']];
  const view = role === 'instructor' ? 'booking' : activeView;
  const navigate = (id: string) => { if (!titles.some(([key]) => key === id)) return; setActiveView(id); history.pushState(null, '', href(id)); document.getElementById('craft-content')?.focus(); };
  const plugin: CraftPlugin<typeof adapter> = {
    id: 'golf-lab', title: role === 'member' ? 'Member portal' : role === 'instructor' ? 'Instructor workspace' : 'Golf Lab management', schemas: [],
    views: titles.map(([id, title]) => ({ id, title, href: href(id), roles: [role], render: () => {
      switch (id) {
        case 'overview': return <AdminOverview bays={adapter.bays} bookings={adapter.bookings} onSchedule={() => navigate('booking')} />;
        case 'bays': return <BayManagement actor={actor} bays={adapter.bays} bookings={adapter.bookings} onUpdate={bays => setAdapter({ ...adapter, bays })} />;
        case 'booking': return <BookingCalendar actor={actor} members={adapter.members} bays={adapter.bays} bookings={adapter.bookings} onUpdate={commit} />;
        case 'members': return <MembersView members={adapter.members.filter(row => row.tier !== 'instructor')} bookings={adapter.bookings} />;
        case 'instructors': return <MembersView instructors members={adapter.members.filter(row => row.tier === 'instructor')} bookings={adapter.bookings} />;
        case 'reports': return <ReportsView members={adapter.members} bookings={adapter.bookings} />;
        case 'billing': return live ? <LiveBillingView role={role} member={role === 'member' ? member : undefined} members={adapter.members.filter(row => row.tier !== 'instructor')} /> : <BillingView role={role} member={role === 'member' ? member : undefined} membershipSelector={membershipSelector} />;
        case 'profile': return <ProfileView member={member} onBilling={() => navigate('billing')} />;
        default: return needsOnboarding(member) ? <Onboarding member={member} membershipSelector={membershipSelector} /> : <>{live?.notice && <p className="craft-callout" role="status">{live.notice}</p>}<MemberHome actor={actor} members={adapter.members} bookings={adapter.bookings} bays={adapter.bays} onBook={() => navigate('booking')} /></>;
      }
    } }))
  };
  // Direct booking entry is guarded too, not just its navigation link.
  if (role === 'member' && view === 'booking' && !canBook(member)) {
    plugin.views = plugin.views.map(item => item.id === 'member' ? { ...item, render: () => <Onboarding member={member} membershipSelector={membershipSelector} /> } : item);
  }
  return <LiveProvider value={live ? { ...live, apply } : null}><CraftShell plugin={plugin} context={{ identity: { ...actor, label: role === 'admin' ? 'Golf Lab team' : adapter.members.find(row => row.id === actor.id)?.name ?? 'Member' }, adapter }} activeView={view} clientNavigation onNavigate={navigate}
    brand={{ name: 'THE GOLF LAB', tagline: 'Practice. With purpose.', homeHref: base + query, sidebarNote: live ? undefined : <a href="/style-guide#platform-member">Design system ↗</a> }}
    controls={live ? <div className="craft-preview-controls"><Button onClick={() => { void live.actions.signOut().then(() => location.assign('/login?out=1')); }}>Sign out</Button></div> : <div className="craft-preview-controls"><label>Account<select aria-label="Account" value={actor.id} onChange={event => {
      const id = event.target.value;
      location.assign(id === 'a1' ? '/admin?account=a1' : id === 'i1' ? '/admin/booking?account=i1' : `/portal?account=${id}`);
    }}>{role === 'member' ? adapter.members.filter(row => row.tier !== 'instructor').map(row => <option key={row.id} value={row.id}>{row.name}</option>) : <>{role === 'admin' && <option value="a1">Golf Lab team</option>}{adapter.members.filter(row => row.tier === 'instructor').map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</>}</select></label></div>} /></LiveProvider>;
}

/** Shared live components and tokens, not parallel mock implementations. */
export function GolfLabSpecimens({ membershipSelector }: { membershipSelector?: MembershipSelector }) {
  const [fixtures, setFixtures] = useState(createFixtureAdapter);
  const [date, setDate] = useState('2026-11-02');
  const [billingRole, setBillingRole] = useState<Role>('member');
  const [scheduling, setScheduling] = useState(false);
  return <div className="craft-root craft-specimens"><nav aria-label="Platform sections" className="craft-specimen-nav"><a href="#platform-member">Member portal</a><a href="#platform-booking">Booking</a><a href="#platform-admin">Management</a><a href="#platform-billing">Billing</a></nav>
    <section id="platform-member"><p className="craft-overline">Member portal</p><h2>More room for your game.</h2><div className="craft-two-columns"><Card title="Membership"><Badge tone="green">Individual · active</Badge><p>7-day advance booking · winter 1h/day · summer 2h/day.</p><a className="craft-button craft-primary" href="/portal">Open member portal ↗</a></Card><Card title="Inputs & status"><label>Specimen day<input aria-label="Specimen day" type="date" value={date} onChange={event => { if (validDate(event.target.value)) setDate(event.target.value); }} min="2026-11-02" max="2026-11-09" /></label><div className="craft-actions"><Badge tone="green">Active</Badge><Badge tone="amber">Pending</Badge><Button disabled>Unavailable</Button></div></Card></div><Onboarding member={fixtures.members.find(row => row.id === 'm6')!} summaryOnly /></section>
    <section id="platform-booking"><p className="craft-overline">Booking</p><h2>One session. Room for possibility.</h2><p className="craft-muted">Labeled native date inputs use the existing form styles and browser date controls. Day/week booking grids and previous/next week controls are unchanged. Member own future session Add to calendar (.ics); instructor own future session/series/day/week; admin all-bay day/week includes labeled history. Cancelled excluded. Downloaded snapshots do not sync.</p><BookingDateControls date={date} onChange={setDate} /><BayCards bays={fixtures.bays} bookings={fixtures.bookings} date={date} /><a href="/portal/booking">Open booking ↗</a><Card title="Instructor weekly blocks"><p>Derek’s Monday 3–9 PM blocks through the next two months: whole-hour duration, inclusive end date, every occurrence reviewed. The shared editor uses a configurable 12-hour prototype ceiling and proposed 90-day horizon; no backend scheduling.</p><Button onClick={() => setScheduling(true)}>Try instructor recurrence</Button><a href="/admin/booking?account=i1">Open instructor schedule ↗</a></Card>{scheduling && <BookingEditor actor={{ id: 'i1', role: 'instructor' }} members={fixtures.members} bookings={fixtures.bookings} bays={fixtures.bays} date="2026-11-02" seed={{ id: 'specimen-weekly', memberId: 'i1', date: '2026-11-02', start: 15, hours: 6, bay: 1, status: 'booked' }} onClose={() => setScheduling(false)} onSave={bookings => { setFixtures({ ...fixtures, bookings }); setScheduling(false); }} />}</section>
    <Card title="Calendar file specimen"><p>Shared member download control: fictional own future reservation only. Import this .ics file into a calendar app. No Google OAuth, subscription, live invitation or backend synchronization.</p><CalendarDownload actor={{ id: 'm1', role: 'member' }} members={fixtures.members} bookings={fixtures.bookings} bays={fixtures.bays} selection={{ bookingId: 'b1' }} label="Add to calendar (.ics)" filename="golf-lab-specimen-session.ics" /></Card>
    <section id="platform-admin"><p className="craft-overline">Management</p><h2>A clear picture.</h2><OverviewCards stats={overviewStats(fixtures.bookings)} /><a href="/admin">Open management ↗</a> · <a href="/admin/booking?account=i1">Instructor schedule ↗</a> · <a href="/admin/bays">Bay Management ↗</a><details><summary>Try the shared bay inventory form</summary><BayManagement actor={{ id: 'a1', role: 'admin' }} bays={fixtures.bays} bookings={fixtures.bookings} onUpdate={bays => setFixtures({ ...fixtures, bays })} /></details></section>
    <section id="platform-billing"><p className="craft-overline">Billing & agreements</p><p className="craft-muted">Shared role-aware tabs: arrow keys, Home and End move focus and open one section. Payment actions are simulated; instructors have no billing exceptions.</p><label>Billing specimen role<select value={billingRole} onChange={event => setBillingRole(event.target.value as Role)}><option value="member">Member</option><option value="admin">Admin</option><option value="instructor">Instructor</option></select></label><BillingView key={billingRole} role={billingRole} member={billingRole === 'member' ? fixtures.members[0] : billingRole === 'instructor' ? fixtures.members.find(row => row.id === 'i1') : undefined} specimen membershipSelector={membershipSelector} /></section>
  </div>;
}