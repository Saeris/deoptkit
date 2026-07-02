import type {
  CodeEntry,
  DeoptKind,
  DeoptSite,
  FunctionTicks,
  IcSite,
  IcState,
  LogModel,
  MapEntry,
  MapTransitionSite
} from "../model/logModel";
import { icStateRank, parseIcState } from "../model/logModel";
import { CodeMap } from "./codeMap";
import { readLog } from "./logReader";

/** IC event commands as emitted by `--log-ic` on modern V8. */
const IC_COMMANDS = [
  "LoadIC",
  "StoreIC",
  "KeyedLoadIC",
  "KeyedStoreIC",
  "LoadGlobalIC",
  "StoreGlobalIC",
  "StoreInArrayLiteralIC"
] as const;

/** Trailing `url:line:column` in a code entry name, e.g. `getX file:///a/b.js:6:14`. */
const SOURCE_REF_RE = /^(?<file>.+):(?<line>\d+):(?<column>\d+)$/u;

/** Deopt location field, e.g. `<file:///a/b.js:23:1>`. */
const DEOPT_LOCATION_RE = /^<(?<file>.+):(?<line>\d+):(?<column>\d+)>$/u;

/** V8 StateTag order as logged in tick events' vmstate field. */
const VM_STATES = [
  "js",
  "gc",
  "parser",
  "bytecode_compiler",
  "compiler",
  "other",
  "external",
  "atomics_wait",
  "idle",
  "logging"
] as const;

const vmStateLabel = (raw: string | undefined): string =>
  VM_STATES[Number(raw)] ?? `state${raw}`;

const splitEntryName = (
  name: string
): {
  functionName: string;
  file: string | undefined;
  line: number | undefined;
  column: number | undefined;
} => {
  const spaceIndex = name.lastIndexOf(" ");
  if (spaceIndex !== -1) {
    const match = SOURCE_REF_RE.exec(name.slice(spaceIndex + 1));
    if (match?.groups) {
      return {
        functionName: name.slice(0, spaceIndex),
        file: match.groups["file"],
        line: Number(match.groups["line"]),
        column: Number(match.groups["column"])
      };
    }
  }
  return {
    functionName: name,
    file: undefined,
    line: undefined,
    column: undefined
  };
};

const parseDeoptKind = (raw: string): DeoptKind => {
  const kind = raw.replace(/^deopt-/u, "");
  return kind === "eager" || kind === "lazy" || kind === "soft"
    ? kind
    : "unknown";
};

/** Parse a v8.log into the queryable model. Unknown events are counted, never fatal. */
export const parseLog = async (path: string): Promise<LogModel> => {
  let v8Version = "unknown";
  const codeMap = new CodeMap();
  const icSites = new Map<string, IcSite>();
  const deoptSites = new Map<string, DeoptSite>();
  let mapsCreated = 0;
  const mapEntries = new Map<string, MapEntry>();
  const mapEventCounts: Record<string, number> = {};
  const transitionSites = new Map<string, MapTransitionSite>();
  let tickCount = 0;
  const vmStates: Record<string, number> = {};
  const functionTicks = new Map<string, FunctionTicks>();

  /** Merge all optimization tiers of a function into one row keyed by source identity. */
  const tickRowFor = (entry: CodeEntry): FunctionTicks => {
    const key = `${entry.functionName}|${entry.file}|${entry.line}|${entry.column}`;
    let row = functionTicks.get(key);
    if (!row) {
      row = {
        functionName: entry.functionName,
        file: entry.file,
        line: entry.line,
        column: entry.column,
        selfTicks: 0,
        totalTicks: 0
      };
      functionTicks.set(key, row);
    }
    return row;
  };

  /** Stack fields are absolute (`0x...`) or relative (`+n`/`-n`) to the previous frame. */
  const parseStackAddress = (
    field: string,
    previous: bigint
  ): bigint | undefined => {
    if (field.startsWith("0x") || field.startsWith("0X")) return BigInt(field);
    if (field.startsWith("+") || field.startsWith("-"))
      return previous + BigInt(field);
    return undefined;
  };

  const freshMapEntry = (address: string, time: number): MapEntry => ({
    address,
    createdAt: time,
    details: undefined,
    parent: undefined,
    subtype: undefined,
    propertyName: undefined
  });

  /** Get-or-create: `map`/`map-details` events may reference maps created before logging began. */
  const upsertMapEntry = (address: string, time: number): MapEntry => {
    let entry = mapEntries.get(address);
    if (!entry) {
      entry = freshMapEntry(address, time);
      mapEntries.set(address, entry);
    }
    return entry;
  };

  const handleIc =
    (type: string) =>
    ([pc, time, line, column, oldState, newState, mapAddress, key]: Array<
      string | undefined
    >): void => {
      const parsedOld = parseIcState(oldState ?? "");
      const parsedNew = parseIcState(newState ?? "");
      if (!parsedOld || !parsedNew)
        throw new Error(`unrecognized IC state: ${oldState}->${newState}`);
      const code = codeMap.find(BigInt(pc ?? "0"));
      const siteKey = `${type}|${code?.file ?? "?"}|${line}|${column}|${key}`;
      let site = icSites.get(siteKey);
      if (!site) {
        site = {
          type,
          file: code?.file,
          functionName: code?.functionName,
          line: Number(line),
          column: Number(column),
          key: key ?? "",
          worstState: parsedNew,
          transitions: []
        };
        icSites.set(siteKey, site);
      }
      site.transitions.push({
        time: Number(time),
        oldState: parsedOld,
        newState: parsedNew,
        mapAddress: mapAddress ?? ""
      });
      if (icStateRank(parsedNew) > icStateRank(site.worstState))
        site.worstState = parsedNew;
    };

  const icHandlers = Object.fromEntries(
    IC_COMMANDS.map((command) => [command, handleIc(command)])
  );

  const warnings = await readLog(path, {
    ...icHandlers,
    "v8-version": (args): void => {
      v8Version = args.filter((field) => field !== "").join(".");
    },
    "code-creation": ([kind, _kindNum, _time, start, size, name]): void => {
      codeMap.add({
        start: BigInt(start ?? "0"),
        size: Number(size),
        kind: kind ?? "unknown",
        ...splitEntryName(name ?? "")
      });
    },
    "code-deopt": ([
      time,
      _size,
      _address,
      _inliningId,
      _scriptOffset,
      kind,
      location,
      reason
    ]): void => {
      const match = DEOPT_LOCATION_RE.exec(location ?? "");
      if (!match?.groups)
        throw new Error(`unrecognized deopt location: ${location}`);
      const file = match.groups["file"] ?? "";
      const line = match.groups["line"] ?? "";
      const column = match.groups["column"] ?? "";
      const parsedKind = parseDeoptKind(kind ?? "");
      const siteKey = `${parsedKind}|${file}|${line}|${column}`;
      const timestamp = Number(time);
      let site = deoptSites.get(siteKey);
      if (!site) {
        site = {
          file,
          line: Number(line),
          column: Number(column),
          kind: parsedKind,
          reasons: [],
          count: 0,
          firstTime: timestamp,
          lastTime: timestamp
        };
        deoptSites.set(siteKey, site);
      }
      site.count += 1;
      site.lastTime = Math.max(site.lastTime, timestamp);
      site.firstTime = Math.min(site.firstTime, timestamp);
      if (reason && !site.reasons.includes(reason)) site.reasons.push(reason);
    },
    "map-create": ([time, address]): void => {
      mapsCreated += 1;
      // A create at a seen address means V8 reused it after GC; the fresh entry wins.
      mapEntries.set(address ?? "", freshMapEntry(address ?? "", Number(time)));
    },
    map: ([subtype, time, from, to, pc, line, column, , name]): void => {
      const kind = subtype ?? "unknown";
      mapEventCounts[kind] = (mapEventCounts[kind] ?? 0) + 1;
      const timestamp = Number(time);
      const entry = upsertMapEntry(to ?? "", timestamp);
      entry.subtype = kind;
      entry.propertyName = name === "" ? undefined : name;
      if (from && from !== "0x000000000000") entry.parent = from;

      const address = BigInt(pc ?? "0");
      if (address === 0n) return;
      const code = codeMap.find(address);
      const siteKey = `${code?.file ?? "?"}|${line}|${column}`;
      let site = transitionSites.get(siteKey);
      if (!site) {
        site = {
          file: code?.file,
          functionName: code?.functionName,
          line: Number(line),
          column: Number(column),
          propertyNames: [],
          count: 0
        };
        transitionSites.set(siteKey, site);
      }
      site.count += 1;
      if (name && !site.propertyNames.includes(name))
        site.propertyNames.push(name);
    },
    "map-details": ([time, address, details]): void => {
      upsertMapEntry(address ?? "", Number(time)).details = details;
    },
    tick: ([
      pc,
      _time,
      _isExternal,
      _tosOrExternal,
      vmState,
      ...stack
    ]): void => {
      tickCount += 1;
      const state = vmStateLabel(vmState);
      vmStates[state] = (vmStates[state] ?? 0) + 1;

      let previous = BigInt(pc ?? "0");
      const top = codeMap.find(previous);
      if (top) tickRowFor(top).selfTicks += 1;

      // Total ticks count each function once per sample, however often it recurs.
      const onStack = new Set<FunctionTicks>();
      if (top) onStack.add(tickRowFor(top));
      for (const field of stack) {
        const address = parseStackAddress(field ?? "", previous);
        if (address === undefined) continue;
        previous = address;
        const entry = codeMap.find(address);
        if (entry) onStack.add(tickRowFor(entry));
      }
      for (const row of onStack) row.totalTicks += 1;
    },
    "code-move": ([from, to]): void => {
      codeMap.move(BigInt(from ?? "0"), BigInt(to ?? "0"));
    },
    "code-delete": ([address]): void => {
      codeMap.delete(BigInt(address ?? "0"));
    }
  });

  const worstFirst = (
    a: { worstState: IcState },
    b: { worstState: IcState }
  ): number => icStateRank(b.worstState) - icStateRank(a.worstState);

  return {
    v8Version,
    ics: [...icSites.values()].sort(worstFirst),
    deopts: [...deoptSites.values()].sort((a, b) => b.count - a.count),
    maps: {
      createdCount: mapsCreated,
      entries: mapEntries,
      eventCounts: mapEventCounts,
      transitionSites: [...transitionSites.values()].sort(
        (a, b) => b.count - a.count
      )
    },
    profile: {
      tickCount,
      vmStates,
      functions: [...functionTicks.values()].sort(
        (a, b) => b.selfTicks - a.selfTicks
      )
    },
    codeEntryCount: codeMap.count,
    warnings: {
      unknownCommands: Object.fromEntries(warnings.unknownCommands),
      badLines: warnings.badLines
    }
  };
};
