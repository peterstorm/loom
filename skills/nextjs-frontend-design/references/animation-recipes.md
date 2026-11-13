# Animation Recipes

Building blocks, not a catalogue. One orchestrated moment (a page load, a reveal) does more than many small effects. Spend the motion budget there and keep the rest quiet. Samples assume Tailwind CSS v4, where theme tokens live in CSS; there is no `tailwind.config.ts` to extend.

## Easing and duration

Choose the curve on purpose instead of taking the default:

- Entrances and reveals: a strong ease-out, so elements arrive fast and settle.
- Playful emphasis: a slight overshoot, used sparingly.
- Continuous motion (spinners, marquees, progress): `linear` is the correct choice.
- Small state changes (a colour or opacity change on hover): the browser's `ease` is fine at 150–200ms.

```css
/* app/globals.css */
@import "tailwindcss";

@theme {
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-out-back: cubic-bezier(0.34, 1.56, 0.64, 1);

  --animate-fade-up: fade-up 0.6s var(--ease-out-expo) both;

  @keyframes fade-up {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }
}
```

`--ease-*` tokens generate easing utilities (`ease-out-expo`) and `--animate-*` tokens generate animation utilities (`animate-fade-up`). The fill mode `both` applies the `from` frame during the delay, so the element needs no separate `opacity: 0` rule that could leave it invisible if the animation never runs.

Animate `transform` and `opacity`. Do not move things with `top`/`left` or resize them with `width`; translate and scale instead. When size really has to animate (an accordion opening), keep the affected subtree small or use Motion's `layout` prop, which performs the change with transforms.

## Staggered reveal (CSS only)

```tsx
<section>
  {items.map((item, index) => (
    <div key={item.id} className="animate-fade-up" style={{ animationDelay: `${index * 80}ms` }}>
      {item.content}
    </div>
  ))}
</section>
```

Keep the stagger to the first handful of elements; past roughly half a second of total delay it reads as slowness. This works in a Server Component and ships no JavaScript.

## Motion for React

The `framer-motion` package is now `motion`: install `motion` and import from `motion/react`. Motion components need `'use client'`. Reach for it when CSS cannot express the effect (exit animations, layout animations, gestures, scroll-linked values).

```tsx
'use client'
import { stagger } from 'motion'
import { motion } from 'motion/react'

const container = {
  hidden: { opacity: 0 },
  // Current Motion staggers with delayChildren: stagger(); older samples use staggerChildren.
  visible: { opacity: 1, transition: { delayChildren: stagger(0.08, { startDelay: 0.1 }) } },
}

const child = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } },
}

export function StaggeredList({ items }: { items: readonly { id: string; label: string }[] }) {
  return (
    <motion.ul variants={container} initial="hidden" animate="visible">
      {items.map((item) => (
        <motion.li key={item.id} variants={child}>
          {item.label}
        </motion.li>
      ))}
    </motion.ul>
  )
}
```

- Pointer-following effects (magnetic buttons, tilt, parallax) must not call `setState` on every `mousemove` or `scroll` event. Write to a ref, a CSS variable or a motion value. See `rerender-use-ref-transient-values` in the `vercel-react-best-practices` skill.
- Do not wrap a layout's `children` in `AnimatePresence` keyed on the pathname to get route transitions. On Next.js 16 use React's `<ViewTransition>`, which animates updates inside a navigation.

## Reduced motion

Every project includes this rule. It is the accessibility floor, not an optional extra.

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

With Motion, wrap the app in `<MotionConfig reducedMotion="user">` so transform and layout animations are disabled for users who ask for that, while opacity and colour still animate.
