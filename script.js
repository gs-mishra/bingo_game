
const app = {
    nav(screenId) {
        document.querySelectorAll('.screen').forEach(s => {
            s.classList.remove('active');
            s.classList.add('hidden');
        });
        const target = document.getElementById('screen-' + screenId);
        target.classList.remove('hidden');
        target.classList.add('active');
    },

    startOffline() {
        game.startOffline();
    },

    toast(msg) {
        const el = document.getElementById('toast');
        el.innerText = msg;
        el.classList.add('show');
        setTimeout(() => el.classList.remove('show'), 3000);
    },

    updateHostGridDisplay() {
        const hostGrid = document.getElementById('host-grid');
        if (!hostGrid) return;
        const val = hostGrid.value;
        document.getElementById('grid-disp').innerText = `${val}x${val}`;
        document.getElementById('win-lines-disp').innerText = val;
    },

    toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('bingo-theme', next);
    },

    initTheme() {
        const saved = localStorage.getItem('bingo-theme') ||
            (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', saved);
    }
};

// Initial Setup on Load
window.addEventListener('DOMContentLoaded', () => {
    app.initTheme();
    const hostGrid = document.getElementById('host-grid');
    if (hostGrid) {
        hostGrid.addEventListener('input', app.updateHostGridDisplay);
        app.updateHostGridDisplay(); // Sync initial value
    }
});

/* --- GAME LOGIC --- */
const game = {
    // Identity
    myId: null,
    myName: 'Player',
    peer: null,
    conn: null,         // Guest -> Host
    connections: [],    // Host -> Guests

    // State
    mode: 'offline',    // host, guest, offline
    status: 'LOBBY',    // LOBBY, SETUP, PLAYING
    players: [],        // { id, name, isReady }
    gridSize: 5,
    myBoard: [],        // Array of numbers
    calledNumbers: [],
    turnIndex: 0,

    // Win Condition
    linesToWin: 5,

    // 1. Initializers

    setupHost() {
        this.mode = 'host';
        this.myName = document.getElementById('host-name').value;
        this.gridSize = parseInt(document.getElementById('host-grid').value);
        this.linesToWin = this.gridSize; // N lines for NxN

        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        this.initPeer(code);
    },

    joinGame() {
        this.mode = 'guest';
        this.myName = document.getElementById('join-name').value;
        const code = document.getElementById('join-code').value.toUpperCase();
        if (code.length !== 4) return app.toast("Invalid Code");

        this.initPeer(null, `bingo-pwa-${code}`);
    },

    startOffline() {
        this.mode = 'offline';
        this.myName = "You";
        // Prompt for grid size for offline too? Let's use 5 by default or add UI.
        // For now, prompt:
        const sizeInput = prompt("Enter grid size (5-10):", "5");
        let size = parseInt(sizeInput);
        if (isNaN(size) || size < 5) size = 5;
        if (size > 10) size = 10;

        this.gridSize = size;
        this.linesToWin = size; // Target: 5 lines for 5x5, 6 for 6x6, etc.

        // Setup mock logic
        this.players = [{ id: 'me', name: 'You' }];
        this.enterSetupPhase();
    },

    // 2. PeerJS Networking

    initPeer(hostCode, targetPeerId) {
        if (typeof Peer === 'undefined') {
            app.toast("PeerJS library not loaded! Check your internet connection.");
            return;
        }

        const myPeerId = hostCode ? `bingo-pwa-${hostCode}` : undefined;
        try {
            this.peer = new Peer(myPeerId);
        } catch (e) {
            console.error(e);
            app.toast("Failed to initialize Peer connection.");
            return;
        }

        this.peer.on('open', (id) => {
            this.myId = id;
            if (this.mode === 'host') {
                document.getElementById('room-code-display').innerText = hostCode;
                this.players = [{ id: this.myId, name: this.myName, isReady: false }];
                this.updateLobby();
                app.nav('lobby');
                document.getElementById('host-controls').classList.remove('hidden');
            } else {
                // Connect to host with optimized settings
                this.conn = this.peer.connect(targetPeerId, {
                    serialization: 'json',
                    reliable: true
                });
                this.conn.on('open', () => {
                    if (this.conn) {
                        this.conn.send({ type: 'JOIN', name: this.myName });
                        app.nav('lobby');
                        document.getElementById('guest-waiting').classList.remove('hidden');
                    }
                });
                this.conn.on('data', data => this.handleData(data));
                this.conn.on('close', () => {
                    app.toast("Connection lost to Host.");
                    setTimeout(() => location.reload(), 2000);
                });
            }
        });

        this.peer.on('connection', (conn) => {
            // Standardize connection settings
            conn.serialization = 'json';
            if (this.mode === 'host') {
                conn.on('data', data => this.handleHostData(data, conn));
                conn.on('close', () => {
                    this.players = this.players.filter(p => p.id !== conn.peer);
                    this.connections = this.connections.filter(c => c.peer !== conn.peer);
                    this.broadcast({ type: 'SYNC_PLAYERS', players: this.players });
                    this.updateLobby();
                });
            }
        });

        this.peer.on('error', err => {
            console.error("Peer Error:", err);
            if (err.type === 'peer-unavailable') {
                app.toast("Room not found! Check the code.");
            } else if (err.type === 'unavailable-id') {
                app.toast("This code is already in use. Try again.");
            } else {
                app.toast("Connection Error: " + err.type);
            }
        });
    },

    // 3. Message Handling

    // Host Logic: Receive data from guests
    handleHostData(data, conn) {
        switch (data.type) {
            case 'JOIN':
                if (this.status !== 'LOBBY') {
                    conn.send({ type: 'ERROR', msg: 'Game already active' });
                    return;
                }
                const newPlayer = { id: conn.peer, name: data.name, isReady: false };
                this.players.push(newPlayer);
                this.connections.push(conn);
                this.updateLobby();
                this.broadcast({ type: 'SYNC_PLAYERS', players: this.players });
                break;

            case 'READY':
                const p = this.players.find(pl => pl.id === conn.peer);
                if (p) p.isReady = true;
                // Check if all ready
                if (this.players.every(pl => pl.isReady)) {
                    this.startGame();
                    this._hasClaimedWin = false;
                } else {
                    this.broadcast({ type: 'SYNC_PLAYERS', players: this.players });
                    this.updateWaitingUI();
                }
                break;

            case 'CLICK_NUMBER':
                this.handleTurn(conn.peer, data.number);
                break;

            case 'BINGO':
                this.registerWin(data.name);
                break;
        }
    },

    // Guest/Client Logic: Receive data from Host (or Host receiving from self)
    handleData(data) {
        // Host calls this locally too
        console.log("RX:", data);
        switch (data.type) {
            case 'SYNC_PLAYERS':
                this.players = data.players;
                this.updateLobby();
                this.updateWaitingUI();
                break;
            case 'START_SETUP':
                this.gridSize = data.gridSize;
                this.linesToWin = data.gridSize;
                document.getElementById('target-lines').innerText = `${this.linesToWin} Lines`;
                this.enterSetupPhase();
                break;
            case 'START_GAME':
                this.players = data.players; // sync order
                this.turnIndex = 0;
                this.calledNumbers = [];
                this.enterGamePhase();
                this._hasClaimedWin = false;
                break;
            case 'NUMBER_CALLED':
                this.calledNumbers.push(data.number);
                this.turnIndex = data.nextTurn;
                this.markNumber(data.number);
                document.getElementById('last-called').innerText = data.number;
                this.updateTurnDisplay();
                // Check win locally
                this.checkWin();
                break;
            case 'GAME_OVER':
                this.showWin(data.winner);
                break;
        }
    },

    broadcast(data) {
        if (this.mode === 'host') {
            this.connections.forEach(c => c.send(data));
            // Handle locally
            this.handleData(data);
        }
    },

    // 4. UI Phases

    updateLobby() {
        const list = document.getElementById('lobby-list');
        list.innerHTML = this.players.map(p => `
            <li class="player-item">
                <div class="status-dot ${p.isReady ? 'ready' : ''}"></div>
                <span>${p.name} <small style="opacity:0.6">${p.id === this.myId ? '(You)' : ''}</small></span>
            </li>
        `).join('');
    },

    // --- SETUP PHASE ---

    triggerSetup() {
        if (this.mode === 'host') {
            this.broadcast({ type: 'START_SETUP', gridSize: this.gridSize });
        }
    },

    enterSetupPhase() {
        app.nav('setup');
        const grid = document.getElementById('setup-grid');
        grid.style.setProperty('--grid-dim', this.gridSize);
        grid.style.gridTemplateColumns = `repeat(${this.gridSize}, 1fr)`;
        grid.innerHTML = '';

        const total = this.gridSize * this.gridSize;
        document.getElementById('max-num-info').innerText = total;

        // Create Inputs
        for (let i = 0; i < total; i++) {
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'grid-input';
            if (this.gridSize >= 8) input.classList.add('dense');
            input.dataset.index = i;
            input.min = 1;
            input.max = total;
            grid.appendChild(input);
        }

        document.getElementById('ready-btn').disabled = false;
        document.getElementById('waiting-other-setup').classList.add('hidden');
    },

    fillBoardRandom() {
        const inputs = document.querySelectorAll('.grid-input');
        const total = this.gridSize * this.gridSize;
        const max = total; // Range is 1 to N^2

        const set = new Set();
        while (set.size < total) {
            set.add(Math.floor(Math.random() * max) + 1);
        }
        const nums = Array.from(set);
        inputs.forEach((inp, i) => inp.value = nums[i]);
    },

    clearBoardInput() {
        document.querySelectorAll('.grid-input').forEach(i => i.value = '');
    },

    confirmReadiness() {
        // Validate Inputs
        const inputs = Array.from(document.querySelectorAll('.grid-input'));
        const totalCells = this.gridSize * this.gridSize;
        const values = [];
        const seen = new Set();

        for (let i = 0; i < inputs.length; i++) {
            const val = parseInt(inputs[i].value);

            if (isNaN(val)) {
                app.toast("Please fill all cells.");
                return;
            }

            if (val < 1 || val > totalCells) {
                app.toast(`Numbers must be between 1 and ${totalCells}.`);
                inputs[i].focus();
                return;
            }

            if (seen.has(val)) {
                app.toast(`Duplicate number found: ${val}. Each number must be unique!`);
                inputs[i].focus();
                return;
            }

            seen.add(val);
            values.push(val);
        }

        this.myBoard = values;

        document.getElementById('ready-btn').disabled = true;
        document.getElementById('waiting-other-setup').classList.remove('hidden');

        if (this.mode === 'offline') {
            this.enterGamePhase(); // Instant start
        } else if (this.mode === 'host') {
            // Mark self ready
            const me = this.players.find(p => p.id === this.myId);
            me.isReady = true;
            if (this.players.every(p => p.isReady)) {
                this.startGame();
                this._hasClaimedWin = false;
            } else {
                this.broadcast({ type: 'SYNC_PLAYERS', players: this.players });
                this.updateWaitingUI();
            }
        } else {
            this.conn.send({ type: 'READY' });
            this.updateWaitingUI();
        }
    },

    // --- GAME PHASE ---

    startGame() {
        const startData = {
            type: 'START_GAME',
            players: this.players
            // Board data is not shared to prevent cheating, validated locally or optimistically.
            // Strict enforcement would require sending board hash or content to host.
            // For this app, we trust client 'BINGO' claim.
        };
        this.broadcast(startData);
    },

    enterGamePhase() {
        app.nav('game');
        document.getElementById('target-lines').innerText = `${this.linesToWin} Lines`;
        const grid = document.getElementById('play-grid');
        grid.style.setProperty('--grid-dim', this.gridSize);
        grid.style.gridTemplateColumns = `repeat(${this.gridSize}, 1fr)`;
        grid.innerHTML = '';

        this.myBoard.forEach(num => {
            const d = document.createElement('div');
            d.className = 'grid-cell';
            d.innerText = num;
            d.dataset.num = num;
            if (this.gridSize >= 8) d.classList.add('dense');
            d.onclick = () => this.clickCell(num);
            grid.appendChild(d);
        });

        this.updateTurnDisplay();
    },

    clickCell(num) {
        if (this.calledNumbers.includes(num)) return;

        const turnPlayer = this.players[this.turnIndex];

        // Validation
        if (this.mode === 'offline') {
            // Just proceed
        } else {
            if (turnPlayer.id !== this.myId) {
                app.toast("Not your turn!");
                return;
            }
        }

        if (this.mode === 'host') {
            this.handleTurn(this.myId, num);
        } else if (this.mode === 'guest') {
            this.conn.send({ type: 'CLICK_NUMBER', number: num });
        } else {
            // Offline
            this.calledNumbers.push(num);
            this.markNumber(num);
            document.getElementById('last-called').innerText = num;
            this.checkWin();
        }
    },

    handleTurn(pid, num) {
        if (this.calledNumbers.includes(num)) return;

        const next = (this.turnIndex + 1) % this.players.length;
        this.broadcast({
            type: 'NUMBER_CALLED',
            number: num,
            nextTurn: next
        });
    },

    markNumber(num) {
        const cells = document.querySelectorAll('.grid-cell');
        cells.forEach(c => {
            if (parseInt(c.dataset.num) === num) c.classList.add('called');
        });
    },

    updateTurnDisplay() {
        const p = this.players[this.turnIndex];
        const disp = document.getElementById('turn-display');
        if (this.mode === 'offline') {
            disp.innerText = "Your Turn";
            disp.style.color = "var(--primary)";
        } else {
            disp.innerText = p.id === this.myId ? "You" : p.name;
            disp.style.color = p.id === this.myId ? "var(--primary)" : "var(--text-main)";
        }

    },

    // Win Handling (Multi-Winner Support)
    winnersQueue: [],
    winTimer: null,

    registerWin(name) {
        if (!this.winnersQueue.includes(name)) {
            this.winnersQueue.push(name);
        }

        if (!this.winTimer) {
            // Wait for other potential winners on the same number (Network latency buffer)
            this.winTimer = setTimeout(() => {
                this.finalizeGame();
            }, 1500);
        }
    },

    finalizeGame() {
        const winnerText = this.winnersQueue.join(' & ');
        this.broadcast({ type: 'GAME_OVER', winner: winnerText });
        this.showWin(winnerText);

        // Reset
        this.winnersQueue = [];
        this.winTimer = null;
    },

    checkWin() {
        const size = this.gridSize;
        let lines = 0;

        const isTicked = (idx) => this.calledNumbers.includes(this.myBoard[idx]);

        // Rows
        for (let r = 0; r < size; r++) {
            let full = true;
            for (let c = 0; c < size; c++) if (!isTicked(r * size + c)) full = false;
            if (full) lines++;
        }
        // Cols
        for (let c = 0; c < size; c++) {
            let full = true;
            for (let r = 0; r < size; r++) if (!isTicked(r * size + c)) full = false;
            if (full) lines++;
        }
        // Diagonals
        let d1 = true; for (let i = 0; i < size; i++) if (!isTicked(i * size + i)) d1 = false;
        if (d1) lines++;

        let d2 = true; for (let i = 0; i < size; i++) if (!isTicked(i * size + (size - 1 - i))) d2 = false;
        if (d2) lines++;

        document.getElementById('my-lines-count').innerText = lines;

        // Win Logic: Lines >= Size
        if (lines >= this.linesToWin) {
            if (this.mode === 'offline') {
                this.showWin("You");
            } else {
                if (this.mode === 'host') {
                    // Host wins, register self
                    this.registerWin(this.myName);
                } else {
                    // Start spamming Bingo to host
                    if (!this._hasClaimedWin) {
                        this.conn.send({ type: 'BINGO', name: this.myName });
                        this._hasClaimedWin = true; // Prevent spamming frame-by-frame
                    }
                }
            }
        }
    },

    showWin(name) {
        document.getElementById('winner-name').innerText = name;
        document.getElementById('win-overlay').classList.remove('hidden');
    },

    updateWaitingUI() {
        const list = document.getElementById('waiting-names');
        if (!list) return;

        // Find players who are NOT ready
        // If I am guest, my own 'isReady' might not be synced back yet if I just clicked, 
        // but for the purpose of "Waiting for X", I shouldn't be in the list anyway if I'm viewing this screen.

        const notReady = this.players.filter(p => !p.isReady && p.id !== this.myId);

        if (roomCodeDisplay = document.getElementById('waiting-list-container')) {
            if (notReady.length === 0) {
                // Technically implies all ready, game should start, but handle empty case
                list.innerHTML = '<span style="opacity:0.5">Starting...</span>';
            } else {
                list.innerHTML = notReady.map(p => `<span class="player-tag">${p.name}</span>`).join('');
            }
        }
    }
};
