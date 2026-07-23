# Assay Bench — Silent Gear Alloy Calculator

A static, client-side website that ranks Silent Gear armor (either normal materials or custom alloys if you prefer). 
Nothing you upload ever leaves your browser; there's no server or backend. Made with the help of ai (because I'm not that smart)


## Using it

1. Open the site and upload your material export `.tsv` (or click **"Try it
   with sample data"** to see it work first). You can get this using the `/sgear_mats dump` command in game
2. Check the stats you care about the most different alloys prioritize different stats.
3. **Single Materials** tab ranks every individual material row on its own.
4. **Forged Alloys** tab lets you pick a candidate pool (filter by part type
   and/or name), a max alloy size (1–6), and computes every meaningful
   combination, ranked the same way.

## Why the alloy tab limits your selection

Order matters for a forged alloy (whichever part is picked first sets the
baseline for the weighted average and the rarity comparison), and repeats are
allowed, so the space of possible alloys grows explosively with the size of
your candidate pool. To stay responsive in a browser, the app:

- Only tracks *which* material sits in the primary (first) slot — everything
  after that is treated as an unordered group, since the underlying math
  treats it that way too.
- Shows a live combination-count estimate and disables the compute button
  once it crosses a safety cap (250,000 by default — tweakable in `app.js` via
  `MAX_COMBOS`).

If your pool is large, narrow it with the part-type filter, the name filter,
or a smaller max alloy size.

## How the numbers are derived

This reimplements the spirit of Silent Gear's `NumberProperty` (weighted
average / add / multiply modifiers) and `SynergyUtils` (category, uniqueness,
and rarity-based synergy) without depending on any Minecraft/Forge code. It's
a best-effort recreation based on the cell formats found in a real export —
see the "How the numbers are calculated" section at the bottom of the page
itself for the exact rules. A few simplifications, clearly noted in the UI:

- Trait effects (e.g. "Synergistic II") are shown for reference but not
  factored into the math, since their real effects live in mod code, not in
  the exported data.
- Values aren't clamped to any per-property min/max, since those bounds
  aren't present in the export either.

## Files

- `index.html` — page structure
- `style.css` — visual styling
- `app.js` — all parsing, calculation, ranking, and UI logic
- `sample-data.js` — one bundled example export for the demo button (the app
  itself does not depend on this file's contents in any way)
