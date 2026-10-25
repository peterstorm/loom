/**
 * A thrown value as diagnostic text: an Error's message, anything else as
 * `String(cause)`. Shells that turn a caught throw into named, data-carried
 * failures share this one rendering.
 */
export const describeCause = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
