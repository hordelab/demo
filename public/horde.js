const HORDE_URL = "wss://host.hordelab.com";

// Variable where the websocket goes
var ws;

// Request Identifier
var nonce = 0;

// Dictionary of listeners of a value, which is usually a response to most messages
const valueListeners = {};

function onMessage (ev) {
    let {name, data} = JSON.parse(ev.data);
    handleMessage(name, data);
}

// Linear backoff. in Milliseconds. Starts at 1000 and adds 500 per try
var backoff = 1000;

function connectWS () {
    ws = new Promise(resolve => {
        let _ws = new WebSocket(HORDE_URL);
        _ws.onmessage = onMessage;
        _ws.onopen = () => {
            backoff = 1000;
            resolve(_ws);
        }
        _ws.onerror = err => {
            console.error("WebSocket error", err.message || err.error && err.error.code)
        }
        _ws.onclose = () => {
            setTimeout(() => {
                console.log()
                backoff += 500;
                console.log("Retry connection");
                connectWS();
            }, backoff)
        }
    });

    return ws;
}

connectWS();


function addValueListeners (nonce, callback) {
    valueListeners[nonce] = callback;
}

function handleMessage (name, data = {}) {
    switch (name) {
        case "value": {
            let listener = valueListeners[data.nonce];
            if (listener) {
                listener(data);
            } else {
                console.warn("Value was received without listener. Nonce: %s, Value:", data.nonce, data.value)
            }
            break;
        }
        case "error": {
            let listener = valueListeners[data.nonce];
            if (listener) {
                listener(new Error("Horde Error: " + data.message));;
            } else {
                console.error("Uncaught Horde Error: " + data.message);
            }
            break;
        }
        default: {
            console.error("Received unknown message", name);
        }
    }
}

async function send (name, data) {
    (await ws).send(JSON.stringify({ name, data }))
}


// Public Interface

async function handle (name, data) {
    if (data == null) data = {};
    data.nonce = nonce++;

    let prom = new Promise((resolve, reject) => {
        addValueListeners(data.nonce, val => {
            if (val instanceof Error) {
                reject(val);
            } else {
                resolve(val);
            }
        });
    });

    await send(name, data);

    let res = await prom;
    return res.value;
}

async function readStream (streamId, chunkFn, endFn) {
    let data = {
        id: streamId,
        nonce: nonce++,
    };

    addValueListeners(data.nonce, streamData => {
        if (streamData.eof) {
            endFn()
        } else {
            chunkFn(streamData.value)
        }
    });

    await send("stream/read", data);
}

async function observe (path, updateFn) {
    let data = {
        path: path,
        nonce: nonce++,
    };

    addValueListeners(data.nonce, updateData => {
        updateFn(updateData.path, updateData.value);
    });

    await send("model/observe", data);
    return async () => {
        await send("model/cancel", {nonce: data.nonce});
    }
}

class Stream {
    constructor (id) {
        this.id = id;
        this.partialContent = "";
        this.eof = false;

        this.listeners = {
            data: [],
            end: [],
        };

        readStream(id,
            delta => {
                if (this.eof) return;

                this.partialContent += delta;
                this.handle("data", delta);
            },
            () => {
                if (this.eof) return;

                this.eof = true;
                this.handle("end");
            }
        );

        this.contentPromise = new Promise((resolve, reject) => {
            this.on("end", () => {
                resolve(this.partialContent);
            });
        });
    }

    getContent () {
        return this.contentPromise;
    }

    handle (event, ...args) {
        for (let fn of this.listeners[event]) {
            fn(...args)
        }
    }

    on (event, callback) {
        this.listeners[event].push(callback);

        if (event == "end" && this.eof) {
            callback();
        }
    }
}