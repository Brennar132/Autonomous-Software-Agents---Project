# Autonomous Agents for Deliveroo.js

Two cooperating software agents for [Deliveroo.js](https://github.com/unitn-ASA/Deliveroo.js), a multi-agent game where agents pick up parcels on a grid and deliver them to drop-off tiles while competing with other agents.

Project for the **Autonomous Software Agents** course at the **University of Trento** (2025–2026), by Tomás Aladjem Ramallo and Erik Brenner Hedmark.

| Agent | File | Approach |
|---|---|---|
| **Agent A** ("Albertito") | [`Albertitos/Albertito.js`](Albertitos/Albertito.js) | BDI agent with A* navigation |
| **Agent A, PDDL version** | [`Albertitos/pddl_albertito.js`](Albertitos/pddl_albertito.js) | Same beliefs, plans computed by Fast Downward |
| **Agent B** ("Alberto") | [`Alberto/alberto.mjs`](Alberto/alberto.mjs) | LLM agent that turns user instructions into plans executed with tools |

The two agents can also run as a team, sharing positions and coordinating through messages.

## Agent A: BDI agent

A sense, revise, deliberate, act loop built on the course's `intention_revision.js` template and extended in several ways:

- **Belief revision that can forget.** Tiles where a move failed are marked as temporary obstacles, parcels that could not be picked up are ignored for a while, and the agent remembers when it last visited each tile so exploration prefers areas it has not seen recently.
- **Intention revision.** Duplicate goals are filtered out, a pickup found on the way interrupts a delivery, and an intention is cancelled as soon as its parcel disappears.
- **Strategy.**
  - When carrying parcels, the agent heads to the nearest drop-off but takes a detour for another parcel if the extra distance `Δ = d(me, p) + d(p, dropoff) − d(me, dropoff)` is worth its reward.
  - When empty-handed, it builds a chain of several parcels per trip.
  - When no parcels are visible, it explores spawn points it has not visited for a while.
- **Navigation.** Full A* that replans when the map changes or a step fails, with timeouts so the agent never gets stuck. It respects one-way (arrow) tiles and only walks into a gate when the box on it can actually be pushed.

## Agent A: PDDL version

`pddl_albertito.js` keeps the same belief revision but delegates the decisions to a classical planner:

- The domain ([`domain.pddl`](Albertitos/domain.pddl)) has three STRIPS actions: `move`, `pickup` and `dropoff`.
- The problem is regenerated on every planning cycle. One-way tiles, pushable gates and tiles blocked by other agents are encoded in which `connected` facts are emitted, so the planner never produces an invalid route.
- All selected parcels share one goal, so Fast Downward computes a single route through all of them. The number of parcels per problem is capped (5 by default) to keep planning real-time.
- The planner runs asynchronously: the agent keeps executing its current plan while a new one is computed, and stale plans are discarded with a version check. A 1-second planning heartbeat skips replanning while the current plan is still valid.

## Agent B: LLM agent

Alberto reads instructions from the terminal (for example, "collect and deliver, but avoid tile 24,12") and:

1. `createPlan()` asks the LLM for a JSON list of steps.
2. `executeStep()` runs each step, letting the model call tools such as `navigate_to(x, y)`, `collect_nearby_and_deliver()`, `search_for_parcels()` and tools that change the game rules, like `add_forbidden_tile` or `set_delivery_stack_size`.
3. `buildFinalAnswer()` reports what was done and how the agent sees the world afterwards.

It works with any OpenAI-compatible endpoint (the course used a LiteLLM proxy).

## Coordination between the agents

- **Position sharing.** Each agent broadcasts its position, and the teammate's tile is treated as a short-lived obstacle by A*.
- **Pickup handshake.** Before chasing a parcel, an agent asks the other whether it is already going for it, so they never converge on the same target.
- **Requests from Agent B to Agent A.**
  - *request fetch*: Agent A brings its parcels to Agent B, who delivers them.
  - *approach and release*: Agent A meets Agent B and stays nearby before both continue.
  - *red light / green light*: both agents freeze until Agent B releases them.

## Project structure

```text
Albertitos/          Agent A: BDI agent, PDDL version, A*, domain.pddl
Alberto/             Agent B: LLM agent
benchmarkAgent/      Simple benchmark agent used for comparison
Labs/                Course lab exercises (Deliveroo APIs, belief revision, planning, communication, LLMs)
index.js, config.js  Course template files (from unitn-ASA/DeliverooAgent.js)
```

## Running

Requirements:

- Node.js 18 or later.
- A Deliveroo.js server. A local server at `http://localhost:8080` works.
- For the PDDL version: [Fast Downward](https://www.fast-downward.org/) cloned into `fast-downward/` at the repository root.
- For Agent B: an OpenAI-compatible LLM endpoint and API key.

Install the dependencies:

```bash
npm install
```

Each agent reads its configuration from a `.env` file in its own folder. Copy the template and fill it in:

```bash
cp Albertitos/.env.example Albertitos/.env
cp Alberto/.env.example Alberto/.env
```

`.env` files are git-ignored. Never commit tokens or API keys.

Run each agent on its own:

```bash
cd Albertitos && node Albertito.js          # BDI agent
cd Albertitos && node pddl_albertito.js     # PDDL version
cd Alberto && node alberto.mjs              # LLM agent
```

Run them as a team by passing each one the other's agent id:

```bash
cd Alberto && node alberto.mjs --teammate-id <albertito-id>
cd Albertitos && node Albertito.js --teammate-id <alberto-id>
```

## Known limitations

- The LLM agent occasionally picks the wrong tool for an instruction (for example, delivering instead of avoiding a tile), so complex requests are not always followed exactly.
- When a parcel sits on a tile at the edge of the map, the BDI agent sometimes steps on it without picking it up and has to step back and forth.

## Authors

- **Tomás Aladjem Ramallo**: [GitHub](https://github.com/Samot2003) · [LinkedIn](https://www.linkedin.com/in/tomas-aladjem/)
- **Erik Brenner Hedmark**: [GitHub](https://github.com/Brennar132)
