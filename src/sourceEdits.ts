/**
 * Map operation → minimal text edit of the Markdown source.
 *
 * Pure module (no `vscode` import). Every function returns either the edited
 * document text or an error message; the caller then applies only the changed
 * region (see `minimalReplace`), so lines the user did not touch on the map are
 * never rewritten.
 */
import {
  LIST_MARKER_RE,
  lineEndAfter,
  lineStart,
  type LinkSource,
  type SourceInfo,
  type SourceMap,
} from './markdownConverter';

// ─── Operations sent by the webview ──────────────────────────────────────────

/** A node reference: `path` (child indexes from the root) wins over `id`. */
export interface NodeRef {
  id: string;
  path?: number[];
}

export type Delta = { x: number; y: number };

export type MapOp =
  | { type: 'insert'; parent: NodeRef; index: number; topic: string }
  | { type: 'edit'; node: NodeRef; topic: string }
  | { type: 'remove'; ids: string[] }
  | { type: 'move'; ids: string[]; parent: NodeRef; index: number }
  | { type: 'createArrow'; from: NodeRef; to: NodeRef; label: string; bidirectional?: boolean }
  | { type: 'removeArrow'; id: string }
  | {
      type: 'updateArrow';
      id: string;
      label?: string;
      bidirectional?: boolean;
      delta1?: Delta;
      delta2?: Delta;
      resetDeltas?: boolean;
    }
  | { type: 'unsupported'; name: string };

/**
 * `edits` are non-overlapping, non-touching replacements on the ORIGINAL text,
 * sorted by offset — apply them as-is so untouched text stays untouched.
 */
export type EditResult = { text: string; edits: Edit[] } | { error: string };

export interface Edit {
  start: number;
  end: number;
  text: string;
}

// ─── Generic helpers ─────────────────────────────────────────────────────────

function applyEdits(text: string, edits: Edit[]): EditResult {
  // At equal start apply deletions before insertions (an insertion at the start
  // of a deleted range must survive).
  const desc = (list: Edit[]) => [...list].sort((a, b) => b.start - a.start || b.end - a.end);
  const sorted = desc(edits);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].end > sorted[i - 1].start) {
      return { error: 'Internal error: overlapping edits.' };
    }
  }
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  // Group touching edits into single replacements, each trimmed to the changed part.
  const asc = [...sorted].reverse();
  const groups: Edit[][] = [];
  for (const e of asc) {
    const g = groups[groups.length - 1];
    if (g && e.start <= Math.max(...g.map((x) => x.end))) g.push(e);
    else groups.push([e]);
  }
  const result: Edit[] = [];
  for (const g of groups) {
    const gs = Math.min(...g.map((x) => x.start));
    const ge = Math.max(...g.map((x) => x.end));
    let span = text.slice(gs, ge);
    for (const e of desc(g)) span = span.slice(0, e.start - gs) + e.text + span.slice(e.end - gs);
    const m = minimalReplace(text.slice(gs, ge), span);
    if (m) result.push({ start: gs + m.start, end: gs + m.end, text: m.text });
  }
  return { text: out, edits: result };
}

/** Smallest single replacement turning `a` into `b`. */
export function minimalReplace(a: string, b: string): Edit | undefined {
  if (a === b) return undefined;
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  return { start: s, end: ea, text: b.slice(s, eb) };
}

const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');
const isBlankLine = (text: string, ls: number) => {
  const le = text.indexOf('\n', ls);
  return text.slice(ls, le === -1 ? text.length : le).trim() === '';
};

/** Insert a block (heading / paragraph / list) at a line start, keeping blank lines around it. */
function blockInsert(text: string, offset: number, content: string): Edit {
  const nl = eolOf(text);
  let before = '';
  if (offset > 0 && text[offset - 1] !== '\n') before = nl + nl;
  else if (offset > 0) {
    const prevLs = lineStart(text, offset - 1);
    if (!isBlankLine(text, prevLs)) before = nl;
  }
  let after = '';
  if (offset < text.length && !isBlankLine(text, offset)) after = nl;
  return { start: offset, end: offset, text: before + content.split('\n').join(nl) + nl + after };
}

/** Insert a single line (list item) at a line start. */
function lineInsert(text: string, offset: number, line: string): Edit {
  const nl = eolOf(text);
  const before = offset > 0 && text[offset - 1] !== '\n' ? nl : '';
  return { start: offset, end: offset, text: before + line.split('\n').join(nl) + nl };
}

/** Delete whole lines [start, end) and one surrounding blank line if that leaves two in a row. */
function blockDelete(text: string, start: number, end: number): Edit {
  let e = end;
  const prevBlank = start === 0 || isBlankLine(text, lineStart(text, start - 1));
  if (prevBlank) {
    while (e < text.length && isBlankLine(text, e)) {
      const nextE = lineEndAfter(text, e + 1);
      if (nextE <= e) break;
      e = nextE;
    }
  }
  return { start, end: e, text: '' };
}

function resolve(sm: SourceMap, ref: NodeRef | undefined): SourceInfo | undefined {
  if (!ref) return undefined;
  if (ref.path) {
    let cur = sm.nodes.get('root');
    for (const i of ref.path) {
      cur = cur && sm.nodes.get(cur.children[i]);
    }
    if (cur) return cur;
  }
  return sm.nodes.get(ref.id);
}

const nextMarker = (marker: string, ordered?: boolean) => {
  if (!ordered) return marker;
  const m = marker.match(/^(\d+)([.)])(\s*)$/);
  return m ? `${Number(m[1]) + 1}${m[2]}${m[3] || ' '}` : marker;
};
const childIndentOf = (n: SourceInfo) => (n.indent ?? '') + ' '.repeat((n.marker ?? '- ').length);

/** Format topic text for a list item (continuation lines indented). */
const listLine = (indent: string, marker: string, topic: string) =>
  indent + marker + topic.split(/\r?\n/).join('\n' + indent + ' '.repeat(marker.length));

const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/g, ' ').trim();

// ─── Placement of a new / moved node ─────────────────────────────────────────

type BlockKind = 'heading' | 'listItem' | 'block';
interface Placement {
  offset: number;
  kind: BlockKind;
  depth?: number;
  indent?: string;
  marker?: string;
}

const kindOf = (n: SourceInfo): BlockKind | 'root' =>
  n.kind === 'listGroup' ? 'block' : n.kind === 'root' ? 'root' : n.kind;

function childHeadingDepth(sm: SourceMap, parent: SourceInfo, siblings: SourceInfo[]): number {
  const sib = siblings.find((s) => s.kind === 'heading');
  if (sib?.depth) return sib.depth;
  if (parent.kind === 'heading') return (parent.depth ?? 1) + 1;
  return sm.h1AsRoot ? 2 : 1;
}

/**
 * Where (and as what) to place a node at `index` among `siblings` of `parent`.
 * `hint` = kind of the node being moved (undefined for a new node).
 */
function place(
  sm: SourceMap,
  parent: SourceInfo,
  siblings: SourceInfo[],
  index: number,
  hint?: BlockKind
): Placement | string {
  const prev = siblings[index - 1];
  const next = siblings[index];

  const fromRef = (ref: SourceInfo, side: 'after' | 'before'): Placement | undefined => {
    const k = kindOf(ref);
    const offset = side === 'after' ? ref.end : ref.start;
    const want = hint ?? (k === 'root' ? 'block' : k);
    if (k === 'listItem') {
      if (want !== 'listItem') return undefined;
      return {
        offset,
        kind: 'listItem',
        indent: ref.indent,
        marker: side === 'after' ? nextMarker(ref.marker ?? '- ', ref.ordered) : ref.marker,
      };
    }
    if (want === 'listItem') return undefined;
    if (k === 'heading') {
      if (want === 'heading') return { offset, kind: 'heading', depth: ref.depth };
      // a paragraph after a heading would become part of that heading's section
      if (want === 'block' && side === 'before') return { offset, kind: 'block' };
      return undefined;
    }
    // ref is a block (paragraph, table, list group…)
    if (want === 'block') return { offset, kind: 'block' };
    if (want === 'heading' && side === 'after') {
      return { offset, kind: 'heading', depth: childHeadingDepth(sm, parent, siblings) };
    }
    return undefined;
  };

  if (prev || next) {
    const p = (prev && fromRef(prev, 'after')) || (next && fromRef(next, 'before'));
    if (p) return p;
    return 'This position mixes different kinds of Markdown elements (headings, paragraphs, list items).';
  }

  // No siblings: derive from the parent
  switch (parent.kind) {
    case 'heading': {
      const d = parent.depth ?? 1;
      if (hint === 'listItem' || (!hint && d >= 6)) {
        return { offset: parent.ownEnd, kind: 'listItem', indent: '', marker: '- ' };
      }
      if (hint === 'block') return { offset: parent.ownEnd, kind: 'block' };
      if (d >= 6) return 'Headings cannot be nested deeper than level 6.';
      return { offset: parent.ownEnd, kind: 'heading', depth: d + 1 };
    }
    case 'listItem':
      if (hint && hint !== 'listItem') return 'Only list items can be placed under a list item.';
      return { offset: parent.end, kind: 'listItem', indent: childIndentOf(parent), marker: '- ' };
    case 'block':
      if (hint && hint !== 'listItem') return 'Only list items can be placed under a paragraph.';
      return { offset: parent.end, kind: 'block', indent: '', marker: '- ' }; // a new list
    case 'root':
      if (hint === 'heading') return { offset: parent.end, kind: 'heading', depth: sm.h1AsRoot ? 2 : 1 };
      if (hint === 'block') return { offset: parent.end, kind: 'block' };
      return { offset: parent.end, kind: 'block', indent: '', marker: '- ' };
    default:
      return 'Cannot add a node here.';
  }
}

function renderNew(text: string, p: Placement, topic: string): Edit {
  if (p.kind === 'heading') return blockInsert(text, p.offset, '#'.repeat(p.depth ?? 2) + ' ' + oneLine(topic));
  if (p.kind === 'listItem') return lineInsert(text, p.offset, listLine(p.indent ?? '', p.marker ?? '- ', topic));
  if (p.marker) return blockInsert(text, p.offset, listLine('', p.marker, topic)); // new list after paragraph
  return blockInsert(text, p.offset, topic);
}

// ─── Operations ──────────────────────────────────────────────────────────────

function insertNode(sm: SourceMap, op: Extract<MapOp, { type: 'insert' }>): EditResult {
  const parent = resolve(sm, op.parent);
  if (!parent) return { error: 'Parent node not found (the map may be out of date).' };
  const siblings = parent.children.map((id) => sm.nodes.get(id)!);
  const p = place(sm, parent, siblings, Math.min(op.index, siblings.length));
  if (typeof p === 'string') return { error: p };
  return applyEdits(sm.text, [renderNew(sm.text, p, op.topic || 'New Node')]);
}

function editNode(sm: SourceMap, op: Extract<MapOp, { type: 'edit' }>): EditResult {
  const node = resolve(sm, op.node);
  if (!node) return { error: 'Node not found (the map may be out of date).' };
  if (node.contentStart === undefined || node.contentEnd === undefined) {
    return { error: 'This node has no editable text in the Markdown source.' };
  }
  let topic = op.topic;
  if (node.kind === 'heading') topic = oneLine(topic);
  else if (node.kind === 'listItem') {
    topic = topic.split(/\r?\n/).join('\n' + childIndentOf(node));
  }
  topic = topic.split(/\r?\n/).join(eolOf(sm.text));
  return applyEdits(sm.text, [{ start: node.contentStart, end: node.contentEnd, text: topic }]);
}

/** Ids of all nodes in the subtree (incl. the node). */
function subtree(sm: SourceMap, id: string, out = new Set<string>()): Set<string> {
  out.add(id);
  for (const c of sm.nodes.get(id)?.children ?? []) subtree(sm, c, out);
  return out;
}

function deletionFor(sm: SourceMap, n: SourceInfo): Edit {
  if (n.kind === 'listItem') return { start: n.start, end: n.end, text: '' };
  return blockDelete(sm.text, n.start, n.end);
}

/** Link declarations pointing at any of the given nodes. */
function linksTouching(sm: SourceMap, nodeIds: Set<string>): LinkSource[] {
  return sm.links.filter(
    (l) => nodeIds.has(sm.anchors.get(l.from) ?? '') || nodeIds.has(sm.anchors.get(l.to) ?? '')
  );
}

function removeNodes(sm: SourceMap, op: Extract<MapOp, { type: 'remove' }>): EditResult {
  const nodes = op.ids.map((id) => sm.nodes.get(id));
  if (nodes.some((n) => !n)) return { error: 'Node not found (the map may be out of date).' };
  if (nodes.some((n) => n!.kind === 'root')) return { error: 'The root node cannot be removed.' };
  // drop nodes nested inside other removed nodes
  const all = new Set<string>();
  for (const n of nodes) subtree(sm, n!.id, all);
  const top = nodes.filter((n) => !nodes.some((o) => o !== n && o!.start <= n!.start && n!.end <= o!.end));
  const edits = top.map((n) => deletionFor(sm, n!));
  // also remove links to deleted nodes (unless the declaration is deleted anyway)
  for (const l of linksTouching(sm, all)) {
    if (top.some((n) => n!.start <= l.removeStart && l.removeEnd <= n!.end)) continue;
    edits.push(linkDeletion(sm, l));
  }
  return applyEdits(sm.text, mergeEdits(edits));
}

/** Merge overlapping deletions (e.g. extended blank-line cleanup touching another range). */
function mergeEdits(edits: Edit[]): Edit[] {
  const dels = edits.filter((e) => e.text === '').sort((a, b) => a.start - b.start);
  const out: Edit[] = [];
  for (const d of dels) {
    const last = out[out.length - 1];
    if (last && d.start <= last.end) last.end = Math.max(last.end, d.end);
    else out.push({ ...d });
  }
  return [...out, ...edits.filter((e) => e.text !== '')];
}

/** Text of a node moved to placement `p`, re-leveled / re-indented. */
function transformForMove(sm: SourceMap, n: SourceInfo, p: Placement): string | { error: string } {
  const src = sm.text.slice(n.start, n.end);
  if (n.kind === 'heading') {
    const shift = (p.depth ?? n.depth!) - n.depth!;
    if (shift === 0) return src;
    const inner = sm.headings.filter((h) => h.start >= n.start && h.start < n.end);
    if (inner.some((h) => !h.atx)) return { error: 'Setext headings (underlined with ===) cannot be re-leveled.' };
    if (inner.some((h) => h.depth + shift > 6 || h.depth + shift < 1)) {
      return { error: 'Moving here would need headings deeper than level 6.' };
    }
    let out = src;
    for (const h of [...inner].sort((a, b) => b.start - a.start)) {
      const rel = h.start - n.start;
      const m = out.slice(rel).match(/^( {0,3})(#{1,6})/)!;
      out = out.slice(0, rel) + m[1] + '#'.repeat(h.depth + shift) + out.slice(rel + m[0].length);
    }
    return out;
  }
  if (n.kind === 'listItem') {
    const lines = src.split('\n');
    const m = lines[0].match(LIST_MARKER_RE);
    if (!m) return src;
    const oldCol = m[1].length + m[2].length + (m[3] || ' ').length;
    const newIndent = p.indent ?? '';
    const newMarker = p.marker ?? '- ';
    const shift = newIndent.length + newMarker.length - oldCol;
    lines[0] = newIndent + newMarker + lines[0].slice(m[0].length);
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === '') continue;
      const lead = l.match(/^[ ]*/)![0].length;
      lines[i] = ' '.repeat(Math.max(0, lead + shift)) + l.slice(lead);
    }
    return lines.join('\n');
  }
  return src;
}

function moveNodes(sm: SourceMap, op: Extract<MapOp, { type: 'move' }>): EditResult {
  const moved = op.ids.map((id) => sm.nodes.get(id));
  if (moved.some((n) => !n)) return { error: 'Node not found (the map may be out of date).' };
  const parent = resolve(sm, op.parent);
  if (!parent) return { error: 'Target node not found (the map may be out of date).' };
  const kinds = new Set(moved.map((n) => kindOf(n!)));
  if (kinds.size !== 1 || kinds.has('root')) return { error: 'Only nodes of the same kind can be moved together.' };
  const hint = Array.from(kinds)[0] as BlockKind;
  const movedIds = new Set(op.ids);
  const siblings = parent.children.filter((id) => !movedIds.has(id)).map((id) => sm.nodes.get(id)!);
  const p = place(sm, parent, siblings, Math.min(op.index, siblings.length), hint);
  if (typeof p === 'string') return { error: p };

  const parts: string[] = [];
  for (const n of moved) {
    const t = transformForMove(sm, n!, p);
    if (typeof t !== 'string') return t;
    parts.push(t);
  }
  const nl = eolOf(sm.text);
  let chunk: string;
  if (p.kind === 'listItem') {
    chunk = parts.map((t) => (t.endsWith('\n') ? t : t + nl)).join('');
  } else {
    chunk = parts.map((t) => t.replace(/(\r?\n)+$/, '')).join(nl + nl);
  }

  const edits = moved.map((n) => deletionFor(sm, n!));
  if (p.kind === 'listItem') {
    edits.push({ start: p.offset, end: p.offset, text: (p.offset > 0 && sm.text[p.offset - 1] !== '\n' ? nl : '') + chunk });
  } else {
    const e = blockInsert(sm.text, p.offset, chunk.replace(/\r\n/g, '\n'));
    edits.push(e);
  }
  // If the insertion point fell into a deleted range (blank-line cleanup), move it to the range start
  const ins = edits[edits.length - 1];
  for (const d of edits.slice(0, -1)) {
    if (ins.start > d.start && ins.start < d.end) ins.start = ins.end = d.start;
  }
  return applyEdits(sm.text, edits);
}

// ─── Arrows ──────────────────────────────────────────────────────────────────

const fmtDelta = (d?: Delta) => (d ? ` (${Math.round(d.x)},${Math.round(d.y)})` : '');

function renderLink(l: Pick<LinkSource, 'form' | 'from' | 'to' | 'label' | 'bidirectional' | 'delta1' | 'delta2'>): string {
  if (l.form === 'blockquote') {
    const arrow = l.bidirectional ? `<-${l.label}->` : `>-${l.label}->`;
    return `> [^${l.from}]${fmtDelta(l.delta1)} ${arrow}${fmtDelta(l.delta2)} [^${l.to}]`;
  }
  const label = l.label.replace(/--/g, '- -');
  const q = label.includes('"') ? `'${label.replace(/'/g, '’')}'` : `"${label}"`;
  const d = (k: string, v?: Delta) => (v ? ` ${k}="${Math.round(v.x)},${Math.round(v.y)}"` : '');
  return (
    `<!-- mindmap:link from=${l.from} to=${l.to}` +
    (l.label ? ` label=${q}` : '') +
    (l.bidirectional ? ' bidirectional' : '') +
    d('delta1', l.delta1) +
    d('delta2', l.delta2) +
    ' -->'
  );
}

function linkDeletion(sm: SourceMap, l: LinkSource): Edit {
  if (l.listItem || !l.block) return { start: l.removeStart, end: l.removeEnd, text: '' };
  return blockDelete(sm.text, l.removeStart, l.removeEnd);
}

const findLink = (sm: SourceMap, arrowId: string) => sm.links.find((l) => l.arrowId === arrowId);

function slugify(topic: string): string {
  const s = topic
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
  return s || 'node';
}

function createArrow(sm: SourceMap, op: Extract<MapOp, { type: 'createArrow' }>): EditResult {
  const from = resolve(sm, op.from);
  const to = resolve(sm, op.to);
  if (!from || !to) return { error: 'Node not found (the map may be out of date).' };
  const edits: Edit[] = [];
  const used = new Set(sm.anchors.keys());
  const anchorOf = (n: SourceInfo): string | { error: string } => {
    if (n.anchor) return n.anchor;
    if (n.contentEnd === undefined) {
      return { error: 'This node has no text in the Markdown source to attach an ID to.' };
    }
    const existing = edits.find((e) => e.start === n.contentEnd);
    if (existing) return existing.text.match(/[\p{L}\p{N}_-]+/u)![0];
    const topic = sm.text.slice(n.contentStart, n.contentEnd);
    let id = slugify(topic);
    for (let i = 2; used.has(id); i++) id = `${slugify(topic)}-${i}`;
    used.add(id);
    edits.push({ start: n.contentEnd, end: n.contentEnd, text: sm.anchorStyle === 'caret' ? ` [^${id}]` : ` {#${id}}` });
    return id;
  };
  const a = anchorOf(from);
  if (typeof a !== 'string') return a;
  const b = anchorOf(to);
  if (typeof b !== 'string') return b;

  const decl = { from: a, to: b, label: op.label ?? '', bidirectional: !!op.bidirectional };
  const last = sm.links[sm.links.length - 1];
  const root = sm.nodes.get('root')!;
  if (last?.listItem) {
    const line = last.listItem.indent + last.listItem.marker + renderLink({ ...decl, form: last.form });
    edits.push(lineInsert(sm.text, last.listItem.end, line));
  } else if (last?.block) {
    const line = renderLink({ ...decl, form: last.form });
    const at = lineEndAfter(sm.text, last.nodeEnd);
    edits.push(last.form === 'comment' ? lineInsert(sm.text, at, line) : blockInsert(sm.text, at, line));
  } else if (root.kind === 'listItem') {
    // one-big-list document: keep it a pure list (Mind Elixir plaintext style)
    edits.push(lineInsert(sm.text, root.end, childIndentOf(root) + '- ' + renderLink({ ...decl, form: 'blockquote' })));
  } else {
    edits.push(blockInsert(sm.text, sm.text.length, renderLink({ ...decl, form: 'comment' })));
  }
  return applyEdits(sm.text, edits);
}

function updateArrow(sm: SourceMap, op: Extract<MapOp, { type: 'updateArrow' }>): EditResult {
  const l = findLink(sm, op.id);
  if (!l) return { error: 'Link not found in the Markdown source (the map may be out of date).' };
  const next = {
    ...l,
    label: op.label ?? l.label,
    bidirectional: op.bidirectional ?? l.bidirectional,
    delta1: op.resetDeltas ? undefined : op.delta1 ?? l.delta1,
    delta2: op.resetDeltas ? undefined : op.delta2 ?? l.delta2,
  };
  return applyEdits(sm.text, [{ start: l.nodeStart, end: l.nodeEnd, text: renderLink(next) }]);
}

function removeArrow(sm: SourceMap, op: Extract<MapOp, { type: 'removeArrow' }>): EditResult {
  const l = findLink(sm, op.id);
  if (!l) return { error: 'Link not found in the Markdown source (the map may be out of date).' };
  return applyEdits(sm.text, [linkDeletion(sm, l)]);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const UNSUPPORTED: Record<string, string> = {
  insertParent: 'Inserting a parent node',
  copyNode: 'Copying nodes',
  copyNodes: 'Copying nodes',
  createSummary: 'Summaries',
  removeSummary: 'Summaries',
  finishEditSummary: 'Summaries',
  reshapeNode: 'Node styles',
};

export function applyMapOp(sm: SourceMap, op: MapOp): EditResult {
  switch (op.type) {
    case 'insert':
      return insertNode(sm, op);
    case 'edit':
      return editNode(sm, op);
    case 'remove':
      return removeNodes(sm, op);
    case 'move':
      return moveNodes(sm, op);
    case 'createArrow':
      return createArrow(sm, op);
    case 'updateArrow':
      return updateArrow(sm, op);
    case 'removeArrow':
      return removeArrow(sm, op);
    case 'unsupported':
      return { error: `${UNSUPPORTED[op.name] ?? `"${op.name}"`} is not supported for Markdown files yet.` };
  }
}
