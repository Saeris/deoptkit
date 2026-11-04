# Plan 016: Parse `map-details` into structured hidden-class descriptions and show sibling shapes

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1bfded1..HEAD -- packages/deoptkit/src/tools/getMap.ts` must print nothing; plans 014, 017, and 020 may run concurrently and touch other parts of `parseLog.ts`, `logModel.ts`, and `findings.ts`, so for those files compare only the excerpts below and STOP on a mismatch there.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/015-inlining-aware-attribution.md
- **Category**: direction, perf
- **Planned at**: commit `1bfded1`, 2026-11-03

## Why this matters

`get_map` returns the raw `map-details` text block V8 wrote (about 700 bytes of V8 heap dump per map), which an agent has to read line by line, and the parser keeps every block as a string: about 9.7 MB of the 38 MB a fixture session occupies. `docs/SPEC.md` §4 promised parsed properties and a sibling-map diff ("these 12 maps differ only in property order") so that a map-churn finding can name the shapes that diverge. With the descriptor list parsed, `get_map` can answer "which properties does this shape have, in what order, and what do its siblings from the same parent look like", which is exactly the information an agent needs to decide between "initialize in one order" and "split the constructor". Findings gain example map addresses so the agent can reach `get_map` without a `list_ics` round trip.

## Current state

Paths relative to `packages/deoptkit/`, at `1bfded1`.

- `src/parser/parseLog.ts`:
  - lines 581–583: `"map-details": ([time, address, details]): void => { upsertMapEntry(address ?? "", Number(time)).details = details; }`.
  - lines 547–580, the `map` handler (after plan 015): `map: ([subtype, time, from, to, pc, line, column, , name])`; `entry.subtype = kind; entry.propertyName = ...; if (from && from !== "0x000000000000") entry.parent = from;` then transition sites via `eventSite`, with `site.events.push({ time: timestamp, propertyName: name === "" ? undefined : name });`.
  - `freshMapEntry(address, time)` (lines ~203–210) builds `{ address, createdAt, details: undefined, parent: undefined, subtype: undefined, propertyName: undefined }`.
- `src/model/logModel.ts` lines 115–126, `MapEntry { address; createdAt; /** Raw map-details text block, when logged. Parsed lazily by the map tools. */ details: string | undefined; parent; subtype; propertyName }`; lines 128–131 `MapTransitionEvent { time; propertyName }`; `MapsModel.entries: Map<string, MapEntry>`.
- `src/tools/getMap.ts` (78 lines): walks `parent` links up to `MAX_CHAIN = 32`, lists `referencedByIcSites`, returns `{ address, createdAt, subtype, propertyName, parent, transitionChain, referencedByIcSites, details: entry.details }`.
- `src/analysis/findings.ts`: the IC loop's megamorphic evidence `{ icType, key, worstState, transitions, keyedAccess }` (plan 020 changes the keyed variant; plan 012 added `distinctMaps` to `list_ics` only); the churn section (lines 285–360) groups `model.maps.transitionSites` by function, with evidence `{ transitionCount, propertyNames, maxTransitionsPerProperty }`.
- `src/analysis/window.ts` spreads transition sites and filters `events` by time; it must keep working with an extra event field.
- `src/parser/__tests__/parseLog.spec.ts`, test "captures map-details text for later property inspection": `withDetails = entries.filter(({ details }) => details?.includes("[Map]") === true); expect(withDetails.length).toBeGreaterThan(100)`.
- `src/__tests__/server.spec.ts`: the `profile_run` test calls `list_ics` with `includeTransitions` (plan 012) and gets `mapAddresses`.

The `map-details` block format, as V8 14 (Node 26) writes it. The log line is `map-details,<time>,<address>,<text>` where `<text>` is the block with newlines escaped as `\n` and commas as `\x2C`; the CSV reader (`src/parser/csv.ts`) decodes both, so the handler receives the plain block:

```
0000027727B2AA99: [Map] in OldSpace
 - map: 0x01cb0a421c99 <MetaMap (0x01cb0a421d29 <NativeContext[306]>)>
 - type: JS_OBJECT_TYPE
 - instance size: 32
 - inobject properties: 1
 - unused property fields: 0
 - elements kind: HOLEY_ELEMENTS
 - enum length: invalid
 - stable_map
 - back pointer: 0x027727b2aa51 <Map[32](HOLEY_ELEMENTS)>
 - prototype_validity_cell: 0x03d63a381351 <Cell value= [cleared]>
 - instance descriptors (own) #5: 0x03e436c38ce1 <DescriptorArray[5]>
 - prototype: 0x02ac6ebe7af1 <Object map = 000001CB0A422761>
 - constructor: 0x02ac6ebd95c9 <JSFunction Object (sfi = 0000019414A88271)>
 - dependent code: 0x03d63a380df1 <Other heap object (WEAK_ARRAY_LIST_TYPE)>
 - construction counter: 0

  [0]: 000003D63A387389: [String] in ReadOnlySpace: #id (const data field 0:s, p: 0, attrs: [WEC]) @ Any
  [1]: 0000027727B2A729: [String] in OldSpace: #even (const data field 1:h, p: 0, attrs: [WEC]) @ Any
  [2]: 0000027727B2A741: [String] in OldSpace: #third (const data field 2:s, p: 0, attrs: [WEC]) @ Any
  [3]: 0000027727B2A759: [String] in OldSpace: #fifth (const data field 3:h, p: 0, attrs: [WEC]) @ Any
  [4]: 0000027727B2A771: [String] in OldSpace: #seventh (const data field 4:h, p: 0, attrs: [WEC]) @ Any
```

Variants seen across the three fixture logs (counts from `map-churn.log`):

- Flag lines without a colon: ` - stable_map`, ` - dictionary_map`, ` - may_have_interesting_properties`, ` - non-extensible`; V8 can also write ` - deprecated_map`, ` - is_migration_target`, ` - prototype_map`, ` - callable`, ` - undetectable`. Treat every ` - <word>` line without `:` as a flag.
- ` - back pointer: 0x... <Map[32](HOLEY_ELEMENTS)>` or ` - back pointer: 0x... <undefined>` (root of a transition tree).
- ` - prototype: 0x... <Object map = ...>` or ` - prototype: 0x... <null>`.
- ` - constructor: 0x... <JSFunction Object (sfi = ...)>`; the name between `<JSFunction ` and ` (` is the constructor name (`Object`, a class name, ...).
- ` - instance descriptors (own) #N:` or ` - instance descriptors (shared) #N:`; `#N` is the descriptor count.
- Descriptor lines: `  [i]: <ADDR>: [String] in <Space>: #name (<details>) @ <field type>` for string keys, or `  [i]: 0x... <Symbol: Symbol.toStringTag> (<details>) @ <field type>` for symbols (also `<PrivateSymbol: ...>`). The `<details>` forms observed: `const data field 0:s, p: 0, attrs: [WEC]` (23,181 times), `data field 1:h, p: 0, attrs: [WEC]`, `const data field 2:t, ...`, `const accessor descriptor, p: 0, attrs: [__C]`, `const data field, attrs: [WEC]` (no field index/representation; dictionary-mode or constant descriptors), `data field, attrs: [WEC]`. Representation letters after the field index: `s` Smi, `h` heap object, `t` tagged, `d` double, `n` none. `attrs: [WEC]` positions are Writable, Enumerable, Configurable with `_` for absent.
- Non-object maps (strings, symbols, `JS_MODULE_NAMESPACE_TYPE`, ...) have the same header shape and often no descriptor lines.

Conventions: parser helpers live in `src/parser/*.ts` with tests under `src/parser/__tests__/`; tests say why; soft-wrapped markdown.

## Commands you will need

| Purpose                   | Command                                                                                                                                                                         | Expected on success    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Install                   | `vp install`                                                                                                                                                                    | exit 0                 |
| Format + lint + typecheck | `vp check --fix`                                                                                                                                                                | clean                  |
| Specs                     | `vp -C packages/deoptkit test src/parser/__tests__/mapDetails.spec.ts src/parser/__tests__/parseLog.spec.ts src/__tests__/server.spec.ts src/analysis/__tests__/window.spec.ts` | pass                   |
| All tests                 | `vp test`                                                                                                                                                                       | all pass               |
| Memory check (optional)   | `node --expose-gc -e "..."` as described in Step 5                                                                                                                              | lower heap than before |

## Scope

**In scope** (relative to `packages/deoptkit/`):

- `src/parser/mapDetails.ts` (create), `src/parser/__tests__/mapDetails.spec.ts` (create)
- `src/parser/parseLog.ts` (`map-details` handler, the `map` handler's `events.push`, `freshMapEntry`)
- `src/model/logModel.ts` (`MapEntry.details`, `MapTransitionEvent.mapAddress`)
- `src/tools/getMap.ts`
- `src/analysis/findings.ts` (evidence fields only)
- `src/parser/__tests__/parseLog.spec.ts`, `src/__tests__/server.spec.ts`
- `docs/SPEC.md` (one sentence marking the §4 `get_map` row as delivered is optional; skip if unsure)
- `.bumpy/016-map-details.md` (repository root; create)

**Out of scope**:

- `src/analysis/window.ts` (the extra event field passes through its spreads; verify, do not edit).
- Churn thresholds and severity.
- Deopt Explorer's map parser (MIT); write the parser from the format above, do not port.

## Git workflow

- Branch: `exec/plan-016` in a dedicated worktree; stay there.
- One commit: `Parser: structured map-details, sibling shapes in get_map, example maps in findings`.
- Bump file `.bumpy/016-map-details.md`:

  ```markdown
  ---
  "deoptkit": minor
  ---

  `map-details` blocks are parsed at load into structured hidden-class descriptions (type, size, flags, back pointer, constructor, and the ordered property descriptors with representation and attributes) instead of being kept as raw text, which also cuts session memory. `get_map` returns the parsed shape plus its sibling shapes from the same parent with their property lists, and megamorphic and map-churn findings carry example map addresses so an agent can reach `get_map` directly.
  ```

- Do NOT push or open a PR. No attribution lines.

## Steps

### Step 1: The parser

Create `src/parser/mapDetails.ts`:

```ts
export interface MapProperty {
  index: number;
  /** Property name; symbols as `Symbol(description)`. */
  name: string;
  kind: "data" | "accessor";
  /** `field` (stored in the object) or `descriptor` (stored in the map). */
  location: "field" | "descriptor";
  constant: boolean;
  fieldIndex: number | undefined;
  representation: "smi" | "heap-object" | "tagged" | "double" | "none" | undefined;
  writable: boolean;
  enumerable: boolean;
  configurable: boolean;
  fieldType: string | undefined;
}

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
  /** Lines the parser did not understand, counted so format drift is visible. */
  unparsedLines: number;
}

export const parseMapDetails = (text: string): MapDetails
```

Parse line by line: header (`: [Map] in`) sets nothing; ` - key: value` lines fill the typed fields (`type`, `instance size`, `inobject properties`, `unused property fields`, `elements kind`, `back pointer` (address before ` <`; `undefined` when the angle text is `<undefined>`), `prototype` (address, or undefined for `<null>`), `constructor` (name between `<JSFunction ` and ` (`), `instance descriptors (own|shared) #N`); ` - word` lines push `word` to `flags`; descriptor lines match `/^\s*\[(?<index>\d+)\]: (?:.*?: #(?<name>\S+)|.*?<(?:Private)?Symbol: (?<symbol>[^>]*)>) \((?<details>[^)]*)\)(?: @ (?<fieldType>.*))?$/u`, with `details` parsed as: optional `const`, then `data field`/`data descriptor`/`accessor descriptor`/`accessor` (`kind`, `location`), an optional `<fieldIndex>:<repr>`, `p: <n>` ignored, and `attrs: [<W|_><E|_><C|_>]`. Map `s/h/t/d/n` to the representation union. Lines that match nothing increment `unparsedLines`. Keep every regex anchored and tolerant of trailing spaces.

Create `src/parser/__tests__/mapDetails.spec.ts` with the five-property block above (expect `type: "JS_OBJECT_TYPE"`, `instanceSize: 32`, `flags: ["stable_map"]`, `backPointer: "0x027727b2aa51"`, `constructorName: "Object"`, `descriptorCount: 5`, and `properties` names `["id","even","third","fifth","seventh"]`, first property `{ kind: "data", location: "field", constant: true, fieldIndex: 0, representation: "smi", writable: true, enumerable: true, configurable: true, fieldType: "Any" }`, `unparsedLines: 0`), the `JS_MODULE_NAMESPACE_TYPE` block (`flags` contains `dictionary_map` and `non-extensible`, `backPointer` undefined, `prototype` undefined, no properties), a block with the `<Symbol: Symbol.toStringTag>` descriptor and `const accessor descriptor, p: 0, attrs: [__C]` (name `Symbol(Symbol.toStringTag)`, `kind: "accessor"`, `location: "descriptor"`, not writable or enumerable, configurable), and a block containing one unknown line (`unparsedLines: 1`, everything else parsed). Comment: the churn explanation can only name the diverging properties if the descriptors parse; counting unparsed lines keeps V8 format drift visible instead of silent.

**Verify**: `vp -C packages/deoptkit test src/parser/__tests__/mapDetails.spec.ts` → passes.

### Step 2: Model and parser

- `src/model/logModel.ts`: `MapEntry.details: MapDetails | undefined` ("Parsed `map-details` block, when logged"; import the type from `../parser/mapDetails`); `MapTransitionEvent` gains `/** The map the transition produced (`to`), for get_map. */ mapAddress: string;`.
- `src/parser/parseLog.ts`: the `map-details` handler stores `parseMapDetails(details ?? "")` (and, when the entry has no `parent` yet and the parsed `backPointer` is defined, sets `entry.parent = backPointer`, so maps created before logging began still chain); the `map` handler's `site.events.push` gains `mapAddress: to ?? ""`.

**Verify**: `vp check --fix` → clean (it reports any literal that still passes a string `details`; `window.spec.ts` builds no map entries). `vp -C packages/deoptkit test src/analysis/__tests__/window.spec.ts` → passes.

### Step 3: `get_map`

In `src/tools/getMap.ts`:

- Return `details: entry.details` (now structured) and additionally `properties: entry.details?.properties.map(({ name }) => name)` for a quick read.
- Add `siblings`: every other entry in `session.model.maps.entries` whose `parent` equals this entry's parent (when the parent is defined), as `{ address, propertyName, properties: string[] | undefined }` (property names from each sibling's parsed details), capped at 16 with `siblingCount` uncapped. Comment: siblings from one parent are the shapes a constructor diverged into; their property lists show which property was added in which order.
- The description: "Inspect one V8 object map (hidden class) by address: its parsed shape (properties in order, representation, flags), the transition chain that produced it, its sibling shapes from the same parent, and the IC sites that observed it."

**Verify**: `vp check --fix` → clean.

### Step 4: Findings evidence

In `src/analysis/findings.ts`:

- Megamorphic and polymorphic IC findings: add `exampleMaps`: the first 3 distinct `mapAddress` values of the site's transitions (named and keyed variants alike; add it next to the existing evidence fields without removing any).
- Map-churn findings: add `exampleMaps`: the first 5 distinct `mapAddress` values across the group's events (collect them while grouping).

Comment at the first use: the addresses let an agent call get_map without a list_ics round trip.

**Verify**: `vp check --fix` → clean; `vp -C packages/deoptkit test src/analysis/__tests__/findings.spec.ts` → passes (update the synthetic `IcSite` literals' transitions if a test now needs `mapAddress` values; they already carry `mapAddress: "0x1"`).

### Step 5: Tests and memory

- `src/parser/__tests__/parseLog.spec.ts`: replace "captures map-details text for later property inspection" with "parses map-details into structured shapes": at least 100 entries with `details?.type === "JS_OBJECT_TYPE"`; the entry for one of the workload's shape literals (find an entry whose `details.properties` names include `x` and whose `constructorName === "Object"`) has `properties[…].representation` defined and `unparsedLines === 0`; and across all parsed entries the total `unparsedLines` is 0 (comment: a non-zero count means V8 changed the block format and the shape data is silently incomplete). Also assert a transition site's `events[0].mapAddress` matches `/^0x/u`.
- `src/__tests__/server.spec.ts`, inside the `profile_run` test after the `list_ics` call: take `idSite.mapAddresses[0]`, call `get_map`, and assert `details.type === "JS_OBJECT_TYPE"`, `properties` contains `"id"`, `siblings` is an array, and `siblingCount >= 1` (the churned records diverge from the `{ id }` map). Comment: this is the drill-down the churn explanation points to.
- Optional memory check, reported in NOTES: before and after this change, `node --expose-gc -e` that imports `dist/index.mjs`, parses `fixtures/logs/node-26/megamorphic.log`, calls `global.gc()`, and prints `process.memoryUsage().heapUsed`; expect a drop (the audit measured 38 MB with raw text).

**Verify**: the specs pass; `vp test` → all pass; `vp -C packages/deoptkit pack` → `Build complete`.

## Test plan

- New `mapDetails.spec.ts` (format variants, drift counter); replaced fixture test in `parseLog.spec.ts`; `get_map` assertions in `server.spec.ts`.
- Verification: `vp test` → all pass.

## Done criteria

- [ ] `vp check` and `vp test` exit 0; `vp -C packages/deoptkit pack` exits 0
- [ ] `grep -n "details: string" packages/deoptkit/src/model/logModel.ts` prints nothing
- [ ] `get_map` returns `details.properties`, `siblings`, and `siblingCount`
- [ ] Findings evidence has `exampleMaps` for IC and churn kinds
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated (skip if your reviewer maintains the index)

## STOP conditions

- The fixture's parsed entries report `unparsedLines > 0` after Step 1 (a format variant this plan did not list); report the unparsed lines (print the first 10 distinct ones) rather than relaxing the test.
- `window.spec.ts` fails after Step 2 (would mean the spread no longer carries events); report.
- The `map-details` handler or the `map` handler's `events.push` differ from the excerpts.

## Maintenance notes

- `unparsedLines` in the fixture test is the drift canary for the block format; when a Node major changes it, extend `parseMapDetails` and the spec together.
- `siblings` is computed per call by scanning `entries` (3,800 maps in a fixture session); if real sessions make `get_map` slow, index entries by parent at load.
- Plan 020 changes keyed IC evidence; both plans add fields without removing any, so they merge cleanly.
