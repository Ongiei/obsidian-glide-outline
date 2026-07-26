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
- **Accessible.** Keyboard focus, Enter/Space activation, `aria-label`s, and full `prefers-reduced-motion` support.

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

| Setting | Default | Description |
| --- | --- | --- |
| Enable Glide Outline | on | Master switch. |
| Position | right | Which editor margin the rail sits in. |
| Vertical offset | 0 px | Shift the rail up/down. |
| Marker style | line | `line` or `dot` markers. |
| Maximum magnification | 1.25 | Peak scale of the label nearest the pointer. |
| Magnification radius | 90 px | Distance over which magnification decays to 1. |
| Base font size | 12 px | Label font size before magnification. |
| Maximum label width | 240 px | Longer headings get a single-line ellipsis. |
| Show heading levels | H1–H6 | Filter which levels appear in the rail. |
| Animation | on | Disable for instant reveal without motion. |

## Why an editor-margin outline?

Sidebar TOC panels cost horizontal space permanently and live far away from the text you are reading. Glide Outline keeps orientation information *inside* the editor's margin: nearly invisible while you write, instantly explorable when you reach for it. It follows the active Markdown pane — in split layouts it belongs to the editor, not to the app window.

## Current limitations

- Only the **active** Markdown pane gets a rail (first version by design).
- Desktop only (`isDesktopOnly: true`); no touch/hover emulation on mobile.
- Setext headings (`===` / `---`) are supported by the live parser in common cases, but exotic Markdown edge cases defer to Obsidian's metadata cache.
- In Reading Mode, headings far outside the rendered viewport may be virtualized by Obsidian; jumping falls back to Obsidian's own scroll state in that case.

## License

[MIT](LICENSE) — implemented independently; no source code was copied from other plugins.
