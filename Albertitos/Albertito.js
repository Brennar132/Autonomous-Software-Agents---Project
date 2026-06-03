import 'dotenv/config';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

const socket = DjsConnect();

// ==========================================
// CONFIGURATION AND SYSTEM PARAMETERS
// ==========================================
const CONFIG = {
    TIMEOUTS: {
        MOVE_RACE: 500,
        ASTAR_STUCK: 10000,
        GATE_WAIT: 200,         // Time to wait for alternate boxes
        OBSTACLE_DELAY: 150,     // Retry margin after bumping into a bot
        EXPLORATION_MS: 3000,    // Reconsider exploration every 3s
        PICKUP_BLACKLIST: 8000,  // Penalty for failed pickup
        TILE_EXPIRATION: 30000,  // Expiration of tiles in memory (30s)
        AGENT_HEARTBEAT: 350     // Frequency of deliberation loop (ms)
    },
    LIMITS: {
        MAX_RETRIES: 5,
        MAX_CARRIED_PARCELS: 6,
        MARGINAL_DIST_THRESHOLD: 6
    },
    TILE_TYPES: {
        WALL: "0",
        SPAWN: "1",
        DROPOFF: "2",
        PATH: "3",
        GATE_OPEN: "5",
        GATE_BLOCKED: "5!"
    },
    UTILITY: {
        DROPOFF_MULT: 8,
        PICKUP_ALPHA: 20,
        PICKUP_BETA: 15,
        PICKUP_EMPTY_MULT: 25,
        EXPLORATION_BASE: 100
    }
};

// ==========================================
// INTERNAL STATE OF THE AGENT (Beliefs)
// ==========================================
const me = { id: '', name: '', x: -1, y: -1, score: 0 };
const parcels = new Map();
const tileMap = new Map();
const dropoffs = new Map(); 
const spawnPoints = new Map();
const dynamicObstacles = new Map();
const blacklistedParcels = new Map();
const recentlyVisited = new Map();
let lastExplorationUpdate = 0;

// console.log("Söker Handslag :C");
// socket.onConnect(() => console.log("Handslag!"));

// ==========================================
// EVENT HANDLERS
// ==========================================
socket.onYou(({ id, name, x, y, score }) => {
    me.id = id;
    me.name = name;
    me.x = x ?? -1;
    me.y = y ?? -1;
    me.score = score;

    // Register recently visited tiles
    if (me.x >= 0 && me.y >= 0) {
        recentlyVisited.set(key(me.x, me.y), Date.now());
        // Cleanup outdated tiles
        for (const [k, timestamp] of recentlyVisited) {
            if (Date.now() - timestamp > CONFIG.TIMEOUTS.TILE_EXPIRATION) {
                recentlyVisited.delete(k);
            }
        }
    }
});

socket.onSensing(async (sensing) => {
    // Synchronize visible parcels
    for (const p of sensing.parcels) {
        parcels.set(p.id, p);
    }
    // Remove parcels that are no longer detected
    for (const p of parcels.values()) {
        if (!sensing.parcels.some(sp => sp.id === p.id)) {
            parcels.delete(p.id);
        }
    }
});

socket.onTile(({ x, y, type }) => {
    const k = key(x, y);
    const oldTile = tileMap.get(k);

    if (!oldTile || oldTile.type !== type) {
        if (oldTile) {
            // console.log(`[MAP UPDATE] Tile ${x},${y} changed: ${oldTile.type} -> ${type}`);
        } else {
            // console.log(`[MAP DISCOVERY] New tile found at ${x},${y}: type ${type}`);
        }

        tileMap.set(k, { x, y, type });
        if (type === CONFIG.TILE_TYPES.SPAWN) spawnPoints.set(k, { x, y, type });
        if (type === CONFIG.TILE_TYPES.DROPOFF) dropoffs.set(k, { x, y, type });
    }
});

// ==========================================
// AUXILIARY FUNCTIONS
// ==========================================

const key = (x, y) => `${x}_${y}`;
const distance = (p1, p2) => Math.abs(Math.round(p1.x) - Math.round(p2.x)) + Math.abs(Math.round(p1.y) - Math.round(p2.y));

function setDynamicObstacle(x, y, duration = 1500) {
    const k = key(x, y);
    dynamicObstacles.set(k, true);
    setTimeout(() => dynamicObstacles.delete(k), duration);
}

function blacklistParcel(id, duration = 5000) {
    blacklistedParcels.set(id, true);
    setTimeout(() => blacklistedParcels.delete(id), duration);
}

// ==========================================
// NAVIGATION AND GEOMETRY RULES
// ==========================================


function isBoxPushable(bx, by, dx, dy) {
    const behindKey = key(bx + dx, by + dy);
    const behindTile = tileMap.get(behindKey);
    return behindTile && behindTile.type === CONFIG.TILE_TYPES.GATE_OPEN;
}

function applyBoxPush(bx, by, dx, dy) {
    const boxKey = key(bx, by);
    const behindKey = key(bx + dx, by + dy);
    tileMap.set(boxKey,    { x: bx,      y: by,      type: CONFIG.TILE_TYPES.GATE_OPEN    });
    tileMap.set(behindKey, { x: bx + dx, y: by + dy, type: CONFIG.TILE_TYPES.GATE_BLOCKED });
}

function isWalkable(x, y, fromX = null, fromY = null) {
    if (x < 0 || y < 0) return false;

    const k = key(x, y);
    if (dynamicObstacles.has(k)) return false;

    const tile = tileMap.get(k);
    if (!tile) return true;
    if (tile.type === CONFIG.TILE_TYPES.WALL) return false;

    if (tile.type === CONFIG.TILE_TYPES.GATE_BLOCKED) {
        // If we know where we're coming from, check if pushable
        if (fromX !== null && fromY !== null) {
            const dx = x - fromX;
            const dy = y - fromY;
            return isBoxPushable(x, y, dx, dy);
        }
        return false; // Conservative if direction unknown
    }

    return true;
}

function MoveIsAllowed(fromTile, toTile) {
   if (!fromTile || !toTile) return true;

   const dx = toTile.x - fromTile.x;
   const dy = toTile.y - fromTile.y;

   // Restriction of movement based on directional tiles
    if (toTile.type === '↑' && dy !== 1)  return false;
    if (toTile.type === '↓' && dy !== -1) return false;
    if (toTile.type === '←' && dx !== 1)  return false;
    if (toTile.type === '→' && dx !== -1) return false;
   
   return true;
}

async function move(dir) {
    return Promise.race([
        socket.emitMove(dir),
        new Promise(res => setTimeout(() => res(false), CONFIG.TIMEOUTS.MOVE_RACE))
    ]);
}

// ==========================================
// A* Implementation
// ==========================================

function aStar(start, goal) {
    const open = [];
    const closed = new Set();
    const cameFrom = new Map();
    const gScore = new Map();
    const fScore = new Map();

    const startKey = key(start.x, start.y);
    gScore.set(startKey, 0);
    fScore.set(startKey, distance(start, goal));
    open.push({ x: start.x, y: start.y });

    while (open.length > 0) {
        open.sort((a, b) => fScore.get(key(a.x, a.y)) - fScore.get(key(b.x, b.y)));
        const current = open.shift();
        const currentKey = key(current.x, current.y);
        closed.add(currentKey);

        if (current.x === goal.x && current.y === goal.y) {
            return reconstructPath(cameFrom, current);
        }

        const neighbors = [
            { x: current.x + 1, y: current.y },
            { x: current.x - 1, y: current.y },
            { x: current.x, y: current.y + 1 },
            { x: current.x, y: current.y - 1 }
        ];

        for (const neighbor of neighbors) {
            const neighborKey = key(neighbor.x, neighbor.y);
            if (closed.has(neighborKey)) continue;

            const isGoal = (neighbor.x === goal.x && neighbor.y === goal.y);
           
            if (!isWalkable(neighbor.x, neighbor.y, current.x, current.y) && !isGoal) continue;

            const currentTile = tileMap.get(currentKey);
            const neighborTile = tileMap.get(neighborKey) || { x: neighbor.x, y: neighbor.y, type: CONFIG.TILE_TYPES.PATH };

            if (!MoveIsAllowed(currentTile, neighborTile) && !isGoal) continue;

            const tentativeG = gScore.get(currentKey) + 1;

            if (!gScore.has(neighborKey) || tentativeG < gScore.get(neighborKey)) {
                cameFrom.set(neighborKey, current);
                gScore.set(neighborKey, tentativeG);
                fScore.set(neighborKey, tentativeG + distance(neighbor, goal));
                
                if (!open.some(n => n.x === neighbor.x && n.y === neighbor.y)) {
                    open.push(neighbor);
                }
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

function nearestDropoff() {
    let best = null;
    let bestDist = Infinity;
    for (const d of dropoffs.values()) {
        const dDist = distance(me, d);
        if (dDist < bestDist) {
            best = d;
            bestDist = dDist;
        }
    }
    return best;
}

// ==========================================
// BDI ARCHITECTURE AND DELIBERATION LOOP
// ==========================================

function optionsGeneration() {
    const options = [];
    const carrying = Array.from(parcels.values()).filter(p => p.carriedBy === me.id);
    const totalCarryingReward = carrying.reduce((sum, p) => sum + p.reward, 0);
    const nearest = nearestDropoff();
    
    const currentIntention = myAgent.intention_queue[0];
    let currentTarget = null;
    if (currentIntention) {
        const [, currX, currY] = currentIntention.predicate;
        currentTarget = { x: currX, y: currY };
    }
    
    if (carrying.length > 0) {
        for (const dropoff of dropoffs.values()) {
            options.push(['go_to_dropoff', dropoff.x, dropoff.y]);
        }
    }

    if (carrying.length < CONFIG.LIMITS.MAX_CARRIED_PARCELS) {
        for (const parcel of parcels.values()) {
            if (!parcel.carriedBy && !blacklistedParcels.has(parcel.id)) {
                options.push(['go_pick_up', parcel.x, parcel.y, parcel.id, parcel.reward]);
            }
        }
    }

    if (carrying.length === 0) {
        const hasFreeParcels = Array.from(parcels.values()).some(p => !p.carriedBy);
        if (!hasFreeParcels && (Date.now() - lastExplorationUpdate > CONFIG.TIMEOUTS.EXPLORATION_MS)) {
            const exploreTarget = getExploreTarget();
            if (exploreTarget) {
                options.push(['go_to_discover', exploreTarget.x, exploreTarget.y]);
                lastExplorationUpdate = Date.now();
            }
        }
    }

    let best_option = null;
    let maxUtility = -Number.MAX_VALUE;

    for (const option of options) {
        const [type, x, y, , reward] = option;
        let utility = 0;

        if (carrying.length > 0) {
            if (type === 'go_to_dropoff') {
                utility = (totalCarryingReward * CONFIG.UTILITY.DROPOFF_MULT) - distance(me, { x, y });
            } else if (type === 'go_pick_up' && nearest) {
                const dMeToParcel = distance(me, { x, y });
                const dParcelToDrop = distance({ x, y }, nearest);
                const dMeToDrop = distance(me, nearest);
                const marginalDistance = dMeToParcel + dParcelToDrop - dMeToDrop;

                if (marginalDistance > CONFIG.LIMITS.MARGINAL_DIST_THRESHOLD) continue;
                
                utility = (reward * CONFIG.UTILITY.PICKUP_ALPHA) - (marginalDistance * CONFIG.UTILITY.PICKUP_BETA);
            } else {
                continue;
            }
        } else {
            if (type !== 'go_pick_up' && type !== 'go_to_discover') continue;
            
            if (type === 'go_pick_up') {
                utility = (reward * CONFIG.UTILITY.PICKUP_EMPTY_MULT) - distance(me, { x, y });
            } else {
                utility = CONFIG.UTILITY.EXPLORATION_BASE - distance(me, { x, y });
            }
        }

        if (utility > maxUtility) {
            maxUtility = utility;
            best_option = option;
        }
    }

    if (best_option) {
        if (currentTarget && best_option[1] === currentTarget.x && best_option[2] === currentTarget.y) {
            return; 
        }
        myAgent.push(best_option);
    }
}

function getExploreTarget() {
    const now = Date.now();
    const STALE_THRESHOLD = 15000;

    const freshSpawns = Array.from(spawnPoints.values()).filter(t => {
        const t_visited = recentlyVisited.get(key(t.x, t.y));
        return !t_visited || (now - t_visited > STALE_THRESHOLD);
    });

    if (freshSpawns.length > 0) {
        return freshSpawns[Math.floor(Math.random() * freshSpawns.length)];
    }

    const fresh = Array.from(tileMap.values()).filter(t =>
        t.type !== CONFIG.TILE_TYPES.WALL && 
        (!recentlyVisited.has(key(t.x, t.y)) || now - recentlyVisited.get(key(t.x, t.y)) > STALE_THRESHOLD)
    );

    if (fresh.length > 0) {
        return fresh[Math.floor(Math.random() * fresh.length)];
    }

    return null;
}

// Interuption of intentions if the target parcel is no longer available
socket.onSensing(() => {
    const current = myAgent.intention_queue[0];
    if (!current) return;
    const [type, , , id] = current.predicate;
    if (type === 'go_pick_up' && id) {
        const p = parcels.get(id);
        if (!p || p.carriedBy) {
            console.log('[CANCEL] Parcel', id, 'no longer free — aborting chase');
            current.stop();
        }
    }
});

// Deliberation loop with fixed interval heartbeat
setInterval(() => {
    if (me.id) optionsGeneration();
}, CONFIG.TIMEOUTS.AGENT_HEARTBEAT);

// ==========================================
// BDI CORE ARCHITECTURE
// ==========================================
class IntentionRevision {
    #intention_queue = [];
    get intention_queue() { return this.#intention_queue; }

    async loop() {
        while (true) {
            if (this.intention_queue.length > 0) {
                const intention = this.intention_queue[0];
                console.log("intentionRevision.loop", this.intention_queue.map(i => i.predicate));
                try {
                    await intention.achieve();
                } catch (error) {
                    console.log("Failed intention", intention.predicate, "with error:", error);
                } finally {
                    this.intention_queue.shift();
                }
            }
            await new Promise(res => setTimeout(res, 50));
        }
    }
    log(...args) { console.log(...args); }
    async push(predicate) {}
}

class IntentionRevisionReplace extends IntentionRevision {
    async push(predicate) {
        const current = this.intention_queue[0];
        const last = this.intention_queue.at(this.intention_queue.length - 1);
        
        if (current && current.predicate[0] === predicate[0] && current.predicate[1] === predicate[1] && current.predicate[2] === predicate[2]) {
            return;
        }

        if (last && last.predicate.slice(0,3).join(' ') === predicate.slice(0,3).join(' ')) {
            return; 
        }

        if (current && current.predicate[0] === 'go_to_dropoff' && predicate[0] === 'go_pick_up') {
            const intention = new IntentionDeliberation(this, predicate);
            this.intention_queue.unshift(intention);
            current.stop();
            return;
        }
        
        const intention = new IntentionDeliberation(this, predicate);
        this.intention_queue.push(intention);
        if (last) last.stop();
    }
}

class IntentionDeliberation {
    #current_plan;
    #stopped = false;
    #parent;
    #predicate;
    #started = false;

    get stopped() { return this.#stopped; }
    get predicate() { return this.#predicate; }

    constructor(parent, predicate) {
        this.#parent = parent;
        this.#predicate = predicate;
    }

    stop() {
        this.#stopped = true;
        if (this.#current_plan) this.#current_plan.stop();
    }

    log(...args) {
        if (this.#parent && this.#parent.log) this.#parent.log('\t', ...args);
        else console.log(...args);
    }

    async achieve() {
        if (this.#started) return false;
        this.#started = true;

        for (const planClass of planLibrary) {
            if (this.stopped) throw ['stopped intention', ...this.predicate];

            if (planClass.isApplicableTo(...this.predicate)) {
                this.#current_plan = new planClass(this.#parent);
                this.log('achieving intention', ...this.predicate, 'with plan', planClass.name);
                try {
                    const plan_res = await this.#current_plan?.execute(...this.predicate);
                    this.log('succesful intention', ...this.predicate, 'with plan', planClass.name, 'with result:', plan_res);
                    return plan_res || false;
                } catch (error) {
                    this.log('failed intention', ...this.predicate, 'with plan', planClass.name, 'with error:', error);
                }
            }
        }
        if (this.stopped) throw ['stopped intention', ...this.predicate];
        throw ['no plan satisfied the intention ', ...this.predicate];
    }
}

class PlanBase {
    #stopped = false;
    #parent;
    #sub_intentions = [];

    get stopped() { return this.#stopped; }

    constructor(parent) { this.#parent = parent; }

    stop() {
        this.#stopped = true;
        for (const i of this.#sub_intentions) i.stop();
    }

    log(...args) {
        if (this.#parent && this.#parent.log) this.#parent.log('\t', ...args);
        else console.log(...args);
    }

    async subIntention(predicate) {
        const sub_intention = new IntentionDeliberation(this, predicate);
        this.#sub_intentions.push(sub_intention);
        return sub_intention.achieve();
    }
}

// ==========================================
// PLAN LIBRARY
// ==========================================
const planLibrary = [];

class GoPickUp extends PlanBase {
    static isApplicableTo(go_pick_up) { return go_pick_up === 'go_pick_up'; }

    async execute(go_pick_up, x, y, id) {
        if (this.stopped) throw ['stopped'];

        const parcel = parcels.get(id);
        if (!parcel || parcel.carriedBy) throw ['parcel no longer available', id];

        try {
            await this.subIntention(['go_to', x, y]);
        } catch (err) {
            if (id && !this.stopped) blacklistParcel(id, CONFIG.TIMEOUTS.PICKUP_BLACKLIST);
            throw err;
        }

        if (this.stopped) throw ['stopped'];
        await socket.emitPickup();
        return true;
    }
}

class AStarMove extends PlanBase {
    static isApplicableTo(go_to) { return go_to === 'go_to'; }

    async execute(go_to, x, y) {
        if (me.x === x && me.y === y) return true;

        const goal = { x, y };
        let retries = 0;
        const startTime = Date.now();

        while (me.x !== x || me.y !== y) {
            if (Date.now() - startTime > CONFIG.TIMEOUTS.ASTAR_STUCK) throw ['A* timeout stuck'];
            if (this.stopped) throw ['stopped'];
            
            if (me.x < 0 || me.y < 0) {
                await new Promise(res => setTimeout(res, 50));
                continue;
            }

            const path = aStar({ x: me.x, y: me.y }, goal);

            if (!path || path.length < 2) {
                this.log('No path found to', x, y, 'Waiting...');
                retries++;
                if (retries >= CONFIG.LIMITS.MAX_RETRIES) throw ['unreachable goal due to persistent blockage'];
                await new Promise(res => setTimeout(res, 300));
                continue;
            }

            let pathBroken = false;

            for (let i = 1; i < path.length; i++) {
                if (this.stopped) throw ['stopped'];

                const next = path[i];
                let moved;

                if (next.x > me.x) moved = await move('right');
                else if (next.x < me.x) moved = await move('left');
                else if (next.y > me.y) moved = await move('up');
                else if (next.y < me.y) moved = await move('down');

                if (this.stopped) throw ['stopped'];

             if (moved) {
                retries = 0;
                
                const carrying = Array.from(parcels.values()).filter(p => p.carriedBy === me.id);
                if (carrying.length < CONFIG.LIMITS.MAX_CARRIED_PARCELS) {
                    const parcelHere = Array.from(parcels.values()).find(
                        p => Math.round(p.x) === next.x && Math.round(p.y) === next.y && !p.carriedBy
                    );
                    if (parcelHere) {
                        await socket.emitPickup();
                    }
                }

                const enteredTile = tileMap.get(key(next.x, next.y));
                if (enteredTile && enteredTile.type === CONFIG.TILE_TYPES.GATE_BLOCKED) {
                    const dx = next.x - path[i - 1].x;
                    const dy = next.y - path[i - 1].y;
                    applyBoxPush(next.x, next.y, dx, dy);
                }

                await new Promise(res => setTimeout(res, 20));
            }else {
                    retries++;
                    const targetTile = tileMap.get(key(next.x, next.y));

                    if (targetTile?.type === CONFIG.TILE_TYPES.GATE_BLOCKED) {                      
                        await new Promise(res => setTimeout(res, CONFIG.TIMEOUTS.GATE_WAIT));
                    } else {
                        setDynamicObstacle(next.x, next.y, 2000);
                        await new Promise(res => setTimeout(res, CONFIG.TIMEOUTS.OBSTACLE_DELAY));
                    }

                    if (retries >= CONFIG.LIMITS.MAX_RETRIES) throw ['too many blocked attempts'];
                    pathBroken = true;
                    break;
                }
            }

            if (this.stopped) throw ['stopped'];
            if (!pathBroken && (me.x !== x || me.y !== y)) {
                await new Promise(res => setTimeout(res, 50));
            }
        }
        return true;
    }
}


class GoToDropoff extends PlanBase {
    static isApplicableTo(go_to_dropoff) { return go_to_dropoff === 'go_to_dropoff'; }

    async execute(go_to_dropoff, x, y) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y]);
        if (this.stopped) throw ['stopped'];

        await socket.emitPutdown();

        for (const [id, p] of parcels.entries()) {
            if (p.carriedBy === me.id) parcels.delete(id);
        }
        return true;
    }
}

class GoToDiscover extends PlanBase {
    static isApplicableTo(go_to_discover) { return go_to_discover === 'go_to_discover'; }

    async execute(go_to_discover, x, y) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y]);
        return true;
    }
}

planLibrary.push(GoPickUp, AStarMove, GoToDropoff, GoToDiscover);

const myAgent = new IntentionRevisionReplace();
(async () => {
    console.log("Starting Agent Loop...");
    await myAgent.loop();
})();