import 'dotenv/config';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

const socket = DjsConnect();


console.log("Searching for  Handshake :C");
socket.onConnect(() => {
    console.log("Handshake!");
    start()
});

/**
 * @type { {id:string, name:string, x:number, y:number, score:number} }
 */
const me = {id: '', name: '', x: -1, y: -1, score: 0}; // my position and score are updated at every 'you' event, which is emitted at every sensing event

socket.onYou( ( {id, name, x, y, score} ) => { // Update position and score of the agent
    me.id = id;
    me.name = name;
    me.x = x ? x : -1;
    me.y = y ? y : -1;
    me.score = score;
} )


/**
 * @type { Map< string, {x:number, y:number, type:string} > }
 */

const tileMap = new Map();
const dropoffs = new Map(); 
const spawnPoints = new Map();

socket.onTile(({x, y, type}) => {
    const key = `${x}_${y}`;
    tileMap.set(key, {x, y, type}); // store the tile information in the map
    if (type == "1") {
        spawnPoints.set(key, {x, y, type});
        console.log('spawn point found!:', {x, y});
    }
    if (type == "2") {
        dropoffs.set(key, {x, y, type});
        console.log('Dropoff:', {x, y});
    }

});

function key(x, y) {
    return `${x}_${y}`;
}

function isWalkable(x, y) {
    // Verificar que las coordenadas sean enteros positivos y que la posición sea transitable
    return x >= 0 && y >= 0 && (!tileMap.has(key(x, y)) || tileMap.get(key(x, y)).type != "0");
}
function heuristic( {x:x1, y:y1}, {x:x2, y:y2}) {
    const dx = Math.abs( Math.round(x1) - Math.round(x2) )
    const dy = Math.abs( Math.round(y1) - Math.round(y2) )
    return dx + dy;
}

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

async function followPath(path) {
    console.log("Following path:", path);
    for (let i = 1; i < path.length; i++) {
        const current = path[i-1];
        const next = path[i];
        if (next.x > current.x) {
            await socket.emitMove("right");
        } else if (next.x < current.x) {
            await socket.emitMove("left");
        } else if (next.y > current.y) {
            await socket.emitMove("down");
        } else if (next.y < current.y) {
            await socket.emitMove("up");
        }
    }
}

async function start() {
    let startPos = {x: 0, y: 0};
    socket.on('you', (id, name, x, y) => {
        startPos = {x, y};
    });
    console.log("Starting position:", startPos);
    const goalPos = {x: 3, y: 3}; // Example goal position, you can change this to your desired target
    const path = await aStar(startPos, goalPos);
    if (path) {
        console.log("Path found:", path);
        followPath(path);
    } else {
        console.log("No path found");
    }
}