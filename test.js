import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

const client = new DeliverooApi(
    'http://localhost:8080',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImFlN2Y1NCIsIm5hbWUiOiJhbm9ueW1vdXMiLCJyb2xlIjoidXNlciIsImlhdCI6MTc3NTY0MjI0M30.RtZ6mdaGuDQM5g7cJTCEjVfZJrRQwhKlmTKZmnvbaVM'
);



let myPosition = {x: 0, y: 0};
client.on('you', (id, name, x, y) => {
    myPosition = {x, y};
});

client.on('map', async (width, height, tiles) => {
    const path = ['right', 'right',  'down', 'down', 'left', 'left', 'up', 'up'];

    for (const direction of path) {
        // Process each direction
        const result = await client.emitMove(direction);
        if (!result) {
            console.log(`Failed to move ${direction}`);
            await new Promise( r => setTimeout(r, 100)); // Wait before retrying
        }
    }
    //pickup Parcels
    await client.emitPickup();
});
