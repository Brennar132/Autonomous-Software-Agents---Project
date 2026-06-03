# AlbertitoV2 — Implementation Notes (vs. `intention_revision.js`)

This README focuses on what **AlbertitoV2** implements/improves compared to the baseline agent in `intention_revision.js`, and how those changes are reflected in the code.

---

## 1) From “blind movement” to **A\*** navigation

### Baseline (`intention_revision.js`)
- Movement plan is `BlindMove`:
  - Moves horizontally then vertically until the target is reached.
  - No pathfinding: it fails when a wall / one-way tile / blocked tile prevents direct movement.
  - “Stuck” detection is minimal (`throw 'stucked'`).

### AlbertitoV2 (`albertitoV2.js`)
- Replaces `BlindMove` with `AStarMove` + full A* implementation:
  - `aStar(start, goal)` computes a shortest path with Manhattan heuristic (`distance`).
  - `reconstructPath(...)` rebuilds the chosen path.
  - `AStarMove.execute('go_to', x, y)`:
    - Replans when the map changes or movement fails.
    - Has retry logic (`CONFIG.LIMITS.MAX_RETRIES`) and a global “stuck timeout” (`CONFIG.TIMEOUTS.ASTAR_STUCK`).
    - Uses `move(dir)` with `Promise.race` to prevent permanent blocking on socket move acknowledgements (`CONFIG.TIMEOUTS.MOVE_RACE`).

**Key implementation pieces**
- `move(dir)` wraps `socket.emitMove(dir)` with a timeout.
- `aStar(...)` uses:
  - `isWalkable(...)` (walls, blocked gates/boxes, dynamic obstacles)
  - `MoveIsAllowed(...)` (directional tiles constraints)

---

## 2) Explicit handling of **dynamic obstacles** and blocked tiles (“gates/boxes”)

### Baseline
- No notion of other agents blocking tiles.
- No special handling for blocked objects; “stuck” is final.

### AlbertitoV2
Adds two mechanisms:

#### 2.1 Dynamic obstacles (temporary)
When a move fails, the agent assumes something dynamic (e.g., another bot) is in the way:
- `setDynamicObstacle(x,y,duration)`
- `dynamicObstacles` map is used by `isWalkable(...)` to avoid re-trying the same failing step for a while.

#### 2.2 Pushable blocked tiles (gate/box model)
AlbertitoV2 models a “blocked gate” tile and tries to reason about pushing:
- Tile types:
  - `GATE_OPEN: "5"`
  - `GATE_BLOCKED: "5!"`
- `isWalkable(x,y,fromX,fromY)`:
  - If the target tile is `"5!"`, only allows it if it is pushable from the approach direction.
- `isBoxPushable(bx,by,dx,dy)` checks whether the tile “behind” the box is open.
- `applyBoxPush(...)` updates the internal `tileMap` after entering a blocked tile to reflect the push effect.

This is a major improvement over the baseline where the map is effectively static and “blocked” means impossible.

---

## 3) Belief revision upgrades: more state, more memory

### Baseline
- Beliefs:
  - `me`
  - `parcels`
  - `tileMap`, `dropoffs`, `spawnPoints`
- Tiles are stored, but there is no “forgetting” nor visit tracking.

### AlbertitoV2
Adds additional belief structures:
- `dynamicObstacles`: temporary non-walkable tiles caused by movement failures.
- `blacklistedParcels`: parcels temporarily ignored after failed pickup attempts.
- `recentlyVisited`: visit timestamps used to drive exploration.
- `lastExplorationUpdate`: exploration throttling.

Also adds a tile-change aware handler:
- `socket.onTile(...)` updates `tileMap` and stores spawns/dropoffs, and detects changes.

---

## 4) Option generation: from nearest-goal to **utility-driven behavior**

### Baseline (`optionsGeneration()` in `intention_revision.js`)
- If carrying anything: push *all* dropoffs as options, then filter by nearest.
- Always adds a pickup option for every free parcel.
- If no parcels: random explore target (`getExploreTarget`), mostly random.

### AlbertitoV2 (`optionsGeneration()` in `albertitoV2.js`)
The behavior is split into explicit cases and uses heuristics:

#### Case 1 — Carrying parcels → deliver, but allow “marginal” pickup
If holding parcels:
- Compute nearest dropoff.
- Evaluate nearby free parcels by **marginal detour**:
  - `marginalDistance = d(me, parcel) + d(parcel, dropoff) - d(me, dropoff)`
  - If detour is small (`MARGINAL_DIST_THRESHOLD`), compute utility:
    - `utility = reward * PICKUP_ALPHA - marginalDistance * PICKUP_BETA`
- If utility is good, temporarily prioritize pickup; otherwise deliver.

This is a more nuanced policy than baseline “always deliver if carrying”.

#### Case 2 — Not carrying → build a pickup chain
Uses `getBestPickupChain()`:
- Greedy chain builder (TSP-like approximation):
  - Start from current position.
  - Iteratively choose next parcel maximizing `reward - detourCost`
  - Stops when chain reaches `MAX_CARRIED_PARCELS` or detour gets too large.

Baseline does not plan multi-pickup; it just chooses nearest single parcel.

#### Case 3 — No parcels → exploration strategy
Uses `getBestExploreTarget()`:
- Scores spawn points based on:
  - staleness (not visited recently)
  - parcel density nearby (`getSpawnZoneDensity`)
  - distance penalty
- Falls back to stale walkable tiles.

Baseline explores mostly at random.

---

## 5) Intention revision: stronger preemption and de-duplication

### Baseline
`IntentionRevisionReplace`:
- If a new intention arrives, append it and stop the last one.
- Validity check is hardcoded and incomplete (skips if parcel is carried, but does not shift/continue cleanly).

### AlbertitoV2
Keeps the “Replace” style but adds **preemption rules** and better duplication checks:
- Does not enqueue duplicates (compares predicate prefix).
- If currently delivering (`go_to_dropoff`) and a strong pickup is generated (`go_pick_up`):
  - **unshift** pickup to the front of the queue
  - stop current delivery intention

Also adds a runtime cancellation mechanism:
- On each sensing update:
  - if chasing a parcel (`go_pick_up`) and it disappears/gets carried → `current.stop()`

This reduces wasted time when the world state changes.

---

## 6) Plan library changes (mapping baseline → V2)

| Goal predicate | Baseline plan | AlbertitoV2 plan | Main difference |
|---|---|---|---|
| `go_pick_up` | `GoPickUp` | `GoPickUp` (enhanced) | Validity checks + blacklisting on failure |
| `go_to` | `BlindMove` | `AStarMove` | Proper pathfinding + replanning + obstacle logic |
| `go_to_dropoff` | `GoToDropoff` | `GoToDropoff` (enhanced) | After putdown: cleans carried parcels from belief map |
| `go_to_discover` | `GoToDiscover` | `GoToDiscover` | Same, but benefits from A* pathing |

**Notable V2 improvements inside plans**
- `GoPickUp` checks `parcels.get(id)` before chasing or picking.
- If navigation fails, parcel gets `blacklistParcel(id, PICKUP_BLACKLIST)` to avoid repeated chasing.

---

## 7) Control loop: continuous option generation with throttling

### Baseline
- `socket.onSensing(optionsGeneration)`
- `socket.onYou(optionsGeneration)`
So decisions are event-driven and may be too frequent / jittery.

### AlbertitoV2
- Uses a fixed heartbeat:
  - `setInterval(() => { if (me.id) optionsGeneration(); }, AGENT_HEARTBEAT)`
- Exploration is throttled with `EXPLORATION_MS`.

This makes deliberation steadier and easier to tune.

---

## 8) Configuration-driven behavior (tuning knobs)

AlbertitoV2 centralizes parameters inside `CONFIG`, e.g.:
- Pathing robustness: `MOVE_RACE`, `ASTAR_STUCK`, `MAX_RETRIES`
- Tactics: `MAX_CARRIED_PARCELS`, `MARGINAL_DIST_THRESHOLD`
- Utility weights: `PICKUP_ALPHA`, `PICKUP_BETA`
- Memory/forgetting: `TILE_EXPIRATION`, `PICKUP_BLACKLIST`
- Exploration: `EXPLORATION_MS`, spawn scoring weights

The baseline has these values spread across code (or missing).

---

## Quick “what to read in the code”
1. **Navigation**: `aStar`, `isWalkable`, `MoveIsAllowed`, `AStarMove.execute`
2. **Decision layer**: `optionsGeneration`, `getBestPickupChain`, `getBestExploreTarget`
3. **BDI runtime**: `IntentionRevisionReplace.push`, sensing-based cancellation, `IntentionDeliberation`
4. **Robustness**: `dynamicObstacles`, `blacklistedParcels`, timeouts/retries

---