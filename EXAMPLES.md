# SpellLang — Canonical Examples

> Used in the LLM system prompt (see GRAMMAR.md) and as conformance fixtures.
> Callable names/types below assume the reference voxel-world host; each host
> substitutes its own registry.

## 1. Structure generation — watchtower

```spelllang
// A stone watchtower, 5x5 footprint, 12 tall, torch on top
call setVoxels(0, 0, 0, 4, 12, 4, STONE)
call setVoxels(1, 0, 1, 3, 12, 3, AIR)
call setVoxels(2, 13, 2, 2, 13, 2, PLANKS)
call setVoxel(2, 14, 2, TORCH)
```

## 2. Structure generation — loop + condition

```spelllang
// Four floors; alternate stone and planks
for floor of range(0, 4) {
    let y = floor * 3
    if floor % 2 == 0 {
        call setVoxels(0, y, 0, 4, y + 2, 4, STONE)
    } else {
        call setVoxels(0, y, 0, 4, y + 2, 4, PLANKS)
    }
}
```

## 3. Entity behavior — batch over a context list

```spelllang
// Fleeing goblins: wounded ones run to the player, others attack
for goblin of goblins {
    if goblin.hp < 5 {
        call moveTowards(goblin, player)
    } else {
        call attack(goblin, player)
    }
}
```

## 4. Entity behavior — persistent state across runs

The host re-invokes this script every tick, passing the previous state back.

```spelllang
if state.awake == false {
    if distanceTo(player) < 8 {
        state.awake = true
    }
}
if state.awake == true {
    call moveTowards(player)
    state.patience = max(0, state.patience - 1)
    if state.patience == 0 {
        state.awake = false
        state.patience = 20
    }
}
```

## 5. Randomized scatter (seeded — reproducible)

```spelllang
// Scatter 5 flower patches near the origin
for i of range(0, 5) {
    let x = round(random() * 20 - 10)
    let z = round(random() * 20 - 10)
    if random() < 0.5 {
        call setVoxel(x, 0, z, FLOWER_RED)
    } else {
        call setVoxel(x, 0, z, FLOWER_BLUE)
    }
}
```

## Deliberate errors (for retry-loop testing)

```spelllang
let height = 10
for i of range(0, 8) {
    call setVoxel(0, hight, 0, WOOD)
}
```

returns:

```json
{
  "ok": false,
  "errors": [
    { "line": 3, "col": 20, "code": "unknown-identifier",
      "message": "Unknown identifier 'hight'.",
      "expected": ["height"], "found": "hight" }
  ]
}
```
