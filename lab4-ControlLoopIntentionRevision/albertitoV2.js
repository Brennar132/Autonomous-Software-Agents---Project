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


//------------------------Visualization------------------------
function printGrid() {
    if (tileMap.size === 0) {
        console.log("Grid is empty!");
        return;
    }

    // 1. Find boundaries
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const tile of tileMap.values()) {
        if (tile.x < minX) minX = tile.x;
        if (tile.x > maxX) maxX = tile.x;
        if (tile.y < minY) minY = tile.y;
        if (tile.y > maxY) maxY = tile.y;
    }

    console.log(`\nGrid Visualization (${minX}-${maxX}, ${minY}-${maxY}):`);

    // 2. Build the string row by row
    for (let y = minY; y <= maxY; y++) {
        let row = "";
        for (let x = minX; x <= maxX; x++) {
            const tile = tileMap.get(key(x, y));
            
            if (!tile) {
                row += " "; // Unknown/Empty
            } else if (tile.type === "0") {
                row += "█"; // Wall
            } else if (tile.type === "1") {
                row += "S"; // Spawn
            } else if (tile.type === "2") {
                row += "D"; // Dropoff
            } else {
                row += "."; // Walkable
            }
        }
        console.log(row);
    }
    console.log("");
}

//------------------------A*------------------------

function aStar(start, goal) {
    const open = [];
    const cameFrom = new Map();
    const gScore = new Map(); // cost from start to current node
    const fScore = new Map(); // estimated cost from start to goal through current node
    

    const startKey = key(start.x, start.y);

    gScore.set(startKey, 0);
    fScore.set(startKey, heuristic(start, goal));

    open.push({x: start.x, y: start.y});

    while (open.length > 0) {
        open.sort((a, b) => fScore.get(key(a.x, a.y)) - fScore.get(key(b.x, b.y)));
        const current = open.shift(); //Shift = Pop
        const currentKey = key(current.x, current.y);

        if (current.x === goal.x && current.y === goal.y) {
            return reconstructPath(cameFrom, current);
        }

        const neighbors = [
            {x: current.x + 1, y: current.y},
            {x: current.x - 1, y: current.y},
            {x: current.x, y: current.y + 1},
            {x: current.x, y: current.y - 1}
        ];

        for (const neighbor of neighbors) {
            if (!isWalkable(neighbor.x, neighbor.y)) continue;

            const tentativeGScore = gScore.get(currentKey) + 1; // Assuming cost between nodes is 1

            const neighborKey = key(neighbor.x, neighbor.y);

            if (!gScore.has(neighborKey) || tentativeGScore < gScore.get(neighborKey)) {
                cameFrom.set(neighborKey, current);
                gScore.set(neighborKey, tentativeGScore);
                fScore.set(neighborKey, tentativeGScore + heuristic(neighbor, goal));

                if (!open.some(node => node.x === neighbor.x && node.y === neighbor.y)) {
                    open.push(neighbor);
                }
            }
        }
    }
}
function reconstructPath(cameFrom, current) {
    const path = [current];

    while (cameFrom.has(key(current.x, current.y))) {
        current = cameFrom.get(key(current.x, current.y));
        path.push(current);
    }
    return path.reverse();
}
async function followPath(path, stoppedFn) {

    for (let i = 1; i < path.length; i++) {

        if (stoppedFn?.())
            throw ['stopped'];

        const current = path[i - 1];
        const next = path[i];

        let moved;

        if (next.x > current.x)
            moved = await socket.emitMove("right");

        else if (next.x < current.x)
            moved = await socket.emitMove("left");

        else if (next.y > current.y)
            moved = await socket.emitMove("down");

        else if (next.y < current.y)
            moved = await socket.emitMove("up");

        if (moved) {
            me.x = moved.x;
            me.y = moved.y;
        }
        else {
            // Path blocked -> force replanning
            return false;
        }
    }

    return true;
}

function isWalkable(x, y) {
    const key = `${x}_${y}`;
    const tile = tileMap.get(key);
    // Only allow tiles that are clearly marked as walkable
    return tile && (tile.type === '1' || tile.type === '2' || tile.type === '3');
}
function heuristic( {x:x1, y:y1}, {x:x2, y:y2}) {
    const dx = Math.abs( Math.round(x1) - Math.round(x2) )
    const dy = Math.abs( Math.round(y1) - Math.round(y2) )
    return dx + dy;
}
function key(x, y) {
    return `${x}_${y}`;
}

//------------------------A*------------------------

/**
 * Belief revision
 */

/**
 * @type { {id:string, name:string, x:number, y:number, score:number} }
 */
const me = {id: '', name: '', x: -1, y: -1, score: 0}; // my position and score are updated at every 'you' event, which is emitted at every sensing event

socket.onYou( ( {id, name, x, y, score} ) => { // Update position and score of the agent
    me.id = id;
    me.name = name;
    me.x = x ?? -1;
    me.y = y ?? -1;
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

socket.onSensing( async ( sensing ) => { // Log sensing information
    for (const p of sensing.positions) {
        //console.log( 'Position:', p );
    
    }
} );
//------------------------Adding TIle Information------------------------
/**
 * @type { Map< string, {x:number, y:number, type:string} > }
 */

const tileMap = new Map();
const dropoffs = new Map(); 
const spawnPoints = new Map();

socket.onTile(({x, y, type}) => {
    const key = `${x}_${y}`;
    tileMap.set(key, {x, y, type});
    if (type == "1") {
        spawnPoints.set(key, {x, y, type});
        console.log('spawn point found!:', {x, y});
    }
    if (type == "2") {
        dropoffs.set(key, {x, y, type});
        console.log('Dropoff:', {x, y});
    }

});

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
    if ( carrying.length > 0 ) { //Needs to be revised
        for ( const dropoff of dropoffs.values() ) {
            options.push( [ 'go_to_dropoff', dropoff.x, dropoff.y ] );
            // myAgent.push( [ 'go_to_dropoff', dropoff.x, dropoff.y ] )
        }
    }



    for (const parcel of parcels.values())
        if ( ! parcel.carriedBy )
            options.push( [ 'go_pick_up', parcel.x, parcel.y, parcel.id ] );
            // myAgent.push( [ 'go_pick_up', parcel.x, parcel.y, parcel.id ] )

    /**
     * Options filtering
     */

    if (carrying.length === 0) {
        const hasFreeParcels = Array.from(parcels.values()).some(p => !p.carriedBy);

        if (!hasFreeParcels) {
            const exploreTarget = getExploreTarget();
            if (exploreTarget) {
                options.push(['go_to_discover', exploreTarget.x, exploreTarget.y]);
                console.log('No free parcels, exploring:', exploreTarget);
            }
        }
    }

    let best_option;
    let nearest = Number.MAX_VALUE;
   for (const option of options) {

        let [, x, y] = option;
        let current_d = distance({x, y}, me);

        if (carrying.length > 0) {
            if (option[0] !== 'go_to_dropoff') continue;
        } else {
            if (option[0] !== 'go_pick_up' && option[0] !== 'go_to_discover') continue;
        }

        if (current_d < nearest) {
            best_option = option;
            nearest = current_d;
        }

    }

    /**
     * Best option is selected
     */
   if (best_option) {
        myAgent.push(best_option);
    } else {
        console.log("No valid option found", {carrying: carrying.length,options});
}

}

function getExploreTarget() {
    // 1. intenta tiles conocidos pero lejanos
    let candidates = Array.from(tileMap.values());

    if (candidates.length > 0) {
        return candidates[Math.floor(Math.random() * candidates.length)];
    }

    // 2. fallback: moverse random cerca
    const dirs = [
        {x: me.x + 1, y: me.y},
        {x: me.x - 1, y: me.y},
        {x: me.x, y: me.y + 1},
        {x: me.x, y: me.y - 1}
    ];

    return dirs[Math.floor(Math.random() * dirs.length)];
}

/**
 * Generate options at every sensing event
 */
socket.onSensing( optionsGeneration )
socket.onYou( optionsGeneration )

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

    async loop ( ) {
        while ( true ) {
            // Consumes intention_queue if not empty
            if ( this.intention_queue.length > 0 ) {
                console.log( 'intentionRevision.loop', this.intention_queue.map(i=>i.predicate) );
            
                // Current intention
                const intention = this.intention_queue[0];
                
                // Is queued intention still valid? Do I still want to achieve it?
                // TODO this hard-coded implementation is an example
                let id = intention.predicate[2]
                let p = parcels.get(id)
                if ( p && p.carriedBy ) {
                    console.log( 'Skipping intention because no more valid', intention.predicate )
                    continue;
                }

                // Start achieving intention
                await intention.achieve()
                // Catch eventual error and continue
                .catch( error => {
                    // console.log( 'Failed intention', ...intention.predicate, 'with error:', ...error )
                } );

                // Remove from the queue
                this.intention_queue.shift();
            }
            // Postpone next iteration at setImmediate
            await new Promise( res => setImmediate( res ) );
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

        // Check if already queued
        const last = this.intention_queue.at( this.intention_queue.length - 1 );
        if ( last && last.predicate.join(' ') == predicate.join(' ') ) {
            return; // intention is already being achieved
        }
        
        console.log( 'IntentionRevisionReplace.push', predicate );
        const intention = new IntentionDeliberation( this, predicate );
        this.intention_queue.push( intention );
        
        // Force current intention stop 
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

// const myAgent = new IntentionRevisionQueue();
const myAgent = new IntentionRevisionReplace();
// const myAgent = new IntentionRevisionRevise();
myAgent.loop();



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

    /**
     * @type { function( string, ...any ) : boolean } 
     */
    static isApplicableTo ( go_pick_up, x, y, id ) {
        return go_pick_up == 'go_pick_up';
    }

    /**
     * @type { function( string, ...any ) : Promise<boolean> } 
     */
    async execute ( go_pick_up, x, y ) {
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await this.subIntention( ['go_to', x, y] );
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await socket.emitPickup()
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        return true;
    }

}

/**
 * @implements { Plan }
 * @extends { PlanBase }
 */
class BlindMove extends PlanBase {

    /**
     * @type { function( string, ...any ) : boolean } 
     */
    static isApplicableTo ( go_to, x, y ) {
        return go_to == 'go_to';
    }

    /**
     * @type { function( string, ...any ) : Promise<boolean> } 
     */
    async execute ( go_to, x, y ) {

        while ( me.x != x || me.y != y ) {

            if ( this.stopped ) throw ['stopped']; // if stopped then quit

            let moved_horizontally;
            let moved_vertically;
            
            // this.log('me', me, 'xy', x, y);

            if ( me.x && x > me.x )
                moved_horizontally = await socket.emitMove('right')
                // status_x = await this.subIntention( 'go_to', {x: me.x+1, y: me.y} );
            else if ( me.x && x < me.x )
                moved_horizontally = await socket.emitMove('left')
                // status_x = await this.subIntention( 'go_to', {x: me.x-1, y: me.y} );

            if (moved_horizontally) {
                me.x = moved_horizontally.x;
                me.y = moved_horizontally.y;
            }

            if ( this.stopped ) throw ['stopped']; // if stopped then quit

            if ( me.y && y > me.y )
                moved_vertically = await socket.emitMove('up')
                // status_x = await this.subIntention( 'go_to', {x: me.x, y: me.y+1} );
            else if ( me.y && y < me.y )
                moved_vertically = await socket.emitMove('down')
                // status_x = await this.subIntention( 'go_to', {x: me.x, y: me.y-1} );

            if (moved_vertically) {
                me.x = moved_vertically.x;
                me.y = moved_vertically.y;
            }
            
            if ( ! moved_horizontally && ! moved_vertically) {
                this.log('stucked');
                throw 'stucked';
            } else if ( me.x == x && me.y == y ) {
                // this.log('target reached');
            }
            
        }

        return true;

    }
}

class AStarMove extends PlanBase {

    static isApplicableTo(go_to, x, y) {
        return go_to == 'go_to';
    }

    async execute(go_to, x, y) {

        const goal = { x, y };

        while (me.x != x || me.y != y) {

            if (this.stopped)
                throw ['stopped'];

            const start = {
                x: me.x,
                y: me.y
            };

            const path = aStar(start, goal);

            if (!path || path.length < 2) {

                this.log(
                    'A* found no path',
                    start,
                    goal
                );

                throw ['no path found'];
            }

            const success = await followPath(
                path,
                () => this.stopped
            );

            if (!success) {
                this.log('Path interrupted, replanning...');
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

        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await this.subIntention( ['go_to', x, y] );
        if ( this.stopped ) throw ['stopped'];
        await socket.emitPutdown();
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
planLibrary.push( BlindMove )
//planLibrary.push( AStarMove )
planLibrary.push( GoToDropoff )
planLibrary.push( GoToDiscover )
setTimeout(printGrid, 2000);