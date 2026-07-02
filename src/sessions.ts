/** Metadata for a parsed V8 log held in memory. */
export interface SessionInfo {
  id: string;
  /** Absolute path of the v8.log this session was parsed from. */
  source: string;
  loadedAt: string;
}

/** In-memory registry of loaded log sessions. */
export class SessionStore {
  #sessions = new Map<string, SessionInfo>();
  #nextId = 1;

  add(source: string): SessionInfo {
    const info: SessionInfo = {
      id: `s${this.#nextId++}`,
      source,
      loadedAt: new Date().toISOString()
    };
    this.#sessions.set(info.id, info);
    return info;
  }

  get(id: string): SessionInfo | undefined {
    return this.#sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()];
  }
}
