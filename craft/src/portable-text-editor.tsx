"use client";
import { useState, type ReactNode } from 'react';
import {
  LIST_ITEMS, MAX_LIST_LEVEL, STYLES, applyLink, blockText, createTextBlock, insertNode, isEditableTextBlock, listLinks, moveNode,
  rangeHasMark, removeLink, removeNode, segments, setBlockList, setBlockStyle, setBlockText, toggleDecorator, updateLinkHref,
  type JsonObject, type Selection, type TextBlock
} from './portable-text.js';
import { isUnder, type Path } from './validate.js';
import { useStudio, useIssuesWithin } from './studio-context.js';

const STYLE_LABELS: Record<string, string> = { normal: 'Normal', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', blockquote: 'Quote' };
const LIST_LABELS: Record<string, string> = { bullet: 'Bulleted', number: 'Numbered' };
const DECORATOR_LABELS = [['strong', 'Bold'], ['em', 'Italic'], ['code', 'Code']] as const;

function Preview({ block }: { block: TextBlock }) {
  const parts = segments(block);
  if (!parts.length) return <p className="jongo-pt-preview jongo-hint"><span className="jongo-sr">Formatted preview: </span>Empty block</p>;
  return <p className={`jongo-pt-preview jongo-pt-${block.style ?? 'normal'}`}><span className="jongo-sr">Formatted preview: </span>{parts.map(part => {
    let node: ReactNode = part.text;
    if (part.decorators.includes('code')) node = <code>{node}</code>;
    if (part.decorators.includes('em')) node = <em>{node}</em>;
    if (part.decorators.includes('strong')) node = <strong>{node}</strong>;
    if (part.href !== undefined) node = <u className="jongo-pt-link" title={part.href}>{node}</u>;
    return <span key={part.key} data-preserved-marks={part.unknown.length ? part.unknown.join(' ') : undefined}>{node}</span>;
  })}</p>;
}

/** Bounded block editor: one textarea per text block, formatting applied to the textarea selection. */
export function PortableTextEditor({ id, label, path, value, onChange }: { id: string; label: string; path: Path; value: unknown; onChange: (value: unknown) => void }) {
  const api = useStudio();
  const [selection, setSelection] = useState<(Selection & { index: number }) | null>(null);
  const issues = useIssuesWithin(path);
  if (value !== undefined && value !== null && !Array.isArray(value)) {
    return <pre className="jongo-pt-json">{JSON.stringify(value, null, 2).slice(0, 2000)}</pre>;
  }
  const nodes: JsonObject[] = Array.isArray(value) ? value as JsonObject[] : [];
  const set = (next: unknown[]) => onChange(next.length ? next : undefined);
  const blockId = (index: number) => `${id}.${index}`;
  const update = (index: number, block: unknown) => set(nodes.map((node, i) => i === index ? block as JsonObject : node));
  const read = (index: number): Selection => {
    const area = document.getElementById(`${blockId(index)}.text`) as HTMLTextAreaElement | null;
    return area ? { start: area.selectionStart, end: area.selectionEnd } : selection ?? { start: 0, end: 0 };
  };
  const decorate = (index: number, block: TextBlock, decorator: string, name: string) => {
    const range = read(index);
    if (range.start === range.end) { api.announce('Select some text in the block first.'); return; }
    const pressed = rangeHasMark(block, range, decorator);
    update(index, toggleDecorator(block, range, decorator, api.makeKey));
    api.announce(`${name} ${pressed ? 'removed from' : 'applied to'} the selected text.`);
    api.focus(`${blockId(index)}.text`, [range.start, range.end]);
  };
  const addLink = (index: number, block: TextBlock) => {
    const range = read(index);
    if (range.start === range.end) { api.announce('Select some text in the block first.'); return; }
    const next = applyLink(block, range, 'https://', api.makeKey);
    update(index, next);
    const created = listLinks(next).at(-1);
    api.announce('Link added. Enter its web address.');
    if (created) api.focus(`${blockId(index)}.link.${created.key}`, [0, 8]);
  };
  const move = (index: number, to: number) => {
    set(moveNode(nodes, index, to));
    api.announce(`Block moved ${to > index ? 'down' : 'up'} to position ${to + 1} of ${nodes.length}.`);
    api.focus(`${blockId(to)}.${to > index ? (to === nodes.length - 1 ? 'up' : 'down') : (to === 0 ? 'down' : 'up')}`);
  };
  const add = (at: number) => {
    set(insertNode(nodes, at, createTextBlock(api.makeKey)));
    api.announce(`Paragraph added at position ${at + 1}.`);
    api.focus(`${blockId(at)}.text`);
  };
  const remove = (index: number, preserved: boolean) => {
    set(removeNode(nodes, index));
    api.announce(`${preserved ? 'Preserved block' : 'Block'} ${index + 1} removed. ${nodes.length - 1} remaining.`);
    api.focus(nodes.length > 1 ? `${blockId(Math.min(index, nodes.length - 2))}` : `${id}.add`);
  };
  return <div className="jongo-pt" id={id}>
    {nodes.length === 0 && <p className="jongo-hint">No content yet.</p>}
    <ol className="jongo-pt-blocks" aria-label={`${label} blocks`}>{nodes.map((node, index) => {
      const key = typeof node._key === 'string' ? node._key : String(index), n = index + 1;
      const actions = <div className="jongo-actions" role="group" aria-label={`Actions for block ${n}`}>
        <button type="button" id={`${blockId(index)}.up`} disabled={index === 0} aria-label={`Move block ${n} up`} onClick={() => move(index, index - 1)}>↑</button>
        <button type="button" id={`${blockId(index)}.down`} disabled={index === nodes.length - 1} aria-label={`Move block ${n} down`} onClick={() => move(index, index + 1)}>↓</button>
        {isEditableTextBlock(node) && <button type="button" onClick={() => add(index + 1)}>Add block below</button>}
        <button type="button" aria-label={`Remove block ${n}`} onClick={() => remove(index, !isEditableTextBlock(node))}>Remove</button>
      </div>;
      const within = issues.filter(issue => isUnder(issue.path, [...path, index]) && !(issue.path.includes('markDefs') && issue.path.at(-1) === 'href'));
      const blockIssues = within.length ? <ul className="jongo-issues" id={`${blockId(index)}-issues`}>{within.map((issue, i) => <li key={i} className={issue.severity === 'error' ? 'jongo-error' : 'jongo-warning'}>{issue.severity === 'error' ? '' : 'Note: '}{issue.message}</li>)}</ul> : null;
      if (!isEditableTextBlock(node)) {
        const json = JSON.stringify(node, null, 2);
        return <li key={key}><fieldset id={blockId(index)} tabIndex={-1} className="jongo-pt-block jongo-pt-preserved" aria-describedby={within.length ? `${blockId(index)}-issues` : undefined}>
          <legend>Block {n} · Preserved block ({typeof node._type === 'string' ? node._type : 'unknown'})</legend>
          <p className="jongo-hint">This content is kept exactly as supplied and cannot be edited here.</p>
          <details><summary>View preserved JSON</summary><pre>{json.length > 4000 ? `${json.slice(0, 4000)}\n… (truncated for display; the full block is kept)` : json}</pre></details>
          {blockIssues}{actions}</fieldset></li>;
      }
      const block = node, text = blockText(block), style = block.style ?? 'normal', list = block.listItem;
      const pressed = (decorator: string) => selection?.index === index && rangeHasMark(block, selection, decorator);
      const links = listLinks(block);
      const textId = `${blockId(index)}.text`;
      return <li key={key}><fieldset id={blockId(index)} tabIndex={-1} className="jongo-pt-block" aria-describedby={within.length ? `${blockId(index)}-issues` : undefined}>
        <legend>Block {n} · {STYLE_LABELS[style] ?? style}{list ? ` · ${LIST_LABELS[list] ?? list} list, level ${block.level ?? 1}` : ''}</legend>
        <div className="jongo-pt-tools" role="group" aria-label={`Formatting for block ${n}`}>
          <label className="jongo-inline">Style<select aria-label={`Style for block ${n}`} value={style} onChange={event => { update(index, setBlockStyle(block, event.target.value)); api.announce(`Block ${n} style set to ${STYLE_LABELS[event.target.value] ?? event.target.value}.`); }}>
            {STYLES.map(name => <option key={name} value={name}>{STYLE_LABELS[name]}</option>)}
            {!(STYLES as readonly string[]).includes(style) && <option value={style}>{style} (preserved)</option>}</select></label>
          <label className="jongo-inline">List<select aria-label={`List type for block ${n}`} value={list ?? ''} onChange={event => { update(index, setBlockList(block, event.target.value || null)); api.announce(event.target.value ? `Block ${n} is now a ${LIST_LABELS[event.target.value] ?? event.target.value} list item.` : `Block ${n} is no longer a list item.`); }}>
            <option value="">Not a list</option>{LIST_ITEMS.map(name => <option key={name} value={name}>{LIST_LABELS[name]}</option>)}
            {list && !(LIST_ITEMS as readonly string[]).includes(list) && <option value={list}>{list} (preserved)</option>}</select></label>
          {list && <label className="jongo-inline">Level<select aria-label={`List level for block ${n}`} value={block.level ?? 1} onChange={event => update(index, setBlockList(block, list, Number(event.target.value)))}>
            {Array.from({ length: MAX_LIST_LEVEL }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>}
        </div>
        <div className="jongo-pt-tools" role="group" aria-label={`Text marks for block ${n}`}>
          {DECORATOR_LABELS.map(([decorator, name]) => <button type="button" key={decorator} aria-pressed={pressed(decorator)} aria-label={`${name} for selected text in block ${n}`} onClick={() => decorate(index, block, decorator, name)}>{name}</button>)}
          <button type="button" aria-label={`Add link to selected text in block ${n}`} onClick={() => addLink(index, block)}>Link</button>
        </div>
        <textarea id={textId} aria-label={`Text of block ${n}`} aria-describedby={within.length ? `${blockId(index)}-issues` : undefined} rows={Math.min(10, Math.max(2, text.split('\n').length + Math.floor(text.length / 70)))} value={text}
          onChange={event => update(index, setBlockText(block, event.target.value, event.target.selectionStart ?? undefined, api.makeKey))}
          onSelect={event => setSelection({ index, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} />
        <Preview block={block} />
        {links.length > 0 && <ul className="jongo-pt-links" aria-label={`Links in block ${n}`}>{links.map(link => {
          const defIndex = (block.markDefs ?? []).findIndex(def => def._key === link.key);
          const linkIssues = issues.filter(issue => issue.path.at(-1) === 'href' && isUnder(issue.path, [...path, index, 'markDefs', defIndex]));
          const linkId = `${blockId(index)}.link.${link.key}`;
          return <li key={link.key}><label>Web address for “{link.text}”<input id={linkId} type="text" inputMode="url" autoComplete="off" value={link.href}
            aria-invalid={linkIssues.length ? true : undefined} aria-describedby={linkIssues.length ? `${linkId}-issues` : undefined}
            onChange={event => update(index, updateLinkHref(block, link.key, event.target.value))} /></label>
            {linkIssues.length > 0 && <ul className="jongo-issues" id={`${linkId}-issues`}>{linkIssues.map((issue, i) => <li key={i} className="jongo-error">{issue.message}</li>)}</ul>}
            <button type="button" aria-label={`Remove link from “${link.text}”`} onClick={() => { update(index, removeLink(block, link.key)); api.announce('Link removed.'); api.focus(textId); }}>Remove link</button></li>;
        })}</ul>}
        {blockIssues}{actions}</fieldset></li>;
    })}</ol>
    <div className="jongo-actions"><button type="button" id={`${id}.add`} onClick={() => add(nodes.length)}>Add paragraph</button></div>
  </div>;
}
