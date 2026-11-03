import type {
  FunctionTicks,
  IcState,
  LogModel,
  ProfileModel
} from "../model/logModel";
import { icStateRank } from "../model/logModel";

export interface MarkWindow {
  fromMark?: string | undefined;
  toMark?: string | undefined;
}

export interface ResolvedWindow {
  fromTime: number;
  toTime: number;
}

/**
 * Resolve marker labels to a time range: the first occurrence of `fromMark` and the
 * last of `toMark`, so repeated runs of the same case widen to cover all of them.
 * Omitted ends are unbounded. Returns an error string when a label is unknown.
 */
export const resolveWindow = (
  model: LogModel,
  window: MarkWindow
): ResolvedWindow | { error: string } => {
  const known = model.markers.map(({ label }) => label);
  const missing = [window.fromMark, window.toMark].filter(
    (label): label is string => label !== undefined && !known.includes(label)
  );
  if (missing.length > 0) {
    return {
      error: `Unknown marker(s): ${missing.join(", ")}. Markers in this session: ${
        known.length > 0
          ? [...new Set(known)].join(", ")
          : "(none — instrument the workload with deoptkit/harness)"
      }`
    };
  }
  const fromTime =
    window.fromMark === undefined
      ? -Infinity
      : (model.markers.find(({ label }) => label === window.fromMark)?.time ??
        -Infinity);
  const toTime =
    window.toMark === undefined
      ? Infinity
      : (model.markers.findLast(({ label }) => label === window.toMark)?.time ??
        Infinity);
  return { fromTime, toTime };
};

const inRange = (time: number, { fromTime, toTime }: ResolvedWindow): boolean =>
  time >= fromTime && time <= toTime;

/**
 * Rebuild a tick row from a sample's function key, the inverse of the parser's
 * `${functionName}|${file}|${line}|${column}`. Splits from the right so any extra
 * leading segments stay part of the name.
 */
export const rowFromKey = (key: string): FunctionTicks => {
  const segments = key.split("|");
  const column = segments.pop();
  const line = segments.pop();
  const file = segments.pop();
  const position = (segment: string | undefined): number | undefined =>
    segment === undefined || segment === "undefined"
      ? undefined
      : Number(segment);
  return {
    functionName: segments.join("|"),
    file: file === "undefined" ? undefined : file,
    line: position(line),
    column: position(column),
    selfTicks: 0,
    totalTicks: 0
  };
};

/** Recount the profile from the samples inside the window, ranked like the parser's. */
const windowProfile = (
  profile: ProfileModel,
  window: ResolvedWindow
): ProfileModel => {
  const samples = profile.samples.filter(({ time }) => inRange(time, window));
  const vmStates: Record<string, number> = {};
  const rows = new Map<string, FunctionTicks>();
  const rowFor = (key: string): FunctionTicks => {
    let row = rows.get(key);
    if (!row) {
      row = rowFromKey(key);
      rows.set(key, row);
    }
    return row;
  };
  for (const sample of samples) {
    vmStates[sample.vmState] = (vmStates[sample.vmState] ?? 0) + 1;
    if (sample.self !== undefined) rowFor(sample.self).selfTicks += 1;
    for (const key of sample.onStack) rowFor(key).totalTicks += 1;
  }
  return {
    tickCount: samples.length,
    vmStates,
    functions: [...rows.values()].sort((a, b) => b.selfTicks - a.selfTicks),
    samples
  };
};

/**
 * Project a model onto a time window: IC, deopt, and map transition events outside
 * the range drop, per-site aggregates recompute, and sites left with no events
 * disappear. Profile ticks are recounted from the samples inside the range, so heat
 * (and therefore finding severity) reflects the window. The map entry registry
 * passes through unwindowed — it is reference material for get_map.
 */
export const applyWindow = (
  model: LogModel,
  window: ResolvedWindow
): LogModel => ({
  ...model,
  ics: model.ics
    .map((site) => {
      const transitions = site.transitions.filter(({ time }) =>
        inRange(time, window)
      );
      const worstState = transitions.reduce<IcState>(
        (worst, { newState }) =>
          icStateRank(newState) > icStateRank(worst) ? newState : worst,
        "no_feedback"
      );
      return { ...site, transitions, worstState };
    })
    .filter((site) => site.transitions.length > 0),
  deopts: model.deopts
    .map((site) => {
      const events = site.events.filter(({ time }) => inRange(time, window));
      const reasons = [
        ...new Set(
          events.map(({ reason }) => reason).filter((reason) => reason !== "")
        )
      ];
      return {
        ...site,
        events,
        count: events.length,
        inlinedCount: events.filter((event) => event.inlinedAt !== undefined)
          .length,
        reasons,
        firstTime: events[0]?.time ?? site.firstTime,
        lastTime: events.at(-1)?.time ?? site.lastTime
      };
    })
    .filter((site) => site.events.length > 0),
  maps: {
    ...model.maps,
    transitionSites: model.maps.transitionSites
      .map((site) => {
        const events = site.events.filter(({ time }) => inRange(time, window));
        const propertyNames = [
          ...new Set(
            events
              .map(({ propertyName }) => propertyName)
              .filter((name): name is string => name !== undefined)
          )
        ];
        return { ...site, events, count: events.length, propertyNames };
      })
      .filter((site) => site.events.length > 0)
  },
  profile: windowProfile(model.profile, window)
});
