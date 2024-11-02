// Used as default. Pass the host url to Horde constructor instead.
const HORDE_URL = "wss://host.hordelab.com";

// Time to wait when a request doesn't go through, in milliseconds.
const RETRY_TIME = 300;

const configPromise = Promise.resolve({
    hostUrl: HORDE_URL
});

var _root_horde = null;

function decodeNet (value) {
    if (value instanceof Array) {
        return value.map(decodeNet);
    }
    if (value instanceof Object) {
        if (value['$horde'] == 'stream') {
            return new Stream(_root_horde, value.id);
        }
        return Object.fromEntries(
            Object.entries(value).map(
                ([k, v]) => [k, decodeNet(v)]
            )
        );
    }

    // fallthrough
    return value;
}

function encodeNet (value) {
    if (value instanceof Stream) {
        return {
            '$horde': 'stream',
            'id': value.id,
        };
    }
    if (value instanceof Array) {
        return value.map(encodeNet);
    }
    if (value instanceof Object) {
        return Object.fromEntries(
            Object.entries(value).map(
                ([k, v]) => [k, encodeNet(v)]
            )
        );
    }

    // fallthrough
    return value;
}

class Stream {
    constructor (horde, id) {
        this.horde = horde;
        this.id = id;
        this.partialContent = "";
        this.eof = false;

        this.listeners = {
            data: [],
            end: [],
        };

        this.horde.sendWs({
            path: 'stream',
            body: {id: this.id},
            onResponse: (msg) => {
                if (this.eof) return;

                if (msg.eof) {
                    this.eof = true;
                    this.handle('end');
                } else {
                    this.partialContent += msg.data;
                    this.handle('data', msg.data);
                }
            }
        });

        this.contentPromise = new Promise((resolve, reject) => {
            this.handle("end", () => {
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

        if (event == "data" && this.partialContent) {
            callback(this.partialContent);
        }
        if (event == "end" && this.eof) {
            callback();
        }
    }
}

class Instance {
    constructor (horde, model, id) {
        this.horde = horde;
        this.model = model;
        this.id = id;
    }

    async get () {
        let res = await this.horde.send(`/m/${this.model}`, {
            args: {id: this.id},
        });
        return res.value;
    }

    async update (subpath, value) {
        let res = await this.horde.send(`/m/${this.model}`, {
            args: {
                id: this.id,
                subpath: subpath
                    .map(s => String(s).replace('.', '\\.'))
                    .join('.'),
            },
            method: 'POST',
            body: value
        });
        return res;
    }

    // Deletes the instance in the server
    async remove () {
        console.log("Delete", this.id)
        let res = await this.horde.send(`/m/${this.model}/delete`, {
            args: {
                id: this.id,
            },
            method: 'POST',
        });
        // res.success == true
    }

    observe (callback) {
        let sendRequest = () => {
            console.log("observe request", this.model, this.id);

            this.horde.sendWs({
                path: `/m/observe`,
                body: {
                    model: this.model,
                    handle: this.id,
                },
                onResponse (msg) {
                    callback(msg.subpath, decodeNet(msg.value));
                }
            });
        };
        this.horde.closeListeners.push(sendRequest);
        sendRequest();
    }
}

class Horde {
    constructor (host = HORDE_URL) {
        this.host = host;

        if (_root_horde == null)
            _root_horde = this;

        this.lastConnection = new Date();
        this.websocketReady = false;
        this.websocketNonce = 0;
        this.websocketQueue = [];
        this.nonceListeners = {};
        this.closeListeners = []
        this.connectWebsocket();
    }

    async connectWebsocket () {
        console.log("connectWebsocket", Boolean(this.ws));
        if (this.ws) return;

        const wsUrl = this.host.replace(/^http/, 'ws').replace(/^https/, 'wss') + '/ws';
        console.log("Connect WebSocket to ", wsUrl);
        this.ws = new WebSocket(wsUrl);
        this.websocketReady = false;

        this.ws.onopen = () => {
            // Make lastConnection be the last reconnection attempt
            this.lastConnection = new Date();
            this.configureWebsocket();

            this.websocketReady = true;
            for (let callback of this.websocketQueue) {
                callback();
            }
            this.websocketQueue = [];
        };

        this.ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            console.log("onmessage", data);
            this.receiveWebsocketMessage(data);
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };

        this.ws.onclose = () => {
            console.log("Websocket connection closed");

            // If the websocket was properly connected,
            // set the last connection to the disconnection time.
            // lastConnection is used to time when is best appropriate
            // to reconnect, so keeping it recent helps with responsiveness.
            if (this.websocketReady) {
                this.lastConnection = new Date();
            }

            this.ws = null;
            this.websocketReady = false;

            for (let callback of this.closeListeners) {
                callback();
            }

            const elapsed = new Date() - this.lastConnection;
            const delay = Math.max(500, elapsed / 2);

            setTimeout(() => {
                this.connectWebsocket();
            }, delay);
        };
    }

    async configureWebsocket () {
        let config = await configPromise;

        if (config.token) {
            let res = this.sendWs({
                path: "auth",
                body: {token: config.token},
                nonce: false,
                forced: true,
            });
        }
    }

    async sendWs (msg) {
        let resultPromise;

        let forced = Boolean(msg.forced);
        if (msg.forced !== undefined) {
            delete msg.forced;
        }

        if (msg.onResponse) {
            const callback = msg.onResponse;
            const nonce = msg.nonce = this.websocketNonce++;
            delete msg.onResponse;

            resultPromise = new Promise((resolve, reject) => {
                this.nonceListeners[nonce] = {
                    resolve: (msg) => {
                        resolve();
                        callback(msg);
                    },
                    reject
                };
            });
        } else if (msg.nonce != null) {
            const nonce = msg.nonce = this.websocketNonce++;

            resultPromise = new Promise((resolve, reject) => {
                this.nonceListeners[nonce] = {
                    resolve: (msg) => {
                        resolve(msg);
                        delete this.nonceListeners[nonce];
                    },
                    reject
                };
            });
        }

        if (forced) {
            this.ws.send(JSON.stringify(msg));
            return;
        }

        // Trying sending until success.
        let retry_time = RETRY_TIME;

        while (true) {
            if (!this.websocketReady) {
                await new Promise(resolve => {
                    this.websocketQueue.push(resolve)
                })
            }

            try {
                this.ws.send(JSON.stringify(msg));
            } catch (e) {
                console.error(e);
                // Wait for a period
                await new Promise(resolve => {
                    setTimeout(retry_time, resolve);
                })

                // Increase the retry time by half it's current value
                retry_time = (retry_time * 1.5) | 0;

                // Don't let this iteration continue.
                continue;
            }

            if (resultPromise) {
                return await resultPromise;
            }

            // Break the send loop if no response is expected
            break;
        }
    }

    async receiveWebsocketMessage (msg) {
        if (msg.nonce != null) {
            let listener = this.nonceListeners[msg.nonce];

            if (listener) {
                delete msg.nonce;

                if (msg.error) {
                    listener.reject(msg.error);
                } else {
                    listener.resolve(msg);
                }
            }
        }
    }

    async makeHeaders (params) {
        let headers = {};

        if (params && params.body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }

        return headers;
    }

    async handle (method, args = {}) {
        const response = await this.sendWs({
            path: "h/" + method,
            body: encodeNet(args),
            nonce: true,
        });

        return decodeNet(response.output);
    }

    async send (path, params={}) {
        let query = "";

        let config = await configPromise;
        if (config.token) {
            params.args = Object.assign({}, params.args || {}, {tk: config.token});
        }

        if (params.args) {
            query = "?" + Object.entries(params.args)
                .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
                .join('&');
        }

        if (path[0] == "/") {
            path = path.slice(1);
        }

        const url = `${this.host}/${path}${query}`;
        const response = await fetch(url, {
            method: params.method || "GET",
            headers: await this.makeHeaders({body: params.body !== undefined}),
            body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
        });

        if (!response.ok) {
            /*try {
                let text = await response.text();
                console.error(text);
            } catch (e) {}*/
            throw new Error(`Request failed with status ${response.status}`);
        }

        if (params.onData) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    params.onData(
                        decoder.decode(value, { stream: true })
                    );
                }
            } finally {
                if (params.onClose) {
                    params.onClose();
                }
            }

        } else {
            const data = await response.json();
            return data;
        }
    }

    async modelIndex (model) {
        let res = await this.send(`/m/${model}/index`);
        return res.entries;
    }

    getStream (stream_id) {
        return new Stream(this, stream_id);
    }
}

let promise = (async function () {
    let config = await configPromise;
    let hostUrl = config.hostUrl;

    return new Horde(hostUrl);
})();

// Public Interface Functions

async function getInstance (model, instance_id) {
    let horde = await promise;
    return new Instance(horde, model, instance_id);
}

async function createInstance (model, members=null) {
    let horde = await promise;
    let res = await horde.send(`/m/${model}/create`, {
        method: 'POST',
        body: members ? {members} : undefined,
    });
    return new Instance(horde, model, res.id);
}

async function login (email, password) {
    let horde = await promise;
    let res = await horde.send(`/user/login`, {
        method:'POST',
        body: {email, password},
    });
    return res.token;
}

async function signup (email, password) {
    let horde = await promise;
    let res = await horde.send(`/user/signup`, {
        method:'POST',
        body: {email, password},
    });
    return res.token;
}

async function getHorde () {
    return await promise;
}



// COMPATIBILITY

async function handle (method, inputs) {
    let horde = await promise;
    let res = await horde.handle(method, inputs);
    return res;
}

