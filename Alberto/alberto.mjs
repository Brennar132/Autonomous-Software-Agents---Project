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
let missionBusy = false; // Guard against concurrent missions aka having multiple runAgentTurn() calls at the same time
const carrying = new Set();   // parcel ids Alberto is currently holding
const handoff = { ready: false, x: null, y: null, count: 0, reqId: 0};

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

  
  // (c) mission/command branch
  if (msg?.type === 'mission') {
    const instruction = msg.text ?? msg.instruction ?? msg.content;
    if (!instruction) {
      if (reply) reply({ ok: false, error: 'No instruction provided.' });
      return;
    }

    if (missionBusy) {
      if (reply) reply({ ok: false, error: 'busy' });
      return;
    }

    console.log(`Received mission from ${name} ${id}: ${instruction}`);
    if (reply) reply({ ok: true, status: 'accepted' });

    missionBusy = true;
    try {
      await runAgentTurn(instruction);
    } catch (error) {
      console.error(`Error executing mission from ${name} ${id}:`, error);
    } finally {
      missionBusy = false;
    }
    return;
  }
  if (msg?.type === 'handoff_ready') {
    if (msg.reqId !== handoff.reqId) {
      return;
    }
    handoff.ready = true;
    handoff.x = msg.x;
    handoff.y = msg.y;
    handoff.count = msg.count ?? 0;
    console.log('[HANDOFF] Albertito left parcels in', handoff.x, handoff.y, 'count:', handoff.count);
    return;
  }
});

// ==========================================
// 2D. Position broadcast — make Alberto verbal
// ==========================================
setInterval(() => {
  if (me.id && teamAgentId) {
    socket.emitSay(teamAgentId, { type: 'position', x: me.x, y: me.y });
    //console.log(`[COMMS] Sent position to teammate: (${me.x}, ${me.y}) to ${teamAgentId}`);
  } else {
    //console.log(`[COMMS] silent — me.id=${me.id}, teamAgentId=${teamAgentId}`);
  }
}, 1000);

// ==========================================
// 2E. Dynamic game strategy from requests - Challenge 2 level 2
// ==========================================

const activeRules = {
  requiredStackSize: null,
  stackRewardMultiplier: 1,
  tileRewardOverrides: new Map(),
  maxParcelScore: Infinity,
  forbiddenTiles: new Set()
}



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
    const result = await socket.emitPutdown();
    if (result) {
      carrying.clear();   // everything we held was dropped at the dropoff
      return `Delivered parcel successfully: ${JSON.stringify(result)}`;
    }
    return "Error: delivery failed — not at dropoff point or no parcel to deliver.";
  } catch (error) {
    return `Error: delivery failed: ${error.message}`;
  }
}


async function searchForParcels() {
  console.log("---- SEARCH FOR PARCELS ----");
  if (parcels.size > 0) return "There are already visible parcels. No need to search.";

  // Rank spawn points by ACTUAL path cost (A* length), not Manhattan distance.
  const start = { x: me.x, y: me.y };
  const ranked = [...spawnPoints.values()]
    .map(s => {
      const path = aStar(start, { x: s.x, y: s.y }, new Set(activeRules.forbiddenTiles));
      return { spawn: s, cost: path ? path.length : Infinity };
    })
    .filter(e => e.cost !== Infinity)          // drop unreachable spawns
    .sort((a, b) => a.cost - b.cost);

  if (ranked.length === 0) return "Error: no reachable spawn points found.";

  for (const { spawn, cost } of ranked) {
    console.log(`Trying spawn (${spawn.x}, ${spawn.y}), path cost ${cost}...`);
    const result = await navigateTo(`${spawn.x},${spawn.y}`);

    // If we sensed parcels at any point during the walk, stop searching immediately.
    if (parcels.size > 0) {
      return `Found parcel(s) while en route to spawn (${spawn.x}, ${spawn.y}).`;
    }
    if (result.startsWith("Arrived")) { 
      // arrived but still nothing sensed here — try the next spawn
      if (parcels.size > 0) return `Found parcel(s) at spawn (${spawn.x}, ${spawn.y}).`;
      console.log(`Nothing at spawn (${spawn.x},${spawn.y}), continuing search...`);
      continue;
    }
    console.log(`Spawn (${spawn.x},${spawn.y}) unreachable at run time: ${result}`);
  }
  return "Searched all reachable spawn points; no parcels found.";
}

async function collectNearbyAndDeliver() {
  console.log("---- COLLECT NEARBY PARCELS AND DELIVER ----");

  const target_stack = activeRules.requiredStackSize;   // null = no constraint
  const pickedUp = [];
  const processed = [];

  while (true) {
    // stop early once we've reached an exact required stack size
    if (target_stack !== null && carrying.size >= target_stack) break;

    const candidates = [...parcels.values()]
      .filter(p => !p.carriedBy && p.reward > 0
        && p.reward <= activeRules.maxParcelScore
        && !processed.includes(p.id)
        && pickupCoordination[p.id] !== teamAgentId)
      .sort((a, b) => b.reward - a.reward);

    if (candidates.length === 0) break;

    const target = candidates[0];
    processed.push(target.id);

    if (teamAgentId) {
      const response = await socket.emitAsk(teamAgentId, { action: "pickup", parcelId: target.id });
      if (!response) {
        console.log(`Team mate declined pickup for ${target.id}`);
        continue;
      }
      pickupCoordination[target.id] = socket.id;
    }

    const nav = await navigateTo(`${target.x},${target.y}`);
    if (!nav.startsWith("Arrived")) {
      console.log(`Could not reach ${target.id}: ${nav}`);
      continue;
    }

    const pickupResult = await pickUp();
    if (pickupResult.startsWith("Picked up")) {
      carrying.add(target.id);
      pickedUp.push(target.id);
      if (target_stack !== null && carrying.size >= target_stack) break;
    } else {
      console.log(`Pickup failed for ${target.id}: ${pickupResult}`);
    }
  }
 
  if (carrying.size === 0) return "No parcels available to collect or deliver.";

  if (target_stack !== null && carrying.size < target_stack) {
    return `Stack requirement not met: need ${target_stack}, carrying ${carrying.size} (${[...carrying].join(", ")}). Not delivering.`;
  }

  const deliveredCount = carrying.size;
  const deliveredIds = [...carrying];
  const dropNav = await navigateToClosestDropoff();
  if (!dropNav.startsWith("Arrived")) {
    return `Carrying ${deliveredCount} parcel(s) but could not reach a dropoff: ${dropNav}`;
  }
  const del = await deliverParcel();
  return `Delivered ${deliveredCount} parcel(s): ${deliveredIds.join(", ")}. Result: ${del}`;
}



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
    open.push({ x: start.x, y: start.y });

    while (open.length > 0) {
        open.sort((a, b) => fScore.get(key(a.x, a.y)) - fScore.get(key(b.x, b.y)));
        const current = open.shift();
        const currentKey = key(current.x, current.y);

        if (current.x === goal.x && current.y === goal.y)
            return reconstructPath(cameFrom, current);

        closed.add(currentKey);

        const neighbors = [
            { x: current.x + 1, y: current.y },
            { x: current.x - 1, y: current.y },
            { x: current.x, y: current.y + 1 },
            { x: current.x, y: current.y - 1 },
        ];

        for (const neighbor of neighbors) {
            const neighborKey = key(neighbor.x, neighbor.y);

            if (closed.has(neighborKey)) continue;

            const isGoal = (neighbor.x === goal.x && neighbor.y === goal.y);

            // a blocker (teammate/opponent) occupies this tile — never enter, even if it's the goal
            if (blocked.has(neighborKey)) continue;

            // walls / non-walkable rejected, but allow stepping onto the goal tile itself
            if (!isWalkable(neighbor.x, neighbor.y) && !isGoal) continue;

            // directional-tile constraint: arrow on destination forces entry direction
            const fromTile = tileMap.get(currentKey)  || { x: current.x,  y: current.y,  type: '3' };
            const toTile   = tileMap.get(neighborKey) || { x: neighbor.x, y: neighbor.y, type: '3' };
            if (!MoveIsAllowed(fromTile, toTile)) continue;

            const tentativeG = gScore.get(currentKey) + 1;

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
  if (!fromTile || !toTile) return true;
  const dx = toTile.x - fromTile.x;
  const dy = toTile.y - fromTile.y;
  // Arrow on the DESTINATION tile forces the direction of entry.
  // Movement model: up = y+1, down = y-1, right = x+1, left = x-1.
  if (toTile.type === '→' && dx !== 1)  return false;
  if (toTile.type === '←' && dx !== -1) return false;
  if (toTile.type === '↑' && dy !== 1)  return false;
  if (toTile.type === '↓' && dy !== -1) return false;
  return true;
}

async function followPath(start, goal, getPosition, maxRetries = 8) {
  const blocked = new Set(activeRules.forbiddenTiles);
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
      const stackTarget = activeRules.requiredStackSize;
      const stackFull = stackTarget !== null && carrying.size >= stackTarget;
      const here = stackFull ? null : [...parcels.values()].find(p =>
        p.x === to.x && p.y === to.y &&
        !p.carriedBy &&
        p.reward > 0 &&
        p.reward <= activeRules.maxParcelScore                 // respect score cap
      );
      if (here) {
        const r = await pickUp();
        if (r.startsWith("Picked up")) {
          carrying.add(here.id);
          console.log(`Opportunistic pickup of ${here.id} at (${to.x},${to.y}).`);
          // if this pickup just completed the stack, stop grabbing more
          if (stackTarget !== null && carrying.size >= stackTarget) {
            console.log(`Stack complete (${carrying.size}/${stackTarget}) — no more opportunistic pickups.`);
          }
        }
      }
    }
  return path ? `Arrived at (${goal.x}, ${goal.y}).` : "No path found.";
  }
}
async function navigateTo(input) {
  const [x, y] = input.split(",").map(Number);
  const goal = { x, y };
  const start = { x: me.x, y: me.y };
  return await followPath(start, goal, getMyPosition);
}
function isWalkable(x, y) {
    if (x < 0 || y < 0) return false;
    const tile = tileMap.get(`${x}_${y}`);
    if (!tile) return true;        // unknown = walkable, followPath self-corrects
    if (tile.type === '0') return false;   // wall = only hard block
    return true;                   // 1, 2, 3, arrows all walkable
}

async function navigateToClosestDropoff() {
    console.log("Navigating to best dropoff (reward-aware)...");
    if (dropoffs.size === 0) return "Error: no dropoff zones known.";
    if (me.x === null || me.y === null) return "Error: agent position unknown.";

    let best = null;
    let bestScore = -Infinity;
    for (const d of dropoffs.values()) {
        const mult = tileRewardMultiplier(d.x, d.y);
        if (mult <= 0) continue;                       // skip 0/negative-reward dropoffs entirely
        const dist = Math.abs(d.x - me.x) + Math.abs(d.y - me.y) + 1;   // +1 avoids /0
        const score = mult / dist;                     // reward per step
        if (score > bestScore) { bestScore = score; best = d; }
    }
    if (!best) return "Error: no profitable dropoff available under current rules.";
    console.log(`Best dropoff (${best.x},${best.y}), multiplier ${tileRewardMultiplier(best.x, best.y)}x`);
    return navigateTo(`${best.x},${best.y}`);
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
function extremeTiles(source, direction) {
  const tiles = [...source.values()];
  if (tiles.length === 0) return { tiles: [], value: null };

  let value, filtered;
  switch (direction) {
    case "left":  value = Math.min(...tiles.map(t => t.x)); filtered = tiles.filter(t => t.x === value); break;
    case "right": value = Math.max(...tiles.map(t => t.x)); filtered = tiles.filter(t => t.x === value); break;
    case "down":  value = Math.min(...tiles.map(t => t.y)); filtered = tiles.filter(t => t.y === value); break;
    case "up":    value = Math.max(...tiles.map(t => t.y)); filtered = tiles.filter(t => t.y === value); break;
    default: return { tiles: [], value: null };
  }
  return { tiles: filtered, value };
}

async function deliverToExtreme(input) {
  console.log("---- EXTREME TILE RULE ----");
  // input format: "direction,points"  e.g. "left,5" or "up,-10"
  const [dirRaw, ptsRaw] = String(input).split(",");
  const direction = (dirRaw || "").trim().toLowerCase();
  const points = Number(ptsRaw);

  if (!["left", "right", "up", "down"].includes(direction))
    return `Error: invalid direction "${direction}". Use left/right/up/down.`;
  if (Number.isNaN(points)) return `Error: could not parse points from "${ptsRaw}".`;
  if (dropoffs.size === 0) return "Error: no dropoff zones known.";

  const { tiles, value } = extremeTiles(dropoffs, direction);
  if (tiles.length === 0) return `Error: no ${direction}most dropoff found.`;

  if (points < 0) {
    for (const t of tiles) activeRules.forbiddenTiles.add(key(t.x, t.y));
    console.log(`Blacklisted ${tiles.length} ${direction}most tile(s) at ${value}.`);
    const nav = await navigateToClosestDropoff();
    if (!nav.startsWith("Arrived"))
      return `${direction}most tile penalized (${points}pt); no reachable alternative: ${nav}`;
    const del = await deliverParcel();
    return `${direction}most tile would cost ${points}pt — avoided it, delivered elsewhere. ${del}`;
  }
 
  const ranked = tiles
    .map(t => {
      const path = aStar({ x: me.x, y: me.y }, { x: t.x, y: t.y }, new Set(activeRules.forbiddenTiles));
      return { tile: t, cost: path ? path.length : Infinity };
    })
    .filter(e => e.cost !== Infinity)
    .sort((a, b) => a.cost - b.cost);

  if (ranked.length === 0) return `Error: no reachable ${direction}most tile.`;

  for (const { tile } of ranked) {
    const nav = await navigateTo(`${tile.x},${tile.y}`);
    if (nav.startsWith("Arrived")) {
      const del = await deliverParcel();
      return `Delivered on ${direction}most tile (${tile.x},${tile.y}) for +${points}pt. ${del}`;
    }
  }
  return `Error: all ${direction}most tiles unreachable.`;
}

function nearestOddRow() {
  let best = null, bestDist = Infinity;
  for (const t of tileMap.values()) {
    if (t.type === '0') continue;               // wall
    if (Math.round(t.y) % 2 !== 1) continue;    // odd rows only
    const d = Math.abs(t.x - me.x) + Math.abs(t.y - me.y);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}
function nearestHandoffTile() {
  // adjacent tiles to me, in preference order
  const neighbors = [
    { x: me.x + 1, y: me.y },
    { x: me.x - 1, y: me.y },
    { x: me.x, y: me.y + 1 },
    { x: me.x, y: me.y - 1 },
  ];
  for (const n of neighbors) {
    if (isWalkable(n.x, n.y) && !dropoffs.has(key(n.x, n.y))) {
      return n;   // a tile next to me, not my own, not a dropoff
    }
  }
  // fallback: nearest walkable non-dropoff tile that isn't my own tile
  let best = null, bestDist = Infinity;
  for (const t of tileMap.values()) {
    if (t.type === '0') continue;
    if (dropoffs.has(key(t.x, t.y))) continue;
    if (t.x === me.x && t.y === me.y) continue;   // never my own tile
    const d = Math.abs(t.x - me.x) + Math.abs(t.y - me.y);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

async function stackDeliver(input) {
  console.log("---- STACK DELIVER ----");
  const n = Number(String(input).trim());
  if (!Number.isInteger(n) || n <= 0) return `Error: invalid stack size "${input}".`;

  activeRules.requiredStackSize = n;
  console.log(`Stack rule set: deliver exactly ${n} parcels together.`);

  if (parcels.size === 0) {
    const search = await searchForParcels();
    console.log(`Search: ${search}`); 
  }
  const result = await collectNearbyAndDeliver();
  return `Exactly-${n} stack delivery: ${result}`;
}
// ==========================================
// 3.3 Communication Tools
// ==========================================

async function tellTeamMate(msg) {
  if (!teamAgentId) return "Error: no team agent ID specified for communication.";
  await socket.emitSay(teamAgentId, msg);
  return "Message sent to team mate.";
}
async function approchAndRelease(_input){
  console.log("---- APPROACH TEAMMATE ----");
  if(!teamAgentId) return "Error: no team agent ID specified for communication.";

  const partner = teamMessages.get(teamAgentId);
  if(!partner) return "Error: no position information for team mate.";

  socket.emitSay(teamAgentId, { type: 'freeze' });
  console.log(`Sent freeze command to teammate ${teamAgentId}.`);
  // give Albertito a moment to actually stop and stop broadcasting
  await new Promise(r => setTimeout(r, 400));

  const partnerNow = teamMessages.get(teamAgentId) || partner;
  const tx = Math.round(partnerNow.x), ty = Math.round(partnerNow.y);

  // already close enough?
  if (Math.abs(me.x - tx) + Math.abs(me.y - ty) <= 3) {
    socket.emitSay(teamAgentId, { type: 'resume' });
    return `Already within distance 3 of teammate (${tx},${ty}). Released.`;
  }

  // Find a walkable tile within distance 3 of the teammate that ISN'T his tile,
  // pick the one closest to me, and navigate there using the robust followPath.
  const candidates = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      if (Math.abs(dx) + Math.abs(dy) > 3) continue;   // Manhattan ≤ 3
      if (dx === 0 && dy === 0) continue;              // not his own tile
      const cx = tx + dx, cy = ty + dy;
      if (!isWalkable(cx, cy)) continue;
      candidates.push({ x: cx, y: cy });
    }
  }
  candidates.sort((a, b) =>
    (Math.abs(me.x - a.x) + Math.abs(me.y - a.y)) -
    (Math.abs(me.x - b.x) + Math.abs(me.y - b.y)));

  let arrived = false;
  for (const c of candidates) {
    const nav = await followPath({ x: me.x, y: me.y }, { x: c.x, y: c.y }, getMyPosition);
    if (nav.startsWith("Arrived")) { arrived = true; break; }
    // else try next-closest candidate
  }

  socket.emitSay(teamAgentId, { type: 'resume' });
  return arrived
    ? `Reached within distance 3 of teammate (${tx},${ty}). Released.`
    : `Could not reach within distance 3 of teammate (${tx},${ty}); released anyway.`;
}

async function redLight(_input) {
  console.log("---- RED LIGHT GREEN LIGHT ----");
  if (!teamAgentId) return "Error: no teammate specified.";

  // 1. tell teammate to go to an odd row and hold
  socket.emitSay(teamAgentId, { type: 'redlight' });
  console.log("Sent redlight to teammate.");

  // 2. walk myself to the nearest walkable odd row
  const isOdd = () => Math.round(me.y) % 2 === 1;
  if (!isOdd()) {
    const target = nearestOddRow();
    if (!target) {
      socket.emitSay(teamAgentId, { type: 'greenlight' });  // don't strand him
      return "Error: no reachable odd row; released teammate.";
    }
    const nav = await followPath({ x: me.x, y: me.y }, { x: target.x, y: target.y }, getMyPosition);
    if (!nav.startsWith("Arrived") && !isOdd()) {
      socket.emitSay(teamAgentId, { type: 'greenlight' });
      return `Could not reach an odd row (${nav}); released teammate.`;
    }
  }
  return 'Red light sent waitinf for green light'
}

async function greenLight(_input) {
  if(!teamAgentId) return "Error: no teammate found"
  socket.emitSay(teamAgentId, {type: 'greenlight'})
  return "Green light given agents can move"
}

async function requestFetch(input) {
  console.log("---- REQUEST FETCH ----");
  if (!teamAgentId) return "Error: no teammate specified.";

  const budget = Number(input) > 0 ? Number(input) : 8;
  const drop = nearestHandoffTile();
  if (!drop) return "Error: no walkable non-dropoff tile near me for handoff.";

  const reqId = Date.now();
  handoff.ready = false;
  handoff.reqId = reqId;
  socket.emitSay(teamAgentId, { type: 'fetch', x: drop.x, y: drop.y, budget, reqId });
  console.log(`Asked Albertito to fetch parcels and drop at (${drop.x}, ${drop.y}). reqId=${reqId}`);

  let waited = 0;
  while (!handoff.ready) {
    await new Promise(r => setTimeout(r, 500));
    if (waited++ > 240) return "Timed out waiting for Albertito to drop parcels.";  // 2 min
  }

  const nav = await navigateTo(`${handoff.x},${handoff.y}`);
  if (!nav.startsWith("Arrived")) {
    return `Albertito dropped ${handoff.count} parcel(s) at (${handoff.x},${handoff.y}) but I couldn't reach them: ${nav}`;
  }
  const pick = await pickUp();
  if (!pick.startsWith("Picked up")) {
    return `Reached the drop but pickup failed: ${pick}`;
  }
  const del = await collectNearbyAndDeliver();
  return `Handoff complete. Picked up parcels Albertito left at (${handoff.x},${handoff.y}) and delivered. ${del}`;
}

// ==========================================
// 3.4 Game Strategy Adaption
// ==========================================

async function addForbiddenTile(input) {
  const [x, y] = input.split(",").map(Number);
  activeRules.forbiddenTiles.add(key(x, y));
  return `Added forbidden tile at (${x}, ${y}).`;
}

async function setTileReward(input) {
  const [x, y, reward] = input.split(",").map(Number);
  activeRules.tileRewardOverrides.set(key(x, y), reward);
  return `Set reward for tile (${x}, ${y}) to ${reward}x.`;
}

async function setDeliveryStackSize(input) {
  activeRules.requiredStackSize = Number(input);
  return `Set required delivery stack size to ${Number(input)}.`;
}

async function setMaxParcelScore(input) {
  activeRules.maxParcelScore = Number(input);
  return `Ignoring parcels with higher score than ${Number(input)}.`;
}

function tileRewardMultiplier(x, y) {
  const override = activeRules.tileRewardOverrides.get(`${x}_${y}`);
  return override === undefined ? 1 : override;
}


// ==========================================
// 3.5 Tool Registry
// ==========================================

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
  add_forbidden_tile: addForbiddenTile,
  set_delivery_stack_size: setDeliveryStackSize,
  set_tile_reward: setTileReward,
  set_max_parcel_score: setMaxParcelScore,
  request_fetch: requestFetch,
  approach_and_release: approchAndRelease,
  red_light: redLight,
  green_light:greenLight,
  deliver_to_extreme: deliverToExtreme,
  stack_deliver: stackDeliver,
};
// ==========================================
// 4. Reusable LLM call
// ==========================================
//Protected against offline or unresponsive LLMs by retrying a few times before giving up and returning an empty string
async function callModel(messages, { temperature = 0, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.chat.completions.create({ model: MODEL, messages, temperature });
      return response.choices?.[0]?.message?.content ?? "";
    } catch (err) {
      console.error(`callModel failed (attempt ${attempt + 1}, status ${err?.status ?? "?"}): ${err.message}`);
      if (attempt === retries) return "";
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return "";
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
    action: actionMatch[1].trim().replace(/\(\)$/, ""), 
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
- add_forbidden_tile(x,y): registers a tile the agent must never path through. Input format: "x,y"
- set_delivery_stack_size(n): require delivering exactly n parcels at once
- set_tile_reward(x,y,mult): delivering on tile (x,y) pays mult times normal. Input format: "x,y,mult"
- set_max_parcel_score(n): ignore parcels with reward above n
- approach_and_release(): tells the teammate to stop, moves this agent to within distance 3 of him, then tells him to resume. Takes no meaningful input.
- red_light(): tells the teammate and this agent to move to an odd-numbered row, and hold. Takes no input.
- green_light(): tells the teammate and this agent to resume moving. Takes no input
- request_fetch(budget): asks the teammate (Albertito) to go collect parcels within a distance budget, drop them at a handoff tile, and notify us; then this agent walks to that tile, picks them up, and delivers. Input is the budget number (default 8 if empty).
- ANY request phrased "Drop a package in the {leftmost|rightmost|topmost/upmost|bottommost/lowest} tile to get N pt" MUST use exactly one step: ["deliver_to_extreme(DIR,N)"], where DIR is one of left/right/up/down and N is the signed number. Map "leftmost"→left, "rightmost"→right, "topmost"/"upmost"/"highest"→up, "bottommost"/"lowest"→down. Positive N means deliver there; negative means avoid it and deliver elsewhere.
- stack_deliver(N): sets required stack size to exactly N, then collects exactly N parcels and delivers them together. Input is the number N.

Movement rules:
- move(up) increases y by 1
- move(down) decreases y by 1
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
- "Deliver stacks of exactly N parcels ... to double/get M of the reward" → exactly one step: ["stack_deliver(N)"].
- "Every time you deliver in (X,Y) [or (X2,Y2)] you get Kx pts" → one set_tile_reward step per tile: ["set_tile_reward(X,Y,K)", "set_tile_reward(X2,Y2,K)"].
- "Every time you deliver in (X,Y) you get 0 pts" → ["set_tile_reward(X,Y,0)"].
- "If you deliver parcels with a score higher than N, you get no reward" → ["set_max_parcel_score(N)"].
- "Do not go through tile (X,Y)" / "avoid tile (X,Y)" → ["add_forbidden_tile(X,Y)"].
- stack_deliver(N): sets required stack size to exactly N, then collects exactly N parcels and delivers them together. Input is the number N.
- ANY request to "approach the teammate", "go to Albertito", "freeze him and come over", or similar MUST use exactly one step: ["approach_and_release()"].
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
- ANY request to "send the teammate to fetch parcels", "have Albertito bring me parcels", "ask your teammate to collect and drop them near you", "go fetch" or similar MUST use exactly one step: ["request_fetch(8)"]. If the user gives a distance/budget number N, use ["request_fetch(N)"] instead.
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
- ANY request to start "red light" / "move to odd rows and wait" MUST use exactly one step: ["red_light()"].
- ANY request to end it / "green light" / "resume" / "we're done" MUST use exactly one step: ["green_light()"].
- If the user asks for both in one message (e.g. "red light, wait N seconds, then green light"), emit ["red_light()", "green_light()"] — the pause between them is handled by the user.`.trim();

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
- add_forbidden_tile(x,y): registers a tile the agent must never path through. Input format: "x,y"
- set_delivery_stack_size(n): require delivering exactly n parcels at once
- set_tile_reward(x,y,mult): delivering on tile (x,y) pays mult times normal. Input format: "x,y,mult"
- set_max_parcel_score(n): ignore parcels with reward above n
- approach_and_release(): tells the teammate to stop, moves this agent to within distance 3 of him, then tells him to resume. Takes no meaningful input.
- red_light(): tells the teammate and this agent to move to an odd-numbered row, and hold. Takes no input.
- green_light(): tells the teammate and this agent to resume moving. Takes no input
- If the current step is request_fetch(...), call request_fetch ONCE with the budget number as Action Input (or "8" if none given). It handles the whole fetch-and-deliver cycle internally; do not emit separate navigate/pick_up/deliver steps for it.
- deliver_to_extreme(DIR,N): DIR is left/right/up/down. Positive N navigates to the nearest reachable extreme dropoff tile in that direction and delivers. Negative N blacklists those tiles and delivers at an alternative. Input format: "DIR,N".

Movement rules:
- move(up) increases y by 1
- move(down) decreases y by 1
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

  try {
    await runAgentTurn(userInput);
  } catch (err) {
    console.error(`Agent turn failed: ${err.message}`);
  }

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