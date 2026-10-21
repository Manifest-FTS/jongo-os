"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "./ModalDrawer.module.css";

type Props = { id?: string; title: string; open: boolean; onClose: () => void; children: ReactNode };
const scrollLocks = new WeakMap<Document, { count: number; restore: () => void }>();

/** Reversible, reference-counted page lock; never hide window scrollbar chrome. */
export function lockDrawerScroll(doc: Document, view: Window): () => void {
  let lock = scrollLocks.get(doc);
  if (!lock) {
    const root = doc.documentElement;
    const body = doc.body;
    // Preserve longhands individually: setting the shorthand would erase
    // pre-existing mixed overflow-x/overflow-y values or !important priorities.
    const properties = [[root.style, "scrollbar-gutter"], [root.style, "overflow-x"],
      [root.style, "overflow-y"], [body.style, "overflow-x"], [body.style, "overflow-y"],
      [body.style, "padding-right"]] as const;
    const previous = properties.map(([style, property]) =>
      [style, property, style.getPropertyValue(property), style.getPropertyPriority(property)] as const);
    const widthBefore = root.clientWidth;
    const paddingBefore = parseFloat(view.getComputedStyle(body).paddingRight) || 0;
    root.style.setProperty("scrollbar-gutter", "stable", "important");
    root.style.setProperty("overflow-x", "hidden", "important");
    root.style.setProperty("overflow-y", "hidden", "important");
    body.style.setProperty("overflow-x", "hidden", "important");
    body.style.setProperty("overflow-y", "hidden", "important");
    // Stable gutters already reserve width. Compensate only actual expansion
    // on older browsers, avoiding a doubled gutter on supporting browsers.
    const expansion = Math.max(0, root.clientWidth - widthBefore);
    if (expansion) body.style.setProperty("padding-right", `${paddingBefore + expansion}px`, "important");
    lock = { count: 0, restore: () => {
      for (const [style, property, value, priority] of previous) {
        if (value) style.setProperty(property, value, priority);
        else style.removeProperty(property);
      }
    } };
    scrollLocks.set(doc, lock);
  }
  lock.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lock.count === 0) {
      lock.restore();
      scrollLocks.delete(doc);
    }
  };
}

export default function ModalDrawer({ id, title, open, onClose, children }: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  const outsidePress = useRef(false);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const doc = dialog.ownerDocument;
    const view = doc.defaultView;
    const previousFocus = doc.activeElement as HTMLElement | null;
    dialog.showModal();
    const unlock = view ? lockDrawerScroll(doc, view) : () => {};
    return () => {
      outsidePress.current = false;
      const shouldRestoreFocus = dialog.contains(doc.activeElement) || doc.activeElement === doc.body;
      if (dialog.open) dialog.close();
      unlock();
      if (shouldRestoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [open]);

  function isOutside(event: React.MouseEvent<HTMLDialogElement> | React.PointerEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false;
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  }

  return (
    <dialog id={id} ref={dialogRef} className={styles.drawer} aria-labelledby={titleId} aria-modal="true"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          onCloseRef.current();
        }
      }}
      onCancel={(event) => { event.preventDefault(); onCloseRef.current(); }}
      onClose={() => {
        // Ignore a queued cleanup close event if the dialog has reopened.
        if (!dialogRef.current?.open && open) onCloseRef.current();
      }}
      onPointerDown={(event) => { outsidePress.current = isOutside(event); }}
      onClick={(event) => {
        const dismiss = outsidePress.current && isOutside(event);
        outsidePress.current = false;
        if (dismiss) onCloseRef.current();
      }}>
      <header className={styles.header}>
        <h2 id={titleId} className={styles.title}>{title}</h2>
        <button type="button" className={styles.close} aria-label="Close drawer" onClick={() => onCloseRef.current()}>×</button>
      </header>
      <div className={styles.content} role="region" tabIndex={0} aria-label="Drawer content">{children}</div>
    </dialog>
  );
}