import "dotenv/config";
import OpenAI from "openai";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";


// ==========================================
// 1. LiteLLM Configuration
// ==========================================

const baseURL = process.env.LITELLM_BASE_URL || "https://llm.bears.disi.unitn.it/v1";
const apiKey = process.env.LITELLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL || "llama-3.3-70b-lmstudio";

if (!apiKey) {
  console.error("Error: missing LITELLM_API_KEY in .env file");
  process.exit(1);
}

// ==========================================
// 2. OpenAI-compatible client
// ==========================================

const client = new OpenAI({
  baseURL,
  apiKey,
});

// ==========================================
// 2B. DeliverooJS Configuration
// ==========================================

const deliverooUrl = process.env.DELIVEROOJS_URL;
const deliverooToken = process.env.DELIVEROOJS_TOKEN;

if (!deliverooUrl || !deliverooToken) {
  console.error("Error: missing DELIVEROOJS_URL or DELIVEROOJS_TOKEN in .env file");
  process.exit(1);
}

const socket = DjsConnect(deliverooUrl, deliverooToken);

const me = {
  id: null,
  name: null,
  x: null,
  y: null,
  score: 0,
};

socket.onYou((you) => {
  me.id = you.id;
  me.name = you.name;
  me.x = you.x;
  me.y = you.y;
  me.score = you.score;
});

import {ArgumentParser} from "argparse";
const parser = new ArgumentParser({description: "Alberto, the Chabal"});
parser.add_argument("--teammate-id", { help: "teammate id", required: false });
let teamAgentId = parser.parse_args().teammate_id ?? null;
console.log("Team agent ID set to:", teamAgentId ?? "None - we go solo!");


// ==========================================
// 2C. Listeners
// ==========================================

/**
 * @type { Map< string, {x:number, y:number, type:string} > }
 */

const tileMap = new Map();
const dropoffs = new Map(); 
const spawnPoints = new Map();
function key(x, y) { return `${x}_${y}`; }
socket.onTile(({x, y, type}) => {
    const k = key(x, y);
    const oldTile = tileMap.get(k);

    // Only print if this is a NEW tile or the TYPE has changed
    if (!oldTile || oldTile.type !== type) {
        
        // If it was a box (5!) and now it's empty (5), or vice versa
        if (oldTile) {
            console.log(`[MAP UPDATE] Tile ${x},${y} changed: ${oldTile.type} -> ${type}`);
        } else {
            console.log(`[MAP DISCOVERY] New tile found at ${x},${y}: type ${type}`);
        }

        // Update the map
        tileMap.set(k, {x, y, type});
        
        // Special case: update dropoffs or spawn points if they are discovered
        if (type == "1") spawnPoints.set(k, {x, y, type});
        if (type == "2") dropoffs.set(k, {x, y, type});
    }
});


/**
 * @type { Map< string, {id: string, carriedBy?: string, x:number, y:number, reward:number} > }
 */
const parcels = new Map();

socket.onSensing( async ( sensing ) => { // Update parcels information Delete/Add parcels based on sensing information
    for (const p of sensing.parcels) {
        parcels.set( p.id, p);
    }
    for ( const p of parcels.values() ) {
        if ( sensing.parcels.map( p => p.id ).find( id => id == p.id ) == undefined ) {
            parcels.delete( p.id );
        }
    }
} )

// Make Alberto a bit more verbal
const pickupCoordination = {};
const teamMessages = new Map(); 


function isPickupMsg(msg) {
  return typeof msg === 'object' && msg !== null && msg.action === 'pickup' && 'parcelId' in msg;
}

socket.onMsg(async (id, name, msg, reply) => {
  // (a) pickup coordination handshake — existing
  if (isPickupMsg(msg)) {
    await new Promise(r => setTimeout(r, 100));
    if (reply) {
      if (pickupCoordination[msg.parcelId] === socket.id) {
        reply(false);
      } else {
        pickupCoordination[msg.parcelId] = id;
        reply(true);
      }
    }
    return;
  }

  // (b) teammate position update — store it, no reply needed
  if (msg?.type === 'position') {
    teamMessages.set(id, { x: msg.x, y: msg.y, name });
    console.log(`Teammate ${name} is at (${msg.x}, ${msg.y}).`);
    return;
  }

  // (c) mission/command branch goes here next (see prior message)
});
// ==========================================
// 3. Standard Tools
// ==========================================

function calculate(expression) {
  console.log("---- CALCULATE ----");
  try {
    const min = Math.min, max = Math.max, abs = Math.abs,
          sqrt = Math.sqrt, floor = Math.floor, ceil = Math.ceil, round = Math.round;
    return String(eval(expression));
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

function getCurrentTime(location) {
  console.log("---- GET CURRENT TIME ----");

  try {
    const normalized = location.trim().toLowerCase();

    const supportedLocations = {
      rome: { city: "Rome", timeZone: "Europe/Rome" },
      roma: { city: "Rome", timeZone: "Europe/Rome" },
    };

    const config = supportedLocations[normalized];

    if (!config) {
      return "Error: Current time is only supported for Rome/Roma in this demo.";
    }

    const now = new Date();

    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));

    const formattedDate = `${map.year}-${map.month}-${map.day}`;
    const formattedTime = `${map.hour}:${map.minute}:${map.second}`;

    return `The current local time in ${config.city} is ${formattedDate} ${formattedTime} (${config.timeZone}).`;
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

async function getMyPosition() {
  console.log("---- GET MY POSITION ----");

  if (me.x === null || me.y === null) {
    return "Error: agent position is not available yet.";
  }

  return JSON.stringify({
    id: me.id,
    name: me.name,
    x: me.x,
    y: me.y,
    score: me.score,
  });
}


async function move(direction) {
  console.log("---- MOVE ----");

  const normalized = direction.trim().toLowerCase();

  const validDirections = ["up", "down", "left", "right"];

  if (!validDirections.includes(normalized)) {
    return `Error: invalid direction '${direction}'. Valid directions are: up, down, left, right.`;
  }

  try {
    const result = await socket.emitMove(normalized);

    if (result) {
      return `Successfully moved ${normalized}. New position: ${JSON.stringify(result)}.`;
    }

    return `Error: failed to move ${normalized}.`;
  } catch (error) {
    return `Error: moving ${normalized} failed: ${error.message}`;
  }
}



// ==========================================
// 3.1 Added Tools
// ==========================================

async function getVisibleParcels() {
  console.log("---- GET VISIBLE PARCELS ----");
  if (parcels.size === 0) {
    return "No parcels currently detected in our known map.";
  }
  return JSON.stringify([...parcels.values()]);
}

async function getTile(input) {
  const [x, y] = input.split(",").map(Number);
  const tile = tileMap.get(key(x, y));
  return JSON.stringify(tile || { x, y, type: "unknown" });
}


async function getDropoffs() {
  console.log("---- GET DROPOFFS ----");
  if (dropoffs.size === 0) {
    return "No dropoff zones discovered yet.";
  }
  return JSON.stringify([...dropoffs.values()]);
}

async function getSpawnPoints() {
  console.log("---- GET SPAWN POINTS ----");
  if (spawnPoints.size === 0) {
    return "No spawn points discovered yet.";
  }
  return JSON.stringify([...spawnPoints.values()]);
}

async function pickUp() {
  console.log("---- PICK UP ----");
  try {
    const result = await socket.emitPickup();  // check exact SDK name
    if (result) return `Picked up parcel successfully: ${JSON.stringify(result)}`;
    return "Error: pickup failed — no parcel at current position.";
  } catch (error) {
    return `Error: pickup failed: ${error.message}`;  // never crash the process
  }
}

async function deliverParcel() {
  console.log("---- DELIVER PARCEL ----");
  try {
    const result = await socket.emitPutdown();  // check exact SDK name
    if (result) return `Delivered parcel successfully: ${JSON.stringify(result)}`;
    return "Error: delivery failed — not at dropoff point or no parcel to deliver.";
  } catch (error) {
    return `Error: delivery failed: ${error.message}`;  // never crash the process
  }
}


async function searchForParcels() {
  console.log("---- SEARCH FOR PARCELS ----");

  if (parcels.size > 0) {
    return "There are already visible parcels. No need to search.";
  }
  
  let closestSpawn = null;
  let minDist = Infinity;

  for (const spawn of spawnPoints.values()) {
    const dist = Math.abs(spawn.x - me.x) + Math.abs(spawn.y - me.y);
    if (dist < minDist) {
      minDist = dist;
      closestSpawn = spawn;
    }
  }
  if (!closestSpawn) {
    return "Error: no known spawn points to search for parcels.";
  }
console.log(`Searching for parcels by navigating to closest spawn point at (${closestSpawn.x}, ${closestSpawn.y})...`);
return await navigateTo(`${closestSpawn.x},${closestSpawn.y}`);


}

async function collectNearbyAndDeliver() {
  console.log("---- COLLECT NEARBY PARCELS AND DELIVER ----");

  const pickedUp = [];
  const processed = [];

  while (true) {
    const candidates = [...parcels.values()]
      .filter(p => !p.carriedBy && p.reward > 0 && !processed.includes(p.id) && pickupCoordination[p.id] !== teamAgentId)
      .sort((a, b) => b.reward - a.reward);

    if (candidates.length === 0) break;

    const target = candidates[0];
    processed.push(target.id); // mark before, so we never loop on it

    //Ask friendly team mates if they are doing this pickup to avoid collisions
    if (teamAgentId) {
      const response = await socket.emitAsk(teamAgentId, { action: "pickup", parcelId: target.id });
      if (!response) {
        console.log(`Team mate declined pickup for ${target.id}`);
        continue;
      }
      pickupCoordination[target.id] = socket.id; // mark it as our target to avoid future conflicts
    }
  
    const nav = await navigateTo(`${target.x},${target.y}`);
    if (!nav.startsWith("Arrived")) {
      console.log(`Could not reach ${target.id}: ${nav}`);
      continue;
    }

    const pickupResult = await pickUp();
    if (pickupResult.startsWith("Picked up")) {
      pickedUp.push(target.id);
    } else {
      console.log(`Pickup failed for ${target.id}: ${pickupResult}`);
    }
  }

  if (pickedUp.length === 0) return "No parcels were picked up.";

  const dropNav = await navigateToClosestDropoff();
  if (!dropNav.startsWith("Arrived")) {
    return `Picked up ${pickedUp.length} parcel(s) but could not reach a dropoff: ${dropNav}`;
  }
  const del = await deliverParcel();
  return `Picked up ${pickedUp.length} parcel(s): ${pickedUp.join(", ")}. Delivery: ${del}`;
}

const TOOLS = {
  calculate,
  get_current_time: getCurrentTime,
  get_my_position: getMyPosition,
  move,
  get_tile: getTile,
  get_dropoffs: getDropoffs,
  get_spawn_points: getSpawnPoints,
  pick_up: pickUp,
  deliver_parcel: deliverParcel,
  navigate_to: navigateTo,
  navigate_to_closest_dropoff: navigateToClosestDropoff,
  navigate_to_closest_spawn: navigateToClosestSpawn,
  get_visible_parcels: getVisibleParcels,
  search_for_parcels: searchForParcels,
  collect_nearby_and_deliver: collectNearbyAndDeliver,
  tell_team_mate: tellTeamMate,
};


// ==========================================
// 3.2 Movement Tools
// =========================================
function heuristic({x: x1, y: y1}, {x: x2, y: y2}) {
    return Math.abs(Math.round(x1) - Math.round(x2)) + Math.abs(Math.round(y1) - Math.round(y2));
}
function aStar(start, goal, blocked = new Set()) {
    const open = [];
    const closed = new Set();
    const cameFrom = new Map();
    const gScore = new Map();
    const fScore = new Map();

    const startKey = key(start.x, start.y);
    gScore.set(startKey, 0);
    fScore.set(startKey, heuristic(start, goal));
    open.push({x: start.x, y: start.y});

    while (open.length > 0) {
        open.sort((a, b) => fScore.get(key(a.x, a.y)) - fScore.get(key(b.x, b.y)));
        const current = open.shift();
        const currentKey = key(current.x, current.y);
        closed.add(currentKey);

        if (current.x === goal.x && current.y === goal.y)
            return reconstructPath(cameFrom, current);

        for (const neighbor of [
            {x: current.x + 1, y: current.y},
            {x: current.x - 1, y: current.y},
            {x: current.x, y: current.y + 1},
            {x: current.x, y: current.y - 1}
        ]) {
            const neighborKey = key(neighbor.x, neighbor.y);
            const tentativeG = gScore.get(currentKey) + 1;

            if (closed.has(neighborKey)) continue;

            const isGoal = (neighbor.x === goal.x && neighbor.y === goal.y);

            // avoid tiles a blocker is occupying (don't enter even if it's the goal)
            if (blocked.has(neighborKey)) continue;

            if (!isWalkable(neighbor.x, neighbor.y) && !isGoal) continue;

            const currentTile = tileMap.get(currentKey);
            const neighborTile = tileMap.get(neighborKey) || { x: neighbor.x, y: neighbor.y, type: '3' };
            if (!MoveIsAllowed(currentTile, neighborTile) && !isGoal) continue;

            if (!gScore.has(neighborKey) || tentativeG < gScore.get(neighborKey)) {
                cameFrom.set(neighborKey, current);
                gScore.set(neighborKey, tentativeG);
                fScore.set(neighborKey, tentativeG + heuristic(neighbor, goal));
                if (!open.some(n => n.x === neighbor.x && n.y === neighbor.y))
                    open.push(neighbor);
            }
        }
    }
    return null;
}

function reconstructPath(cameFrom, current) {
    const path = [current];
    while (cameFrom.has(key(current.x, current.y))) {
        current = cameFrom.get(key(current.x, current.y));
        path.push(current);
    }
    return path.reverse();
}
function MoveIsAllowed(fromTile, toTile) {
   if(!fromTile || !toTile) return true;

   const dx = toTile.x - fromTile.x;
   const dy = toTile.y - fromTile.y;

   if (toTile.type === '↑' && dy !== -1) return false;
   if (toTile.type === '↓' && dy !== 1)  return false;
   if (toTile.type === '←' && dx !== -1) return false;
   if (toTile.type === '→' && dx !== 1)  return false;
   
   return true;
}

async function followPath(start, goal, getPosition, maxRetries = 8) {
  const blocked = new Set();
  let path = aStar(start, goal, blocked);
  let failures = 0;

  while (path && path.length > 1) {
    const from = path[0];
    const to = path[1];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const direction =
      dx === 1 ? "right" : dx === -1 ? "left" : dy === 1 ? "up" : "down";

    const result = await move(direction);

    if (result.startsWith("Error")) {
      failures++;
      if (failures >= maxRetries) {
        return `Blocked: could not progress toward (${goal.x}, ${goal.y}) after ${maxRetries} attempts.`;
      }
      // mark the tile we tried to enter as blocked, then reroute around it
      // in followPath, when a move fails:
      const rawpos = await getPosition();
      const pos = JSON.parse(rawpos);

    if (to.x === goal.x && to.y === goal.y) {
      // transient failure entering the destination — wait and retry, don't blacklist the goal
      await new Promise(r => setTimeout(r, 300));
      path = aStar(pos, goal, blocked);
    } else {
      blocked.add(key(to.x, to.y));
      console.log(`Movement blocked toward (${to.x}, ${to.y}). Marking as blocked and recalculating path...`);
      await new Promise(r => setTimeout(r, 300)); // brief pause before recalculating
      path = aStar(pos, goal, blocked);

      // ... existing reroute ...
    }
    if (!path) {
      return `Blocked: no route to (${goal.x}, ${goal.y}) avoiding occupied tiles.`;
    }
    } else {
      console.log(`Moved ${direction} to (${to.x}, ${to.y}).`);
      path.shift();
      // don't reset `blocked` — the agent may still be there;
      // but do reset the failure counter since we made progress
      failures = 0;

      //Oppurtinistic pickup: if we see a parcel on the ground at our new position, pick it up before continuing to navigate to the goal
      const here = [...parcels.values()].find(p => p.x === to.x && p.y === to.y && !p.carriedBy);
      if (here) {
        const r = await pickUp();
        if (r.startsWith("Picked up")) {
      console.log(`Opportunistic pickup of ${here.id} at (${to.x},${to.y}).`);
    }
      }
    }
  }
  return path ? `Arrived at (${goal.x}, ${goal.y}).` : "No path found.";
}
async function navigateTo(input) {
  const [x, y] = input.split(",").map(Number);
  const goal = { x, y };
  const start = { x: me.x, y: me.y };
  return await followPath(start, goal, getMyPosition);
}
function isWalkable(x, y) {
    const key = `${x}_${y}`;
    const tile = tileMap.get(key);
    // Only allow tiles that are clearly marked as walkable
    return tile && (tile.type === '1' || tile.type === '2' || tile.type === '3');
}

async function navigateToClosestDropoff(input) {
    console.log("Navigating to closest dropoff...");
    if (dropoffs.size === 0) return "Error: no dropoff zones discovered yet.";
    if (me.x === null || me.y === null) return "Error: agent position is not available yet.";

    let closest = null;
    let minDist = Infinity;
    for (const dropoff of dropoffs.values()) {
        const dist = Math.abs(dropoff.x - me.x) + Math.abs(dropoff.y - me.y);
        if (dist < minDist) {
            minDist = dist;
            closest = dropoff;
        }
    }
    if (!closest) return "Error: no reachable dropoff zones found.";
    return navigateTo(`${closest.x},${closest.y}`);
}

async function navigateToClosestSpawn(input) {
    console.log("Navigating to closest spawn point...");
    if (spawnPoints.size === 0) return "Error: no spawn points discovered yet.";
    if (me.x === null || me.y === null) return "Error: agent position is not available yet.";

    let closest = null;
    let minDist = Infinity;
    for (const spawn of spawnPoints.values()) {
        const dist = Math.abs(spawn.x - me.x) + Math.abs(spawn.y - me.y);
        if (dist < minDist) {
            minDist = dist;
            closest = spawn;
        }
    }
    if (!closest) return "Error: no reachable spawn points found.";
    return navigateTo(`${closest.x},${closest.y}`);
}


// ==========================================
// 3.3 Communication Tools
// ==========================================

async function tellTeamMate(msg) {
  if (!teamAgentId) return "Error: no team agent ID specified for communication.";
  await socket.emitSay(teamAgentId, msg);
  return "Message sent to team mate.";
}


// ==========================================
// 4. Reusable LLM call
// ==========================================

async function callModel(messages, { temperature = 0 } = {}) {
  const response = await client.chat.completions.create({
    model: MODEL,
    messages,
    temperature,
  });

  return response.choices?.[0]?.message?.content ?? "";
}

// ==========================================
// 5. Output parsing
// ==========================================

function extractAction(text) {
  const actionMatch = text.match(/^Action:\s*(.+)$/im);
  const actionInputMatch = text.match(/^Action Input:\s*(.+)$/im);

  if (!actionMatch || !actionInputMatch) {
    return null;
  }

  return {
    action: actionMatch[1].trim(),
    actionInput: actionInputMatch[1].trim(),
  };
}

function extractStepResult(text) {
  const match = text.match(/^Step Result:\s*([\s\S]*)$/im);

  if (!match) {
    return null;
  }

  return match[1].trim();
}

function countActions(text) {
  const matches = text.match(/^Action:\s*.+$/gim);
  return matches ? matches.length : 0;
}

function hasBothActionAndStepResult(text) {
  const actionMatch = text.match(/^Action:\s*(.+)$/im);
  const stepResultMatch = text.match(/^Step Result:\s*[\s\S]*$/im);

  if (!actionMatch || !stepResultMatch) {
    return false;
  }

  const action = actionMatch[1].trim().toLowerCase();

  return action !== "none";
}

function safeJsonParse(text) {
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ==========================================
// 6. Prompts
// ==========================================

const PLANNER_PROMPT = `
You are a planning module inside an AI agent connected to a DeliverooJS environment.

Your job is to break the user's request into a short sequence of concrete steps.

Available tools:
- calculate(expression): evaluates a mathematical expression
- get_current_time(location): returns the current local time for Rome/Roma
- get_my_position(): returns the agent's current x, y coordinates and score
- move(direction): moves the agent one step in one direction: up, down, left, or right
- get_tile(x,y): returns the type of tile at coordinates x,y
- get_dropoffs(): returns a list of known dropoff points with their coordinates
- get_spawn_points(): returns a list of known spawn points with their coordinates
- pick_up(): picks up a parcel if the agent is currently on a spawn point
- deliver_parcel(): delivers a parcel if the agent is currently on a dropoff point
- navigate_to(x,y): moves the agent to the specified coordinates using pathfinding and returns the movement result
- navigate_to_closest_dropoff(): navigates to the nearest known dropoff point automatically
- navigate_to_closest_spawn(): navigates to the nearest known spawn point automatically
- When the user asks to navigate to the "closest" dropoff or spawn, use these tools directly — no manual distance calculation needed.
- get_visible_parcels(): returns a JSON array of all currently known or tracked parcels, including their IDs, coordinates, and rewards.
- search_for_parcels(): automatically checks the map for unvisited or nearby spawn points and moves Alberto there to look for new parcels when none are currently visible.
- When the user asks to pick up parcels and deliver them, prefer the collect_nearby_and_deliver() function which will automatically pick up nearby parcels and deliver them efficiently. 
  Do not emit separate pick_up or deliver_parcel steps if collect_nearby_and_deliver() can be used.



Movement rules:
- move(up) decreases y by 1
- move(down) increases y by 1
- move(right) increases x by 1
- move(left) decreases x by 1
- move can move only one step at a time
- if the user asks to move multiple steps, create one move step for each movement
- if the user asks for the current or final position, include a get_my_position step
- if the user asks to move relative to the current position, first include a get_my_position step
- if the user ask to move to specific coordinates, use navigate_to(x,y) instead of multiple move steps
- navigate_to_closest_dropoff(): navigates to the nearest known dropoff point automatically
- navigate_to_closest_spawn(): navigates to the nearest known spawn point automatically
- When the user asks to navigate to the "closest" dropoff or spawn, use these tools directly — no manual distance calculation needed.


Rules:
- Return ONLY valid JSON.
- Do not use markdown.
- Do not explain.
- Keep the plan short: 1 to 10 steps.
- Each step must be concrete and executable.
- If the user asks for the current time in Rome/Roma, include a step that uses get_current_time.
- If the user asks for arithmetic, include a step that uses calculate.
- If the user asks where the agent is, include a step that uses get_my_position.
- If the user asks to move the agent, include one move step for each single movement.
- If the user asks for the final position after moving, include a final get_my_position step.
- pick_up is also a valid action to include in the plan, it picks up a parcel if the agent is on a spawn point
- deliver_parcel is also a valid action to include in the plan, it delivers a parcel if the agent is on a dropoff point
- When asked to search, pick up, and deliver, design plans that maximize efficiency.
- If multiple parcels are likely to be found, instruct the agent to check for visible parcels, loop through picking up multiple high-reward parcels if they are nearby, and only then navigate to the closest dropoff to deliver them all.
- If the user asks to "search for parcels", create a multi-step plan:
  1. Use search_for_parcels() to move to an investigation zone.
  2. Use get_visible_parcels() to look at what is on the ground.
  3. If a parcel is present at the current position, use pick_up().
- When the user asks to navigate to the "closest" dropoff or spawn, use these tools directly — no manual distance calculation needed.
Return exactly this JSON shape:
{
  "steps": [
    "step 1",
    "step 2"
  ]
}
- ANY request involving picking up and delivering parcels (e.g. "pick them up and deliver",
  "collect and deliver", "search pick up deliver") MUST use exactly:
  ["search_for_parcels()", "collect_nearby_and_deliver()"]
  Never emit individual pick_up() or deliver_parcel() steps for multi-parcel collection.
- tell_team_mate(message): sends a message to the teammate agent (use for sharing position or coordinating)
`.trim();

const EXECUTOR_PROMPT = `
You are an executor module inside an AI agent connected to a DeliverooJS environment.

You execute exactly ONE step at a time.

Available tools:
- calculate(expression): evaluates a mathematical expression
- get_current_time(location): returns the current local time for Rome/Roma
- get_my_position(): returns the agent's current x, y coordinates and score
- move(direction): moves the agent one step in one direction: up, down, left, or right
- get_tile(x,y): returns the tile type at coordinates x,y (input format: "x,y")
- get_dropoffs(): returns all known delivery/dropoff zone coordinates
- get_spawn_points(): returns all known parcel spawn point coordinates
- pick_up(): picks up a parcel if the agent is currently on a spawn point
- deliver_parcel(): delivers a parcel if the agent is currently on a dropoff point
- navigate_to(x,y): moves the agent to the specified coordinates using pathfinding and returns the movement result
- navigate_to_closest_dropoff(): navigates to the nearest known dropoff point automatically
- navigate_to_closest_spawn(): navigates to the nearest known spawn point automatically
- When the user asks to navigate to the "closest" dropoff or spawn, use these tools directly — no manual distance calculation needed.
- get_visible_parcels(): returns a JSON array of all currently known or tracked parcels, including their IDs, coordinates, and rewards.
- search_for_parcels(): automatically checks the map for unvisited or nearby spawn points and moves Alberto there to look for new parcels when none are currently visible.
- When the user asks to pick up parcels and deliver them, prefer the collect_nearby_and_deliver() function which will automatically pick up nearby parcels and deliver them efficiently. 
  Do not emit separate pick_up or deliver_parcel steps if collect_nearby_and_deliver() can be used.
- tell_team_mate(message): sends a message to the teammate agent (use for sharing position or coordinating)

Movement rules:
- move(up) decreases y by 1
- move(down) increases y by 1
- move(right) increases x by 1
- move(left) decreases x by 1
- move can move only one step at a time
- to check the current position, call get_my_position with Action Input: none
- if the user asks to move to specific coordinates, use navigate_to(x,y) instead of multiple move steps

You receive:
- the original user request
- the full plan
- completed step results so far
- the current step to execute

STRICT OUTPUT FORMAT — choose exactly one format.

FORMAT 1 — use one tool:

Thought: <brief reasoning>
Action: <tool name>
Action Input: <tool input>

FORMAT 2 — step complete:

Thought: I completed this step.
Step Result: <result for this step>

Rules:
- Execute only the current step.
- Do not execute future steps.
- Output exactly one action at a time.
- Never output two actions in the same message.
- Never output an Action and a Step Result in the same message.
- Never write Action: None.
- Do not invent tool results.
- Do not calculate arithmetic yourself.
- Do not invent the current time.
- Do not invent the agent position.
- Do not invent movement results.
- If the current step requires arithmetic, call calculate.
- If the current step requires the current time in Rome/Roma, call get_current_time.
- If the current step requires the current position, call get_my_position.
- If the current step requires movement, call move.
- If the current step does not require a tool, do not output Action.
- If the current step can be completed using previous step results, return Step Result directly.
- Use only the available tools.
- If the current step requires dropoff locations, call get_dropoffs.
- If the current step requires spawn point locations, call get_spawn_points.
- If the current step requires tile info at a position, call get_tile.
- If the current step requires picking up a parcel, call pick_up.
- If the current step requires delivering a parcel, call deliver_parcel.
- If the current step requires moving to specific coordinates, use navigate_to(x,y) instead of multiple move steps.
- After receiving an Observation, decide whether the step is truly complete.
  If you still need to call a tool to finish the step, call it using Action/Action Input.
  Only return a Step Result when the action has been fully executed.
- A Step Result must describe what actually happened, not name a tool to call.
  Writing "navigate_to(20, 2)" as a Step Result is WRONG — you must call it as an Action first.
- A step that requires navigate_to is NOT complete until navigate_to has been called and returned a result.
- If i ask you to deliver a parcel, you must make sure you stand on a dropoff point before calling deliver_parcel. If you are not on a dropoff point, you must navigate there first by calling navigate_to_closest_droppoff or navigate_to with the dropoff coordinates and then call deliver parcel
- A step requiring 'pick_up()' or 'deliver_parcel()' is NOT complete until you have explicitly invoked that specific tool action and received its specific success observation. 
- Do not assume that moving or arriving at a destination automatically executes a pickup or delivery.
- If an Observation reports "unknown tool", you called a tool that does not exist. Re-read the available tools list, pick the correct exact name, and call it with a new Action. NEVER return a Step Result claiming success after an unknown-tool error.
`.trim();

const FINAL_ANSWER_PROMPT = ` 
You are the final response module of an AI agent.

You receive:
- the original user request
- the plan that was executed
- the result of each step

Write a clear, concise final answer for the user.
If any step failed or could not be verified, say so explicitly.
`.trim();

// ==========================================
// 7. Conversation memory
// ==========================================

// Global memory stores only the visible conversation.
// It does not store internal actions, observations, or plans.
const messages = [
  {
    role: "system",
    content: "You are a concise assistant.",
  },
];

// ==========================================
// 8. Planner
// ==========================================

async function createPlan(userInput) {
  const plannerMessages = [
    {
      role: "system",
      content: PLANNER_PROMPT,
    },
    {
      role: "user",
      content: userInput,
    },
  ];

  const rawPlan = await callModel(plannerMessages, { temperature: 0 });

  console.log("=== PLAN RAW OUTPUT ===");
  console.log(rawPlan);
  console.log();

  const parsedPlan = safeJsonParse(rawPlan);

  if (
    !parsedPlan ||
    !Array.isArray(parsedPlan.steps) ||
    parsedPlan.steps.length === 0
  ) {
    console.log("Warning: planner returned invalid JSON. Using fallback plan.\n");

    return {
      steps: [`Answer the user's request: ${userInput}`],
    };
  }

  return parsedPlan;
}

// ==========================================
// 9. Step executor
// ==========================================

async function executeStep(step, context, maxStepIterations = 4) {
  const stepMessages = [
    {
      role: "system",
      content: EXECUTOR_PROMPT,
    },
    {
      role: "user",
      content:
        `Original user request:\n${context.userInput}\n\n` +
        `Full plan:\n${context.plan.steps
          .map((s, index) => `${index + 1}. ${s}`)
          .join("\n")}\n\n` +
        `Completed step results so far:\n${
          context.completedResults.length > 0
            ? context.completedResults
                .map((result, index) => `${index + 1}. ${result}`)
                .join("\n")
            : "None"
        }\n\n` +
        `Current step to execute:\n${step}`,
    },
  ];

  console.log("=== EXECUTING STEP ===");
  console.log(step);
  console.log();

  for (let i = 0; i < maxStepIterations; i++) {
    console.log(`--- Step iteration ${i + 1} ---`);

    const assistantMessage = await callModel(stepMessages, { temperature: 0 });

    console.log(`Assistant output:\n${assistantMessage}\n`);

    stepMessages.push({
      role: "assistant",
      content: assistantMessage,
    });

    const actionCount = countActions(assistantMessage);
    const mixedOutput = hasBothActionAndStepResult(assistantMessage);

    if (actionCount > 1) {
      console.log(
        `[Warning: model output contained ${actionCount} actions. ` +
          `The runtime will execute only the first one.]\n`
      );
    }

    if (mixedOutput) {
      console.log(
        "[Warning: model output contained both Action and Step Result. " +
          "The runtime will execute the Action and ignore the premature Step Result.]\n"
      );
    }

    // Defensive rule:
    // If an Action is present, execute it before accepting any Step Result.
    const parsedAction = extractAction(assistantMessage);

    if (parsedAction) {
      const { action, actionInput } = parsedAction;

      let observation;

      if (TOOLS[action]) {
        console.log(`[System executing tool: ${action}("${actionInput}")]`);
        observation = await TOOLS[action](actionInput);
      } else {
        observation =
          `Error: unknown tool '${action}'. ` +
          `Available tools: ${Object.keys(TOOLS).join(", ")}`;
      }

      console.log(`[Observation: ${observation}]\n`);

      stepMessages.push({
        role: "user",
        content:
          `Observation: ${observation}\n\n` +
          `Now complete the current step. ` +
          `Return a Step Result. Do not execute future steps. ` +
          `Remember: output only one Action or one Step Result.`,
      });

      continue;
    }

    const stepResult = extractStepResult(assistantMessage);

    if (stepResult) {
      return {
        success: true,
        result: stepResult,
      };
    }

    const observation =
      "Error: invalid format. You must output either one Action or one Step Result.";

    console.log(`[Observation: ${observation}]\n`);

    stepMessages.push({
      role: "user",
      content: `Observation: ${observation}`,
    });
  }

  return {
    success: false,
    result: `Step could not be completed: ${step}`,
  };
}

// ==========================================
// 10. Final answer builder
// ==========================================

async function buildFinalAnswer(userInput, plan, completedResults) {
  const finalMessages = [
    {
      role: "system",
      content: FINAL_ANSWER_PROMPT,
    },
    {
      role: "user",
      content:
        `Original user request:\n${userInput}\n\n` +
        `Executed plan:\n${plan.steps
          .map((step, index) => `${index + 1}. ${step}`)
          .join("\n")}\n\n` +
        `Step results:\n${completedResults
          .map((result, index) => `${index + 1}. ${result}`)
          .join("\n")}`,
    },
  ];

  return await callModel(finalMessages, { temperature: 0.1 });
}

// ==========================================
// 11. Agent turn
// ==========================================

async function runAgentTurn(userInput) {
  // 1. Create a plan
  const plan = await createPlan(userInput);

  console.log("=== PLAN ===");
  plan.steps.forEach((step, index) => {
    console.log(`${index + 1}. ${step}`);
  });
  console.log();

  // 2. Execute each planned step explicitly
  const completedResults = [];

  for (const step of plan.steps) {
    const execution = await executeStep(step, {
      userInput,
      plan,
      completedResults,
    });

    completedResults.push(execution.result);
  }

  console.log("=== STEP RESULTS ===");
  completedResults.forEach((result, index) => {
    console.log(`${index + 1}. ${result}`);
  });
  console.log();

  // 3. Build final answer from all step results
  const finalAnswer = await buildFinalAnswer(userInput, plan, completedResults);

  console.log(`Assistant: ${finalAnswer}\n`);

  // 4. Store only visible conversation
  messages.push({
    role: "user",
    content: userInput,
  });

  messages.push({
    role: "assistant",
    content: finalAnswer,
  });
}

// ==========================================
// 12. Terminal chat loop
// ==========================================

const rl = readline.createInterface({ input, output });

console.log("Mini agent 10: planner + DeliverooJS step executor started.");
console.log("Commands:");
console.log("- /memory   show visible conversation memory");
console.log("- /reset    clear conversation memory");
console.log("- /exit     quit");
console.log();

while (true) {
  const userInput = await rl.question("You: ");
  const command = userInput.trim().toLowerCase();

  if (command === "/exit" || command === "exit") {
    break;
  }

  if (command === "/memory") {
    console.dir(messages, { depth: null });
    console.log();
    continue;
  }

  if (command === "/reset") {
    messages.splice(1);
    console.log("Conversation memory reset.\n");
    continue;
  }

  if (userInput.trim() === "") {
    continue;
  }

  await runAgentTurn(userInput);

  console.log(`Visible memory contains ${messages.length} messages.\n`);
}

rl.close();

console.log("\nChat ended.");


// Test examples:
// What time is it in Rome?
// How much is 12 * 7?
// What time is it in Rome, and how much is 12 * 7?
// Where are you?
// Move up.
// Move up and then right.
// Move right twice and then up once.
// Move up, then right, then tell me where you are.
// First tell me where you are, then move right twice, then tell me your final position.