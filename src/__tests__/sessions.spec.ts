import { describe, expect, it } from "vitest";
import type { LogModel } from "../model/logModel";
import { SessionStore } from "../sessions";

const emptyModel = (): LogModel => ({
  v8Version: "0.0.0",
  ics: [],
  deopts: [],
  maps: {
    createdCount: 0,
    entries: new Map(),
    eventCounts: {},
    transitionSites: []
  },
  profile: { tickCount: 0, vmStates: {}, functions: [] },
  scripts: new Map(),
  functionIndex: [],
  markers: [],
  codeEntryCount: 0,
  warnings: { unknownCommands: {}, badLines: 0 }
});

describe("sessionStore", () => {
  // Sessions hold full parsed models (every map entry and script source), so an
  // unbounded store leaks the server over a long agent session.
  it("evicts the oldest session beyond the cap while keeping recent ones", () => {
    const store = new SessionStore();
    const ids = Array.from(
      { length: 10 },
      (_, index) => store.add(`run-${index}`, emptyModel()).id
    );
    const listed = store.list().map(({ id }) => id);
    expect(listed).toHaveLength(8);
    expect(listed).not.toContain(ids[0]);
    expect(listed).not.toContain(ids[1]);
    expect(listed).toContain(ids[9]);
    expect(store.get(ids[0] ?? "")).toBeUndefined();
    expect(store.get(ids[9] ?? "")).toBeDefined();
  });
});
