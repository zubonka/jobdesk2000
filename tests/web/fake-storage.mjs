// In-memory localStorage for the browser modules. Import this before any app module: several of
// them read storage while they load.

class MemoryStorage {
  #items = new Map();
  get length() { return this.#items.size; }
  key(i) { return [...this.#items.keys()][i] ?? null; }
  getItem(key) { return this.#items.has(key) ? this.#items.get(key) : null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
  clear() { this.#items.clear(); }
}

export const storage = new MemoryStorage();

// defineProperty, because newer Node versions ship their own localStorage accessor on globalThis
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
