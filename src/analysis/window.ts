import type { IcState, LogModel } from "../model/logModel";
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
 * Project a model onto a time window for the structural signals (ICs, deopts, map
 * transitions): events outside the range drop, per-site aggregates recompute, and
 * sites left with no events disappear. Timing data (profile ticks) and the map entry
 * registry pass through unwindowed — ticks carry no per-sample retention in the model
 * and the registry is reference material for get_map.
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
  }
});
