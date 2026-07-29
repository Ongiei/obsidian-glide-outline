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

### Manual stress test

`tests/fixtures/glide-outline-stress-test.md` is a real, readable manual with 120+ headings designed to break outlines. Copy it into a test vault and walk through this checklist:

1. **Overflow & edge fades** — the outline must overflow any laptop viewport; the top/bottom fades appear only on the edges that hide more content and follow every scroll.
2. **Edge auto-scroll** — park the pointer in the lower fifth of the rail: scrolling starts softly after a short dwell and speeds up toward the edge. Hold the mouse button: scrolling pauses; release: it resumes.
2b. **Pointer-follow pre-scroll** — flick the pointer quickly downward from the middle of the list: the list pre-scrolls to meet the gesture with no dwell; slow browsing movements never trigger it.
2c. **Wheel** — with the pointer over the outline, the wheel scrolls the outline (not the editor); at a dead end the wheel passes through to the editor. A wheel action pauses both automatic mechanisms briefly.
3. **Level badges** — the H1–H6 badges align in one column on the rail-facing card edge; 附录 L's eight consecutive H3 cards must line up perfectly; 附录 M jumps H2 → H5 with no intermediate badge.
4. **Magnification at the extremes** — the very long first and last titles must stay fully visible at peak scale, never clipped by the pane edges.
5. **Long tokens** — the space-less `Supercalifragilisticexpialidocious…` heading gets a single-line ellipsis; long English titles with spaces do too.
6. **Duplicates** — three identical `常见问题` H3s and the two-level `监控` pair all highlight and jump independently.
7. **Code fences** — none of the fake `# headings` inside fenced blocks appear in the rail.
8. **Narrow pane** — drag the split narrow: cards shrink text budget first, badges and paddings last; nothing overlaps the editor text.
9. **Reduced motion** — with the system reduced-motion preference (or Animation off), magnification snaps without transitions and auto-scroll disables entirely.

Structural properties of the fixture are pinned by `tests/stress-fixture.test.ts`, so edits cannot silently destroy this coverage.

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
| Border / Shadow | off | Optional card chrome. |
| Level badge | on | H1–H6 badge on the rail-facing edge of each card. |
| Corner radius | 4 px | Card corner rounding. |
| Horizontal / vertical padding | 7 / 1 px | Card padding. |
| Render Markdown in labels | off | Show inline bold/code/links in labels. |
| Show heading levels | H1–H6 | Filter which levels appear in the rail. |
| Pointer edge auto-scroll | on | Scroll the list when the pointer dwells near a list edge. |
| Auto-scroll speed | 1 | Speed multiplier for pointer edge auto-scroll. |
| Auto-scroll trigger area | 120 px | Height of the edge zone that starts auto-scroll. |
| Pointer-follow pre-scroll | on | Fast vertical pointer flicks pre-scroll the list toward the gesture. |

Slider changes apply instantly but are saved to disk with a short debounce, so dragging never hammers the settings file.

### The four scrolling mechanisms

The outline viewport can scroll for four independent reasons; they are deliberately separate mechanisms with separate rules:

1. **Active-heading follow** — while the pointer is *outside* the outline, the rail quietly keeps the active heading in view. Paused the moment your pointer enters the outline.
2. **Edge auto-scroll** — pointer *dwelling* near the top/bottom edge scrolls the list; a short dwell, a latch and hysteresis prevent accidental triggering while browsing headings near an edge.
3. **Pointer-follow pre-scroll** — a *fast, decisive* vertical pointer movement anywhere in the list pre-scrolls it in the same direction (no dwell — the gesture itself is the intent). Capped below the edge mechanism's speed; toggleable via *Pointer-follow pre-scroll*.
4. **Manual wheel** — the wheel always wins: wheeling over the outline scrolls it directly and pauses mechanisms 2 and 3 for a short cooldown, so the outline never fights your hand. Wheeling past a dead end, over a non-overflowing outline, or with Ctrl/⌘ held passes through to the editor untouched.

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
