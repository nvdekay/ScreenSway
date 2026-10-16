// Stand-in for @tauri-apps/api/event: the studio's progress events, raised by the web backend.
export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

export type UnlistenFn = () => void;

const listeners = new Map<string, Set<(event: Event<unknown>) => void>>();
let nextId = 0;

export async function listen<T>(event: string, handler: (event: Event<T>) => void): Promise<UnlistenFn> {
  const set = listeners.get(event) ?? new Set();
  listeners.set(event, set);
  const listener = handler as (event: Event<unknown>) => void;
  set.add(listener);
  return () => set.delete(listener);
}

export function emit(event: string, payload: unknown) {
  for (const listener of listeners.get(event) ?? []) listener({ event, id: nextId++, payload });
}
