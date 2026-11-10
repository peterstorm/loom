export const db = {
  query: async (sql: string, parameters: readonly unknown[] = []): Promise<unknown> => ({ sql, parameters }),
};
