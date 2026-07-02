import type {
  DeoptKind,
  DeoptSite,
  IcSite,
  IcState,
  LogModel
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
    codeEntryCount: codeMap.count,
    warnings: {
      unknownCommands: Object.fromEntries(warnings.unknownCommands),
      badLines: warnings.badLines
    }
  };
};
