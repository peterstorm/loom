---
name: nextjs-frontend-design
description: "This skill should be used when the user asks to 'build a Next.js app', 'design a landing page', 'create a dashboard', 'style my app', 'build a design system', or needs a Next.js interface with a deliberate visual direction. Covers choosing and executing an aesthetic (type, colour, motion, layout) and current App Router conventions (Server Components, Server Actions, caching, async request APIs). NOT for React/Next.js performance tuning (use vercel-react-best-practices)."
---

# Next.js Frontend Design

Build Next.js interfaces that are architecturally sound and look designed for their context. This file sets the approach and routes to the references; load a reference when its row in the table applies.

If not already in context this session, read `${CLAUDE_PLUGIN_ROOT}/rules/architecture.md` and `${CLAUDE_PLUGIN_ROOT}/rules/typescript-patterns.md`.

<frontend_aesthetics>
You tend to converge toward generic, "on distribution" outputs. In frontend design, this creates what users call the "AI slop" aesthetic. Avoid this: make creative, distinctive frontends that surprise and delight.

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes. Draw from IDE themes and cultural aesthetics for inspiration.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density—not the safe middle ground.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Layer CSS gradients, use geometric patterns, noise textures, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

Avoid generic AI-generated aesthetics:
- Overused font families (Inter, Roboto, Arial, system fonts)
- Clichéd color schemes (particularly purple gradients on white backgrounds)
- Predictable layouts and component patterns
- Perfectly centered everything with equal padding
- Cookie-cutter design that lacks context-specific character

Interpret creatively and make unexpected choices that feel genuinely designed for the context. Vary between light and dark themes, different fonts, different aesthetics. You still tend to converge on common choices (Space Grotesk, for example) across generations. Avoid this: it is critical that you think outside the box!
</frontend_aesthetics>

## Before writing code

Commit to a direction:

1. **Purpose.** What problem does the interface solve, and who uses it?
2. **Tone.** Pick a direction and commit to it fully: brutally minimal, maximalist, editorial, industrial, organic, luxury, playful, retro-futuristic, terminal, or one taken from the product's own subject.
3. **Differentiation.** Name the one thing someone will remember.

Bold maximalism and refined minimalism both work. What matters is that the choice is intentional and carried through; half-measures are what look generic. Match the implementation to the vision: a maximalist design needs elaborate code, a minimal one needs precision in spacing and type.

## Scope of the brief

The brief above is written for marketing pages, landing pages and brand moments. It does not apply unchanged everywhere:

- **Dashboards, admin panels, data-heavy tools and forms** call for restraint. A system or neutral font, solid backgrounds and conventional layout are correct there; distinction comes from hierarchy, alignment, density and one disciplined accent. See "Product UI" in `references/design-philosophy.md`.
- **An existing brand guide or design system** outranks the brief. Follow it.
- **Accessibility is a constraint on every direction**: 4.5:1 contrast for body text, keyboard access, a reduced-motion path.

## Vary the choices

This skill ships no font list and no palette on purpose. Any fixed list becomes the new default, and every project built with it converges. Choose type and colour from the product's subject, and if the result matches your previous project, choose again. `references/design-philosophy.md` gives the principles (contrast in pairing, extremes of weight and size, dominant colour plus accent, measured contrast) and shows the `next/font` and Tailwind v4 token setup.

## Load when

| Doing this | Read |
|---|---|
| Choosing or executing the visual direction: type, colour, backgrounds, layout, component styling, product-UI restraint, the pre-ship review | `references/design-philosophy.md` |
| Writing pages, layouts, Server Actions, forms, Route Handlers, caching or revalidation, `proxy.ts`, typed env, or anything touching `params` / `cookies()` / `headers()` | `references/nextjs-patterns.md` |
| Checking keyboard, focus, ARIA or contrast | `references/nextjs-patterns.md` → "Accessibility" |
| Adding motion: easing, staggered reveals, Motion for React, reduced motion | `references/animation-recipes.md` |
| Performance work: waterfalls, bundle size, re-renders, client data fetching | the `vercel-react-best-practices` skill (its `SKILL.md` indexes 57 rule files; read only the rules that apply) |

`references/nextjs-patterns.md` is required reading before the first Server Action, cache call or request-API use in a session. Next.js 15 and 16 and React 19 changed those APIs, and what you remember is likely the older behaviour.
