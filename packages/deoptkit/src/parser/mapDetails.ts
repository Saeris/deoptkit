/** One entry of a map's descriptor array: a named property of the shape, in order. */
export interface MapProperty {
  index: number;
  /** Property name; symbols as `Symbol(description)`. */
  name: string;
  kind: "data" | "accessor";
  /** `field` (stored in the object) or `descriptor` (stored in the map). */
  location: "field" | "descriptor";
  constant: boolean;
  /** The number after `field`: the field index before V8 15.6, its word offset from then on. */
  fieldIndex: number | undefined;
  representation:
    | "smi"
    | "heap-object"
    | "tagged"
    | "double"
    | "none"
    | undefined;
  writable: boolean;
  enumerable: boolean;
  configurable: boolean;
  fieldType: string | undefined;
}

/** One outgoing transition V8 printed for a map: the child shape and what produced it. */
export interface MapTransitionEntry {
  /** Property added (symbols as `Symbol(description)`), the new prototype's function name for prototype transitions, or `""`. */
  name: string;
  kind: "data" | "accessor" | "frozen" | "elements" | "prototype" | "other";
  /** Target map address (`0x...`). */
  to: string;
}

/** A parsed `map-details` block: the hidden class V8 printed (Map::MapPrint). */
export interface MapDetails {
  type: string;
  instanceSize: number | undefined;
  inobjectProperties: number | undefined;
  unusedPropertyFields: number | undefined;
  elementsKind: string | undefined;
  flags: string[];
  /** Parent map address (`0x...`) or undefined at the root. */
  backPointer: string | undefined;
  prototype: string | undefined;
  constructorName: string | undefined;
  descriptorCount: number | undefined;
  properties: MapProperty[];
  /** Child maps already reachable from this one when V8 printed it. */
  transitions: MapTransitionEntry[];
  /** Count from the `Prototype transitions #N:` line, when printed. */
  prototypeTransitions: number | undefined;
  /** Lines the parser did not understand, counted so format drift is visible. */
  unparsedLines: number;
}

/**
 * The block's first line: `000003D63A387389: [Map] in OldSpace` on Windows, where the C++
 * stream prints a pointer as 16 upper-case digits, `0x3d63a387389: [Map] in OldSpace` on
 * Linux; meta maps print `[MetaMap]`, and V8 15.6 prints maps with interceptors (Node's
 * `process`, the global object) as `[ExtendedMap]`.
 */
const HEADER_RE = /^(?:0x)?[0-9A-Fa-f]+: \[(?:Meta|Extended)?Map\] in \S+$/u;

/** ` -------`: the rule V8 15.6 prints before an extended map's extra fields. */
const SECTION_RULE_RE = /^ -+$/u;

/** ` - instance size: 32` and the other keyed header lines. */
const KEY_VALUE_RE = /^ - (?<key>[^:]+): ?(?<value>.*)$/u;

/** ` - stable_map`, ` - non-extensible`: header flags carry no colon. */
const FLAG_RE = /^ - (?<flag>[\w-]+)$/u;

/**
 * `  [0]: <addr>: [String] in <space>: #id (<details>) @ Any`, or a `<Symbol: ...>` key.
 * The symbol alternative comes first so a private name (`<Symbol: #compare>`) is not
 * read as a string key named `compare>`.
 */
const DESCRIPTOR_RE =
  /^\s*\[(?<index>\d+)\]: .*?(?:<(?:Private)?Symbol: (?<symbol>[^>]*)>|\[String\] in \S+: #(?<name>\S+)) \((?<details>[^)]*)\)(?: @ (?<fieldType>.*))?$/u;

/**
 * `const data field 0:s, p: 0, attrs: [WEC]` (PropertyDetails::PrintAsFastTo). V8 15.6
 * (Node 27) adds where the field lives, `in-obj` or `ooo`, after the representation.
 */
const PROPERTY_DETAILS_RE =
  /^(?<constant>const )?(?<form>data field|data descriptor|accessor descriptor|accessor)(?: (?<fieldIndex>\d+))?(?::(?<representation>[a-z]))?(?:, (?:in-obj|ooo))?(?:, p: \d+)?, attrs: \[(?<attrs>[W_][E_][C_])\]$/u;

/** `0x027727b2aa51 <Map[32](HOLEY_ELEMENTS)>`: an address and V8's short print of it. */
const REFERENCE_RE = /^(?<address>\S+) <(?<print>.*)>$/u;

const INSTANCE_DESCRIPTORS_RE =
  /^instance descriptors(?: \((?:own|shared)\))? #(?<count>\d+)$/u;

const CONSTRUCTOR_NAME_RE = /<JSFunction (?<name>[^\s(]+) \(/u;

/**
 * ` - transitions #N: ...` opens the transition listing: a single (weak) transition is
 * printed directly below it, a full array under a `Transitions #N:` line.
 */
const TRANSITIONS_FIELD_RE = /^transitions #\d+$/u;

const TRANSITIONS_HEADER_RE = /^\s+Transitions #\d+:$/u;

const PROTOTYPE_TRANSITIONS_RE = /^\s+Prototype transitions #(?<count>\d+):/u;

/** Every transition entry ends `-> 0x<target> <Map[...]>`; the last arrow names the target. */
const TRANSITION_TARGET_RE = /^\s+.* -> (?<to>0x[0-9A-Fa-f]+)\b/u;

/** `<addr>: [String] in OldSpace: #x: (transition to ...)` or `0x... <Symbol: ...>: (transition to ...)`. */
const TRANSITION_KEY_RE =
  /^\s+\S+ (?:<(?:Private)?Symbol: (?<symbol>[^>]*)>|\[String\] in \S+: #(?<name>\S+)): \(transition to (?<details>\([^)]*\)|[^)]*)/u;

/** Prototype transitions print the new prototype: `0x... <JSFunction Error (sfi = ...)> -> 0x...`. */
const PROTOTYPE_ENTRY_RE = /^\s+0x[0-9A-Fa-f]+ <JSFunction (?<name>[^\s(]*)/u;

const REPRESENTATIONS: Record<string, MapProperty["representation"]> = {
  s: "smi",
  h: "heap-object",
  t: "tagged",
  d: "double",
  v: "none"
};

const integer = (value: string): number | undefined =>
  /^\d+$/u.test(value) ? Number(value) : undefined;

/** The address of a reference, or undefined when V8 printed `<undefined>`/`<null>`. */
const referenceAddress = (value: string): string | undefined => {
  const groups = REFERENCE_RE.exec(value)?.groups;
  const print = groups?.["print"];
  if (print === undefined || print === "undefined" || print === "null")
    return undefined;
  return groups?.["address"];
};

const keyName = (
  symbol: string | undefined,
  name: string | undefined
): string => (symbol === undefined ? (name ?? "") : `Symbol(${symbol})`);

const parseProperty = (line: string): MapProperty | undefined => {
  const groups = DESCRIPTOR_RE.exec(line)?.groups;
  if (groups === undefined) return undefined;
  const details = PROPERTY_DETAILS_RE.exec(groups["details"] ?? "")?.groups;
  if (details === undefined) return undefined;
  // Unmatched optional groups are undefined at runtime, though typed as string.
  const form = details["form"] ?? "";
  const attrs = details["attrs"] ?? "___";
  return {
    index: Number(groups["index"]),
    name: keyName(groups["symbol"], groups["name"]),
    kind: form.startsWith("data") ? "data" : "accessor",
    location: form === "data field" ? "field" : "descriptor",
    constant: (details["constant"] ?? "") !== "",
    fieldIndex: integer(details["fieldIndex"] ?? ""),
    representation: REPRESENTATIONS[details["representation"] ?? ""],
    writable: attrs.startsWith("W"),
    enumerable: attrs[1] === "E",
    configurable: attrs[2] === "C",
    fieldType: groups["fieldType"]
  };
};

const parseTransition = (line: string): MapTransitionEntry | undefined => {
  const to = TRANSITION_TARGET_RE.exec(line)?.groups?.["to"];
  if (to === undefined) return undefined;
  const prototype = PROTOTYPE_ENTRY_RE.exec(line)?.groups;
  if (prototype !== undefined)
    return { name: prototype["name"] ?? "", kind: "prototype", to };
  const key = TRANSITION_KEY_RE.exec(line)?.groups;
  if (key === undefined) return { name: "", kind: "other", to };
  const symbol = key["symbol"];
  const details = key["details"] ?? "";
  const kind: MapTransitionEntry["kind"] = details.includes("accessor")
    ? "accessor"
    : details.includes("data field")
      ? "data"
      : symbol === "(frozen_symbol)"
        ? "frozen"
        : symbol === "(elements_transition_symbol)"
          ? "elements"
          : "other";
  return { name: keyName(symbol, key["name"]), kind, to };
};

/**
 * Parse the text V8 writes for `--log-maps-details` (one `map-details` event per map)
 * into its header fields, ordered property descriptors, and printed transitions. Lines
 * that match no known shape are counted rather than dropped, so a V8 format change
 * shows up as data.
 */
export const parseMapDetails = (text: string): MapDetails => {
  const result: MapDetails = {
    type: "",
    instanceSize: undefined,
    inobjectProperties: undefined,
    unusedPropertyFields: undefined,
    elementsKind: undefined,
    flags: [],
    backPointer: undefined,
    prototype: undefined,
    constructorName: undefined,
    descriptorCount: undefined,
    properties: [],
    transitions: [],
    prototypeTransitions: undefined,
    unparsedLines: 0
  };
  let inTransitions = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      inTransitions = false;
      continue;
    }
    if (HEADER_RE.test(line) || SECTION_RULE_RE.test(line)) continue;

    const keyed = KEY_VALUE_RE.exec(line)?.groups;
    if (keyed !== undefined) {
      const key = keyed["key"] ?? "";
      const value = keyed["value"] ?? "";
      inTransitions = TRANSITIONS_FIELD_RE.test(key);
      if (key === "type") result.type = value;
      else if (key === "instance size") result.instanceSize = integer(value);
      else if (key === "inobject properties")
        result.inobjectProperties = integer(value);
      else if (key === "unused property fields")
        result.unusedPropertyFields = integer(value);
      else if (key === "elements kind") result.elementsKind = value;
      else if (key === "back pointer")
        result.backPointer = referenceAddress(value);
      else if (key === "prototype") result.prototype = referenceAddress(value);
      else if (key === "constructor")
        result.constructorName =
          CONSTRUCTOR_NAME_RE.exec(value)?.groups?.["name"];
      else {
        const count = INSTANCE_DESCRIPTORS_RE.exec(key)?.groups?.["count"];
        if (count !== undefined) result.descriptorCount = Number(count);
      }
      continue;
    }

    const flag = FLAG_RE.exec(line)?.groups?.["flag"];
    if (flag !== undefined) {
      inTransitions = false;
      result.flags.push(flag);
      continue;
    }

    if (TRANSITIONS_HEADER_RE.test(line)) {
      inTransitions = true;
      continue;
    }
    const prototypeCount =
      PROTOTYPE_TRANSITIONS_RE.exec(line)?.groups?.["count"];
    if (prototypeCount !== undefined) {
      inTransitions = true;
      result.prototypeTransitions = Number(prototypeCount);
      continue;
    }
    // A descriptor line closes the transition listing.
    if (inTransitions && !/^\s*\[\d+\]:/u.test(line)) {
      const transition = parseTransition(line);
      if (transition === undefined) result.unparsedLines += 1;
      else result.transitions.push(transition);
      continue;
    }
    inTransitions = false;

    const property = parseProperty(line);
    if (property === undefined) result.unparsedLines += 1;
    else result.properties.push(property);
  }
  return result;
};
