export type Rec = Record<string, unknown> & { id: string };

export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
