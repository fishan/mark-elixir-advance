import 'mind-elixir/style.css';
import 'katex/dist/katex.min.css';

import MindElixir from 'mind-elixir';
import type {
  MindElixirData,
  MindElixirInstance,
  NodeObj,
  ArrowSvg,
  Options,
} from 'mind-elixir';
import * as mindElixirI18n from 'mind-elixir/i18n';
import { downloadImage } from '@mind-elixir/export-mindmap';
import katex from 'katex';
import 'katex/contrib/mhchem';


interface InjectedData {
  /** Full map: nodes plus arrows (links between nodes) */
  data: MindElixirData;
  locale?: string;
}

interface Window {
  injectedData: InjectedData;
  acquireVsCodeApi(): {
    postMessage: (message: any) => void;
  };
}
declare const window: Window & typeof globalThis;

const vsc = window.acquireVsCodeApi && window.acquireVsCodeApi();

// ─── KaTeX Math Rendering ────────────────────────────────────────────────────
function renderMath(text: string): string {
  let parsedText = text;
  // Handle display math ($$...$$)
  parsedText = parsedText.replace(/\$\$([^$]+)\$\$/g, (_, math: string) => {
    return katex.renderToString(math.trim(), {
      displayMode: true,
      output: 'html',
      throwOnError: false,
    });
  });
  // Handle inline math ($...$)
  parsedText = parsedText.replace(/\$([^$]+)\$/g, (_, math: string) => {
    return katex.renderToString(math.trim(), {
      displayMode: false,
      output: 'html',
      throwOnError: false,
    });
  });
  return parsedText;
}

// ─── Locale Resolution ───────────────────────────────────────────────────────
function resolveLocale(locale?: string): mindElixirI18n.LangPack {
  if (!locale) return mindElixirI18n.en;
  if (locale === 'zh_CN') return mindElixirI18n.zh_CN;
  if (locale === 'zh_TW') return mindElixirI18n.zh_TW;
  const key = locale as keyof typeof mindElixirI18n;
  if (key in mindElixirI18n) {
    return (mindElixirI18n as any)[key] as mindElixirI18n.LangPack;
  }
  return mindElixirI18n.en;
}

// ─── Expand / Collapse Helpers ────────────────────────────────────────────────
const setExpandedAll = (data: NodeObj, expanded: boolean) => {
  data.expanded = expanded;
  if (data.children) {
    for (let i = 0; i < data.children.length; i++) {
      setExpandedAll(data.children[i], expanded);
    }
  }
};

// ─── Init ─────────────────────────────────────────────────────────────────────
const injected: InjectedData = window.injectedData;
const langPack = resolveLocale(injected.locale);
const isRu = injected.locale === 'ru';
const tr = (en: string, ru: string) => (isRu ? ru : en);

const data: MindElixirData = injected.data;
let mind: MindElixirInstance | null = null;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Node topics hold the Markdown *source* (that is what the user edits); the
 * extension also sends the rendered HTML in `metadata.html`. Show the HTML
 * while the topic is unchanged, plain text right after an edit (until the
 * file round-trip brings fresh HTML).
 */
const renderTopic = (text: string, obj?: any): string => {
  const meta = obj?.metadata;
  if (meta && typeof meta.html === 'string' && meta.src === text) return renderMath(meta.html);
  return renderMath(escapeHtml(text ?? ''));
};

const options: Options = {
  el: '#map',
  direction: MindElixir.RIGHT,
  draggable: true,
  editable: true,
  contextMenu: { locale: langPack },
  toolBar: true,
  keypress: true,
  // Undo/redo is done in the text editor (the file is the source of truth)
  allowUndo: false,
  theme: MindElixir.DARK_THEME,
  markdown: renderTopic,
};

mind = new MindElixir(options);
mind.init(data);
const me = mind as MindElixirInstance & Record<string, any>;

// ─── Map operations → extension (targeted edits of the Markdown file) ───────
const send = (op: Record<string, unknown>) => vsc?.postMessage({ command: 'op', op });

const walk = (n: NodeObj, fn: (n: NodeObj) => void) => {
  fn(n);
  n.children?.forEach((c) => walk(c, fn));
};
const nodeById = (id: string): NodeObj | undefined => {
  let found: NodeObj | undefined;
  if (mind) walk(mind.nodeData, (n) => (n.id === id ? (found = n) : undefined));
  return found;
};
/** Child indexes from the root (valid in the current map state). */
const pathOf = (node: NodeObj): number[] | undefined => {
  const path: number[] = [];
  let cur: any = node;
  while (cur.parent) {
    const i = cur.parent.children?.indexOf(cur) ?? -1;
    if (i < 0) return undefined;
    path.unshift(i);
    cur = cur.parent;
  }
  return path;
};
const ref = (n: NodeObj) => ({ id: n.id, path: pathOf(n) });

mind.bus.addListener('operation', (op: any) => {
  switch (op.name) {
    case 'addChild':
    case 'insertSibling': {
      const n: any = op.obj;
      const p = n.parent;
      if (!p) return;
      send({ type: 'insert', parent: ref(p), index: p.children.indexOf(n), topic: n.topic });
      break;
    }
    case 'finishEdit':
      send({ type: 'edit', node: ref(op.obj), topic: op.obj.topic });
      break;
    case 'removeNodes':
      send({ type: 'remove', ids: op.objs.map((o: NodeObj) => o.id) });
      break;
    case 'moveUpNode':
    case 'moveDownNode':
    case 'moveNodeIn':
    case 'moveNodeBefore':
    case 'moveNodeAfter': {
      const objs: any[] = op.objs ?? [op.obj];
      const p = objs[0]?.parent;
      if (!p) return;
      const moved = new Set(objs.map((o) => o.id));
      const kids: NodeObj[] = p.children ?? [];
      const first = kids.findIndex((k) => moved.has(k.id));
      const index = kids.slice(0, first).filter((k) => !moved.has(k.id)).length;
      send({ type: 'move', ids: objs.map((o) => o.id), parent: { id: p.id }, index });
      break;
    }
    case 'createArrow': {
      const a = op.obj;
      const from = nodeById(a.from);
      const to = nodeById(a.to);
      if (!from || !to) return;
      send({ type: 'createArrow', from: ref(from), to: ref(to), label: a.label ?? '', bidirectional: !!a.bidirectional });
      break;
    }
    case 'removeArrow':
      send({ type: 'removeArrow', id: op.obj.id });
      break;
    case 'finishEditArrowLabel':
      send({ type: 'updateArrow', id: op.obj.id, label: op.obj.label });
      break;
    case 'insertParent':
    case 'copyNode':
    case 'copyNodes':
    case 'createSummary':
    case 'removeSummary':
    case 'finishEditSummary':
    case 'reshapeNode':
      send({ type: 'unsupported', name: op.name });
      break;
    default:
      // beginEdit, expand / collapse … — view state only, nothing to write
      break;
  }
});

// Curve changed with the control-point handles: write it once the user stops
const deltaTimers = new Map<string, ReturnType<typeof setTimeout>>();
mind.bus.addListener('updateArrowDelta', (arrow: any) => {
  clearTimeout(deltaTimers.get(arrow.id));
  deltaTimers.set(
    arrow.id,
    setTimeout(() => {
      deltaTimers.delete(arrow.id);
      send({ type: 'updateArrow', id: arrow.id, delta1: arrow.delta1, delta2: arrow.delta2 });
    }, 500)
  );
});

// Ctrl+Z / Ctrl+Y on the map → undo / redo in the Markdown editor
window.addEventListener(
  'keydown',
  (e) => {
    if ((e.target as HTMLElement)?.id === 'input-box' || !(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    const command = k === 'z' && !e.shiftKey ? 'undo' : k === 'y' || (k === 'z' && e.shiftKey) ? 'redo' : '';
    if (!command) return;
    e.preventDefault();
    e.stopPropagation();
    vsc?.postMessage({ command });
  },
  true
);

// ─── Arrow context menu & drag-to-bend ───────────────────────────────────────
type ArrowG = ArrowSvg & { arrowObj: any };
const mapEl = document.getElementById('map')!;

const style = document.createElement('style');
style.textContent = `
.me-arrow-menu{position:fixed;z-index:1000;min-width:190px;padding:4px 0;
  background:var(--vscode-menu-background,#252526);color:var(--vscode-menu-foreground,#ccc);
  border:1px solid var(--vscode-menu-border,#454545);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.45);
  font:13px var(--vscode-font-family,sans-serif);user-select:none}
.me-arrow-menu .item{padding:6px 14px;cursor:pointer;white-space:nowrap}
.me-arrow-menu .item:hover{background:var(--vscode-menu-selectionBackground,#04395e);color:var(--vscode-menu-selectionForeground,#fff)}
.me-arrow-menu .danger{color:var(--vscode-errorForeground,#f48771)}
.me-arrow-menu .sep{height:1px;margin:4px 0;background:var(--vscode-menu-separatorBackground,#454545)}
#map g[data-linkid] path{cursor:grab}
#map.me-arrow-dragging, #map.me-arrow-dragging *{cursor:grabbing !important}
`;
document.head.appendChild(style);

const menu = document.createElement('div');
menu.className = 'me-arrow-menu';
menu.hidden = true;
document.body.appendChild(menu);
const hideMenu = () => (menu.hidden = true);

const findArrowG = (id: string) =>
  me.container.querySelector(`g[data-linkid="${CSS.escape(id)}"]`) as ArrowG | null;
const arrowFromTarget = (target: EventTarget | null): ArrowG | null => {
  if (!(target instanceof Element)) return null;
  const g = target.closest('g[data-linkid]') as ArrowG | null;
  if (g) return g;
  const label = target.closest('.svg-label[data-type="arrow"]') as HTMLElement | null;
  const svgId = label?.dataset.svgId;
  return svgId ? (document.getElementById(svgId) as unknown as ArrowG) : null;
};
const selectArrow = (g: ArrowG) => {
  me.clearSelection();
  me.selectArrow(g);
};

function showArrowMenu(g: ArrowG, x: number, y: number) {
  const a = g.arrowObj;
  menu.innerHTML = '';
  const item = (label: string, fn: () => void, cls = '') => {
    const el = document.createElement('div');
    el.className = 'item ' + cls;
    el.textContent = label;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      hideMenu();
      fn();
    });
    menu.appendChild(el);
  };
  const sep = () => menu.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }));

  item(tr('Edit label', 'Изменить подпись'), () => me.editArrowLabel(findArrowG(a.id) ?? g));
  item(
    a.bidirectional ? tr('Make one-way', 'Сделать односторонней') : tr('Make two-way', 'Сделать двусторонней'),
    () => {
      a.bidirectional = !a.bidirectional;
      me.renderArrow();
      send({ type: 'updateArrow', id: a.id, bidirectional: a.bidirectional });
    }
  );
  item(tr('Reset curve', 'Сбросить изгиб'), () => {
    delete a.delta1;
    delete a.delta2;
    me.renderArrow();
    send({ type: 'updateArrow', id: a.id, resetDeltas: true });
  });
  sep();
  item(tr('Delete link', 'Удалить связь'), () => me.removeArrow(findArrowG(a.id) ?? g), 'danger');

  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
}

// Capture phase on #map: runs before Mind Elixir's own handlers on the container
mapEl.addEventListener(
  'contextmenu',
  (e) => {
    const g = arrowFromTarget(e.target);
    if (!g) return;
    e.preventDefault();
    e.stopPropagation();
    selectArrow(g);
    showArrowMenu(g, e.clientX, e.clientY);
  },
  true
);

let drag: null | {
  a: any;
  id: string;
  x: number;
  y: number;
  d1: { x: number; y: number };
  d2: { x: number; y: number };
  moved: boolean;
} = null;

// Drag the arrow line itself: both control points move together → the curve bends.
// (Labels keep Mind Elixir's behaviour: click selects, double-click edits.)
mapEl.addEventListener(
  'pointerdown',
  (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) hideMenu();
    const g = e.target instanceof Element ? (e.target.closest('g[data-linkid]') as ArrowG | null) : null;
    if (!g) return;
    e.stopPropagation(); // no panning / box selection
    if (e.button !== 0) return;
    e.preventDefault();
    selectArrow(g);
    const a = g.arrowObj;
    if (!a.delta1 || !a.delta2) return;
    drag = { a, id: a.id, x: e.clientX, y: e.clientY, d1: { ...a.delta1 }, d2: { ...a.delta2 }, moved: false };
  },
  true
);
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const scale = me.scaleVal || 1;
  const dx = (e.clientX - drag.x) / scale;
  const dy = (e.clientY - drag.y) / scale;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
  if (!drag.moved) {
    drag.moved = true;
    me.unselectArrow();
    mapEl.classList.add('me-arrow-dragging');
  }
  drag.a.delta1 = { x: Math.round(drag.d1.x + dx), y: Math.round(drag.d1.y + dy) };
  drag.a.delta2 = { x: Math.round(drag.d2.x + dx), y: Math.round(drag.d2.y + dy) };
  me.renderArrow();
});
window.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  mapEl.classList.remove('me-arrow-dragging');
  if (!d.moved) return;
  const g = findArrowG(d.id);
  if (g) selectArrow(g);
  send({ type: 'updateArrow', id: d.id, delta1: d.a.delta1, delta2: d.a.delta2 });
});
window.addEventListener('keydown', (e) => e.key === 'Escape' && hideMenu());
window.addEventListener('blur', hideMenu);
mapEl.addEventListener('wheel', hideMenu, { passive: true });

// ─── Toolbar Buttons ──────────────────────────────────────────────────────────
const toolBar = document.querySelector('.mind-elixir-toolbar.rb');

// Expand All button
const expandAllBtn = document.createElement('span');
expandAllBtn.title = 'Expand All';
expandAllBtn.innerHTML = '<svg t="1739342378874" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1617" width="1em" height="1em" fill="currentColor" style="vertical-align: middle;"><path d="M768 342.016H341.984v426.016H255.968V342.016q0-36 24.992-60.992t60.992-24.992h426.016v86.016z m-169.984-256H170.016q-34.016 0-59.008 24.992t-24.992 59.008v428h84V170.016h428V86.016zM938.016 512v342.016q0 34.016-24.992 59.008t-59.008 24.992H512q-36 0-60.992-24.992t-24.992-59.008V512q0-36 24.992-60.992T512 426.016h342.016q34.016 0 59.008 24.992T938.016 512z m-84 128h-128v-128H640v128h-128v86.016h128v128h86.016v-128h128V640z" p-id="1618"></path></svg>';

// Collapse All button
const collapseAllBtn = document.createElement('span');
collapseAllBtn.title = 'Collapse All';
collapseAllBtn.innerHTML = '<svg t="1739342411256" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="2596" width="1em" height="1em" fill="currentColor" style="vertical-align: middle;"><path d="M597.333333 170.666667H170.666667v426.666666H85.333333V170.666667a85.333333 85.333333 0 0 1 85.333334-85.333334h426.666666v85.333334m170.666667 85.333333H341.333333a85.333333 85.333333 0 0 0-85.333333 85.333333v426.666667h85.333333V341.333333h426.666667V256m170.666667 256v341.333333a85.333333 85.333333 0 0 1-85.333334 85.333334h-341.333333a85.333333 85.333333 0 0 1-85.333333-85.333334v-341.333333a85.333333 85.333333 0 0 1 85.333333-85.333333h341.333333a85.333333 85.333333 0 0 1 85.333334 85.333333m-85.333334 128h-341.333333v85.333333h341.333333v-85.333333z" p-id="2597"></path></svg>';

expandAllBtn.addEventListener('click', () => {
  if (mind) {
    setExpandedAll(mind.nodeData, true);
    mind.refresh();
    mind.bus.fire('operation', { name: 'expandAll' as any, obj: mind.nodeData });
  }
});
collapseAllBtn.addEventListener('click', () => {
  if (mind) {
    setExpandedAll(mind.nodeData, false);
    mind.refresh();
    mind.bus.fire('operation', { name: 'collapseAll' as any, obj: mind.nodeData });
  }
});

toolBar?.appendChild(expandAllBtn);
toolBar?.appendChild(collapseAllBtn);

// Export as PNG button (replaces old HTML-only download)
const exportPngBtn = document.createElement('span');
exportPngBtn.title = 'Export as PNG';
exportPngBtn.innerHTML = '<svg t="1739342547294" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="3585" width="1em" height="1em" fill="currentColor" style="vertical-align: middle;"><path d="M731.428571 341.333333h73.142858a73.142857 73.142857 0 0 1 73.142857 73.142857v414.476191a73.142857 73.142857 0 0 1-73.142857 73.142857H219.428571a73.142857 73.142857 0 0 1-73.142857-73.142857V414.47619a73.142857 73.142857 0 0 1 73.142857-73.142857h73.142858v73.142857H219.428571v414.476191h585.142858V414.47619h-73.142858v-73.142857z m-176.90819-242.590476l0.048762 397.092572 84.577524-84.601905 51.687619 51.712-172.373334 172.397714-172.397714-172.373333 51.712-51.736381 83.626667 83.626666V98.742857h73.142857z" p-id="3586"></path></svg>';
exportPngBtn.addEventListener('click', () => {
  if (mind) {
    void downloadImage(mind, 'png');
  }
});
toolBar?.appendChild(exportPngBtn);

// HTML download button (legacy, only shown when vsc API is available)
if (vsc) {
  const downloadHtmlBtn = document.createElement('span');
  downloadHtmlBtn.title = 'Download HTML';
  // Use a code/html icon or a download icon instead of the confusing plus icon
  downloadHtmlBtn.innerHTML = '<svg class="icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" style="vertical-align: middle;"><path d="M512 0C229.232 0 0 229.232 0 512s229.232 512 512 512 512-229.232 512-512S794.768 0 512 0zm0 822.422L219.422 529.844h164.578V292.578h256v237.266h164.578L512 822.422z"/></svg>';
  downloadHtmlBtn.addEventListener('click', () => {
    vsc.postMessage({ command: 'download' });
  });
  toolBar?.appendChild(downloadHtmlBtn);
}

// ─── Updates from the extension (the file changed) ───────────────────────────
// Deferred while the user is typing in a node / dragging, so the edit box is
// not destroyed under their cursor. Collapsed branches stay collapsed.
let pending: MindElixirData | null = null;
const isBusy = () => !!document.getElementById('input-box') || !!drag || deltaTimers.size > 0;
const applyPending = () => {
  if (!pending || !mind) return;
  if (isBusy()) {
    setTimeout(applyPending, 200);
    return;
  }
  const next = pending;
  pending = null;
  const collapsed = new Set<string>();
  walk(mind.nodeData, (n) => (n.expanded === false ? collapsed.add(n.id) : undefined));
  walk(next.nodeData, (n) => (collapsed.has(n.id) ? (n.expanded = false) : undefined));
  mind.refresh(next);
};

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.command) {
    case 'updateData':
      pending = message.data as MindElixirData;
      applyPending();
      break;
  }
});
