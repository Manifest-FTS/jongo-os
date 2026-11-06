"use client";
import { createContext, useContext, type ReactNode } from 'react';
import type { TypeDefinition } from './schema.js';
import type { KeyMaker, JsonObject } from './portable-text.js';
import type { ReferenceIndex } from './content-ops.js';
import type { MediaLimits, StudioAssetDocument } from './media-contract.js';
import type { UploadHandlers, UploadSource } from './media-client.js';
import type { UploadResult } from './studio-store.js';
import { isUnder, pathKey, type Issue, type Path } from './validate.js';

/** Present only when the host can take uploads. The image picker shows Upload exactly when this exists. */
export type MediaApi = {
  limits: MediaLimits;
  /** Never rejects; failures are typed codes. */
  upload: (file: UploadSource, handlers: UploadHandlers) => Promise<UploadResult<{ asset: StudioAssetDocument }>>;
  /** Makes a just-uploaded asset listable and resolvable at once. */
  adopt: (asset: StudioAssetDocument) => void;
};

export type StudioApi = {
  docId: string;
  values: JsonObject;
  issues: readonly Issue[];
  index: ReferenceIndex;
  schemas: ReadonlyMap<string, TypeDefinition>;
  makeKey: KeyMaker;
  /** Polite live-region message for the whole editor. */
  announce: (message: string) => void;
  /** Move focus after the next render; optionally select a text range. */
  focus: (id: string, select?: readonly [number, number]) => void;
  media?: MediaApi;
  /** Developer-oriented explanations (allowed types, storage notes) are shown only when true. */
  debug?: boolean;
};
export const StudioContext = createContext<StudioApi | null>(null);
export function useStudio(): StudioApi {
  const api = useContext(StudioContext);
  if (!api) throw new Error('Studio fields must render inside a ContentStudio.');
  return api;
}
export const safeId = (value: string) => value.replace(/[^\w-]/g, '_');
export const fieldId = (docId: string, path: Path) => `jongo-${safeId(docId)}-${path.join('.')}`;
export function useFieldId(path: Path) { return fieldId(useStudio().docId, path); }
/** Issues attached exactly to this path. */
export function useIssues(path: Path): Issue[] {
  const key = pathKey(path);
  return useStudio().issues.filter(issue => pathKey(issue.path) === key);
}
export function useIssuesWithin(path: Path): Issue[] {
  return useStudio().issues.filter(issue => isUnder(issue.path, path));
}
export const hasErrors = (issues: readonly Issue[]) => issues.some(issue => issue.severity === 'error');
export function describedBy(id: string, hasHint: boolean, issues: readonly Issue[]) {
  const ids = [hasHint ? `${id}-hint` : '', issues.length ? `${id}-issues` : ''].filter(Boolean).join(' ');
  return ids || undefined;
}
export function Issues({ id, issues }: { id: string; issues: readonly Issue[] }) {
  if (!issues.length) return null;
  return <ul id={`${id}-issues`} className="jongo-issues">{issues.map((issue, index) =>
    <li key={index} className={issue.severity === 'error' ? 'jongo-error' : 'jongo-warning'}>{issue.severity === 'error' ? '' : 'Note: '}{issue.message}</li>)}</ul>;
}
export function LabelText({ title, required, isPrivate }: { title: string; required?: boolean; isPrivate?: boolean }) {
  return <>{title}{required && <><span aria-hidden="true"> *</span><span className="jongo-sr"> (required)</span></>}{isPrivate && <span className="jongo-tag">Private</span>}</>;
}
export function Hint({ id, children }: { id: string; children?: ReactNode }) {
  return children ? <p id={`${id}-hint`} className="jongo-hint">{children}</p> : null;
}
