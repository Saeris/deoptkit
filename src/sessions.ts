import type { LogModel } from "./model/logModel";

/** One parsed v8.log held in memory. */
export interface Session {
  id: string;
  /** Absolute path of the v8.log this session was parsed from. */
  source: string;
  loadedAt: string;
  model: LogModel;
}

/** What `list_sessions` reports for each session. */
export interface SessionSummary {
  id: string;
  source: string;
  loadedAt: string;
  v8Version: string;
  icSites: number;
  deoptSites: number;
}

/** In-memory registry of loaded log sessions. */
export class SessionStore {
  #sessions = new Map<string, Session>();
  #nextId = 1;

  add(source: string, model: LogModel): Session {
    const session: Session = {
      id: `s${this.#nextId++}`,
      source,
      loadedAt: new Date().toISOString(),
      model
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  list(): SessionSummary[] {
    return [...this.#sessions.values()].map(
      ({ id, source, loadedAt, model }) => ({
        id,
        source,
        loadedAt,
        v8Version: model.v8Version,
        icSites: model.ics.length,
        deoptSites: model.deopts.length
      })
    );
  }
}
