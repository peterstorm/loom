# Design Philosophy

How to turn the direction chosen in `SKILL.md` into type, colour, depth and layout. The aesthetics brief and the three direction steps live in `SKILL.md`; motion lives in `animation-recipes.md`. Nothing here is a recipe: there is no approved font list and no house palette, because a fixed list makes every project look the same. The CSS samples show a technique. Their values are placeholders to replace.

## Why defaults converge

Safe choices dominate the web a model learned from, so an unprompted design lands on the same typeface, the same gradient and the same three-card grid. Each section below names the default and gives a way to choose instead of a substitute default. If two projects in a row end up with the same fonts or the same palette, the choice was not made for the project.

## Directions

A direction is a short phrase that settles the later decisions. Some starting points; invent others, and take them from the subject of the product rather than from this list:

- **Brutally minimal**: one typeface, monochrome, extreme whitespace.
- **Maximalist**: dense, layered, loud.
- **Editorial**: strong type hierarchy, asymmetric grid, long measures.
- **Industrial / utilitarian**: monospace, exposed grid, visible structure.
- **Organic**: soft curves, earth tones, flowing layout.
- **Luxury**: serif display type, restrained colour, generous spacing.
- **Playful**: rounded shapes, saturated primaries, bouncy motion.
- **Retro-futuristic**: neon, scanlines, synth palettes.
- **Terminal**: dark surface, syntax colours, monospace throughout.

Test the direction before building: say in one sentence what a visitor will remember. If the sentence is vague, the direction is.

## Typography

Type is the fastest signal of intent, so decide it first.

- **Choose for the subject.** Browse the catalogue with the product in mind (a legal tool, a synth shop and a children's app want different faces) and pick something you have not used in the last project. Popular geometric sans faces are the convergence point; the previous "distinctive" pick becomes the next default.
- **Pair by contrast.** A display face with a quiet text face; serif with sans; proportional with monospace. Two families are enough.
- **Use the ends of the scale.** Weight 200 against 800 reads as a decision; 400 against 600 reads as an accident. Make heading sizes several times the body size, with `clamp()` so they scale.
- **Check the text face at body size** in long paragraphs before committing. Display faces often fail there.

Load fonts with `next/font`, which self-hosts the files and sends no request to Google from the browser. Do not use a Google Fonts `@import` or `<link>`. A face that is not on Google Fonts goes through `next/font/local` with the licensed file in the repo.

```tsx
// app/layout.tsx — the families are examples; choose per project
import { Fraunces, IBM_Plex_Mono } from 'next/font/google'
import localFont from 'next/font/local'

const display = Fraunces({ subsets: ['latin'], variable: '--font-fraunces' }) // variable font: no weight needed
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '600'], variable: '--font-plex-mono' })
// const display = localFont({ src: './fonts/licensed-face.woff2', variable: '--font-licensed' })

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
```

```css
/* app/globals.css — Tailwind CSS v4 */
@import "tailwindcss";

@theme inline {
  --font-display: var(--font-fraunces);
  --font-mono: var(--font-plex-mono);
}
```

The `variable` option only declares a CSS variable; it takes effect once `display.variable` is on an ancestor element. Refer to the font through that variable (`font-display`, or `font-family: var(--font-fraunces)`). Writing the family name as a string does not select the face that `next/font` generated.

## Colour

- **Dominant plus accent.** Roughly 60% one surface colour, 30% a secondary, 10% a sharp accent. An evenly distributed palette has no hierarchy.
- **Derive it from something.** A photograph of the subject, a print tradition, a material, an editor theme. A source gives the palette an internal logic that picking swatches does not.
- **Vary light and dark.** Dark with a hot accent is as much a default as purple on white. Decide per project.
- **Avoid the stock looks:** purple or blue-to-purple gradients, teal on grey, anything that reads as a SaaS template.
- **Measure contrast.** Body text needs 4.5:1 against its surface and large text 3:1. Muted text is where palettes fail: `#6b6b6b` on `#0a0a0a` is about 3.7:1 and is not acceptable for body copy.

Define the palette as tokens so it stays consistent:

```css
/* One illustration (warm paper, ink, rust). Not a default. */
@theme {
  --color-surface: #f4efe6;
  --color-ink: #1d1a16;
  --color-muted: #5f584e;  /* about 6:1 on the surface */
  --color-accent: #b3401f; /* about 5:1 on the surface */
}
```

## Depth and atmosphere

A flat surface is a choice, not a failure (see the next section). When the direction calls for atmosphere, build it from the palette rather than from a stock gradient:

```css
/* Mesh built from the project's own tokens */
.hero {
  background:
    radial-gradient(ellipse at 20% 40%, color-mix(in oklab, var(--color-accent) 25%, transparent), transparent 55%),
    radial-gradient(ellipse at 85% 60%, color-mix(in oklab, var(--color-ink) 12%, transparent), transparent 50%),
    var(--color-surface);
}

/* Grain: an inline SVG filter, no image file needed */
.grain {
  position: relative;
  isolation: isolate;
}
.grain::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  opacity: 0.04;
  pointer-events: none;
}

/* Layered shadow: several small steps read as real elevation */
.raised {
  box-shadow:
    0 1px 2px rgb(0 0 0 / 0.07),
    0 4px 8px rgb(0 0 0 / 0.07),
    0 16px 32px rgb(0 0 0 / 0.07);
}
```

Other tools: repeating geometric patterns, hard offset shadows, heavy borders, a tinted shadow in the accent colour. Use one or two that fit the direction. Stacking all of them is its own kind of generic.

## Composition

The default is everything centred with equal padding and cards in a three-column grid. Alternatives:

```css
/* Asymmetric columns, aligned to the baseline instead of the centre */
.hero {
  display: grid;
  grid-template-columns: 1.5fr 1fr;
  gap: clamp(2rem, 5vw, 6rem);
  align-items: end;
}

/* Overlap: a card that crosses the section boundary */
.feature-card {
  position: relative;
  z-index: 1;
  margin-top: -4rem;
}

/* A diagonal edge between sections */
.slanted {
  clip-path: polygon(0 5%, 100% 0, 100% 95%, 0 100%);
}
```

Choose generous negative space or controlled density and commit to it. Vary the rhythm between sections so the page does not read as one block repeated.

## Product UI: when restraint is right

Dashboards, admin panels, data tables, settings and forms are used for hours by people trying to finish a task. The brief's push toward expressive fonts, textured backgrounds and surprising layouts applies to marketing pages and brand moments, not to these screens. For product UI:

- A system font stack or a neutral sans is a sound choice: it renders fast and stays legible at 13–14px in dense tables. A monospace or tabular-figure face for numbers helps more than a display face.
- Solid backgrounds are correct. Texture and gradients behind data reduce legibility.
- Conventional layout (sidebar, table, detail pane) is a feature. Users already know it.
- Motion is functional: short transitions that explain a state change, nothing that plays on every visit.
- Distinction comes from precision: consistent spacing, careful alignment, a clear hierarchy, one accent used only for the primary action and status, good empty and error states.

The same holds when a brand guide or an existing design system is present: follow it, and put the craft into the execution.

## Components

Use the shadcn CLI for primitives (`shadcn@latest add <component>` through the project's package runner adds the component and its dependencies to the project), then restyle them to the chosen direction: radius, border weight, type, spacing, focus ring. An unmodified default component is the component-level version of the three-card grid. Do not hand-write dialogs, menus or comboboxes; the primitives carry the keyboard and focus behaviour.

## Review before shipping

- Can you state the direction in one phrase, and does every screen follow it?
- Would the fonts and palette be different if the product were different?
- Is there a clear hierarchy in type size and weight, and one dominant colour?
- Does any text fail contrast, especially muted text and text over gradients?
- Is there one deliberate motion moment, and a reduced-motion path?
- Does the layout have a reason, or is it the centred default?
- For product UI: did decoration get in the way of the task anywhere?
