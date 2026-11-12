# Markdown Mindmap

View and edit a Markdown file as a mind map — with links (arrows) between nodes.
Powered by [Mind Elixir](https://github.com/SSShooter/mind-elixir-core).

## Features

- **Markdown → mind map**: headings, paragraphs, lists, tables, code, images and math (KaTeX, incl. `mhchem`).
- **Edit on the map**: add, rename, delete and move nodes. The Markdown file stays the source of truth —
  only the lines you changed on the map are rewritten, everything else is left untouched.
- **Links between nodes**: arrows with labels, one-way or two-way, with an adjustable curve.
- **Live sync**: edits in the text editor update the map immediately.
- **Problems panel**: unknown or duplicate link IDs are reported as warnings at the exact line.
- **Mind maps in the Markdown preview** via ` ```mindelixir ` code blocks.
- Export the map as PNG or HTML.

## How To Use

Open any Markdown file and click the button in the editor title bar
(or run the command **Show Markdown as Mind Map** — `mind-elixir.markdown`).

![Click The Button](https://github.com/SSShooter/mark-elixir/blob/master/images/how-to-use-1.png?raw=true)

![View Markdown As A Mindmap](https://github.com/SSShooter/mark-elixir/blob/master/images/how-to-use-2.png?raw=true)

### How the document becomes a map

| Markdown | Map |
| --- | --- |
| `# Title` (the only h1) | root node (see `h1AsRoot`) |
| `##`, `###`, … headings | nested branches |
| paragraph, table, code block | a node under its heading |
| list items | one node per item, direct children of the section (nested lists → deeper levels) |
| a list right after a paragraph (e.g. `Features:`) | children of that paragraph |
| several lines of text without `- ` | one node (Markdown joins them into a single paragraph) |
| a list indented by 2 spaces right after a table / code block | children of that table / code block |
| a document that is one big list | its single top-level item is the root |

## Links Between Nodes

Give a heading, paragraph or list item an ID by appending `{#id}` or `[^id]`
(the marker is hidden on the map), then declare a link:

```markdown
## Build {#build}
## Deploy {#deploy}
- Staging [^staging]

> [^build] >-produces-> [^deploy]

<!-- mindmap:link from=deploy to=staging label="first" -->
<!-- mindmap:link from=build to=staging bidirectional -->
```

| Syntax | Meaning |
| --- | --- |
| `> [^a] >-label-> [^b]` | one-way link (Mind Elixir plaintext syntax, visible in rendered Markdown) |
| `> [^a] <-label-> [^b]` | two-way link |
| `> [^a] (10,-20) >-label-> (30,5) [^b]` | link with a saved curve |
| `<!-- mindmap:link from=a to=b label="x" -->` | link as an HTML comment — invisible in rendered Markdown |
| `bidirectional`, `delta1="10,-20"`, `delta2="30,5"` | extra attributes of the comment form |

Tables, code blocks and images get an ID with a comment right after them (invisible when rendered);
their children are an **indented** list below it — a list without indentation stays a sibling:

```markdown
| packet | tag  |
|--------|------|
| SEAL   | 0x11 |
<!-- mindmap:node id=packets -->

  - child of the table
  - another child

- a sibling of the table
```

- IDs may contain letters of any alphabet, digits, `_` and `-`.
- IDs survive editing the text or moving lines around.
- A link can be declared anywhere in the file, also as a list item: `- > [^a] >-label-> [^b]`.

## Editing on the Map

Every change on the map is turned into a minimal edit of the affected lines of the file.

| On the map | In the file |
| --- | --- |
| Add a node (`Tab` / `Enter` / context menu) | a new line shaped like its neighbours: a heading next to headings, a list item inside a list |
| Rename a node (double-click / `F2`) | only the text changes; `{#id}`, styles and markers stay |
| Delete a node (`Delete`) | its lines (with children) and the links pointing to it |
| Move a node (drag & drop, `PgUp` / `PgDn`) | its lines are moved; heading levels and list indentation are adjusted |
| Add a parent (context menu) | a heading above it (the section moves one level down) or a list item above it (the item is indented) |
| Create a link (node context menu → Link) | one link line; missing IDs are added to the nodes automatically (`<!-- mindmap:node id=… -->` for tables) |
| Summary / «Описание» (select siblings → context menu) | `<!-- mindmap:summary from=a to=b label="…" -->`, or `- }:2 label` for nested list items |
| Right-click a link | edit label, make one-way / two-way, reset curve, delete |
| Drag a link's line (or its handles) | the curve is saved as coordinates in the link line |
| `Ctrl+Z` / `Ctrl+Y` on the map | undo / redo in the text editor |

The file is saved after a map change (unless it already had unsaved changes).

Not supported for Markdown yet — the map shows a warning and reloads from the file:
copy / paste of nodes and node styles. The content of tables and code blocks is edited in the text
editor (on the map they can get children, links and summaries, be moved and deleted).
A parent can be added to a paragraph or table only when it is the last block before the next heading.

### Mind Elixir plaintext files

Files that consist of a single `- ` list (the Mind Elixir plaintext format) are handled the same way:
`[^id]` anchors, `- > [^a] >-label-> [^b]` links, node styles `{"color": "#e87a90"}` and
summaries `- }:2 label` are understood, and edits keep the file a plain list.

## Mind Maps in the Markdown Preview

A code block with the `mindelixir` language is rendered as a mind map in VS Code's built-in Markdown preview:

````markdown
```mindelixir
- Root
  - Child 1 [^a]
  - Child 2 [^b]
  - > [^a] >-link-> [^b]
```
````

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `mindElixirMarkdown.h1AsRoot` | `true` | Use the h1 heading — or, for a document that is a single list, its only top-level item — as the root node instead of the file name |

## Known Issues

[Report issues on GitHub](https://github.com/fishan/mark-elixir-advance/issues)

## License

MIT License
