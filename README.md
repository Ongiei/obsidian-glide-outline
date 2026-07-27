# Glide Outline

A fluid **editor-margin outline** for [Obsidian](https://obsidian.md) with dock-style proximity magnification.

Glide Outline lives in the margin of your Markdown editor as a quiet column of heading markers. Move your pointer near the rail and the markers glide open into heading labels — the heading closest to your pointer magnifies the most, neighbours scale down continuously, like a vertical macOS Dock made of text.

> **Demo placeholder** — animation GIF coming soon.

## Features

- **Margin rail, not a panel.** A thin column of markers on the left or right edge of the current Markdown editor. No card, no border, no toolbar.
- **Marker length encodes level.** H1 gets the longest marker, H6 the shortest. Line or dot style.
- **Active heading highlight.** The heading you are currently reading is tinted with your theme accent colour.
- **Proximity reveal.** Hover near the rail and labels slide out from the margin toward the text.
- **Dock magnification.** Cosine falloff scaling centred on the pointer, with gentle vertical displacement so magnified neighbours never overlap.
- **Instant updates while typing.** Headings are parsed live from the editor on every change, then corrected by Obsidian's metadata cache.
- **Accurate click-to-jump.** Works in Source Mode, Live Preview and Reading Mode — including duplicate headings — without reopening the file.
- **Non-blocking by design.** Every drawing layer is pointer-transparent; only the thin marker rail and the actually visible label cards intercept clicks. The editor underneath stays fully interactive.
- **Narrow-pane aware.** In split layouts the rail measures its pane and shrinks labels so magnified text never clips; extremely narrow panes fall back to markers-only compact mode.
- **Customisable label cards.** Background opacity, border, corner radius, shadow, padding and text shadow — down to a pure-text mode with no chrome at all.
- **Optional Markdown labels.** Render inline formatting (bold, code, links…) inside heading labels, powered by Obsidian's own renderer.
- **Pop-out window safe.** All DOM checks use the owning window, so the rail works in detached editor windows.
- **Accessible.** Keyboard focus keeps the outline open, Enter/Space activation, `aria-label`s, and full `prefers-reduced-motion` support.

## Installation

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from a release.
2. Copy them to `<vault>/.obsidian/plugins/glide-outline/`.
3. Reload Obsidian and enable **Glide Outline** in *Settings → Community plugins*.

### Development

```bash
pnpm install
pnpm run dev     # watch build
pnpm run build   # type-check + production build
pnpm run lint
pnpm test
```

Symlink (or copy) the repository into `<vault>/.obsidian/plugins/glide-outline/` for live testing.

## Settings

Settings are grouped into **General**, **Marker**, **Motion**, **Typography**, **Label card**, **Rendering** and **Show heading levels**, plus a one-click **Restore default appearance** button (position, shown levels and Markdown rendering are preserved).

| Setting | Default | Description |
| --- | --- | --- |
| Enable outline | on | Master switch. |
| Position | right | Which editor margin the rail sits in. |
| Vertical offset | 0 px | Shift the rail up/down. |
| Marker style | line | `line` or `dot` markers. |
| Maximum magnification | 1.25 | Peak scale of the label nearest the pointer. |
| Magnification radius | 90 px | Distance over which magnification decays to 1. |
| Animation | on | Disable for instant reveal without motion. |
| Base font size | 12 px | Label font size before magnification. |
| Maximum label width | 240 px | Longer headings get a single-line ellipsis. |
| Background opacity | 78 % | Label card background; 0 turns cards into pure text. |
| Border / Shadow / Text shadow | off | Optional card chrome. |
| Corner radius | 4 px | Card corner rounding. |
| Horizontal / vertical padding | 7 / 1 px | Card padding. |
| Render Markdown in labels | off | Show inline bold/code/links in labels. |
| Show heading levels | H1–H6 | Filter which levels appear in the rail. |

Slider changes apply instantly but are saved to disk with a short debounce, so dragging never hammers the settings file.

## Commands

- **Toggle outline** — show or hide the rail.
- **Move outline to opposite side** — flip between the left and right margin.

## Why an editor-margin outline?

Sidebar TOC panels cost horizontal space permanently and live far away from the text you are reading. Glide Outline keeps orientation information *inside* the editor's margin: nearly invisible while you write, instantly explorable when you reach for it. It follows the active Markdown pane — in split layouts it belongs to the editor, not to the app window.

## Current limitations

- Only the **active** Markdown pane gets a rail (first version by design).
- Desktop only (`isDesktopOnly: true`); no touch/hover emulation on mobile.
- Setext headings (`===` / `---`) are supported by the live parser in common cases, but exotic Markdown edge cases defer to Obsidian's metadata cache.
- In Reading Mode, headings far outside the rendered viewport may be virtualized by Obsidian; jumping falls back to Obsidian's own scroll state in that case.

## License

[MIT](LICENSE) — implemented independently; no source code was copied from other plugins.
