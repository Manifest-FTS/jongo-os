"use client";
import { useState } from 'react';
import { Button } from '../shell.js';
import { calendarExport, type CalendarSelection } from './calendar-export.js';
import type { Actor, Booking, Member } from './logic.js';
import type { Bay } from './inventory.js';

export function CalendarDownload({ actor, bookings, members, bays, selection, label, filename }: {
  actor: Actor; bookings: Booking[]; members: Member[]; bays: Bay[]; selection: CalendarSelection; label: string; filename: string;
}) {
  const [notice, setNotice] = useState('');
  return <div className="craft-calendar-download"><Button onClick={() => {
    try {
      const result = calendarExport(bookings, members, bays, actor, selection);
      if (!result.count) { setNotice('No eligible reservations. No file downloaded. Cancelled sessions are excluded.'); return; }
      const url = URL.createObjectURL(new Blob([result.content], { type: 'text/calendar;charset=utf-8' })), link = document.createElement('a');
      link.href = url; link.download = filename; link.hidden = true; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`ICS prepared: ${result.count} reservation(s). Browser download requested. Import the file into your calendar; changes do not sync.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Calendar could not be prepared.'); }
  }}>{label}</Button>{notice && <small role="status" className="craft-muted">{notice}</small>}</div>;
}