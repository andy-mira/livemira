// SPDX-License-Identifier: Apache-2.0

/** Typed events; a listener that throws is reported to the console and does not stop the others. */
export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<(event: never) => void>>();

  on<K extends keyof Events>(type: K, listener: (event: Events[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener as (event: never) => void);
    return () => {
      set.delete(listener as (event: never) => void);
    };
  }

  emit<K extends keyof Events>(type: K, event: Events[K]): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      try {
        (listener as (event: Events[K]) => void)(event);
      } catch (error) {
        console.error(`LiveMira: a '${String(type)}' listener threw`, error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
