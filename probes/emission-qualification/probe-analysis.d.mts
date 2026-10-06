/**
 * Types for the parts of `probe-analysis.mjs` the TypeScript probe modules
 * import. The engine tsconfig has no `allowJs`, so this declaration is the
 * typed seam onto the plain-JS analysis module.
 */

/** Compile one generated detector's source into its predicate over emitted arguments. */
export declare const detector: (source: string) => (args: unknown) => boolean;
