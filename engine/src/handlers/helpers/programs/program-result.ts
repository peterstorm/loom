/** Shared shell boundary results; independent of registration parsers and program drivers. */
export type ProgramParse<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; message: string }>;

export type FacadeDriveResult =
  | Readonly<{ ok: true; action: unknown }>
  | Readonly<{ ok: false; message: string }>;

export const failed = (message: string): FacadeDriveResult => ({ ok: false, message });
