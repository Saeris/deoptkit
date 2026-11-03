import { describe, expect, it } from "vitest";
import { parseMapDetails } from "../mapDetails";

// The churn explanation can only name the diverging properties if the descriptors
// parse; counting unparsed lines keeps V8 format drift visible instead of silent.
describe("parseMapDetails", () => {
  // One of map-churn.js's record shapes as Node 26 prints it.
  const RECORD = [
    "0000027727B2AA99: [Map] in OldSpace",
    " - map: 0x01cb0a421c99 <MetaMap (0x01cb0a421d29 <NativeContext[306]>)>",
    " - type: JS_OBJECT_TYPE",
    " - instance size: 32",
    " - inobject properties: 1",
    " - unused property fields: 0",
    " - elements kind: HOLEY_ELEMENTS",
    " - enum length: invalid",
    " - stable_map",
    " - back pointer: 0x027727b2aa51 <Map[32](HOLEY_ELEMENTS)>",
    " - prototype_validity_cell: 0x03d63a381351 <Cell value= [cleared]>",
    " - instance descriptors (own) #5: 0x03e436c38ce1 <DescriptorArray[5]>",
    " - prototype: 0x02ac6ebe7af1 <Object map = 000001CB0A422761>",
    " - constructor: 0x02ac6ebd95c9 <JSFunction Object (sfi = 0000019414A88271)>",
    " - dependent code: 0x03d63a380df1 <Other heap object (WEAK_ARRAY_LIST_TYPE)>",
    " - construction counter: 0",
    "",
    "  [0]: 000003D63A387389: [String] in ReadOnlySpace: #id (const data field 0:s, p: 0, attrs: [WEC]) @ Any",
    "  [1]: 0000027727B2A729: [String] in OldSpace: #even (const data field 1:h, p: 0, attrs: [WEC]) @ Any",
    "  [2]: 0000027727B2A741: [String] in OldSpace: #third (const data field 2:s, p: 0, attrs: [WEC]) @ Any",
    "  [3]: 0000027727B2A759: [String] in OldSpace: #fifth (const data field 3:h, p: 0, attrs: [WEC]) @ Any",
    "  [4]: 0000027727B2A771: [String] in OldSpace: #seventh (const data field 4:h, p: 0, attrs: [WEC]) @ Any"
  ].join("\n");

  // Property order is the shape: two records with the same names in a different
  // order are different maps, and that is what the sibling diff has to show.
  it("reads the header and the ordered property descriptors of an object shape", () => {
    const details = parseMapDetails(RECORD);
    expect(details).toMatchObject({
      type: "JS_OBJECT_TYPE",
      instanceSize: 32,
      inobjectProperties: 1,
      unusedPropertyFields: 0,
      elementsKind: "HOLEY_ELEMENTS",
      flags: ["stable_map"],
      backPointer: "0x027727b2aa51",
      prototype: "0x02ac6ebe7af1",
      constructorName: "Object",
      descriptorCount: 5,
      unparsedLines: 0
    });
    expect(details.properties.map(({ name }) => name)).toEqual([
      "id",
      "even",
      "third",
      "fifth",
      "seventh"
    ]);
    expect(details.properties[0]).toEqual({
      index: 0,
      name: "id",
      kind: "data",
      location: "field",
      constant: true,
      fieldIndex: 0,
      representation: "smi",
      writable: true,
      enumerable: true,
      configurable: true,
      fieldType: "Any"
    });
    // `h` after the field index: a heap-object field, which a Smi store would generalize.
    expect(details.properties[1]?.representation).toBe("heap-object");
  });

  // A transition-tree root and a null prototype print as `<undefined>`/`<null>`; an
  // address there would invent a parent link that get_map would then follow.
  it("reads a dictionary-mode namespace map with no parent, prototype, or properties", () => {
    const details = parseMapDetails(
      [
        "000001E6DABEF711: [Map] in OldSpace",
        " - map: 0x03d34dd79d61 <MetaMap (0x03d34dd79df1 <NativeContext[306]>)>",
        " - type: JS_MODULE_NAMESPACE_TYPE",
        " - instance size: 40",
        " - inobject properties: 0",
        " - unused property fields: 0",
        " - elements kind: DICTIONARY_ELEMENTS",
        " - enum length: invalid",
        " - dictionary_map",
        " - may_have_interesting_properties",
        " - non-extensible",
        " - back pointer: 0x02729aec0011 <undefined>",
        " - prototype_validity_cell: 0x02729aec1351 <Cell value= [cleared]>",
        " - instance descriptors (own) #0: 0x02729aec0e21 <DescriptorArray[0]>",
        " - prototype: 0x02729aec0041 <null>",
        " - constructor: 0x01d9c077cc19 <JSFunction Object (sfi = 0000028A928882E9)>",
        " - dependent code: 0x02729aec0df1 <Other heap object (WEAK_ARRAY_LIST_TYPE)>",
        " - construction counter: 0",
        "",
        ""
      ].join("\n")
    );
    expect(details.type).toBe("JS_MODULE_NAMESPACE_TYPE");
    expect(details.flags).toEqual(
      expect.arrayContaining(["dictionary_map", "non-extensible"])
    );
    expect(details.backPointer).toBeUndefined();
    expect(details.prototype).toBeUndefined();
    expect(details.descriptorCount).toBe(0);
    expect(details.properties).toEqual([]);
    expect(details.unparsedLines).toBe(0);
  });

  // Symbol keys print as `<Symbol: ...>` instead of `#name`; an accessor lives in the
  // map, not the object, and its attributes decide whether a store can ever succeed.
  it("names a symbol-keyed accessor and reads its location and attributes", () => {
    const details = parseMapDetails(
      [
        "000001D9C07537C9: [Map] in OldSpace",
        " - type: JS_ITERATOR_PROTOTYPE_TYPE",
        " - instance size: 56",
        " - prototype_map",
        " - instance descriptors (own) #1: 0x009b12ba0c59 <Other heap object (STRONG_DESCRIPTOR_ARRAY_TYPE)>",
        "",
        "  [0]: 0x02729aec8e29 <Symbol: Symbol.toStringTag> (const accessor descriptor, p: 0, attrs: [__C]) @ 0x009b12ba0e51 <AccessorPair>(get: 0x009b12ba0e69 <JSFunction get [Symbol.toStringTag] (sfi = 0000028A92892969)>, set: 0x009b12ba0ea1 <undefined>)"
      ].join("\n")
    );
    expect(details.properties).toEqual([
      {
        index: 0,
        name: "Symbol(Symbol.toStringTag)",
        kind: "accessor",
        location: "descriptor",
        constant: true,
        fieldIndex: undefined,
        representation: undefined,
        writable: false,
        enumerable: false,
        configurable: true,
        fieldType:
          "0x009b12ba0e51 <AccessorPair>(get: 0x009b12ba0e69 <JSFunction get [Symbol.toStringTag] (sfi = 0000028A92892969)>, set: 0x009b12ba0ea1 <undefined>)"
      }
    ]);
    expect(details.unparsedLines).toBe(0);
  });

  // A line V8 adds in a future version must not abort the block or vanish: the rest
  // still parses, and the count is what the fixture test watches.
  it("counts a line it does not understand and still parses the rest", () => {
    const lines = RECORD.split("\n");
    lines.splice(9, 0, "   Some future V8 section #3:");
    const details = parseMapDetails(lines.join("\n"));
    expect(details.unparsedLines).toBe(1);
    expect(details.type).toBe("JS_OBJECT_TYPE");
    expect(details.backPointer).toBe("0x027727b2aa51");
    expect(details.properties).toHaveLength(5);
  });

  // The printed transitions name the child shapes a map branched into and the property
  // each one added — the sibling picture of a churning constructor, straight from V8.
  // Node's own bootstrap maps print 1,663 such lines per fixture log, so leaving them
  // unparsed would hide real drift behind expected noise.
  it("reads a map's transitions, prototype transitions, and their targets", () => {
    const details = parseMapDetails(
      [
        "000000C577FBAB39: [Map] in OldSpace",
        " - type: JS_OBJECT_TYPE",
        " - instance size: 64",
        " - back pointer: 0x01f4afa00011 <undefined>",
        " - instance descriptors (own) #0: 0x01f4afa00e21 <DescriptorArray[0]>",
        " - transitions #5: 0x00c577fbb661 <TransitionArray[13]>",
        "   Transitions #5:",
        "     000003B47CD93309: [String] in OldSpace: #import: (transition to (const data field, attrs: [WEC]) @ Any) -> 0x00c577fbaca1 <Map[64](HOLEY_ELEMENTS)>",
        "     000003B47CD9DB49: [String] in OldSpace: #_stat: (transition to (const accessor descriptor, attrs: [W_C]) @ 0x02ad39854af1 <AccessorPair>(get: 0x02ad39854b09 <JSFunction get (sfi = 00000136452D5899)>, set: 0x02ad39854b59 <JSFunction set (sfi = 00000136452D5949)>)) -> 0x00c577fbbae1 <Map[64](HOLEY_ELEMENTS)>",
        "     0x00c577fac911 <Symbol: #size>: (transition to (const data field, attrs: [W_C]) @ Any) -> 0x01c49ff7a5e1 <Map[56](HOLEY_ELEMENTS)>",
        "     0x01f4afa089f9 <Symbol: (frozen_symbol)>: (transition to frozen) -> 0x01c49ff58121 <Map[56](HOLEY_FROZEN_ELEMENTS)>",
        "     0x01f4afa019c1 <Symbol: (elements_transition_symbol)>: (transition to HOLEY_DOUBLE_ELEMENTS) -> 0x02ad39841a59 <Map[32](HOLEY_DOUBLE_ELEMENTS)>",
        "   Prototype transitions #2: 0x00c577fbb759 <WeakFixedArray[2]>",
        "     0x00c577fbcee9 <JSFunction Error (sfi = 000003AE0A98D869)> -> 0x004a31914e31 <Map[64](HOLEY_ELEMENTS)>",
        "     0x01f4afa00041 <null> -> 0x004a31928f11 <Map[48](HOLEY_ELEMENTS)>",
        " - prototype: 0x02ac6ebe7af1 <Object map = 000001CB0A422761>",
        " - construction counter: 0",
        ""
      ].join("\n")
    );
    expect(details.transitions).toEqual([
      { name: "import", kind: "data", to: "0x00c577fbaca1" },
      { name: "_stat", kind: "accessor", to: "0x00c577fbbae1" },
      { name: "Symbol(#size)", kind: "data", to: "0x01c49ff7a5e1" },
      { name: "Symbol((frozen_symbol))", kind: "frozen", to: "0x01c49ff58121" },
      {
        name: "Symbol((elements_transition_symbol))",
        kind: "elements",
        to: "0x02ad39841a59"
      },
      { name: "Error", kind: "prototype", to: "0x004a31914e31" },
      { name: "", kind: "other", to: "0x004a31928f11" }
    ]);
    expect(details.prototypeTransitions).toBe(2);
    // The listing ends at the next field line, which still parses as a field.
    expect(details.prototype).toBe("0x02ac6ebe7af1");
    expect(details.unparsedLines).toBe(0);
  });

  // A single transition prints directly under the ` - transitions` field, with no
  // `Transitions #N:` line: 1,419 of the 1,585 entries in the megamorphic fixture.
  it("reads a single transition printed directly under the transitions field", () => {
    const details = parseMapDetails(
      [
        "000003B47CD93001: [Map] in OldSpace",
        " - type: JS_OBJECT_TYPE",
        " - transitions #1: 0x00c577fbaca1 <Map[64](HOLEY_ELEMENTS)>",
        "     000003B47CD93309: [String] in OldSpace: #import: (transition to (const data field, attrs: [WEC]) @ Any) -> 0x00c577fbaca1 <Map[64](HOLEY_ELEMENTS)>",
        " - prototype: 0x02ac6ebe7af1 <Object map = 000001CB0A422761>"
      ].join("\n")
    );
    expect(details.transitions).toEqual([
      { name: "import", kind: "data", to: "0x00c577fbaca1" }
    ]);
    expect(details.unparsedLines).toBe(0);
  });

  // Each of these printed differently from the first block: meta maps, V8 14's `v`
  // mnemonic for the None representation, a descriptor count without `(own)`, and a
  // private name, whose `#` must not be mistaken for a string key.
  it("reads meta map headers, None fields, unqualified descriptor counts, and private names", () => {
    const meta = parseMapDetails(
      [
        "000000C577FB9D61: [MetaMap] in OldSpace",
        " - map: 0x00c577fb9d61 <MetaMap (0x00c577fb9df1 <NativeContext[306]>)>",
        " - type: MAP_TYPE",
        " - instance size: 72",
        " - native_context: 0x00c577fb9df1 <NativeContext[306]>"
      ].join("\n")
    );
    expect(meta).toMatchObject({
      type: "MAP_TYPE",
      instanceSize: 72,
      unparsedLines: 0
    });

    const details = parseMapDetails(
      [
        "0000004A31928F11: [Map] in OldSpace",
        " - type: JS_OBJECT_TYPE",
        " - instance descriptors #3: 0x02ad398550e1 <Other heap object (STRONG_DESCRIPTOR_ARRAY_TYPE)>",
        "",
        "  [0]: 000003B47CDA73E1: [String] in OldSpace: #expandArgv1 (const data field 0:v, p: 0, attrs: [WEC]) @ None",
        "  [1]: 0x00c577fac8c9 <Symbol: #compare> (data field 1:h, p: 0, attrs: [W_C]) @ Any",
        "  [2]: 000003B47CD95F91: [String] in OldSpace: #kMaxUserId (const data field 2:d, p: 0, attrs: [WEC]) @ Any"
      ].join("\n")
    );
    expect(details.descriptorCount).toBe(3);
    expect(
      details.properties.map(({ name, representation, fieldType }) => ({
        name,
        representation,
        fieldType
      }))
    ).toEqual([
      { name: "expandArgv1", representation: "none", fieldType: "None" },
      {
        name: "Symbol(#compare)",
        representation: "heap-object",
        fieldType: "Any"
      },
      { name: "kMaxUserId", representation: "double", fieldType: "Any" }
    ]);
    expect(details.properties[1]).toMatchObject({
      kind: "data",
      location: "field",
      constant: false,
      writable: true,
      enumerable: false,
      configurable: true
    });
    expect(details.unparsedLines).toBe(0);
  });
});
