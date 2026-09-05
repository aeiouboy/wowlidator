# wowlidator Design System

This document records the visual system already shared by the control panel,
HTML report, and verification report. The implementation source of truth for
the tokens remains `src/reporter/theme.ts`; this file names how those tokens and
the reusable UI primitives are meant to be used.

## 1. Atmosphere & Identity

A quiet QA command center: dense evidence should remain scannable without
looking decorative. Its signature is operational telemetry in teal, paired
with hairline panels, dotted status chips, uppercase micro-labels, and monospace
text for anything a person could copy into a terminal.

## 2. Color

All colors come from the light and dark token sets in `GRIM_TOKENS`.

| Role | Tokens | Usage |
|---|---|---|
| Canvas and surfaces | `--bg`, `--panel`, `--panel-2`, `--code-bg` | Page, cards, quiet rows, commands |
| Borders | `--line`, `--line-strong` | Hairlines and control outlines |
| Text | `--ink`, `--muted`, `--faint` | Primary, explanatory, and tertiary copy |
| Active telemetry | `--accent`, `--accent-soft`, `--accent-line`, `--accent-strong`, `--accent-ink`, `--on-accent` | Navigation, focus, primary actions |
| Status | `--ok`, `--warn`, `--bad`, `--info`, `--violet` and matching `-bg` tokens | Verified, review, failure, running, generated |

No component introduces a literal color when an existing semantic token fits.

## 3. Typography

- Primary: `--sans`, preferring IBM Plex Sans Thai and IBM Plex Sans with a
  platform UI fallback.
- Monospace: `--mono`, preferring IBM Plex Mono with platform mono fallbacks.
- Scale: `--fs-cap`, `--fs-xs`, `--fs-sm`, `--fs-md`, `--fs-lg`, `--fs-xl`,
  and `--fs-mono` from `GRIM_TOKENS`.
- Prose uses the primary family; identifiers, paths, commands, token counts,
  timings, and model IDs use the monospace family.
- Micro-labels are uppercase and tracked. Prose is never uppercase for style.

## 4. Spacing & Layout

- Base unit: 4px. The scale is `--s1` through `--s7` (4, 8, 12, 16, 20,
  24, and 32px).
- Page frame: sticky top navigation, document-owned vertical scrolling, and a
  centered main content column.
- Machinery: a two-column layout above 1040px and one column below it.
- Dense tables own their horizontal scroll. Their controls use intrinsic widths
  so long provider and model names remain readable; the page itself must not
  drift sideways.
- Mobile target: 375px. Primary content reflows to one column; wide data tables
  remain locally scrollable because their rows represent two-dimensional data.

## 5. Components

### Panel and Card

- **Structure:** tonal surface, hairline border, restrained elevation.
- **States:** default and row-hover where the surface is interactive.
- **Layout:** stack or grid; content must set `min-width: 0` when it can shrink.

### Button and Link

- **Variants:** default, accent, primary, destructive, disabled.
- **States:** default, hover, active, focus-visible, disabled, loading.
- **Accessibility:** native button/link semantics and a visible accent focus ring.

### Status Chip

- **Structure:** semantic label with a same-color dot.
- **Variants:** verified, running, warning, blocked, failure, neutral.
- **Accessibility:** color supplements the written status; it never carries the
  meaning alone.

### Dense Data Table

- **Structure:** uppercase header, hairline rows, compact body copy.
- **States:** row hover, empty table, long content, and locally scrolled view.
- **Layout:** the table is its horizontal scroll owner. Columns and controls may
  use intrinsic minimum widths rather than clipping selected values.
- **Accessibility:** semantic table markup; all controls retain labels and
  keyboard reachability.

### Provider and Model Picker

- **Structure:** native provider select, editable model input with datalist,
  and one explanatory line below.
- **States:** default, focus, overridden-from-environment, unavailable catalog,
  local-server port, and fixed model.
- **Layout:** a compact cluster inside a locally scrollable table. The selected
  provider and a 30-character model identifier remain fully visible.
- **Accessibility:** the controls use role-specific accessible names and native
  keyboard behavior.

## 6. Motion & Interaction

- Micro feedback uses the existing 120ms ease transition for buttons and
  navigation.
- Running telemetry may pulse; completed states remain still.
- Motion only communicates interaction or live state, uses composited
  properties, and respects reduced-motion preferences.

## 7. Depth & Surface

The strategy is mixed but restrained: tonal shifts and hairline borders do
most of the work, while `--shadow` is reserved for panels and `--shadow-over`
for overlays. Pills are reserved for status and counts, not general containers.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Target WCAG 2.2 AA with visible focus on every interactive element.
- Status text is always present alongside status color.
- The IBM Plex Sans Thai-first stack must preserve Thai, CJK fallback, and
  wide-character shaping without external font requests.
- At 375px, the page remains readable and non-blank. Any horizontal scrolling
  is local to a genuinely two-dimensional data table.

### Accepted Debt

| Item | Location | Why accepted | Exit |
|---|---|---|---|
| Dense role tables require horizontal scrolling on narrow screens | Machinery role table | Five operational columns cannot reflow without losing their row relationship | Replace only if the information architecture changes |
