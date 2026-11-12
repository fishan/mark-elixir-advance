/**
 * Markdown → Mind Elixir conversion.
 *
 * Pure module (no `vscode` import) so it can be unit-tested in plain Node.
 *
 * Besides the node tree it produces a *source map*: for every map node the
 * exact text range it came from. The map editor (see `sourceEdits.ts`) uses it
 * to turn map operations into minimal, targeted text edits.
 *
 * Node IDs — appended at the end of a heading, paragraph or list item:
 *     ## Build {#build}
 *     - Deploy [^deploy]
 *
 * Links — a blockquote in Mind Elixir plaintext syntax:
 *     > [^build] >-produces-> [^deploy]          (one-way)
 *     > [^build] (10,20) <-related-> (5,5) [^deploy]   (two-way, with curve)
 * or an HTML comment (invisible in rendered Markdown):
 *     <!-- mindmap:link from=build to=deploy label="produces" -->
 *     <!-- mindmap:link from=a to=b bidirectional delta1="10,20" delta2="5,5" -->
 *
 * Also understood (Mind Elixir plaintext compatibility), in list items:
 *     - Node {"color": "#e87a90"}       node style
 *     - }:2 Summary                      summary of the previous 2 siblings
 */
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import type { Heading, List, ListItem, Node as MdNode, Yaml } from 'mdast';
import type { Root } from 'hast';
import type { MindElixirData, NodeObj } from 'mind-elixir';

type Arrow = NonNullable<MindElixirData['arrows']>[number];
type Summary = NonNullable<MindElixirData['summaries']>[number];

// ─── Public types ────────────────────────────────────────────────────────────

export interface SourceRange {
  /** 1-based, as in mdast positions */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface ConvertIssue {
  message: string;
  range?: SourceRange;
}

export interface ConvertOptions {
  /** Fallback title (usually the file name) */
  title: string;
  /** Use a single top-level h1 (or a single top-level list item) as the root node */
  h1AsRoot: boolean;
}

export type SourceKind = 'root' | 'heading' | 'listItem' | 'block' | 'listGroup';

/** Where a map node lives in the document. All offsets are 0-based. */
export interface SourceInfo {
  id: string;
  kind: SourceKind;
  parentId: string | null;
  /** child node ids, in map order */
  children: string[];
  /** full range including descendants; `start` is a line start */
  start: number;
  end: number;
  /** end of the node's own line(s), before its children (line start after it) */
  ownEnd: number;
  /** editable text (excludes markers, `{#id}`, style JSON); absent = not editable */
  contentStart?: number;
  contentEnd?: number;
  anchor?: string;
  /** heading */
  depth?: number;
  atx?: boolean;
  /** list item: leading whitespace, marker incl. trailing space ("- ", "1. ") */
  indent?: string;
  marker?: string;
  ordered?: boolean;
}

export interface LinkSource {
  /** id of the produced arrow (absent when the link could not be resolved) */
  arrowId?: string;
  form: 'blockquote' | 'comment';
  /** range of the blockquote / comment itself */
  nodeStart: number;
  nodeEnd: number;
  /** what to delete to remove the declaration */
  removeStart: number;
  removeEnd: number;
  /** set when the declaration is a list item (`- > [^a] ... [^b]`) */
  listItem?: { indent: string; marker: string; end: number };
  /** block-level (own line) vs inline comment */
  block: boolean;
  from: string;
  to: string;
  label: string;
  bidirectional: boolean;
  delta1?: { x: number; y: number };
  delta2?: { x: number; y: number };
}

export interface SourceMap {
  text: string;
  nodes: Map<string, SourceInfo>;
  links: LinkSource[];
  /** markdown id → map node id */
  anchors: Map<string, string>;
  /** start offset + depth of every top-level heading */
  headings: { start: number; depth: number; atx: boolean }[];
  /** preferred syntax when the editor has to add an id */
  anchorStyle: 'brace' | 'caret';
  h1AsRoot: boolean;
}

export interface ConvertResult {
  data: MindElixirData;
  title: string;
  issues: ConvertIssue[];
  source: SourceMap;
}

// ─── Syntax ──────────────────────────────────────────────────────────────────

const ID = '[\\p{L}\\p{N}_-]+';
/** Trailing `{#id}` or `[^id]` */
export const ANCHOR_RE = new RegExp(`\\s*(?:\\{#(${ID})\\}|\\[\\^(${ID})\\])\\s*$`, 'u');
/** Trailing style JSON `{"color": "..."}` */
const STYLE_RE = /\s*(\{\s*"[^{}]*\})\s*$/;
const NUM = '(-?[\\d.]+)';
/** `[^a] (x,y)? >-label-> (x,y)? [^b]`, `<-label->` = bidirectional */
const ARROW_LINE_RE = new RegExp(
  `^\\[\\^(${ID})\\](?:\\s*\\(${NUM},\\s*${NUM}\\))?\\s*([<>])-(.*?)->(?:\\s*\\(${NUM},\\s*${NUM}\\))?\\s*\\[\\^(${ID})\\]$`,
  'u'
);
const LINK_COMMENT_RE = /^<!--\s*mindmap:link\b([\s\S]*?)-->\s*$/;
const ATTR_RE = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/g;
const SUMMARY_RE = /^\}(?::(\d+))?\s*(.*)$/s;
export const LIST_MARKER_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+|$)/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface TreeItem {
  children: TreeItem[];
  object: any;
  parent: TreeItem | null;
  type: string;
}

interface LinkDecl extends Omit<LinkSource, 'arrowId'> {
  range?: SourceRange;
}

interface Ctx {
  text: string;
  anchors: Map<string, { nodeId: string; range?: SourceRange }>;
  links: LinkDecl[];
  /** mdast nodes consumed as link declarations (not rendered as map nodes) */
  skip: Set<unknown>;
  issues: ConvertIssue[];
  nodes: Map<string, SourceInfo>;
  summaries: Summary[];
  headings: { start: number; depth: number; atx: boolean }[];
}

export function extractText(node: any): string {
  if (!node) return '';
  if (typeof node.value === 'string') return node.value;
  if (node.children) {
    return node.children.map(extractText).join('');
  }
  return '';
}

function rangeOf(node: MdNode | undefined): SourceRange | undefined {
  const p = node?.position;
  if (!p) return undefined;
  return {
    startLine: p.start.line,
    startColumn: p.start.column,
    endLine: p.end.line,
    endColumn: p.end.column,
  };
}

export const lineStart = (text: string, off: number) => text.lastIndexOf('\n', off - 1) + 1;
/** offset just after the newline ending the line that contains `off - 1` */
export const lineEndAfter = (text: string, off: number) => {
  const i = text.indexOf('\n', Math.max(off - 1, 0));
  return i === -1 ? text.length : i + 1;
};
const startOf = (n: any): number => n.position?.start?.offset ?? 0;
const endOf = (n: any): number => n.position?.end?.offset ?? 0;

const parseFrontmatter = (frontmatter: string) => {
  const data = frontmatter
    .split('\n')
    .map((line) => line.split(':').map((item) => item.trim()));
  return Object.fromEntries(data);
};

const toNum = (s?: string) => (s === undefined ? undefined : Number(s));
const delta = (x?: string, y?: string) => {
  const nx = toNum(x);
  const ny = toNum(y);
  return nx === undefined || ny === undefined || isNaN(nx) || isNaN(ny)
    ? undefined
    : { x: nx, y: ny };
};
const parseDeltaAttr = (v: string | true | undefined) => {
  if (typeof v !== 'string') return undefined;
  const [x, y] = v.split(',');
  return delta(x?.trim(), y?.trim());
};

interface Trailers {
  /** length of the text without trailers */
  length: number;
  anchor?: string;
  style?: Record<string, string>;
}

/** Strip trailing `{"style"}` and `{#id}` / `[^id]` (in any order) from a string. */
export function splitTrailers(s: string): Trailers {
  let rest = s;
  let anchor: string | undefined;
  let style: Record<string, string> | undefined;
  for (let i = 0; i < 2; i++) {
    const sm = !style && rest.match(STYLE_RE);
    if (sm) {
      try {
        style = JSON.parse(sm[1]);
        rest = rest.slice(0, sm.index);
        continue;
      } catch {
        /* not JSON */
      }
    }
    const am = !anchor && rest.match(ANCHOR_RE);
    if (am) {
      anchor = am[1] ?? am[2];
      rest = rest.slice(0, am.index);
      continue;
    }
    break;
  }
  rest = rest.replace(/\s+$/, '');
  return { length: rest.length, anchor, style };
}

/** Same as splitTrailers but mutates the mdast node so trailers are not rendered. */
function stripMdTrailers(node: any): void {
  if (!node || (node.type !== 'heading' && node.type !== 'paragraph')) return;
  const children: any[] = node.children || [];
  const last = children[children.length - 1];
  if (!last || last.type !== 'text') return;
  const t = splitTrailers(last.value as string);
  last.value = (last.value as string).slice(0, t.length);
  if (!last.value) children.pop();
}

/** Editable content range of a heading / paragraph (source offsets). */
function contentRange(text: string, node: any): { start: number; end: number; t: Trailers } | undefined {
  if (!node?.position) return undefined;
  let start = startOf(node);
  let end = endOf(node);
  if (node.type === 'heading') {
    const ls = lineStart(text, start);
    const lineEnd = text.indexOf('\n', ls);
    const line = text.slice(ls, lineEnd === -1 ? text.length : lineEnd).replace(/\r$/, '');
    const m = line.match(/^( {0,3}#{1,6}(?:[ \t]+|$))(.*?)(?:[ \t]+#+)?[ \t]*$/);
    if (m) {
      start = ls + m[1].length;
      end = start + m[2].length;
    } else {
      // setext: first line is the text
      const nl = text.indexOf('\n', start);
      end = nl === -1 ? text.length : nl;
      if (text[end - 1] === '\r') end--;
    }
  } else if (node.type !== 'paragraph') {
    return undefined;
  }
  const t = splitTrailers(text.slice(start, end));
  return { start, end: start + t.length, t };
}

/** Topic text for editing: source text with list continuation indentation removed. */
const topicOf = (text: string, start: number, end: number) =>
  text
    .slice(start, end)
    .split(/\r?\n/)
    .map((l, i) => (i === 0 ? l : l.trimStart()))
    .join('\n');

/** Find every link declaration in the document and mark it as consumed. */
function collectLinks(ast: any, ctx: Ctx): void {
  const text = ctx.text;
  visit(ast, (node: any, index, parent: any) => {
    const inListItem = parent?.type === 'listItem' && parent.children[0] === node && parent.children.length === 1;
    const listInfo = (): LinkDecl['listItem'] => {
      const ls = lineStart(text, startOf(parent));
      const m = text.slice(ls).match(LIST_MARKER_RE);
      return {
        indent: m?.[1] ?? '',
        marker: m ? m[2] + (m[3] || ' ') : '- ',
        end: lineEndAfter(text, endOf(parent)),
      };
    };
    const removal = (block: boolean) => {
      if (inListItem) {
        return { removeStart: lineStart(text, startOf(parent)), removeEnd: lineEndAfter(text, endOf(parent)) };
      }
      if (block) {
        return { removeStart: lineStart(text, startOf(node)), removeEnd: lineEndAfter(text, endOf(node)) };
      }
      return { removeStart: startOf(node), removeEnd: endOf(node) };
    };

    if (node.type === 'blockquote') {
      const m = extractText(node).trim().match(ARROW_LINE_RE);
      if (!m) return;
      ctx.skip.add(node);
      ctx.links.push({
        form: 'blockquote',
        block: true,
        nodeStart: startOf(node),
        nodeEnd: endOf(node),
        ...removal(true),
        listItem: inListItem ? listInfo() : undefined,
        from: m[1],
        delta1: delta(m[2], m[3]),
        bidirectional: m[4] === '<',
        label: m[5].trim(),
        delta2: delta(m[6], m[7]),
        to: m[8],
        range: rangeOf(node),
      });
      return 'skip';
    }
    if (node.type === 'html') {
      const m = (node.value as string).trim().match(LINK_COMMENT_RE);
      if (!m) return;
      ctx.skip.add(node);
      const attrs: Record<string, string | true> = {};
      for (const a of Array.from(m[1].matchAll(ATTR_RE))) {
        attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? true;
      }
      const from = attrs.from;
      const to = attrs.to;
      if (typeof from !== 'string' || typeof to !== 'string') {
        ctx.issues.push({
          message: 'Mind map: link comment needs both from=<id> and to=<id>.',
          range: rangeOf(node),
        });
        return;
      }
      const bi = attrs.bidirectional;
      const block = parent?.type !== 'paragraph';
      ctx.links.push({
        form: 'comment',
        block,
        nodeStart: startOf(node),
        nodeEnd: endOf(node),
        ...removal(block),
        listItem: inListItem ? listInfo() : undefined,
        from,
        to,
        label: typeof attrs.label === 'string' ? attrs.label : '',
        bidirectional: bi === true || bi === 'true' || bi === 'yes' || bi === '1',
        delta1: parseDeltaAttr(attrs.delta1),
        delta2: parseDeltaAttr(attrs.delta2),
        range: rangeOf(node),
      });
    }
    return undefined;
  });
}

function resolveLinks(ctx: Ctx): { arrows: Arrow[]; links: LinkSource[] } {
  const arrows: Arrow[] = [];
  const links: LinkSource[] = [];
  ctx.links.forEach((link, i) => {
    const { range, ...rest } = link;
    const missing = [link.from, link.to].filter((id) => !ctx.anchors.has(id));
    if (missing.length) {
      ctx.issues.push({
        message: `Mind map: unknown node ID ${missing
          .map((id) => `"${id}"`)
          .join(' and ')}. Add {#${missing[0]}} or [^${missing[0]}] to a heading or list item.`,
        range,
      });
      links.push(rest);
      return;
    }
    const arrow: Arrow = {
      id: `arrow-${i}-${link.from}-${link.to}`,
      label: link.label,
      from: ctx.anchors.get(link.from)!.nodeId,
      to: ctx.anchors.get(link.to)!.nodeId,
    };
    if (link.bidirectional) arrow.bidirectional = true;
    if (link.delta1) arrow.delta1 = link.delta1;
    if (link.delta2) arrow.delta2 = link.delta2;
    arrows.push(arrow);
    links.push({ ...rest, arrowId: arrow.id });
  });
  return { arrows, links };
}

function registerAnchor(ctx: Ctx, id: string, nodeObj: NodeObj, source: MdNode): boolean {
  const range = rangeOf(source);
  const existing = ctx.anchors.get(id);
  if (existing) {
    ctx.issues.push({
      message:
        `Mind map: duplicate node ID "${id}"` +
        (existing.range ? ` (first defined on line ${existing.range.startLine})` : '') +
        '. This occurrence is ignored.',
      range,
    });
    return false;
  }
  ctx.anchors.set(id, { nodeId: nodeObj.id, range });
  return true;
}

// ─── HTML rendering ──────────────────────────────────────────────────────────

const addWidthAndHeight: Plugin<[], Root> = () =>
  function transformer(tree) {
    visit(tree, 'element', function visitor(node) {
      if (node.tagName === 'img') {
        node.properties.width = 200;
        node.properties.height = 100;
      }
    });
  };

const htmlProcessor = unified()
  .use(remarkRehype)
  .use(rehypeHighlight)
  .use(addWidthAndHeight)
  .use(rehypeStringify);

function toHtml(node: any): string | undefined {
  try {
    const hastNode = htmlProcessor.runSync(node);
    const htmlStr = htmlProcessor.stringify(hastNode);
    return typeof htmlStr === 'string' ? htmlStr : undefined;
  } catch (e) {
    console.error('HTML conversion error', e);
    return undefined;
  }
}

// ─── Node building ───────────────────────────────────────────────────────────

const pathId = (path: number[]) => 'n-' + path.join('-');

/**
 * Fill a NodeObj from a heading / paragraph (editable text node) or from any
 * other block (rendered as static HTML). Registers its anchor & style.
 */
function fillNode(
  ctx: Ctx,
  node: NodeObj,
  info: SourceInfo,
  md: any,
  anchorSource: MdNode
): void {
  const cr = contentRange(ctx.text, md);
  if (cr) {
    info.contentStart = cr.start;
    info.contentEnd = cr.end;
    stripMdTrailers(md);
    const topic = topicOf(ctx.text, cr.start, cr.end);
    node.topic = topic;
    node.metadata = { src: topic, html: toHtml(md) };
    if (cr.t.style) node.style = cr.t.style as NodeObj['style'];
    if (cr.t.anchor) {
      const anchored = `ref-${cr.t.anchor}`;
      if (!ctx.anchors.has(cr.t.anchor) && !ctx.nodes.has(anchored)) {
        node.id = anchored;
        info.id = anchored;
      }
      if (registerAnchor(ctx, cr.t.anchor, node, anchorSource)) {
        info.anchor = cr.t.anchor;
        (node.metadata as any).refId = cr.t.anchor;
      }
    }
  } else if (md.type === 'html') {
    node.topic = '';
    node.dangerouslySetInnerHTML = md.value;
  } else {
    node.topic = '';
    const html = toHtml(md);
    if (html !== undefined) node.dangerouslySetInnerHTML = html;
  }
}

function processList(ctx: Ctx, list: List, parent: SourceInfo, path: number[]): NodeObj[] {
  const text = ctx.text;
  const result: NodeObj[] = [];
  for (const listItem of list.children as ListItem[]) {
    const contentNode: any = listItem.children[0];
    if (ctx.skip.has(contentNode)) continue;

    // Summary: `- }:2 label` / `- } label`
    if (contentNode?.type === 'paragraph') {
      const sm = extractText(contentNode).match(SUMMARY_RE);
      if (sm && result.length > 0) {
        const n = sm[1] ? Math.min(Number(sm[1]), result.length) : result.length;
        ctx.summaries.push({
          id: `summary-${ctx.summaries.length}`,
          label: sm[2].trim(),
          parent: parent.id,
          start: result.length - n,
          end: result.length - 1,
        } as Summary);
        continue;
      }
    }

    const childPath = [...path, result.length];
    const ls = lineStart(text, startOf(listItem));
    const mm = text.slice(ls).match(LIST_MARKER_RE);
    const node: NodeObj = { topic: '', id: pathId(childPath), children: [] };
    const info: SourceInfo = {
      id: node.id,
      kind: 'listItem',
      parentId: parent.id,
      children: [],
      start: ls,
      end: lineEndAfter(text, endOf(listItem)),
      ownEnd: contentNode ? lineEndAfter(text, endOf(contentNode)) : lineEndAfter(text, startOf(listItem) + 1),
      indent: mm?.[1] ?? '',
      marker: mm ? mm[2] + (mm[3] || ' ') : '- ',
      ordered: !!list.ordered,
    };
    if (contentNode) fillNode(ctx, node, info, contentNode, listItem);
    ctx.nodes.set(info.id, info);

    const nested = listItem.children.slice(1).find((c) => c.type === 'list') as List | undefined;
    if (nested) node.children = processList(ctx, nested, info, childPath);
    info.children = (node.children ?? []).map((c) => c.id);
    parent.children.push(info.id);
    result.push(node);
  }
  return result;
}

/** End offset of a top-level heading's section (start of the next heading of depth <= d). */
function sectionEnd(ctx: Ctx, heading: Heading): number {
  const s = lineStart(ctx.text, startOf(heading));
  const next = ctx.headings.find((h) => h.start > s && h.depth <= heading.depth);
  return next ? next.start : ctx.text.length;
}

function treeToMindElixir(ctx: Ctx, items: TreeItem[], parent: SourceInfo, path: number[]): NodeObj[] {
  const text = ctx.text;
  if (items.length === 1 && items[0].type === 'list') {
    return processList(ctx, items[0].object as List, parent, path);
  }
  const nodes: NodeObj[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const md = item.object;
    const childPath = [...path, nodes.length];
    const node = { id: pathId(childPath), topic: '', children: [] } as NodeObj;
    const start = lineStart(text, startOf(md));
    const info: SourceInfo = {
      id: node.id,
      kind: item.type === 'heading' ? 'heading' : item.type === 'list' ? 'listGroup' : 'block',
      parentId: parent.id,
      children: [],
      start,
      end: lineEndAfter(text, endOf(md)),
      ownEnd: lineEndAfter(text, endOf(md)),
    };
    nodes.push(node);

    if (item.type === 'list') {
      node.topic = 'List';
      ctx.nodes.set(info.id, info);
      node.children = processList(ctx, md as List, info, childPath);
    } else {
      if (item.type === 'heading') {
        info.depth = (md as Heading).depth;
        info.atx = /^ {0,3}#/.test(text.slice(start));
        info.end = sectionEnd(ctx, md as Heading);
      }
      fillNode(ctx, node, info, md, md);
      ctx.nodes.set(info.id, info);

      // Merge a following list into the preceding content node
      const next = items[i + 1];
      if (next && next.type === 'list' && item.type !== 'heading') {
        node.children = processList(ctx, next.object as List, info, childPath);
        info.end = lineEndAfter(text, endOf(next.object));
        items.splice(i + 1, 1);
      } else {
        node.children = treeToMindElixir(ctx, item.children, info, childPath);
      }
    }
    info.children = (node.children ?? []).map((c) => c.id);
    parent.children.push(info.id);
  }
  return nodes;
}

const markdownAstToTree = (ast: any, ctx: Ctx): TreeItem => {
  const children = ast.children || ast;
  const treeItem: TreeItem = { type: 'root', children: [], object: ast, parent: null };

  let current = treeItem;
  for (const child of children) {
    if (!child) continue;
    if (child.type === 'yaml' || child.type === 'thematicBreak' || ctx.skip.has(child)) continue;
    if (child.type === 'heading') {
      const heading = child as Heading;
      const data: TreeItem = { type: heading.type, object: heading, parent: current, children: [] };
      while (heading.depth <= (current.object.depth || 0) && current.parent) {
        current = current.parent;
      }
      current.children.push(data);
      current = data;
    } else {
      current.children.push({ type: child.type, object: child, parent: current, children: [] });
    }
  }
  return treeItem;
};

// ─── Entry point ─────────────────────────────────────────────────────────────

export function markdownToMindElixirData(text: string, options: ConvertOptions): ConvertResult {
  const ctx: Ctx = {
    text,
    anchors: new Map(),
    links: [],
    skip: new Set(),
    issues: [],
    nodes: new Map(),
    summaries: [],
    headings: [],
  };
  let title = options.title;

  const ast = unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm).parse(text);

  const frontmatter = ast.children.find((child) => child.type === 'yaml');
  if (frontmatter) {
    const obj = parseFrontmatter((frontmatter as Yaml).value);
    if (obj.title) title = obj.title;
  }

  for (const c of ast.children) {
    if (c.type === 'heading') {
      const s = lineStart(text, startOf(c));
      ctx.headings.push({ start: s, depth: c.depth, atx: /^ {0,3}#/.test(text.slice(s)) });
    }
  }

  collectLinks(ast, ctx);
  const tree = markdownAstToTree(ast, ctx);

  const rootNode: NodeObj = { topic: title, id: 'root', children: [] };
  let rootInfo: SourceInfo = {
    id: 'root',
    kind: 'root',
    parentId: null,
    children: [],
    start: 0,
    end: text.length,
    ownEnd: 0,
  };

  const h1 = options.h1AsRoot
    ? tree.children.find((c) => c.type === 'heading' && (c.object as Heading).depth === 1)
    : undefined;
  const singleList =
    options.h1AsRoot && !h1 && tree.children.length === 1 && tree.children[0].type === 'list'
      ? (tree.children[0].object as List)
      : undefined;
  const singleItems = singleList?.children.filter((li) => !ctx.skip.has(li.children[0])) ?? [];

  if (h1) {
    const md = h1.object as Heading;
    rootInfo = {
      ...rootInfo,
      kind: 'heading',
      depth: 1,
      atx: /^ {0,3}#/.test(text.slice(lineStart(text, startOf(md)))),
      start: lineStart(text, startOf(md)),
      end: sectionEnd(ctx, md),
      ownEnd: lineEndAfter(text, endOf(md)),
    };
    fillNode(ctx, rootNode, rootInfo, md, md);
    rootNode.id = rootInfo.id = 'root';
    if (rootInfo.anchor) ctx.anchors.set(rootInfo.anchor, { nodeId: 'root', range: rangeOf(md) });
    ctx.nodes.set('root', rootInfo);
    rootNode.children = treeToMindElixir(ctx, h1.children, rootInfo, []);
  } else if (singleList && singleItems.length === 1) {
    // A document that is one big list (Mind Elixir plaintext style): its single
    // top-level item is the root.
    const li = singleItems[0];
    const fake = { ...singleList, children: [li] } as List;
    const holder: SourceInfo = { ...rootInfo, id: '__holder__', children: [] };
    const [only] = processList(ctx, fake, holder, []);
    const info = ctx.nodes.get(only.id)!;
    ctx.nodes.delete(only.id);
    for (const s of ctx.summaries) if (s.parent === only.id) s.parent = 'root';
    for (const a of Array.from(ctx.anchors.values())) if (a.nodeId === only.id) a.nodeId = 'root';
    info.id = 'root';
    info.parentId = null;
    for (const cid of info.children) ctx.nodes.get(cid)!.parentId = 'root';
    Object.assign(rootNode, only, { id: 'root' });
    rootInfo = info;
    ctx.nodes.set('root', rootInfo);
  } else {
    ctx.nodes.set('root', rootInfo);
    rootNode.children = treeToMindElixir(ctx, tree.children, rootInfo, []);
  }

  const { arrows, links } = resolveLinks(ctx);
  const anchors = new Map<string, string>();
  for (const [k, v] of Array.from(ctx.anchors.entries())) anchors.set(k, v.nodeId);

  const usesCaret = /\[\^[\p{L}\p{N}_-]+\]\s*(\{[^}]*\})?\s*$/mu.test(text) || rootInfo.kind === 'listItem';

  return {
    data: { nodeData: rootNode, arrows, summaries: ctx.summaries },
    title,
    issues: ctx.issues,
    source: {
      text,
      nodes: ctx.nodes,
      links,
      anchors,
      headings: ctx.headings,
      anchorStyle: usesCaret ? 'caret' : 'brace',
      h1AsRoot: options.h1AsRoot,
    },
  };
}
