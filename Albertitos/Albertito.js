import 'dotenv/config';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

const socket = DjsConnect();

/** @type { function ({x:number, y:number}, {x:number, y:number}): number } */
function distance( {x:x1, y:y1}, {x:x2, y:y2}) {
    const dx = Math.abs( Math.round(x1) - Math.round(x2) )
    const dy = Math.abs( Math.round(y1) - Math.round(y2) )
    return dx + dy;
}
console.log("Söker Handslag :C");
socket.onConnect(() => {
    console.log("Handslag!");
});


/**
 * Belief revision
 */

/**
 * @type { {id:string, name:string, x:number, y:number, score:number} }
 */
const me = {id: '', name: '', x: -1, y: -1, score: 0}; // my position and score are updated at every 'you' event, which is emitted at every sensing event

socket.onYou( ( {id, name, x, y, score} ) => {
    me.id = id;
    me.name = name;
    me.x = x !== undefined && x !== null ? x : -1;
    me.y = y !== undefined && y !== null ? y : -1;
    me.score = score;
} )

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

//------------------------Adding TIle Information------------------------
/**
 * @type { Map< string, {x:number, y:number, type:string} > }
 */

const tileMap = new Map();
const dropoffs = new Map(); 
const spawnPoints = new Map();

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

function key(x, y) { return `${x}_${y}`; }


const dynamicObstacles = new Map();

// We set a dynamic obstacle on the tile where we got blocked, so to avoid trying the same move multiple times while the other bot is still there
function setDynamicObstacle(x, y, duration = 1500) {
    const k = key(x, y);

    dynamicObstacles.set(k, true);

    setTimeout(() => {
        dynamicObstacles.delete(k);
    }, duration);
}

const blacklistedParcels = new Map();

// When a parcel is blacklisted, it means that we consider it temporarily unreachable 
function blacklistParcel(id, duration = 5000) {
    blacklistedParcels.set(id, true);
    setTimeout(() => blacklistedParcels.delete(id), duration);
}

function isWalkable(x, y) {
    if (x < 0 || y < 0) {
        return false;
    }

    const k = key(x, y);

    if (dynamicObstacles.has(k)) {
        return false;
    }

    const tile = tileMap.get(k);

    // If tile is unknown, assume it's walkable (or change to false if map boundaries are strict)
    if (!tile) {
        return true;
    }

    // Type "0" is a hard wall or 
    if (tile.type == "0") {
        return false;
    }

    // Type "5" is a box
    if (tile.type == "5!") {
        return false;
    }

    return true;
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

function heuristic({x: x1, y: y1}, {x: x2, y: y2}) {
    return Math.abs(Math.round(x1) - Math.round(x2)) + Math.abs(Math.round(y1) - Math.round(y2));
}

function move(dir) {
    return Promise.race([
        socket.emitMove(dir),
        new Promise(res => setTimeout(() => res(false), 500))
    ]);
}

function aStar(start, goal) {
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
            const tentativeG = gScore.get(currentKey) + 1;
            const neighborKey = key(neighbor.x, neighbor.y);

            if (closed.has(neighborKey)){
                continue;
            }

            const isGoal = (neighbor.x === goal.x && neighbor.y === goal.y);
            if (!isWalkable(neighbor.x, neighbor.y) && !isGoal) {
                continue;
            }

            const currentTile = tileMap.get(currentKey);
            const neighborTile = tileMap.get(neighborKey) || { x: neighbor.x, y: neighbor.y, type: '3' };

            if (!MoveIsAllowed(currentTile, neighborTile) && !isGoal) {
                continue;
            }

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




/**
 * Options generation and filtering function
 */
function optionsGeneration () {

    // TODO revisit beliefset revision so to trigger option generation only in the case a new parcel is observed

    /**
     * Options generation
     * @type { Array< [string, ...any] > }
     */
    const options = []

    const carrying = Array.from(parcels.values()).filter( p => p.carriedBy == me.id );
    const totalCarryingReward = carrying.reduce( (sum, p) => sum + p.reward, 0 );
    const nearest = nearestDropoff();
    
    const currentIntention = myAgent.intention_queue[0];
    let currentTarget = null;
    if (currentIntention) {
        const [, currX, currY] = currentIntention.predicate;
        currentTarget = { x: currX, y: currY };
    }
    
    if ( carrying.length > 0 ) { // Needs to be revised
        for ( const dropoff of dropoffs.values() ) {
            options.push( [ 'go_to_dropoff', dropoff.x, dropoff.y ] );
            // myAgent.push( [ 'go_to_dropoff', dropoff.x, dropoff.y ] )
        }
    }

    if (carrying.length < 3) {
        for (const parcel of parcels.values()) {
            if ( !parcel.carriedBy && !blacklistedParcels.has(parcel.id) ) {
                options.push( [ 'go_pick_up', parcel.x, parcel.y, parcel.id, parcel.reward ] );
            }
        }
    }
    /**
     * Options filtering
     */

    if (carrying.length === 0) {

    const hasFreeParcels =
        Array.from(parcels.values())
        .some(p => !p.carriedBy);

    if (!hasFreeParcels) {

        // Reconsider exploration only occasionally
        if (
            Date.now() - lastExplorationUpdate
            > EXPLORATION_RECONSIDER_MS
        ) {

            const exploreTarget = getExploreTarget();

            if (exploreTarget) {

                options.push([
                    'go_to_discover',
                    exploreTarget.x,
                    exploreTarget.y
                ]);

                lastExplorationUpdate = Date.now();
            }
        }
    }
}

    let best_option = null;
    let maxUtility = -Number.MAX_VALUE;
    for (const option of options) {
        const [type, x, y, id, reward] = option;
        let utility = 0;

        if (carrying.length > 0) {
            if (type === 'go_to_dropoff') {
                // Utility of drop-off is inversely proportional to distance
                utility = (totalCarryingReward * 8) - distance(me, {x, y});
            } 
            else if (type === 'go_pick_up' && nearest) {
                // Evaluation of pick-up opportunity
                const dMeToParcel = distance(me, {x, y});
                const dParcelToDrop = distance({x, y}, nearest);
                const dMeToDrop = distance(me, nearest);

                // Calculus of marginal distance (deviation cost)
                const marginalDistance = dMeToParcel + dParcelToDrop - dMeToDrop;

                if (marginalDistance > 6) continue;
                
                // Can be tuned for better performance
                const alpha = 20; // Factor of reward importance (how much we value the reward of the new parcel)
                const beta = 15;  // Cost of deviation (opportunity cost)

                // Utility is calculated as the reward minus the cost of deviation
                utility = (reward * alpha) - (marginalDistance * beta);
                
            } else {
                continue;
            }
        } else {
            // Prioritizing pick-ups when not carrying anything in function of reward/distance, then exploration
            if (type !== 'go_pick_up' && type !== 'go_to_discover') continue;
            
            if (type === 'go_pick_up') {
                utility = (reward * 25) - distance(me, {x, y});
            } else {
                utility = 100 - distance(me, {x, y}); // Exploration utility
            }
        }

        if (utility > maxUtility) {
            maxUtility = utility;
            best_option = option;
        }
    }
    /**
     * Best option is selected
     */
    if (best_option) {
        // If the best option is the same as the current intention, do nothing
        if (currentTarget && best_option[1] === currentTarget.x && best_option[2] === currentTarget.y) {
            return; 
        }

        // If we are going to dropoff but want to pick up a package, prioritize the new pick-up intention
        myAgent.push(best_option);
    }
}

// Cancel active go_pick_up if the target parcel was taken by someone else
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

const recentlyVisited = new Map(); // key → timestamp
let lastExplorationUpdate = 0;
const EXPLORATION_RECONSIDER_MS = 3000; // 3 seconds

socket.onYou(() => {
    const k = key(me.x, me.y);
    recentlyVisited.set(k, Date.now());
    // Expire after 30s
    for (const [k, t] of recentlyVisited)
        if (Date.now() - t > 30000) recentlyVisited.delete(k);
});

function getExploreTarget() {
    const now = Date.now();
    const STALE_THRESHOLD = 15000;

    // Prefer spawn points not recently visited
    const freshSpawns = Array.from(spawnPoints.values()).filter(t => {
        const t_visited = recentlyVisited.get(key(t.x, t.y));
        return !t_visited || (now - t_visited > STALE_THRESHOLD);
    });

    if (freshSpawns.length > 0)
        return freshSpawns[Math.floor(Math.random() * freshSpawns.length)];

    // Fall back to any walkable tile not recently visited
    const fresh = Array.from(tileMap.values()).filter(t =>
        t.type !== "0" && (!recentlyVisited.has(key(t.x, t.y)) ||
        now - recentlyVisited.get(key(t.x, t.y)) > STALE_THRESHOLD)
    );

    if (fresh.length > 0)
        return fresh[Math.floor(Math.random() * fresh.length)];

    return null;
}

/**
 * Generate options at every sensing event
 */
//Make Albertito a little bit lazier 
setInterval(() => {
    if (me.id) {
        optionsGeneration();
    }
}, 350);

// /**
//  * Alternatively, generate options continuously
//  */
// while (true) {
//     if ( ! me.id || ! parcels.size ) {
//         await new Promise( res => setTimeout( res, 100 ) );
//         continue;
//     }
//     optionsGeneration();
//     await new Promise( res => setTimeout( res ) );
// }



/**
 * Intention revision loop
 */
class IntentionRevision {

    /** @type {IntentionDeliberation[]} */
    #intention_queue = new Array();
    get intention_queue () {
        return this.#intention_queue;
    }

async loop() {
    while (true) {
        if (this.intention_queue.length > 0) {
            const intention = this.intention_queue[0];
            console.log("intentionRevision.loop", this.intention_queue.map(i => i.predicate)
            );
            let success = false;
            try {
                await intention.achieve();
                success = true;
            } catch (error) {
                console.log("Failed intention", intention.predicate, "with error:", error);
            } finally {
                this.intention_queue.shift();
            }
        }

        await new Promise(res => setTimeout(res, 50));
    }
}

    // async push ( predicate ) { }

    /** @type { function(...any): void } */
    log ( ...args ) {
        console.log( ...args )
    }

    /**
     * @abstract
     * @param { [string, ...any] } predicate is in the form ['go_to', x, y]
     */
    async push ( predicate ) {
    }

}

/**
 * @extends { IntentionRevision }
 */
class IntentionRevisionQueue extends IntentionRevision {

    /**
     * @param { [string, ...any] } predicate is in the form ['go_to', x, y]
     */
    async push ( predicate ) {
        
        // Check if already queued
        if ( this.intention_queue.find( (i) => i.predicate.join(' ') == predicate.join(' ') ) )
            return; // intention is already queued

        console.log( 'IntentionRevisionReplace.push', predicate );
        const intention = new IntentionDeliberation( this, predicate );
        this.intention_queue.push( intention );
    }

}

class IntentionRevisionReplace extends IntentionRevision {

    /**
     * @param { [string, ...any] } predicate is in the form ['go_to', x, y]
     */
    async push ( predicate ) {
        const current = this.intention_queue[0];
        const last = this.intention_queue.at( this.intention_queue.length - 1 );
        
        if (current && current.predicate[0] === predicate[0] && current.predicate[1] === predicate[1] && current.predicate[2] === predicate[2]) {
            return;
        }

        // If the new intention is the same as the current or last one, do nothing
        if ( last && last.predicate.slice(0,3).join(' ') == predicate.slice(0,3).join(' ') ) {
            return; 
        }

        // If we are going to dropoff but want to pick up a package, unshift the new intention
        if (current && current.predicate[0] === 'go_to_dropoff' && predicate[0] === 'go_pick_up') {
            const intention = new IntentionDeliberation( this, predicate );
            this.intention_queue.unshift( intention ); // Prioritize the new pick-up intention
            current.stop(); // Stop the dropoff journey temporarily
            return;
        }
        
        // Replace current intention with the new one, stopping the current one if exists
        const intention = new IntentionDeliberation( this, predicate );
        this.intention_queue.push( intention );
        
        if ( last ) {
            last.stop();
        }
    }

}

class IntentionRevisionRevise extends IntentionRevision {

    /**
     * @param { [string, ...any] } predicate is in the form ['go_to', x, y]
     */
    async push ( predicate ) {
        console.log( 'Revising intention queue. Received', ...predicate );
        // TODO
        // - order intentions based on utility function (reward - cost) (for example, parcel score minus distance)
        // - eventually stop current one
        // - evaluate validity of intention
    }

}

/**
 * Start intention revision loop
 */




/**
 * IntentionDeliberation
 */
class IntentionDeliberation {

    // Plan currently used for achieving the desire 
    /** @type { Plan | undefined } */
    #current_plan;
    
    // This is used to stop the intentionDeliberation
    #stopped = false;
    get stopped () {
        return this.#stopped;
    }
    stop () {
        // this.log( 'stop intentionDeliberation', ...this.#predicate );
        this.#stopped = true;
        if ( this.#current_plan)
            this.#current_plan.stop();
    }

    /**
     * #parent refers to caller
     */
    #parent;

    /**
     * Desire to be achieved, for example ['go_to', x, y]
     * @type { [string, ...any] } predicate is in the form ['go_to', x, y]
     */
    #predicate;
    get predicate () {
        return this.#predicate;
    }

    /**
     * @param { IntentionDeliberation } parent 
     * @param { [string, ...any] } predicate 
     */
    constructor ( parent, predicate ) {
        this.#parent = parent;
        this.#predicate = predicate;
    }

    /** @type { function(...any): void } */
    log ( ...args ) {
        if ( this.#parent && this.#parent.log )
            this.#parent.log( '\t', ...args )
        else
            console.log( ...args )
    }

    #started = false;
    /**
     * Using the plan library to achieve an intention
     * @returns { Promise<boolean> } the result of the plan execution
     */
    async achieve () {
        // Cannot start twice
        if ( this.#started)
            return false;
        else
            this.#started = true;

        // Trying all plans in the library
        for (const planClass of planLibrary) {

            // if stopped then quit
            if ( this.stopped ) throw [ 'stopped intention', ...this.predicate ];

            // if plan is 'statically' applicable
            if ( planClass.isApplicableTo( ...this.predicate ) ) {
                // plan is instantiated
                this.#current_plan = new planClass(this.#parent);
                this.log('achieving intention', ...this.predicate, 'with plan', planClass.name);
                // and plan is executed and result returned
                try {
                    const plan_res = await this.#current_plan?.execute( ...this.predicate );
                    this.log( 'succesful intention', ...this.predicate, 'with plan', planClass.name, 'with result:', plan_res );
                    return plan_res || false;
                // or errors are caught so to continue with next plan
                } catch (error) {
                    this.log( 'failed intention', ...this.predicate,'with plan', planClass.name, 'with error:', error );
                }
            }

        }

        // if stopped then quit
        if ( this.stopped ) throw [ 'stopped intention', ...this.predicate ];

        // no plans have been found to satisfy the intention
        // this.log( 'no plan satisfied the intention ', ...this.predicate );
        throw ['no plan satisfied the intention ', ...this.predicate ]
    }

}

/**
 * @typedef { {
 *      stop: ()=>void,
 *      stopped: boolean,
 *      log: (...arg0: any[])=>void,
 *      subIntention: (predicate: any) => Promise<any>,
 *      execute: function (string, ...any) : Promise<boolean>
 * } } Plan
 */

/**
 * @typedef { {
 *      name: string,
 *      isApplicableTo: function (string, ...any) : boolean,
 *      prototype: Plan
 * } } PlanClass
 */

/**
 * Plan library
 * @type { PlanClass [] }
 */
const planLibrary = [];

/**
 * @abstract
 */
class PlanBase {

    // This is used to stop the plan
    #stopped = false;
    stop () {
        // this.log( 'stop plan' );
        this.#stopped = true;
        for ( const i of this.#sub_intentions ) {
            i.stop();
        }
    }
    get stopped () {
        return this.#stopped;
    }

    /**
     * #parent refers to caller
     */
    #parent;

    /**
     * @param { PlanBase } parent
     */
    constructor ( parent ) {
        this.#parent = parent;
    }

    /** @type { function(...any): void } */
    log ( ...args ) {
        if ( this.#parent && this.#parent.log )
            this.#parent.log( '\t', ...args )
        else
            console.log( ...args )
    }

    // this is an array of sub intention. Multiple ones could eventually being achieved in parallel.
    /** @type { IntentionDeliberation [] } */
    #sub_intentions = [];

    /**
     * @param { [string, ...any] } predicate 
     * @returns { Promise<boolean> }
     */
    async subIntention ( predicate ) {
        const sub_intention = new IntentionDeliberation( this, predicate );
        this.#sub_intentions.push( sub_intention );
        return sub_intention.achieve();
    }

}

/**
 * @implements { Plan }
 */
class GoPickUp extends PlanBase {

    static isApplicableTo ( go_pick_up, x, y, id ) {
        return go_pick_up == 'go_pick_up';
    }

    async execute ( go_pick_up, x, y, id ) {
        if ( this.stopped ) throw ['stopped'];

        // Abort immediately if already taken or gone
        const parcel = parcels.get(id);
        if ( !parcel || parcel.carriedBy ) throw ['parcel no longer available', id];

        try {
            await this.subIntention( ['go_to', x, y] );
        } catch (err) {
            // Navigation failed: temporarily blacklist so we don't keep chasing it
            if ( id && !this.stopped ) blacklistParcel(id, 8000);
            throw err;
        }

        if ( this.stopped ) throw ['stopped'];
        await socket.emitPickup();
        if ( this.stopped ) throw ['stopped'];
        return true;
    }
}

/**
 * @implements { Plan }
 * @extends { PlanBase }
 */
class AStarMove extends PlanBase {

    static isApplicableTo(go_to, x, y) {
        return go_to == 'go_to';
    }

    async execute(go_to, x, y) {
        if (me.x === x && me.y === y) {
            return true;
        }

        const goal = {x, y};
        let retries = 0;
        const MAX_RETRIES = 5; // Max retries before giving up and considering the goal unreachable

        const startTime = Date.now();
        const TIMEOUT = 10000; // Max time to spend trying to reach the goal before giving up

        while (me.x !== x || me.y !== y) {

            if (Date.now() - startTime > TIMEOUT) {
                throw ['A* timeout stuck'];
            }
            if (this.stopped){
                throw ['stopped'];
            }

            if (me.x < 0 || me.y < 0) {
                this.log('Invalid position, waiting...');
                await new Promise(res => setTimeout(res, 50));
                continue;
            }

            const path = aStar({x: me.x, y: me.y}, goal);

            if (me.x < 0 || me.y < 0) {
                this.log('Invalid position, waiting...');
                await new Promise(res => setTimeout(res, 50));
                continue;
            }

            if (!path || path.length < 2) {
                this.log('No path found to', x, y, 'possibly blocked by another bot. Waiting...');
                retries++;
                
                if (retries >= MAX_RETRIES) {
                    throw ['unreachable goal due to persistent blockage'];
                }
                await new Promise(res => setTimeout(res, 300));
                continue;
            }

            let pathBroken = false;

            // Follow the path step by step, checking for dynamic obstacles and blockages
            for (let i = 1; i < path.length; i++) {
                if (this.stopped){
                    throw ['stopped'];
                }

                const next = path[i];
                let moved;

                if      (next.x > me.x) moved = await move('right');
                else if (next.x < me.x) moved = await move('left');
                else if (next.y > me.y) moved = await move('up');
                else if (next.y < me.y) moved = await move('down');

                if (this.stopped) throw ['stopped'];

                if (moved) {
                    retries = 0;
                    await new Promise(res => setTimeout(res, 20));
                } else {
                    retries++;

                    // Set dynamic obstacle on the tile
                    setDynamicObstacle(next.x, next.y, 2000);

                    this.log('Blocked at:', next.x, next.y);

                    if (retries >= MAX_RETRIES) {
                        throw ['too many blocked attempts'];
                    }

                    // Waiting before recalculating path
                    await new Promise(res => setTimeout(res, 150));

                    this.log('Move blocked, recalculating path...');
                    pathBroken = true;
                    break;
                }
            }
            if (this.stopped){
                throw ['stopped'];
            }
            // If the path is not broken and the destination is not reached
            if (!pathBroken && (me.x !== x || me.y !== y)) {
                await new Promise(res => setTimeout(res, 50));
            }
        }
        return true;
    }
}

class GoToDropoff extends PlanBase {

    static isApplicableTo ( go_to_dropoff, x, y ) {
        return go_to_dropoff == 'go_to_dropoff';
    }

    async execute ( go_to_dropoff, x, y ) {

        if ( this.stopped ){
            throw ['stopped'];
        }
        await this.subIntention( ['go_to', x, y] );
        if ( this.stopped ) {
            throw ['stopped'];
        }

        await socket.emitPutdown();

        for (const [id, p] of parcels.entries()) {
            if (p.carriedBy === me.id) {
                parcels.delete(id);
            }
        }

        return true;
    }

}

class GoToDiscover extends PlanBase {

    static isApplicableTo ( go_to_discover, x, y ) {
        return go_to_discover == 'go_to_discover';
    }

    async execute ( go_to_discover, x, y ) {

        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await this.subIntention( ['go_to', x, y] );
        if ( this.stopped ) throw ['stopped'];
        return true;
    }

}

// plan classes are added to plan library 
planLibrary.push( GoPickUp )
planLibrary.push( AStarMove )
planLibrary.push( GoToDropoff )
planLibrary.push( GoToDiscover )

const myAgent = new IntentionRevisionReplace();
(async () => {
    console.log("Starting Agent Loop...");
    await myAgent.loop();
})();