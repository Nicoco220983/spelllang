# spelllang API Specification & Design Decisions

This document specifies the current API contract, language conventions, and design decisions for **spelllang**. It serves as the single source of truth for runtime implementations, AST sanitizers, and LLM prompt generation.

---

## 1. Core Architecture & Philosophy

* **Direct Host Injection (No `app.` prefix):**
  Host environment methods and actions are injected directly into the global execution scope as standard functions (e.g. `getSensors()`, `notify()`). The `app.` prefix is eliminated to reduce prompt complexity and LLM friction.
* **Identifier Protection (No Shadowing):**
  Declaring a variable with `let` that matches the name of any built-in function or host-injected function is strictly forbidden at compile time.
* **Persistent State (`state.`):**
  All cross-execution persistent data is accessed and modified exclusively through `state.<key>`.
* **Null Singleton (`null`):**
  `null` represents the absence of a value. Supported in equality checks (`== null`, `!= null`) and returned by lookup functions like `find()` when no item matches. `nil` and `None` are silently accepted as synonyms.
* **Robustness Principle (Postel's Law):**
  *Be liberal in what you accept, conservative in what you emit.* The parser silently tolerates common LLM dialect variations and normalizes them in the AST before mapping to visual blocks.

---

## 2. Records & Property Access

* **Recommended Syntax (Dot Access):**
  Property access on maps and objects uses dot notation:
  ```spelllang
  let weather = getWeather()
  if weather.forecast == "Sunny" { ... }
  ```
* **Tolerant Alternatives (Silently Supported):**
  * Bracket access: `weather["forecast"]`
  * Functional access: `get(weather, "forecast")`
* **Pipeline Property Access:**
  Property chaining within a pipeline is tolerated:
  ```spelllang
  getWeather() |> .forecast |> contains("Sunny")
  ```
  The compiler/sanitizer treats `|> .prop` as extracting `prop` from the piped record.

---

## 3. Silent Tolerances & AST Sanitization

To prevent LLM generation failures caused by pre-training priors, the parser silently normalizes the following constructs into canonical SpellLang:

| Input Variant | Canonical AST Equivalent | Notes |
| :--- | :--- | :--- |
| `and`, `or`, `not` | `&&`, `||`, `!` | Automatically desugared in lexer/parser. |
| `nil`, `None` | `null` | Silently normalized to canonical `null`. |
| `\|> func(_, arg2)` | `\|> func(arg2)` | Pipeline placeholder `_` in first position is stripped. |
| `fn(x)` (untyped) | `fn(x: Any)` | Untyped arguments fallback to `Any`. |
| `fn(...) -> Type` | `fn(...)` | Return type annotations are silently discarded (types are inferred). |
| `x -> expr` or `x => expr` | `fn(x: Any) { expr }` | Arrow lambda shorthand desugars to standard `fn`. |
| `\|> .prop` | `map.prop` | Chained property access inside pipelines is accepted. |

### Visual Block Isomorphism
The **Sanitizer / AST Normalizer** rewrites accepted dialect variants into a single canonical AST representation. This guarantees that visual block editors (Blockly/Scratch) only need one 1:1 block mapping per concept.

---

## 4. Built-in Standard Library

### List Operations
* `filter(list: List, predicate: Fn): List`
* `map(list: List, transform: Fn): List`
* `flatMap(list: List, transform: Fn): List`
* `reduce(list: List, initial: Any, reducer: Fn): Any`
* `countBy(list: List, predicate: Fn): Num`
* `any(list: List, predicate: Fn): Bool`
* `all(list: List, predicate: Fn): Bool`
* `find(list: List, predicate: Fn): Any`
* `contains(list: List, item: Any): Bool`
* `append(list: List, item: Any): List`
* `reverse(list: List): List`
* `sortBy(list: List, keyFn: Fn): List`
* `sum(list: List<Num>): Num`
* `avg(list: List<Num>): Num`
* `min(list: List<Num>): Num`
* `max(list: List<Num>): Num`
* `first(list: List): Any`
* `last(list: List): Any`
* `head(list: List, n: Num): List`
* `tail(list: List, n: Num): List`
* `len(list: List): Num`

### Math Operations
* `abs(x: Num): Num`
* `floor(x: Num): Num`
* `ceil(x: Num): Num`
* `round(x: Num): Num`
* `sqrt(x: Num): Num`
* `pow(base: Num, exp: Num): Num`
* `sin(angle: Num): Num`
* `cos(angle: Num): Num`
* `tan(angle: Num): Num`
* `atan2(y: Num, x: Num): Num`
* `clamp(val: Num, min: Num, max: Num): Num`
* `random(min: Num, max: Num): Num`
* `sign(x: Num): Num`

### String Operations
* `split(str: Str, delimiter: Str): List<Str>`
* `join(list: List<Str>, delimiter: Str): Str`
* `trim(str: Str): Str`
* `contains(str: Str, substr: Str): Bool`

---

## 5. Host Context Integration

Host applications inject domain-specific functions directly into the script scope. For test environments, the standard host functions are:

* `getSensors(type: Str): List<Map>` (Map contains `{id: Str, value: Num, room: Str}`)
* `setDeviceState(id: Str, active: Bool): Bool`
* `notify(message: Str, priority: Num): Bool`
* `getWeather(): Map` (Returns `{temp: Num, forecast: Str, humidity: Num}`)
* `getTime(): Num` (Returns current UNIX timestamp)
