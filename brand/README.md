# Facet brand assets

The Facet gem is a princess-cut stone seen from above: an outer rhombus, an inner table and four
facets. Geometry and colors are specified in [`docs/DESIGN.md`](../docs/DESIGN.md#logo--the-facet-gem);
these files implement that spec exactly.

| File | Use |
|---|---|
| `facet-gem.svg` | The mark in full color. Works on dark and light backgrounds. |
| `facet-gem-mono.svg` | Single color (`currentColor`): outline, facet edges and solid table. For one-color print, notification icons, watermarks. |
| `facet-wordmark-dark.svg` | Gem + `facet` wordmark with light text (`#E8ECF2`), **for dark backgrounds**. Text is outlined to paths. |
| `facet-wordmark-light.svg` | Gem + `facet` wordmark with ink text (`#12161C`), **for light backgrounds**. Text is outlined to paths. |
| `facet-icon.svg` | App icon preview: gem on Basalt `#11151B` with a faint radial glow, rounded square. The canvas represents the 72 dp visible area of a 108 dp Android adaptive icon; the gem is 58% of the 66 dp safe zone. |
| `favicon.svg` | Browser tab icon (gem with slightly heavier seam strokes for small sizes). |
| `facet-og.svg` | Social card source (1200×630). Uses live `<text>` set in Instrument Serif / Instrument Sans, so render it with those fonts installed; the PNG export is in `png/`. |
| `png/` | Raster exports: gem 48/192/512/1024, icon 512/1024 (512 is the Play Store icon size), wordmarks at 1200 wide, social card 1200×630. |

## Clear space and minimum size

- Keep clear space around the gem equal to **25% of its height** on every side; around the
  wordmark, 25% of the gem height.
- Minimum size: gem 16 px (digital) / 5 mm (print); wordmark 72 px wide.
- The gap between gem and wordmark is fixed at 0.35 × gem height. Don't re-space or re-set
  the wordmark; use the files.

## Colors

| Name | Hex | Role |
|---|---|---|
| Gold | `#F2C66D` | North-west facet |
| Flash blue | `#6E9BFF` | North-east facet |
| Deep | `#3A5BD9` | South-east facet |
| Glint teal | `#49D3C1` | South-west facet; the single UI accent in the dark theme |
| Table | `#F4F7FB` | Table facet |
| Basalt | `#11151B` | Icon and dark-theme background |
| Quartz | `#F5F6F8` | Light-theme background |

The four facet colors appear **only** in the gem (and the send-button gradient, Flash blue →
Glint teal). Don't use them as general UI colors, don't recolor individual facets, don't add
outlines, shadows or bevels, and don't rotate the gem: the 45° orientation is the mark.

## Motion

"Thinking" animation: facet colors advance one position clockwise every 400 ms with a
cross-fade (one turn = 1.6 s) while the table breathes between 70% and 100% opacity. With
reduced motion enabled the gem stays still.

## Typography

Wordmark and UI: Instrument Sans (SemiBold for the wordmark, tracking −2%). Welcome moments:
Instrument Serif. Code: JetBrains Mono. All three are licensed under the SIL Open Font
License 1.1.
