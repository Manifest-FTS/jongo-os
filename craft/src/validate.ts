/** Pure document validation. Local drafts may be saved with issues; only `error` issues block the
 * publish-ready indicator. Warnings flag preserved content this studio cannot check. */
import { IMAGE_ASSET_TYPE, type Descriptor, type FieldDefinition, type TypeDefinition } from './schema.js';
import { isObject, memberFor, resolveReference, type ReferenceIndex } from './content-ops.js';
import { DECORATORS, LIST_ITEMS, MAX_LIST_LEVEL, STYLES, hasPortableTextContent, isEditableTextBlock, isPlainSpan, type JsonObject } from './portable-text.js';

export type Path = readonly (string | number)[];
export type Issue = { path: Path; code: string; message: string; severity: 'error' | 'warning' };
export const pathKey = (path: Path) => path.join('.');
export const isUnder = (path: Path, prefix: Path) => prefix.length <= path.length && prefix.every((part, i) => part === path[i]);
export function publishState(issues: readonly Issue[]) {
  const errors = issues.filter(issue => issue.severity === 'error').length;
  return { ready: errors === 0, errors, warnings: issues.length - errors };
}
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isSafeUrl(value: string): boolean {
  if (!value || /[\s\u0000-\u001f]/.test(value)) return false;
  if (value.startsWith('#') || (value.startsWith('/') && !value.startsWith('//'))) return true;
  try { return ['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(value).protocol); } catch { return false; }
}
export function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number), date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
export const isValidDatetime = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));

export function validateDocument(schema: TypeDefinition, doc: JsonObject, index: ReferenceIndex): Issue[] {
  const issues: Issue[] = [];
  const add = (path: Path, code: string, message: string, severity: Issue['severity'] = 'error') => { issues.push({ path, code, message, severity }); };
  if (typeof doc._id !== 'string' || !doc._id) add(['_id'], 'envelope', 'Document needs a non-empty _id.');
  if (doc._type !== schema.name) add(['_type'], 'envelope', `Document _type must be "${schema.name}".`);

  function fields(definitions: readonly FieldDefinition[], value: JsonObject, path: Path, extra: readonly string[]) {
    for (const key of Object.keys(value)) if (!extra.includes(key) && !definitions.some(field => field.name === key)) add([...path, key], 'unregistered', 'Unregistered field is preserved but not validated.', 'warning');
    for (const field of definitions) check(field, value[field.name], [...path, field.name]);
  }
  function check(d: Descriptor, value: unknown, path: Path, member = false) {
    const here = (code: string, message: string, severity: Issue['severity'] = 'error') => add(path, code, message, severity);
    const empty = value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (d.type === 'slug' && isObject(value) && !value.current)
      || (d.type === 'reference' && isObject(value) && !value._ref) || (d.type === 'image' && isObject(value) && !isObject(value.asset));
    if (empty && d.type !== 'object' && d.type !== 'array' && d.type !== 'portableText') {
      if (member || d.required) here('required', d.type === 'reference' || d.type === 'image' ? 'Choose a value.' : member ? 'Enter a value or remove this item.' : 'This field is required.');
      else if (d.publishRequired) here('publish_required', 'Required before publishing.');
      return;
    }
    switch (d.type) {
      case 'string': case 'text': case 'url': case 'date': case 'datetime': {
        if (typeof value !== 'string') { here('type', 'Enter text.'); break; }
        if (d.minLength !== undefined && value.length < d.minLength) here('length', `Use at least ${d.minLength} characters.`);
        else if (d.maxLength !== undefined && value.length > d.maxLength) here('length', `Use at most ${d.maxLength} characters.`);
        else if (d.type === 'url' && !isSafeUrl(value)) here('url', 'Enter an http(s), mailto, tel, relative or #fragment URL.');
        else if (d.type === 'date' && !isValidDate(value)) here('date', 'Enter a valid date (YYYY-MM-DD).');
        else if (d.type === 'datetime' && !isValidDatetime(value)) here('datetime', 'Enter a valid UTC date and time.');
        break;
      }
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) here('type', 'Enter a number.');
        else if (d.integer && !Number.isInteger(value)) here('number', 'Enter a whole number.');
        else if (d.min !== undefined && value < d.min) here('number', `Enter a number of at least ${d.min}.`);
        else if (d.max !== undefined && value > d.max) here('number', `Enter a number of at most ${d.max}.`);
        break;
      case 'boolean': if (typeof value !== 'boolean') here('type', 'Choose yes or no.'); break;
      case 'enum': if (typeof value !== 'string' || !d.options.includes(value)) here('enum', 'Choose a registered option.'); break;
      case 'slug': {
        const current = isObject(value) && value._type === 'slug' ? value.current : undefined;
        if (typeof current !== 'string') here('type', 'Slug must be {_type:"slug", current}.');
        else if (current.length > (d.maxLength ?? 96)) here('slug', `Use at most ${d.maxLength ?? 96} characters.`);
        else if (!SLUG_PATTERN.test(current)) here('slug', 'Use lowercase letters, numbers and single hyphens.');
        break;
      }
      case 'reference': reference(value, path, d.to, d.weak); break;
      case 'image': {
        if (!isObject(value)) { here('type', 'Expected an image object.'); break; }
        if (value._type !== undefined && value._type !== 'image') here('type', 'Image _type must be "image".');
        reference(value.asset, [...path, 'asset'], [IMAGE_ASSET_TYPE], false);
        for (const name of ['alt', 'caption']) if (value[name] !== undefined && typeof value[name] !== 'string') add([...path, name], 'type', 'Enter text.');
        if (d.altRequired && isObject(value.asset) && !(typeof value.alt === 'string' && value.alt.trim())) add([...path, 'alt'], 'alt', 'Add alternative text for this image.');
        break;
      }
      case 'object': {
        if (value === undefined || value === null) { if (d.required) here('required', 'This field is required.'); break; }
        if (!isObject(value)) { here('type', 'Expected an object.'); break; }
        if (d.objectType && value._type !== d.objectType) here('object_type', `Object _type must be "${d.objectType}".`);
        fields(d.fields, value, path, ['_type', '_key']);
        break;
      }
      case 'array': {
        const list = value === undefined || value === null ? [] : value;
        if (!Array.isArray(list)) { here('type', 'Expected a list.'); break; }
        if (list.length === 0 && (d.required || d.publishRequired) && !(d.minItems && d.minItems > 0)) { if (d.required) here('required', 'Add at least one item.'); else here('publish_required', 'Required before publishing.'); }
        if (list.length < (d.minItems ?? 0)) here('array_bounds', `Add at least ${d.minItems} item${d.minItems === 1 ? '' : 's'}.`);
        else if (list.length > (d.maxItems ?? 2000)) here('array_bounds', `Use at most ${d.maxItems} item${d.maxItems === 1 ? '' : 's'}.`);
        const keys = new Set<string>();
        list.forEach((item, i) => {
          const itemPath = [...path, i], found = memberFor(d, item);
          if (!found) { add(itemPath, 'unsupported_member', 'Unregistered list item is preserved but not validated.', 'warning'); return; }
          if (found.type === 'object' || found.type === 'reference' || found.type === 'image') {
            const key = isObject(item) ? item._key : undefined;
            if (typeof key !== 'string' || !key) add(itemPath, 'key', 'Item needs a stable _key.');
            else if (keys.has(key)) add(itemPath, 'duplicate_key', 'Item _key must be unique within the list.');
            else keys.add(key);
          }
          check(found, item, itemPath, true);
        });
        break;
      }
      case 'portableText': portableText(value, path, d.required === true, d.publishRequired === true); break;
    }
  }
  function reference(value: unknown, path: Path, to: readonly string[], weak?: boolean) {
    if (!isObject(value) || value._type !== 'reference') { add(path, 'type', 'Expected a reference.'); return; }
    const found = resolveReference(index, value, to);
    if (found.status === 'draftPrefix') add(path, 'reference', 'Reference the logical ID without the drafts. prefix.');
    else if (found.status === 'missing') add(path, 'reference', 'The referenced document was not found.', weak ? 'warning' : 'error');
    else if (found.status === 'type') add(path, 'reference_type', `Reference must point to: ${to.join(', ')}.`);
  }
  function portableText(value: unknown, path: Path, required: boolean, publishRequired: boolean) {
    if (value === undefined || value === null) { if (required) add(path, 'required', 'This field is required.'); else if (publishRequired) add(path, 'publish_required', 'Required before publishing.'); return; }
    if (!Array.isArray(value)) { add(path, 'type', 'Expected Portable Text blocks.'); return; }
    if (!hasPortableTextContent(value)) { if (required) add(path, 'required', 'Add some content.'); else if (publishRequired) add(path, 'publish_required', 'Required before publishing.'); }
    const seen = new Set<string>();
    value.forEach((node, i) => {
      const p = [...path, i];
      if (!isObject(node)) { add(p, 'node', 'Expected a block object.'); return; }
      if (typeof node._key !== 'string' || !node._key) add(p, 'key', 'Block needs a stable _key.');
      else if (seen.has(node._key)) add(p, 'duplicate_key', 'Block _key must be unique.');
      else seen.add(node._key);
      if (node._type !== 'block') { add(p, 'unsupported_block', `Preserved "${String(node._type)}" block is not validated.`, 'warning'); return; }
      if (node.style !== undefined && !(STYLES as readonly unknown[]).includes(node.style)) add([...p, 'style'], 'style', `Style "${String(node.style)}" is preserved but not editable here.`, 'warning');
      if (node.listItem !== undefined && !(LIST_ITEMS as readonly unknown[]).includes(node.listItem)) add([...p, 'listItem'], 'list', `List type "${String(node.listItem)}" is preserved but not editable here.`, 'warning');
      if (node.level !== undefined && (!Number.isInteger(node.level) || (node.level as number) < 1 || (node.level as number) > MAX_LIST_LEVEL || node.listItem === undefined)) add([...p, 'level'], 'level', `List level must be 1 to ${MAX_LIST_LEVEL} and belong to a list.`);
      const markKeys = new Set<string>();
      if (node.markDefs !== undefined && !Array.isArray(node.markDefs)) add([...p, 'markDefs'], 'type', 'markDefs must be a list.');
      else (node.markDefs as unknown[] | undefined)?.forEach((def, j) => {
        const dp = [...p, 'markDefs', j];
        if (!isObject(def) || typeof def._key !== 'string' || !def._key) { add(dp, 'key', 'Annotation needs a _key.'); return; }
        markKeys.add(def._key);
        if (def._type === 'link') { if (typeof def.href !== 'string' || !isSafeUrl(def.href)) add([...dp, 'href'], 'url', 'Enter an http(s), mailto, tel, relative or #fragment URL.'); }
        else add(dp, 'unsupported_annotation', `Annotation "${String(def._type)}" is preserved but not editable here.`, 'warning');
      });
      if (!Array.isArray(node.children)) { add([...p, 'children'], 'type', 'Block children must be a list.'); return; }
      if (!isEditableTextBlock(node)) add(p, 'preserved_content', 'Contains inline content this editor cannot edit. It is preserved verbatim.', 'warning');
      node.children.forEach((child, j) => {
        if (!isPlainSpan(child)) return;
        for (const mark of child.marks ?? []) if (!(DECORATORS as readonly string[]).includes(mark) && !markKeys.has(mark)) add([...p, 'children', j], 'unknown_mark', `Mark "${mark}" is preserved but has no definition here.`, 'warning');
      });
    });
  }
  fields(schema.fields, doc, [], ['_id', '_type', '_rev', '_createdAt', '_updatedAt']);
  return issues;
}
