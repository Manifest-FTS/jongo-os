"use client";

import React, { useRef } from "react";
import CmsFormBuilder from "./CmsFormBuilder";
import type { TypeDefinition, Finding } from "@/lib/cms/schema";
import type { Values } from "@/lib/cms/form";

export type DraftSaveRequest = {
  documentId: string | null;
  expectedNativeRev: string | null;
  mutationId: string;
  serializedForm: string;
};
export type DraftSaveResult =
  | { status: "saved"; documentId: string; nativeRev: string }
  | { status: "invalid" | "denied" | "conflict" | "unavailable"; findings?: Finding[] };
export type DraftEditorProps = {
  schema: TypeDefinition; canEdit: boolean; initialDocument: Record<string, unknown>;
  documentId: string | null; nativeRev: string | null;
  saveAction: (request: DraftSaveRequest) => Promise<DraftSaveResult>;
  documentUrl: string;
};

/** Native CAS state changes only after persisted success. No simulated saves. */
export default function DraftEditor(props: DraftEditorProps) {
  const current = useRef({ documentId: props.documentId, nativeRev: props.nativeRev });
  const pending = useRef<{ fingerprint: string; request: DraftSaveRequest } | null>(null);
  const busy = useRef(false);
  const conflict = useRef(false);
  async function onSave(values: Values) {
    if (!props.canEdit) return { message: "Draft editing is not available." };
    if (busy.current) return { message: "A draft save is already in progress." };
    if (conflict.current) return { message: "Draft conflict. Your inputs are retained. Reload to review the latest revision before saving." };
    const serializedForm = JSON.stringify(values);
    const fingerprint = JSON.stringify({ ...current.current, serializedForm });
    if (pending.current?.fingerprint !== fingerprint) pending.current = {
      fingerprint, request: { documentId: current.current.documentId, expectedNativeRev: current.current.nativeRev,
        serializedForm, mutationId: crypto.randomUUID() }
    };
    const request = pending.current!.request;
    busy.current = true;
    try {
      const result = await props.saveAction(request);
      if (result.status === "saved") {
        current.current = { documentId: result.documentId, nativeRev: result.nativeRev };
        pending.current = null;
        // Preserve form state; a reload of this URL reads the committed revision.
        if (typeof window !== "undefined") window.history.replaceState(null, "", `${props.documentUrl}?docId=${encodeURIComponent(result.documentId)}`);
        return { message: "Draft saved. Nothing was published." };
      }
      if (result.status === "conflict") conflict.current = true;
      return { findings: result.findings, message: result.status === "conflict"
        ? "Draft conflict. Your inputs are retained. Reload to review the latest revision before saving."
        : result.status === "invalid" ? "Draft not saved. Correct the validation findings."
        : result.status === "denied" ? "Draft editing is no longer available. Your inputs are retained."
        : "Draft save unavailable. Your inputs are retained; retry the same request." };
    } finally { busy.current = false; }
  }
  return <CmsFormBuilder schemas={[props.schema]} canAuthor={props.canEdit}
    draft={{ initialDocument: props.initialDocument, onSave }} />;
}