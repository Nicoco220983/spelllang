# spelllang - Agent Instructions

This document serves as the primary system prompt and architectural guideline for any AI agent or LLM contributing to the development, parsing, or generation of **spelllang** scripts.

> **Full Specification:** See [API.md](file:///home/ncarrez/dev/spelllang/API.md) for the complete standard library reference, tolerant parsing rules, and language design decisions.

## 1. Project Overview
**spelllang** is a minimalistic, securely sandboxed scripting language designed specifically for LLM generation and visual "blocky" editor representation. It executes safely on client environments, prevents hallucinations through strict syntax rules and strong type inference, and persists memory via a built-in state object.

## 2. Core Design Principles
*   **Zero Hallucination Tolerance:** No external imports, no imaginary standard libraries, and no meta-programming. 
*   **Rich Standard Library for Lean Prompts:** To maximize scripting capabilities while keeping the LLM API prompt short, spelllang natively provides common utility and math functions (e.g., `min`, `max`, `cos`, `filter`, `map`, `clamp`, `reduce`). This empowers the script without cluttering the host context schema.
*   **Direct Host Injection:** Host functions are injected directly into the global scope—no `app.` prefix is used.
*   **Pipeline-First:** Nested parentheses are error-prone for LLMs and hard to map to visual blocks. Chained operations must use the pipeline operator `|>`.
*   **Strong, Silent Typing:** Types are strictly enforced at compile time to ensure safe execution. Types are inferred from assignment. Explicit type annotations are restricted exclusively to custom function arguments.
*   **Perfect Isomorphism:** Every line of code must map 1:1 to a visual block (Blockly/Scratch style), and vice versa.

## 3. Syntax Reference & Rules

### Variables & State
*   **Local Variables (`let`):** Temporary variables scoped to the current execution. Types are inferred. Cannot shadow built-in or host function names.
    ```
    let threshold = 50 
    let isActive = true
    ```
*   **Persistent State (`state.`):** The only way to persist data between script executions.
    ```
    state.executionCount = state.executionCount + 1
    state.lastUser = "Alice"
    ```

### Host Context
All domain-specific actions, side effects, or external data retrieval are injected directly into the execution scope as standard functions. Agents must strictly use the methods provided in the runtime context prompt.
```
let sensorValue = getSensorData("temperature")
if sensorValue > threshold {
    triggerAlarm()
}
```

### Records & Property Access
Maps and records use standard dot notation for field access:
```
let weather = getWeather()
let currentForecast = weather.forecast
```

### Pipelines (`|>`)

Agents must avoid deep nesting. Use `|>` to pass the result of the left expression as the first argument to the right function.

```
// DO NOT DO THIS:
let result = tail(map(filter(state.logs, isError), extractMessage), 10)

// DO THIS:
let result = state.logs 
    |> filter(isError) 
    |> map(extractMessage) 
    |> tail(10)
```

### Custom Functions & Typing (`fn`)

Functions use the `fn` keyword. To support the visual editor's block shapes and strict type-checking, arguments must use lightweight type annotations: `Num`, `Str`, `Bool`, `List`, `Map`, `Any`. Return types are automatically inferred.

```
fn calculatePenalty(daysOverdue: Num, isPremium: Bool) {
    if isPremium {
        return 0
    }
    return daysOverdue * 1.5
}
```

## 4. Agent Guidelines for Script Generation

1. **Context Strictness:** Never invent host functions. If a requirement cannot be met with the provided functions in the context schema, halt and request clarification.
2. **Type Consistency:** Do not attempt to implicitly coerce types (e.g., adding a `Str` to a `Num`). Rely on explicit mapping or standard utility functions if provided.
3. **Self-Healing Loop:** If the interpreter returns a compilation or type mismatch error (e.g., *"Type mismatch on line 4: sendEmail() expects Str, got List"*), immediately update the script to satisfy the strict type contract. Do not argue with the compiler.
4. **Formatting:** Always use braces `{}` for control structures (`if`, `else`, `fn`). Never rely on indentation alone for scoping.
