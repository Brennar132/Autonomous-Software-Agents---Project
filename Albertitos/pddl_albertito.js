import 'dotenv/config';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const socket = DjsConnect();

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
    TIMEOUTS: {
        MOVE_RACE:          500,
        PLANNING_HEARTBEAT: 1000,
        EXECUTION_TICK:     100,
        TILE_EXPIRATION:    30000,
    },
    LIMITS: {
        MAX_CARRIED_PARCELS: 6,
        MAX_PARCELS_IN_PLAN: 5,
        MAX_DETOUR_CARRYING: 3,
    },
    TILE_TYPES: {
        WALL:        "0",
        SPAWN:       "1",
        DROPOFF:     "2",
        PATH:        "3",
        GATE_OPEN:   "5",
        GATE_BLOCKED:"5!"
    },
    PLANNER: {
        PROBLEM_FILE: 'problem.pddl',
        PLAN_FILE:    'sas_plan',
        COMMAND: 'python3 ../fast-downward/fast-downward.py --plan-file sas_plan domain.pddl problem.pddl --search "lazy_greedy([ff()], preferred=[ff()])"'
    }
};

// ==========================================
// AGENT STATE
// ==========================================
const me = { id: '', name: '', x: -1, y: -1, score: 0 };
const parcels    = new Map();
const tileMap    = new Map();
const dropoffs   = new Map();
const spawnPoints = new Map();
const recentlyVisited = new Map();

let currentPlanActions     = [];
let isPlanning             = false;
let isExecuting            = false;
let planVersion            = 0;
let worldChangedSinceLastPlan = true;
let committedDropoff       = null;

// ==========================================
// EVENT HANDLERS
// ==========================================
socket.onYou(({ id, name, x, y, score }) => {
    me.id   = id;
    me.name = name;
    me.x    = x ?? -1;
    me.y    = y ?? -1;
    me.score = score;

    if (me.x >= 0 && me.y >= 0) {
        recentlyVisited.set(tileKey(me.x, me.y), Date.now());
        for (const [k, ts] of recentlyVisited)
            if (Date.now() - ts > CONFIG.TIMEOUTS.TILE_EXPIRATION)
                recentlyVisited.delete(k);
    }
});

socket.onSensing((sensing) => {
    const visibleIds = new Set();

    for (const p of sensing.parcels) {
        const prev = parcels.get(p.id);
        if (!prev || prev.carriedBy !== p.carriedBy || prev.x !== p.x || prev.y !== p.y)
            worldChangedSinceLastPlan = true;
        parcels.set(p.id, p);
        visibleIds.add(p.id);
    }

    for (const id of parcels.keys()) {
        if (!visibleIds.has(id) && parcels.get(id)?.carriedBy !== me.id) {
            parcels.delete(id);
            worldChangedSinceLastPlan = true;
        }
    }

    // Invalidate plan if a planned pickup target is no longer available
    const plannedPickup = currentPlanActions.find(a => a.action === 'pickup');
    if (plannedPickup) {
        const pid = plannedPickup.args[0].replace('p_', '');
        const p   = parcels.get(pid);
        if (!p || (p.carriedBy && p.carriedBy !== me.id)) {
            console.log(`[CANCEL] Parcel ${pid} taken — invalidating plan`);
            currentPlanActions = [];
            worldChangedSinceLastPlan = true;
        }
    }
});

socket.onTile(({ x, y, type }) => {
    const k   = tileKey(x, y);
    const old = tileMap.get(k);
    if (old && old.type === type) return;

    tileMap.set(k, { x, y, type });
    if (type === CONFIG.TILE_TYPES.DROPOFF) dropoffs.set(k, { x, y, type });
    if (type === CONFIG.TILE_TYPES.SPAWN)   spawnPoints.set(k, { x, y, type });
    worldChangedSinceLastPlan = true;
});

// ==========================================
// HELPERS
// ==========================================
const tileKey = (x, y) => `tile_${x}_${y}`;

const manhattanDist = (a, b) =>
    Math.abs(Math.round(a.x) - Math.round(b.x)) +
    Math.abs(Math.round(a.y) - Math.round(b.y));

function nearestDropoffFrom(pos) {
    let best = null, bestDist = Infinity;
    for (const d of dropoffs.values()) {
        const dd = manhattanDist(pos, d);
        if (dd < bestDist) { best = d; bestDist = dd; }
    }
    return best;
}

// ==========================================
// PARCEL & DROPOFF SELECTION
// ==========================================

/**
 * Builds a greedy nearest-neighbor pickup chain and selects
 * the optimal dropoff based on the END of that chain.
 * If already carrying with a committed dropoff, keeps it and
 * only adds strictly on-path parcels.
 */
function selectParcelsAndDropoff() {
    const carrying  = Array.from(parcels.values()).filter(p => p.carriedBy === me.id);
    const free      = Array.from(parcels.values()).filter(p => !p.carriedBy);
    const slotsLeft = CONFIG.LIMITS.MAX_PARCELS_IN_PLAN - carrying.length;

    // Already carrying with a committed dropoff → keep commitment
    if (carrying.length > 0 && committedDropoff) {
        if (slotsLeft <= 0 || carrying.length >= CONFIG.LIMITS.MAX_CARRIED_PARCELS)
            return { chain: carrying, dropoff: committedDropoff };

        // Add only parcels strictly on the way to the committed dropoff
        const chain = [];
        let cur = { x: me.x, y: me.y };
        const pool = [...free];
        while (chain.length < slotsLeft && pool.length > 0) {
            pool.sort((a, b) => manhattanDist(cur, a) - manhattanDist(cur, b));
            const next   = pool[0];
            const detour = manhattanDist(cur, next)
                         + manhattanDist(next, committedDropoff)
                         - manhattanDist(cur, committedDropoff);
            if (detour > CONFIG.LIMITS.MAX_DETOUR_CARRYING) break;
            chain.push(pool.shift());
            cur = next;
        }
        return { chain: [...carrying, ...chain], dropoff: committedDropoff };
    }

    // No committed dropoff yet — build fresh chain and pick best dropoff
    if (slotsLeft <= 0) {
        const drop = nearestDropoffFrom(me);
        committedDropoff = drop;
        return { chain: carrying, dropoff: drop };
    }

    // Greedy nearest-neighbour chain
    let cur   = { x: me.x, y: me.y };
    const chain = [];
    const pool  = [...free];
    while (chain.length < slotsLeft && pool.length > 0) {
        pool.sort((a, b) => manhattanDist(cur, a) - manhattanDist(cur, b));
        chain.push(pool.shift());
        cur = chain[chain.length - 1];
    }

    // Best dropoff = nearest to the LAST parcel in the chain
    const lastPos = chain.length > 0 ? chain[chain.length - 1] : me;
    const drop    = nearestDropoffFrom(lastPos) || nearestDropoffFrom(me);
    committedDropoff = drop;
    return { chain: [...carrying, ...chain], dropoff: drop };
}

// ==========================================
// PDDL GENERATION
// ==========================================
function buildWalkableTiles() {
    return Array.from(tileMap.values()).filter(
        t => t.type !== CONFIG.TILE_TYPES.WALL &&
             t.type !== CONFIG.TILE_TYPES.GATE_BLOCKED
    );
}

function buildConnectivity(tiles) {
    let s = '';
    for (const tile of tiles) {
        const tk = tileKey(tile.x, tile.y);
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nk    = tileKey(tile.x + dx, tile.y + dy);
            const nTile = tileMap.get(nk);
            if (nTile &&
                nTile.type !== CONFIG.TILE_TYPES.WALL &&
                nTile.type !== CONFIG.TILE_TYPES.GATE_BLOCKED)
                s += `    (connected ${tk} ${nk})\n`;
        }
    }
    return s;
}

function generateDeliveryPDDL(parcels, targetDropoff) {
    if (me.x < 0 || !targetDropoff) return null;

    const tiles = buildWalkableTiles();

    let pddl = `(define (problem deliveroo_prob) (:domain deliveroo)\n`;

    // Objects
    pddl += `  (:objects\n`;
    pddl += `    ${tiles.map(t => tileKey(t.x, t.y)).join(' ')} - tile\n`;
    if (parcels.length > 0)
        pddl += `    ${parcels.map(p => `p_${p.id}`).join(' ')} - parcel\n`;
    pddl += `  )\n`;

    // Init
    pddl += `  (:init\n`;
    pddl += `    (at-me ${tileKey(me.x, me.y)})\n`;
    for (const t of tiles)
        if (t.type === CONFIG.TILE_TYPES.DROPOFF)
            pddl += `    (is-dropoff ${tileKey(t.x, t.y)})\n`;
    pddl += buildConnectivity(tiles);
    for (const p of parcels)
        if (p.carriedBy === me.id)
            pddl += `    (carrying p_${p.id})\n`;
        else
            pddl += `    (at-parcel p_${p.id} ${tileKey(p.x, p.y)})\n`;
    pddl += `  )\n`;

    // Goal: ALL parcels delivered to the committed dropoff
    const dk = tileKey(targetDropoff.x, targetDropoff.y);
    pddl += `  (:goal\n    (and\n`;
    for (const p of parcels)
        pddl += `      (at-parcel p_${p.id} ${dk})\n`;
    pddl += `    )\n  )\n)\n`;

    return pddl;
}

function generateExplorePDDL(target) {
    if (me.x < 0 || !target) return null;

    const tiles = buildWalkableTiles();
    const tk    = tileKey(target.x, target.y);

    let pddl = `(define (problem deliveroo_prob) (:domain deliveroo)\n`;
    pddl += `  (:objects\n    ${tiles.map(t => tileKey(t.x, t.y)).join(' ')} - tile\n  )\n`;
    pddl += `  (:init\n    (at-me ${tileKey(me.x, me.y)})\n`;
    for (const t of tiles)
        if (t.type === CONFIG.TILE_TYPES.DROPOFF)
            pddl += `    (is-dropoff ${tileKey(t.x, t.y)})\n`;
    pddl += buildConnectivity(tiles);
    pddl += `  )\n`;
    pddl += `  (:goal (at-me ${tk}))\n)\n`;

    return pddl;
}

// ==========================================
// EXPLORATION TARGET
// ==========================================
function getExploreTarget() {
    const now   = Date.now();
    const STALE = 15000;

    const scored = Array.from(spawnPoints.values()).map(t => {
        const lastVisit = recentlyVisited.get(tileKey(t.x, t.y)) || 0;
        const staleness = Math.min(now - lastVisit, STALE) / STALE;
        return { t, score: staleness * 100 - manhattanDist(me, t) * 0.5 };
    }).sort((a, b) => b.score - a.score);

    if (scored.length > 0) return scored[0].t;

    const fresh = Array.from(tileMap.values()).filter(t =>
        t.type !== CONFIG.TILE_TYPES.WALL &&
        (!recentlyVisited.has(tileKey(t.x, t.y)) ||
         now - recentlyVisited.get(tileKey(t.x, t.y)) > STALE)
    );
    return fresh.length > 0
        ? fresh[Math.floor(Math.random() * fresh.length)]
        : null;
}

// ==========================================
// PLANNER
// ==========================================
async function runPlanner() {
    if (isPlanning || me.x < 0) return;

    // Fast-path: already at a dropoff with parcels
    const carrying = Array.from(parcels.values()).filter(p => p.carriedBy === me.id);
    if (dropoffs.has(tileKey(me.x, me.y)) && carrying.length > 0 && currentPlanActions.length === 0) {
        currentPlanActions = [{ action: 'dropoff', args: ['direct'] }];
        return;
    }

    isPlanning            = true;
    worldChangedSinceLastPlan = false;
    const thisVersion     = ++planVersion;

    let pddl = null;

    if (dropoffs.size === 0) {
        pddl = generateExplorePDDL(getExploreTarget());
    } else {
        const { chain, dropoff } = selectParcelsAndDropoff();
        if (chain.length > 0 && dropoff) {
            pddl = generateDeliveryPDDL(chain, dropoff);
        } else {
            pddl = generateExplorePDDL(getExploreTarget());
        }
    }

    if (!pddl) { isPlanning = false; return; }

    fs.writeFileSync(CONFIG.PLANNER.PROBLEM_FILE, pddl);

    try {
        if (fs.existsSync(CONFIG.PLANNER.PLAN_FILE))
            fs.unlinkSync(CONFIG.PLANNER.PLAN_FILE);

        await execAsync(CONFIG.PLANNER.COMMAND).catch(() => {});

        if (thisVersion !== planVersion) { isPlanning = false; return; }

        if (fs.existsSync(CONFIG.PLANNER.PLAN_FILE)) {
            const raw     = fs.readFileSync(CONFIG.PLANNER.PLAN_FILE, 'utf-8');
            const actions = parsePlan(raw);
            if (actions.length > 0) {
                currentPlanActions = actions;
                console.log(`[PLAN] ${actions.length} steps → dropoff @ (${committedDropoff?.x},${committedDropoff?.y})`);
            }
            fs.unlinkSync(CONFIG.PLANNER.PLAN_FILE);
        } else {
            console.log('[PLAN] No solution found');
        }
    } catch (err) {
        console.error('[PLANNER]', err.message);
    } finally {
        isPlanning = false;
    }
}

function parsePlan(raw) {
    const actions = [];
    for (let line of raw.split('\n')) {
        line = line.trim().toLowerCase();
        if (!line || line.startsWith(';')) continue;
        const m = line.match(/\(([^)]+)\)/);
        if (m) {
            const parts = m[1].split(/\s+/);
            actions.push({ action: parts[0], args: parts.slice(1) });
        }
    }
    return actions;
}

// ==========================================
// EXECUTION
// ==========================================

async function executeNextAction() {
    if (currentPlanActions.length === 0 || isExecuting) return;

    isExecuting = true;
    const step  = currentPlanActions[0];
    let success = false;

    try {
        if (step.action === 'move') {
            const parts   = step.args[1].split('_');
            const targetX = parseInt(parts[1]);
            const targetY = parseInt(parts[2]);

            let dir = null;
            if      (targetX > me.x) dir = 'right';
            else if (targetX < me.x) dir = 'left';
            else if (targetY > me.y) dir = 'up';
            else if (targetY < me.y) dir = 'down';

            if (dir) {
                success = await Promise.race([
                    socket.emitMove(dir),
                    new Promise(res => setTimeout(() => res(false), CONFIG.TIMEOUTS.MOVE_RACE))
                ]);

                if (success) {
                    // Opportunistic pickup: grab any free parcel we just stepped on
                    const nowCarrying = Array.from(parcels.values()).filter(p => p.carriedBy === me.id);
                    if (nowCarrying.length < CONFIG.LIMITS.MAX_CARRIED_PARCELS) {
                        const here = Array.from(parcels.values()).find(
                            p => Math.round(p.x) === targetX &&
                                 Math.round(p.y) === targetY &&
                                 !p.carriedBy
                        );
                        if (here) {
                            await socket.emitPickup();
                            await new Promise(res => setTimeout(res, 50));
                            console.log(`[PICKUP+] ${here.id} at (${targetX},${targetY})`);
                        }
                    }
                }
            }
        }

        else if (step.action === 'pickup') {
            const pid = step.args[0].replace('p_', '');
            const p   = parcels.get(pid);
            if (!p || (p.carriedBy && p.carriedBy !== me.id)) {
                console.log(`[SKIP] ${pid} gone`);
                currentPlanActions = [];
                worldChangedSinceLastPlan = true;
                return;
            }
            const res = await socket.emitPickup();
            success   = !!res;
            if (!success) {
                await new Promise(r => setTimeout(r, 100));
                success = !!(await socket.emitPickup());
            }
        }

        else if (step.action === 'dropoff') {
            const res = await socket.emitPutdown();
            success   = !!res;
            if (success) {
                for (const [id, p] of parcels.entries())
                    if (p.carriedBy === me.id) parcels.delete(id);
                committedDropoff      = null;
                worldChangedSinceLastPlan = true;
            }
        }

        if (success) {
            currentPlanActions.shift();
            console.log(`[OK] ${step.action} ${step.args.join(' ')}`);
        } else {
            console.log(`[FAIL] ${step.action}`);
            currentPlanActions    = [];
            worldChangedSinceLastPlan = true;
        }
    } catch (err) {
        console.error('[EXEC]', err.message);
        currentPlanActions    = [];
        worldChangedSinceLastPlan = true;
    } finally {
        isExecuting = false;
    }
}

// ==========================================
// MAIN LOOPS
// ==========================================
setInterval(() => {
    if (me.id) executeNextAction();
}, CONFIG.TIMEOUTS.EXECUTION_TICK);

setInterval(() => {
    if (!me.id) return;

    const carrying = Array.from(parcels.values()).filter(p => p.carriedBy === me.id);

    // Don't replan if the current plan is still valid
    const hasStalePickup = currentPlanActions.some(a => {
        if (a.action !== 'pickup') return false;
        const p = parcels.get(a.args[0].replace('p_', ''));
        return !p || (p.carriedBy && p.carriedBy !== me.id);
    });

    const planIsValid = currentPlanActions.length >= 3 &&
                        carrying.length > 0 &&
                        !hasStalePickup;

    if (planIsValid) {
        worldChangedSinceLastPlan = false;
        return;
    }

    if ((currentPlanActions.length === 0 || worldChangedSinceLastPlan) && !isPlanning)
        runPlanner();

}, CONFIG.TIMEOUTS.PLANNING_HEARTBEAT);