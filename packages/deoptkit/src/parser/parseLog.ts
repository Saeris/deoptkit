import type {
  CodeEntry,
  DeoptKind,
  DeoptSite,
  FunctionInfo,
  FunctionTicks,
  IcSite,
  IcState,
  LogModel,
  MapEntry,
  MapTransitionSite,
  Marker,
  SourcePosition,
  TickSample
} from "../model/logModel";
import { icStateRank, parseIcState } from "../model/logModel";
import { CodeMap } from "./codeMap";
import { readLog } from "./logReader";
import { decodeSourceInfo, positionAt, ScriptPositions } from "./sourceInfo";

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

/**
 * Loaders append cache-busting queries to file URLs (Vitest `?vitest=<ts>`, Vite
 * `?t=`); they do not identify a different script, so drop them at the model
 * boundary. Non-file URLs pass through untouched.
 */
export const normalizeScriptUrl = (url: string): string => {
  if (!url.startsWith("file:")) return url;
  const cut = url.search(/[?#]/u);
  return cut === -1 ? url : url.slice(0, cut);
};

const DEOPT_POSITION_RE = /^<(?<file>.+):(?<line>\d+):(?<column>\d+)>$/u;

/**
 * V8 writes a deopt location as `<url:line:col>` and, for code inlined into a
 * caller, appends ` inlined at <url:line:col>` once per inlining level. The first
 * segment is the deopting expression; the rest is the caller chain, innermost first.
 */
export const parseDeoptLocation = (
  location: string
): { site: SourcePosition; inlinedAt: SourcePosition[] } | undefined => {
  const positions: SourcePosition[] = [];
  for (const segment of location.split(" inlined at ")) {
    const match = DEOPT_POSITION_RE.exec(segment);
    if (!match?.groups) return undefined;
    positions.push({
      file: normalizeScriptUrl(match.groups["file"] ?? ""),
      line: Number(match.groups["line"]),
      column: Number(match.groups["column"])
    });
  }
  const [site, ...inlinedAt] = positions;
  return { site, inlinedAt };
};

/**
 * Harness marker functions from `deoptkit/harness`. Eval'd functions carry an empty
 * file ref (` :1:38`), so the label ends at the last `__` before the space or end.
 */
const MARKER_NAME_RE = /^__DEOPT_MARK__(?<label>.+)__(?: |$)/u;

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
        file: normalizeScriptUrl(match.groups["file"] ?? ""),
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

/** Source identity of a function, as named by its `code-creation` line. */
interface FunctionIdentity {
  functionName: string;
  file: string | undefined;
  line: number | undefined;
  column: number | undefined;
}

/** A function a pc executes in; code inlined into a caller yields one frame per level. */
interface Frame extends FunctionIdentity {
  /** Where inside that function the pc is, when the script's source is known. */
  at: { line: number; column: number } | undefined;
}

/** Bound on the inlining walk, so a malformed parent chain cannot loop forever. */
const MAX_INLINING_DEPTH = 64;

/** TurboFan (`*`) or Maglev (`+`) code, whose logged pcs are machine-code addresses. */
const isOptimizedMachineCode = (entry: CodeEntry): boolean =>
  entry.marker !== undefined && /[*+]/u.test(entry.marker);

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
  const samples: TickSample[] = [];
  const scripts = new Map<string, string>();
  const functionIndex = new Map<string, FunctionInfo>();
  const markers: Marker[] = [];
  /** SharedFunctionInfo address -> function; inlining tables name inlined functions by sfi. */
  const sfiIndex = new Map<string, FunctionIdentity>();
  let codeSourceInfoCount = 0;
  const scriptPositions = new Map<string, ScriptPositions>();

  /** Line table of a script, built on first use from its logged source. */
  const positionsFor = (
    url: string | undefined
  ): ScriptPositions | undefined => {
    if (url === undefined) return undefined;
    let positions = scriptPositions.get(url);
    if (!positions) {
      const source = scripts.get(url);
      if (source === undefined) return undefined;
      positions = new ScriptPositions(source);
      scriptPositions.set(url, positions);
    }
    return positions;
  };

  /** Frames for a pc, innermost first: inlined functions (via the entry's tables) then the entry's own function. */
  const resolvePc = (
    pc: bigint,
    kind: "sampled" | "return"
  ): { entry: CodeEntry; frames: Frame[] } | undefined => {
    const entry = codeMap.find(pc);
    if (!entry) return undefined;
    const own = (at: Frame["at"]): Frame => ({
      functionName: entry.functionName,
      file: entry.file,
      line: entry.line,
      column: entry.column,
      at
    });
    // For TurboFan and Maglev code an IC or map event's pc and every non-top sampled
    // frame are return addresses, one instruction past the call, and V8 resolves them
    // one byte back; interpreted and baseline frames log bytecode positions, which are
    // exact, and the top sampled pc is exact too.
    const raw = Number(pc - entry.start);
    const offset =
      kind === "return" && isOptimizedMachineCode(entry)
        ? Math.max(0, raw - 1)
        : raw;
    const { source } = entry;
    const position =
      source === undefined ? undefined : positionAt(source, offset);
    if (source === undefined || position === undefined)
      return { entry, frames: [own(undefined)] };
    const frames: Frame[] = [];
    let { scriptOffset, inliningId: id } = position;
    for (let steps = 0; id >= 0 && steps < MAX_INLINING_DEPTH; steps += 1) {
      const inlined = source.inlining.at(id);
      if (!inlined) break;
      const sfi =
        inlined.functionIndex === undefined
          ? undefined
          : source.inlinedSfis[inlined.functionIndex];
      const info = sfi === undefined ? undefined : sfiIndex.get(sfi);
      frames.push({
        ...(info ?? {
          functionName: "(inlined)",
          file: entry.file,
          line: undefined,
          column: undefined
        }),
        at: positionsFor(info?.file ?? entry.file)?.at(scriptOffset)
      });
      // The call site is a position in the parent: the enclosing inlined function, or
      // the code object's own function once the chain runs out.
      scriptOffset = inlined.scriptOffset;
      id = inlined.parent ?? -1;
    }
    frames.push(own(positionsFor(entry.file)?.at(scriptOffset)));
    return { entry, frames };
  };

  /**
   * Where an IC or map event happened. V8 logs the caller's code address for inlined
   * code and resolves the line/column against the caller's script, so for an inlined
   * pc the innermost frame's own position replaces the logged one.
   */
  const eventSite = (
    pc: bigint,
    line: string | undefined,
    column: string | undefined
  ): {
    file: string | undefined;
    functionName: string | undefined;
    line: number;
    column: number;
  } => {
    const resolved = resolvePc(pc, "return");
    const frame = resolved?.frames.at(0);
    if (resolved && resolved.frames.length > 1 && frame?.at) {
      return {
        file: frame.file,
        functionName: frame.functionName,
        line: frame.at.line,
        column: frame.at.column
      };
    }
    return {
      file: resolved?.entry.file,
      functionName: resolved?.entry.functionName,
      line: Number(line),
      column: Number(column)
    };
  };

  /**
   * Name of the function whose start is the closest one at or before a position in
   * the same file. The index has no end positions, so this is a heuristic.
   */
  const enclosingFunctionName = (
    file: string,
    line: number,
    column: number
  ): string | undefined => {
    let best: FunctionInfo | undefined;
    for (const info of functionIndex.values()) {
      if (info.file !== file) continue;
      if (info.line > line || (info.line === line && info.column > column))
        continue;
      if (
        !best ||
        info.line > best.line ||
        (info.line === best.line && info.column > best.column)
      )
        best = info;
    }
    return best?.functionName;
  };

  /** Source identity of a function; tick rows and retained samples share this key. */
  const functionKey = (entry: FunctionIdentity): string =>
    `${entry.functionName}|${entry.file}|${entry.line}|${entry.column}`;

  /** Merge all optimization tiers of a function into one row keyed by source identity. */
  const tickRowFor = (entry: FunctionIdentity): FunctionTicks => {
    const key = functionKey(entry);
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
      const at = eventSite(BigInt(pc ?? "0"), line, column);
      const siteKey = `${type}|${at.file ?? "?"}|${at.line}|${at.column}|${key}`;
      let site = icSites.get(siteKey);
      if (!site) {
        site = {
          type,
          file: at.file,
          functionName: at.functionName,
          line: at.line,
          column: at.column,
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
    "code-creation": ([
      kind,
      kindNum,
      time,
      start,
      size,
      name,
      sfi,
      tierMarker
    ]): void => {
      const marker = MARKER_NAME_RE.exec(name ?? "");
      if (marker?.groups) {
        // Harness markers are 2-byte eval'd no-ops; keep them out of the code map
        // and function index so they never pollute attribution or findings.
        markers.push({
          label: marker.groups["label"] ?? "",
          time: Number(time)
        });
        return;
      }
      const entry: CodeEntry = {
        start: BigInt(start ?? "0"),
        size: Number(size),
        kind: kind ?? "unknown",
        ...splitEntryName(name ?? "")
      };
      codeMap.add(entry);
      if (kind !== "JS") return;
      entry.sfi = sfi;
      entry.marker = tierMarker;
      // First tier wins; every tier of a function names the same function.
      if (sfi !== undefined && !sfiIndex.has(sfi)) {
        sfiIndex.set(sfi, {
          functionName: entry.functionName,
          file: entry.file,
          line: entry.line,
          column: entry.column
        });
      }
      if (entry.file === undefined || entry.line === undefined) return;
      const key = `${entry.functionName}|${entry.file}|${entry.line}|${entry.column}`;
      let info = functionIndex.get(key);
      if (!info) {
        info = {
          functionName: entry.functionName,
          file: entry.file,
          line: entry.line,
          column: entry.column ?? 0,
          tiers: [],
          codeCreations: 0
        };
        functionIndex.set(key, info);
      }
      info.codeCreations += 1;
      const tier = Number(kindNum);
      if (!info.tiers.includes(tier)) info.tiers.push(tier);
    },
    "script-source": ([, url, source]): void => {
      if (url === undefined || source === undefined) return;
      const normalized = normalizeScriptUrl(url);
      scripts.set(normalized, source);
      scriptPositions.delete(normalized);
    },
    "sfi-move": ([from, to]): void => {
      // Keep the old key: tables logged before the move still reference it.
      const info = from === undefined ? undefined : sfiIndex.get(from);
      if (info && to) sfiIndex.set(to, info);
    },
    "code-source-info": ([
      address,
      scriptId,
      _startPos,
      _endPos,
      positions,
      inlining,
      inlinedSfis
    ]): void => {
      const entry = codeMap.at(BigInt(address ?? "0"));
      if (!entry) return;
      entry.source = decodeSourceInfo(
        scriptId ?? "",
        positions ?? "",
        inlining ?? "",
        inlinedSfis ?? ""
      );
      codeSourceInfoCount += 1;
    },
    "code-deopt": ([
      time,
      _size,
      address,
      inliningId,
      _scriptOffset,
      kind,
      location,
      reason
    ]): void => {
      const parsed = parseDeoptLocation(location ?? "");
      if (!parsed) throw new Error(`unrecognized deopt location: ${location}`);
      const { site: position, inlinedAt } = parsed;
      const parsedKind = parseDeoptKind(kind ?? "");
      const siteKey = `${parsedKind}|${position.file}|${position.line}|${position.column}`;
      const timestamp = Number(time);
      // The logged address is the deopting code object; a non-negative inlining id
      // names the inlined function, through the object's tables, that holds the position.
      const entry = codeMap.find(BigInt(address ?? "0"));
      const id = Number(inliningId);
      const inlined =
        entry?.source && id >= 0 ? entry.source.inlining[id] : undefined;
      const sfi =
        inlined?.functionIndex === undefined
          ? undefined
          : entry?.source?.inlinedSfis[inlined.functionIndex];
      const functionName =
        (id < 0
          ? entry?.functionName
          : sfi === undefined
            ? undefined
            : sfiIndex.get(sfi)?.functionName) ??
        enclosingFunctionName(position.file, position.line, position.column);
      let site = deoptSites.get(siteKey);
      if (!site) {
        site = {
          ...position,
          functionName,
          kind: parsedKind,
          reasons: [],
          count: 0,
          inlinedCount: 0,
          firstTime: timestamp,
          lastTime: timestamp,
          events: []
        };
        deoptSites.set(siteKey, site);
      }
      site.functionName ??= functionName;
      site.count += 1;
      if (inlinedAt.length > 0) site.inlinedCount += 1;
      site.lastTime = Math.max(site.lastTime, timestamp);
      site.firstTime = Math.min(site.firstTime, timestamp);
      site.events.push({
        time: timestamp,
        reason: reason ?? "",
        ...(inlinedAt.length > 0 ? { inlinedAt } : {})
      });
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
      const at = eventSite(address, line, column);
      const siteKey = `${at.file ?? "?"}|${at.line}|${at.column}`;
      let site = transitionSites.get(siteKey);
      if (!site) {
        site = {
          file: at.file,
          functionName: at.functionName,
          line: at.line,
          column: at.column,
          propertyNames: [],
          count: 0,
          events: []
        };
        transitionSites.set(siteKey, site);
      }
      site.count += 1;
      site.events.push({
        time: timestamp,
        propertyName: name === "" ? undefined : name
      });
      if (name && !site.propertyNames.includes(name))
        site.propertyNames.push(name);
    },
    "map-details": ([time, address, details]): void => {
      upsertMapEntry(address ?? "", Number(time)).details = details;
    },
    tick: ([
      pc,
      time,
      _isExternal,
      _tosOrExternal,
      vmState,
      ...stack
    ]): void => {
      tickCount += 1;
      const state = vmStateLabel(vmState);
      vmStates[state] = (vmStates[state] ?? 0) + 1;

      let previous = BigInt(pc ?? "0");
      // Inlined code runs under the caller's code address; the innermost frame is the
      // function actually executing, so it gets the self tick.
      const top = resolvePc(previous, "sampled")?.frames ?? [];
      const self = top.at(0);
      if (self) tickRowFor(self).selfTicks += 1;

      // Total ticks count each function once per sample, however often it recurs.
      // Keyed by function key; insertion order keeps the stack innermost first.
      const onStack = new Map<string, FunctionTicks>();
      const pushFrames = (frames: Frame[]): void => {
        for (const frame of frames)
          onStack.set(functionKey(frame), tickRowFor(frame));
      };
      pushFrames(top);
      for (const field of stack) {
        const address = parseStackAddress(field ?? "", previous);
        if (address === undefined) continue;
        previous = address;
        pushFrames(resolvePc(address, "return")?.frames ?? []);
      }
      for (const row of onStack.values()) row.totalTicks += 1;
      samples.push({
        time: Number(time),
        vmState: state,
        self: self ? functionKey(self) : undefined,
        onStack: [...onStack.keys()]
      });
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
      ),
      samples
    },
    scripts,
    functionIndex: [...functionIndex.values()],
    markers,
    codeEntryCount: codeMap.count,
    codeSourceInfoCount,
    warnings: {
      unknownCommands: Object.fromEntries(warnings.unknownCommands),
      badLines: warnings.badLines
    }
  };
};
