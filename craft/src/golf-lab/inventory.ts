import type { Actor, Booking } from './logic.js';

/** Operational inventory, not a CMS document. Identity and number never change on rename. */
export type Bay = { readonly id: string; readonly displayNumber: number; name: string };
export function createBayFixtures(): Bay[] {
  return ['The Fairway', 'The Approach', 'The Turn', 'The Launch'].map((name, index) => ({ id: `golf-lab-bay-${index + 1}`, displayNumber: index + 1, name }));
}
export function bayLabel(bay: Bay): string { return `Bay ${String(bay.displayNumber).padStart(2, '0')} · ${bay.name}`; }
/** Legacy reservations store immutable displayNumber, never an array index or editable name. */
export function resolveBay(bays: readonly Bay[], number: number): Bay | undefined { return bays.find(bay => bay.displayNumber === number); }
export function assertInventory(bays: readonly Bay[]): void {
  if (bays.some(bay => !bay.id.trim() || !Number.isSafeInteger(bay.displayNumber) || bay.displayNumber < 1)
    || new Set(bays.map(bay => bay.id)).size !== bays.length || new Set(bays.map(bay => bay.displayNumber)).size !== bays.length) throw new Error('Bay identity/number collision. Inventory was not changed.');
}
function nameFor(bays: readonly Bay[], value: string, except?: string): string {
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Enter a bay name between 1 and 60 characters, without control characters.');
  if (bays.some(bay => bay.id !== except && bay.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))) throw new Error('A bay with this name already exists. Choose a unique name.');
  return name;
}
export function updateInventory(actor: Actor, bays: readonly Bay[], name: string, editId?: string, newId?: string): Bay[] {
  if (actor.role !== 'admin') throw new Error('Only admins may manage bay inventory.');
  assertInventory(bays);
  const label = nameFor(bays, name, editId);
  if (editId !== undefined) {
    if (!bays.some(bay => bay.id === editId)) throw new Error('Bay not found. Inventory was not changed.');
    return bays.map(bay => bay.id === editId ? { ...bay, name: label } : { ...bay });
  }
  const id = newId ?? `bay-${crypto.randomUUID()}`;
  if (!id.trim() || bays.some(bay => bay.id === id)) throw new Error('Bay identity collision. Inventory was not changed.');
  const displayNumber = Math.max(0, ...bays.map(bay => bay.displayNumber)) + 1;
  if (!Number.isSafeInteger(displayNumber)) throw new Error('Bay number limit reached.');
  return [...bays.map(bay => ({ ...bay })), { id, displayNumber, name: label }];
}
export function bayReservations(bay: Bay, bookings: readonly Booking[], date: string): Booking[] {
  return bookings.filter(row => row.bay === bay.displayNumber && row.date === date && row.status !== 'cancelled').sort((a, b) => a.start - b.start);
}