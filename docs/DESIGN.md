# Facet Design System

## Concept

Facet is named after the cut faces of a gem: one stone, many faces, the way one app holds
many models. The visual language borrows from **labradorite**, a dark stone that flashes blue,
teal and gold when light catches it. The interface is the stone: calm, mineral, quiet. The
flash appears in exactly one place, the **Facet gem**, which is the logo, the "thinking"
indicator, the active send button and the streaming cursor. Everything else stays restrained,
so the gem is the one memorable thing.

Principles:
1. **Content is the interface.** Assistant replies are unboxed, full-width, set for reading.
   Chrome recedes; hierarchy comes from tone and spacing, not boxes and borders.
2. **Spend boldness once.** Only the gem carries the iridescent palette. UI accents use a
   single teal ("Glint").
3. **Motion answers action.** Sheets spring from where they're summoned, messages settle in,
   tokens arrive at a steady cadence. Idle screens are still. Reduced motion → fades only.
4. **Radii by hierarchy**, never one radius everywhere.
5. **Honest numbers.** Tokens and cost are shown quietly and precisely, never hidden.

## Logo — the Facet gem

A princess-cut gem seen from above, rotated 45°: an outer rhombus, an inner table, and four
trapezoid facets. ViewBox `0 0 100 100`:

| Part | Points | Color |
|---|---|---|
| North-west facet | 4,50 50,4 50,32 32,50 | Gold `#F2C66D` |
| North-east facet | 50,4 96,50 68,50 50,32 | Flash blue `#6E9BFF` |
| South-east facet | 96,50 50,96 50,68 68,50 | Deep `#3A5BD9` |
| South-west facet | 50,96 4,50 32,50 50,68 | Glint teal `#49D3C1` |
| Table | 50,32 68,50 50,68 32,50 | Table white `#F4F7FB` |

Animation ("thinking"): the four facet colors rotate one position clockwise every 400 ms with
a cross-fade (one full turn = 1.6 s) while the table breathes between 70% and 100% opacity.
It reads as light moving across a turning stone.

Wordmark: `facet`, Instrument Sans SemiBold, tracking −2%, set to the right of the gem with
a gap of 0.35 × gem height.

App icon: gem at 58% of the safe zone on Basalt `#11151B`. Monochrome (themed) icon: gem
outline + table only.

## Color

### Dark — "Basalt" (default when the system is dark)

| Token | Hex | Use |
|---|---|---|
| background | `#11151B` | Screen |
| surface | `#171C24` | Sheets, drawer |
| surfaceHigh | `#1E242E` | User bubble, composer, inputs |
| surfaceHighest | `#262D39` | Pressed, chips selected |
| outline | `#2C3441` | Dividers, input borders |
| outlineVariant | `#222833` | Hairlines |
| text | `#E8ECF2` | Primary text |
| textSecondary | `#A3ACBA` | Secondary text |
| textTertiary | `#6F7A8A` | Hints, disabled |
| primary (Glint) | `#49D3C1` | Toggles, links, selection, focus |
| onPrimary | `#04201C` | |
| primaryContainer | `#12352F` | Selected rows |
| onPrimaryContainer | `#A6F0E5` | |
| error | `#FF7A7A` | |
| success | `#5BD69B` | |
| warning | `#F2C66D` | |

### Light — "Quartz"

| Token | Hex |
|---|---|
| background | `#F5F6F8` |
| surface | `#FFFFFF` |
| surfaceHigh | `#ECEFF3` |
| surfaceHighest | `#E2E6EC` |
| outline | `#D3D8DF` |
| outlineVariant | `#E3E6EB` |
| text | `#12161C` |
| textSecondary | `#4F5968` |
| textTertiary | `#8590A0` |
| primary | `#087A6C` |
| onPrimary | `#FFFFFF` |
| primaryContainer | `#D5F2EC` |
| onPrimaryContainer | `#043B34` |
| error | `#C93636` |
| success | `#1F8A55` |
| warning | `#A87412` |

### Black — "Obsidian" (AMOLED)
Dark tokens with background `#000000`, surface `#0A0C10`, surfaceHigh `#13171D`,
surfaceHighest `#1B2028`, outline `#232A34`, outlineVariant `#171B22`.

### Gem palette (brand moments only)
Gold `#F2C66D`, Flash blue `#6E9BFF`, Deep `#3A5BD9`, Glint teal `#49D3C1`,
Table `#F4F7FB`. Send button gradient: 135° Flash blue → Glint teal.

## Typography

| Role | Face | Size / line | Weight | Tracking |
|---|---|---|---|---|
| Display | Instrument Serif | 40 / 44 | 400 | −1% |
| Headline | Instrument Serif | 30 / 36 | 400 | −0.5% |
| Title L | Instrument Sans | 22 / 28 | 600 | −1% |
| Title M | Instrument Sans | 17 / 24 | 600 | 0 |
| Chat body | Instrument Sans | 16.5 / 26 | 400 | 0 |
| Body | Instrument Sans | 15 / 22 | 400 | 0 |
| Label L | Instrument Sans | 15 / 20 | 500 | 0 |
| Label M | Instrument Sans | 13 / 18 | 500 | +0.5% |
| Label S | Instrument Sans | 12 / 16 | 500 | +1% |
| Code | JetBrains Mono | 13.5 / 21 | 400 | 0 |

Serif is reserved for moments of welcome (onboarding, the empty chat greeting, section
heroes on the website). Sentence case everywhere; no all-caps labels.

## Shape

| Element | Radius |
|---|---|
| Composer | 26 dp |
| Bottom sheets (top corners) | 28 dp |
| User message bubble | 22 dp, bottom-end 8 dp |
| Settings groups / cards | 18 dp |
| Code blocks, tables | 14 dp |
| Chips | 12 dp |
| Buttons | full pill |

## Spacing

4 dp base. Screen gutter 16 dp (20 dp ≥ 600 dp wide). Message column max width 760 dp,
centered on large screens. Vertical rhythm between turns 24 dp; between paragraphs 12 dp.

## Motion

| Moment | Spec |
|---|---|
| Default spring | damping 0.85, stiffness 380 |
| Message enter | fade + rise 12 dp, 260 ms, emphasized-decelerate |
| Sheet | spring from the summoning edge |
| Streaming | deltas buffered and revealed at an adaptive 40–400 chars/s cadence; breathing gem cursor |
| Thinking | gem facet rotation (see Logo) |
| Send | button scales 0.92 → 1 with a light haptic |
| Reduced motion | all of the above become 150 ms fades; gem stays static |

## Voice

Plain verbs, sentence case, no filler. Buttons say what happens ("Add key", "Create account",
"Save recovery code"). Errors say what happened and what to do ("OpenAI rejected this key.
Check it in Providers."), never apologize. Empty states invite action.
