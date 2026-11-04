---
"deoptkit": minor
---

`map-details` blocks are parsed at load into structured hidden-class descriptions (type, size, flags, back pointer, constructor, the ordered property descriptors with representation and attributes, and the transitions V8 printed) instead of being kept as raw text. `get_map` returns the parsed shape plus its sibling shapes from the same parent with their property lists, and megamorphic and map-churn findings carry example map addresses so an agent can reach `get_map` directly.
