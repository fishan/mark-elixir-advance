# Change Log

All notable changes to the "mind-elixir" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [1.2.0] - 2026-11-12
- Links (arrows) between nodes: node IDs via `{#id}` / `[^id]`, links via `> [^a] >-label-> [^b]` or `<!-- mindmap:link from=a to=b -->`; one-way / two-way, labels and saved curves.
- The map is always editable: add, rename, delete and move nodes, create links. Each map change edits only the affected lines of the Markdown file (heading levels and list indentation are adjusted on move).
- Link context menu (edit label, one-way / two-way, reset curve, delete) and dragging a link's line to bend it.
- Unknown / duplicate link IDs are reported in the Problems panel.
- Tables, code blocks and images are full map nodes: ID via `<!-- mindmap:node id=… -->`, children as an indented list below them, links and summaries.
- List items are direct children of their section (no synthetic "List" node); only a paragraph takes a following list as its children.
- "Add parent" and summaries («Описание») work on the map and are written to the file (`<!-- mindmap:summary from=a to=b label="…" -->` or `- }:N label`).
- `Ctrl+Z` / `Ctrl+Y` on the map undo / redo in the text editor.
- Fix: a Markdown file starting with a list was treated as Mind Elixir plaintext and the whole file was rewritten on any map change (tables and other content were lost). The separate plaintext mode is removed; plaintext files are parsed as Markdown.
- Fix: arrows in plaintext files were dropped when the map was opened.
- Escape map data embedded into the webview `<script>`.

## [1.1.0] - 2026-05-22
- Implement markdown-it plugin to render MindElixir mindmaps directly inside VSCode standard markdown previews (e.g. using `mindmap` code blocks).
- Integrate KaTeX `mhchem` extension for high-quality chemical formula rendering.
- Bundle required stylesheet and font assets in esbuild configuration for seamless offline math/chemistry formula rendering.

## [1.0.1] - 2026-05-22
- Fix secret leak issue by updating `.vscodeignore` to exclude private token files.

## [1.0.0] - 2026-05-22
- Real-time bidirectional sync between editor and webview with debouncing.
- Upgrade mind-elixir dependency to 5.11.3.
- Remove pointer-events override from map-container elements.
- Rewrite AST to mindmap transformation logic.