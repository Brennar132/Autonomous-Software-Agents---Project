# PDDL Deliveroo Agent — pddl_albertito.js

An autonomous BDI-style agent for the Deliveroo simulation platform. Instead of hand-coded heuristics, it translates the current world state into a PDDL planning problem, calls an external planner (Fast-Downward) to compute an optimal action sequence, and executes that plan while reacting to world changes in real time.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                      Deliveroo Server                   │
│  onYou / onSensing / onTile  ←→  emitMove / emitPickup  │
└───────────────────┬─────────────────────────────────────┘
                    │ events
          ┌─────────▼──────────┐
          │   Belief Update    │  Updates parcels, tileMap,
          │   (Event Handlers) │  dropoffs, spawnPoints
          └─────────┬──────────┘
                    │
          ┌─────────▼──────────┐
          │  selectParcels     │  Greedy nearest-neighbour
          │  AndDropoff()      │  chain + optimal dropoff
          └─────────┬──────────┘
                    │
          ┌─────────▼──────────┐
          │  PDDL Generation   │  generateDeliveryPDDL()
          │                    │  generateExplorePDDL()
          └─────────┬──────────┘
                    │ problem.pddl
          ┌─────────▼──────────┐
          │  Fast-Downward     │  lazy_greedy([ff()])
          │  Planner           │  → sas_plan
          └─────────┬──────────┘
                    │ action sequence
          ┌─────────▼──────────┐
          │  executeNextAction │  move / pickup / dropoff
          │  + opportunistic   │  + grab parcels on the way
          │    pickup          │
          └────────────────────┘
```

---

## Files

| File | Description |
|------|-------------|
| `pddl_albertito.js` | Main agent — all logic in one file |
| `domain.pddl` | PDDL domain definition (actions, predicates) |
| `problem.pddl` | Auto-generated per planning cycle (do not edit) |
| `sas_plan` | Temporary plan output (auto-deleted after reading) |

---

## PDDL Domain

The domain (`domain.pddl`) defines three actions:

```pddl
(define (domain deliveroo)
    (:requirements :strips :typing)
    (:types tile parcel)
    (:predicates
        (at-me ?t - tile)
        (at-parcel ?p - parcel ?t - tile)
        (carrying ?p - parcel)
        (is-dropoff ?t - tile)
        (connected ?t1 - tile ?t2 - tile)
    )

    (:action move    ...)   ; move between connected tiles
    (:action pickup  ...)   ; pick up a parcel on the current tile
    (:action dropoff ...)   ; deliver a carried parcel at a dropoff tile
)
```

**Important:** the domain must use only `:strips :typing`. Do not add `:fluents`, `:durative-actions`, or `total-cost` — the `lazy_greedy([ff()])` search engine does not support them and the planner will fail.

---

## Configuration

All tunable parameters are in the `CONFIG` object at the top of `pddl_albertito.js`:

```js
CONFIG = {
    TIMEOUTS: {
        MOVE_RACE:          500,   // ms before a move is considered failed
        PLANNING_HEARTBEAT: 1000,  // ms between deliberation checks
        EXECUTION_TICK:     100,   // ms between action execution attempts
        TILE_EXPIRATION:    30000, // ms before a visited tile is considered stale
        DYNAMIC_OBSTACLE:   2000,  // ms a tile blocked by another agent is excluded from planning
    },
    LIMITS: {
        MAX_CARRIED_PARCELS: 6,  // max parcels the agent can hold
        MAX_PARCELS_IN_PLAN: 5,  // max parcels included in one PDDL problem
        MAX_DETOUR_CARRYING: 3,  // max Manhattan tiles of detour to add a parcel on the way
    },
    TILE_TYPES: { ... },         // string codes as sent by the server ("0"=wall, "2"=dropoff, ...)
    PLANNER: {
        COMMAND: 'python3 ../fast-downward/fast-downward.py ...'  // path to Fast-Downward
    }
}
```

### Key Parameters

**`MAX_PARCELS_IN_PLAN`** controls how many parcels the agent tries to collect in one trip. Higher = more parcels per trip but slower planning. Recommended: 4–6 for maps up to 10×10, 3–4 for larger maps.

**`MAX_DETOUR_CARRYING`** controls how far off-route the agent will go to grab an extra parcel when already committed to a dropoff. Set to 0 to disable on-the-way pickups entirely.

**`PLANNING_HEARTBEAT`** controls how often the agent reconsiders its plan. Lower = more reactive but more planner calls.

**`DYNAMIC_OBSTACLE`** controls how long a tile is excluded from planning after a move onto it unexpectedly fails (see [Dynamic Obstacles](#dynamic-obstacles-not-modeled-by-the-planner) below).

---

## How the Agent Works

### 1. Belief Update (Event Handlers)

Three socket events keep the agent's world model up to date:

- **`onYou`** — updates position and registers the current tile as recently visited.
- **`onSensing`** — synchronises the parcel map. Detects parcels that appeared, disappeared, or changed owner. Sets `worldChangedSinceLastPlan = true` on any meaningful change.
- **`onTile`** — incrementally builds the tile map. Classifies tiles as walls, spawn points, dropoffs, or walkable paths.

### 2. Parcel and Dropoff Selection (`selectParcelsAndDropoff`)

This function decides *what* to collect and *where* to deliver it.

**When not yet carrying anything:**
1. Builds a greedy nearest-neighbour chain starting from the agent's current position — always picking the closest free parcel next.
2. Selects the dropoff closest to the *last* parcel in the chain (not closest to the agent now).
3. Commits to this dropoff (`committedDropoff`) for the duration of the trip.

**When already carrying parcels with a committed dropoff:**
1. Keeps the committed dropoff — does not recalculate it.
2. Considers adding extra parcels only if the detour is within `MAX_DETOUR_CARRYING` tiles.

This two-phase logic prevents the common failure mode where the agent recalculates the dropoff mid-trip and picks a different one based on its current position (which may be far from the optimal delivery point).

### 3. PDDL Problem Generation

Two generators produce PDDL problems:

**`generateDeliveryPDDL(parcels, targetDropoff)`** — used when there are parcels to collect and deliver. The goal requires *all* parcels in the chain to be at the same dropoff tile:

```pddl
(:goal
  (and
    (at-parcel p_p1 tile_9_9)
    (at-parcel p_p2 tile_9_9)
    (at-parcel p_p3 tile_9_9)
  )
)
```

This forces the planner to compute a single route that picks up all parcels and delivers them together, rather than making one trip per parcel.

**`generateExplorePDDL(target)`** — used when no parcels are visible. The goal is simply to reach an unvisited spawn point:

```pddl
(:goal (at-me tile_5_8))
```

Both generators use `buildConnectivity()` to emit `(connected tileA tileB)` facts for all adjacent walkable tile pairs, giving the planner an accurate map of traversable paths.

### 4. External Planning (Fast-Downward)

The agent calls Fast-Downward asynchronously with `lazy_greedy([ff()], preferred=[ff()])`:

- **`lazy_greedy`** — a greedy best-first search that finds good solutions quickly without guaranteeing optimality. Suitable for real-time use.
- **`ff()`** — the FF heuristic (relaxed planning graph), which estimates the number of actions needed to reach the goal.

The call is non-blocking (`execAsync`). While Fast-Downward runs, the agent continues executing the previous plan. If the world changes significantly while planning, the old plan is discarded and a new one is requested.

### 5. Plan Execution (`executeNextAction`)

The execution loop runs every `EXECUTION_TICK` ms and processes one action at a time:

- **`move`** — emits a directional move. On success, checks if a free parcel is on the destination tile and picks it up opportunistically (without invalidating the current plan).
- **`pickup`** — verifies the parcel is still free before picking up. Retries once on failure.
- **`dropoff`** — calls `emitPutdown()`. On success, clears the local parcel cache and resets `committedDropoff`.

If any action fails, the entire plan is discarded and `worldChangedSinceLastPlan` is set to trigger a replan.

### 6. Replanning Logic

The deliberation loop runs every `PLANNING_HEARTBEAT` ms and decides whether to replan:

```
Plan is still valid if:
  - It has ≥ 3 remaining steps
  - The agent is carrying at least one parcel
  - No planned pickup targets have been taken by other agents
```

If the plan is valid, the loop suppresses `worldChangedSinceLastPlan` to avoid unnecessary replanning while moving toward the dropoff. If the plan is invalid or exhausted, a new planning cycle is triggered.

### 7. World Rules Outside the PDDL Domain

`domain.pddl` only knows about `move`/`pickup`/`dropoff` over `connected` tiles — it has no concept of one-way tiles, pushable boxes, or other agents. Those rules are enforced entirely on the JS side, by pruning which `(connected ...)` facts get emitted into `problem.pddl` in the first place (`buildWalkableTiles` / `buildConnectivity`), plus some handling at execution time.

#### Directional tiles ("arrows")
Tiles of type `↑`/`↓`/`←`/`→` can only be entered while moving in the direction the arrow allows. `isDirectionalMoveAllowed(fromTile, toTile)` checks this for every candidate edge in `buildConnectivity()`; a disallowed edge is simply never written as `(connected ...)`, so the planner can't route through it the wrong way.

#### Pushable gates/boxes
A `GATE_BLOCKED` (`"5!"`) tile models a box occupying a cell. `isBoxPushable(bx, by, dx, dy)` allows an edge into that tile only if the cell one step further along the same direction is `GATE_OPEN` (`"5"`) — i.e. there's room to push the box into. `buildWalkableTiles()`/`buildConnectivity()` use this to decide whether a gate tile (and the edges into it) belong in the PDDL problem at all. When `executeNextAction()` actually steps onto a `GATE_BLOCKED` tile, `applyBoxPush(...)` patches `tileMap` after the fact (the entered tile becomes `GATE_OPEN`, the tile behind becomes `GATE_BLOCKED`) and flags `worldChangedSinceLastPlan` so the next problem reflects the box's new position.

#### Dynamic obstacles (other agents)
If a `move` fails unexpectedly in `executeNextAction()` (most likely another agent standing on the target tile), `setDynamicObstacle(x, y)` marks that tile as blocked for `DYNAMIC_OBSTACLE` ms. While marked, `buildWalkableTiles()` and `buildConnectivity()` exclude it from the PDDL problem entirely, so replans route around it instead of retrying the same failing step. The mark expires automatically via `setTimeout`.
