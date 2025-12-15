const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// --- CONFIG ---
let userDB = {}; 
let rooms = {};
let usersByUid = {}; // uid -> { username, totalWealth, cumulativeScore }
// helper to get or create user record by uid or username
function getUserRecord(uid, username) {
    if(uid) {
        if(!usersByUid[uid]) usersByUid[uid] = { username: username || `GUEST-${uid}`, totalWealth: INITIAL_WEALTH, cumulativeScore: 0 };
        // update username if changed
        if(username) usersByUid[uid].username = username;
        return usersByUid[uid];
    }
    if(!userDB[username]) userDB[username] = { totalWealth: INITIAL_WEALTH, cumulativeScore: 0 };
    return userDB[username];
}
let randomQueues = {}; // keyed by gameType -> array of { socketId, username, buyIn }
let globalChatLogs = [];
const LOG_RETENTION = 24 * 3600000; // 24 hours
const DATA_DIR = path.join(__dirname, 'data');
const GLOBAL_CHAT_FILE = path.join(DATA_DIR, 'globalChat.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SAVE_INTERVAL = 30 * 1000; // persist every 30s
const INITIAL_WEALTH = 3000;
const RELIEF_THRESHOLD = 100;
const RELIEF_AMOUNT = 1000;

setInterval(() => {
    const cut = Date.now() - LOG_RETENTION;
    globalChatLogs = globalChatLogs.filter(l => l.timestamp > cut);
}, 60000);

// Persistence helpers (simple JSON files)
const fs = require('fs');
async function ensureDataDir() {
    try { await fs.promises.mkdir(DATA_DIR, { recursive: true }); } catch(e){}
}

async function loadPersistentData() {
    await ensureDataDir();
    try {
        const txt = await fs.promises.readFile(GLOBAL_CHAT_FILE, 'utf8');
        const arr = JSON.parse(txt);
        if(Array.isArray(arr)) globalChatLogs = arr;
    } catch(e) {}
    try {
        const txt = await fs.promises.readFile(USERS_FILE, 'utf8');
        const obj = JSON.parse(txt);
        if(obj && typeof obj === 'object') usersByUid = obj;
    } catch(e) {}
}

async function savePersistentData() {
    try {
        await ensureDataDir();
        await fs.promises.writeFile(GLOBAL_CHAT_FILE, JSON.stringify(globalChatLogs.slice(-1000)), 'utf8');
        await fs.promises.writeFile(USERS_FILE, JSON.stringify(usersByUid), 'utf8');
    } catch(e) { console.error('savePersistentData error', e); }
}

// Periodic save
setInterval(() => { savePersistentData(); }, SAVE_INTERVAL);

// load on start
loadPersistentData().then(()=> console.log('Persistent data loaded')).catch(()=>{});

// --- UNO HELPERS ---
const UNO_COLORS = ['red', 'yellow', 'green', 'blue'];
const UNO_VALUES = ['0','1','2','3','4','5','6','7','8','9','skip','reverse','draw2'];

function createUnoDeck() {
    let deck = [];
    for(let c of UNO_COLORS) {
        for(let v of UNO_VALUES) {
            deck.push({ color: c, type: v, id: Math.random() }); // 1枚目
            if(v !== '0') deck.push({ color: c, type: v, id: Math.random() }); // 0以外は2枚目
        }
    }
    for(let i=0; i<4; i++) {
        deck.push({ color: 'black', type: 'wild', id: Math.random() });
        deck.push({ color: 'black', type: 'draw4', id: Math.random() });
    }
    return shuffle(deck);
}

// --- BJ HELPERS ---
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function createBjDeck() {
    let deck = [];
    for(let s of SUITS) {
        for(let r of RANKS) {
            let val = parseInt(r); if(['J','Q','K'].includes(r)) val=10; if(r==='A') val=11;
            let pow = parseInt(r); if(r==='10')pow=10; if(r==='J')pow=11; if(r==='Q')pow=12; if(r==='K')pow=13; if(r==='A')pow=14;
            deck.push({ suit: s, rank: r, val: val, power: pow });
        }
    }
    return shuffle(deck);
}
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}
function getBjScore(hand) {
    let s=0, a=0; for(let c of hand){ s+=c.val; if(c.rank==='A')a++; }
    while(s>21 && a>0){ s-=10; a--; } return s;
}

io.on('connection', (socket) => {
    sendRanking(socket);
    socket.emit('chatHistory', { type: 'global', logs: globalChatLogs });
    // also send persisted users record snapshot
    socket.emit('usersSnapshot', { users: usersByUid });

    // ensure removal from random queues on disconnect
    socket.on('disconnecting', () => {
        for (const gt in randomQueues) {
            randomQueues[gt] = randomQueues[gt].filter(e => e.socketId !== socket.id);
        }
    });

        // UNO call from client
        socket.on('unoCall', ({ room }) => {
            const r = rooms[room]; if(!r) return;
            const p = r.players.find(pl => pl.id === socket.id);
            if(p) {
                p.unoCalled = true;
                io.to(room).emit('unoCalled', { username: p.username });
            }
        });

    // Chat
    socket.on('sendChat', (d) => {
        const msg = { id:Date.now(), timestamp:Date.now(), username:d.username||'GUEST', text:d.text, color:d.color, type:d.type };
        if(d.type==='global') { globalChatLogs.push(msg); io.emit('chatMsg', msg); savePersistentData(); }
        else if(d.type==='room' && rooms[d.room]) { io.to(d.room).emit('chatMsg', msg); }
    });

    // Join
    socket.on('joinRoom', ({ username, room, gameType, buyInAmount, uid }) => {
        if(!username || !room) return socket.emit('error', 'INVALID INPUT');
        if(!rooms[room]) {
            rooms[room] = {
                gameType, players: [], gameActive: false,
                unoDeck: [], unoPile: [], unoTurn: 0, unoDirection: 1, unoDrawStack: 0, unoColor: null,
                deck: [], dealerHand: [], bjTurnIndex: 0, bjPhase: 'lobby', maxRounds: 7, currentRound: 0,
                ovDeck: [], ovDealerCard: null, ovPhase: 'lobby'
            };
        }
        const r = rooms[room];
        
        // Remove ghost (by username or uid)
        const dupIdx = r.players.findIndex(p => (uid && p.uid === uid) || p.username === username);
        if(dupIdx !== -1) r.players.splice(dupIdx, 1);

        if(r.players.length >= 6) return socket.emit('error', 'ROOM FULL');

        // DB record (by uid if provided)
        const userRec = getUserRecord(uid, username);
        let relief = false;
        if(userRec.totalWealth < RELIEF_THRESHOLD) { userRec.totalWealth = RELIEF_AMOUNT; relief = true; }

        let fee = parseInt(buyInAmount); if(isNaN(fee)||fee<100) fee=100;
        if(userRec.totalWealth < fee) return socket.emit('error', '資金不足です');
        userRec.totalWealth -= fee;
        savePersistentData();

        const colors = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#FFFFFF', '#FF9FF3', '#54A0FF'];
        r.players.push({
            id: socket.id, username, uid: uid || null, color: colors[r.players.length % colors.length],
            isCpu: false, ready: false, score: fee, initialScore: fee, currentBet: 0, 
            hand: [], status: 'playing', result: '', unoHand: []
        });
        
        socket.join(room);
        const me = r.players.find(pl=>pl.id===socket.id);
        socket.emit('joined', { color: me.color, mySeat: r.players.indexOf(me), wealth: userRec.totalWealth, relief, room });
        io.to(room).emit('roomUpdate', { players: r.players, gameType: r.gameType, maxRounds: r.maxRounds });
        io.emit('rankingUpdate', getRankingData());
    });

    // RANDOM MATCH: put player in a waiting queue for the requested game type and buy-in
    socket.on('joinRandom', ({ username, gameType, buyInAmount, uid }) => {
        if(!username || !gameType) return socket.emit('error','INVALID INPUT');
        const buyIn = parseInt(buyInAmount) || 100;
        const key = `${gameType}:${buyIn}`;
        if(!randomQueues[key]) randomQueues[key] = [];

        // add to queue
        randomQueues[key].push({ socketId: socket.id, username, buyIn, uid });
        socket.join(`waiting-${key}`);
        socket.emit('waiting', `Looking for an opponent (${gameType}, ${buyIn})...`);

        // if there is another waiting player, pair them
        if(randomQueues[key].length >= 2) {
            const a = randomQueues[key].shift();
            const b = randomQueues[key].shift();
            const roomId = `rand-${Date.now()}-${Math.floor(Math.random()*10000)}`;

            // Create room and add both players
            rooms[roomId] = {
                gameType, players: [], gameActive: false,
                unoDeck: [], unoPile: [], unoTurn: 0, unoDirection: 1, unoDrawStack: 0, unoColor: null,
                deck: [], dealerHand: [], bjTurnIndex: 0, bjPhase: 'lobby', maxRounds: 7, currentRound: 0,
                ovDeck: [], ovDealerCard: null, ovPhase: 'lobby'
            };

            [a,b].forEach((entry, idx) => {
                const sid = entry.socketId;
                const sock = io.sockets.sockets.get(sid);
                if(!sock) return;

                const userRec = getUserRecord(entry.uid, entry.username);
                let relief = false;
                if(userRec.totalWealth < RELIEF_THRESHOLD) { userRec.totalWealth = RELIEF_AMOUNT; relief = true; }

                let fee = parseInt(entry.buyIn); if(isNaN(fee)||fee<100) fee=100;
                if(userRec.totalWealth < fee) return sock.emit('error', '資金不足です');
                userRec.totalWealth -= fee;
                savePersistentData();

                const colors = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#FFFFFF', '#FF9FF3', '#54A0FF'];
                const player = {
                    id: sid, username: entry.username, uid: entry.uid || null, color: colors[idx % colors.length],
                    isCpu: false, ready: false, score: fee, initialScore: fee, currentBet: 0,
                    hand: [], status: 'playing', result: '', unoHand: []
                };

                rooms[roomId].players.push(player);
                sock.leave(`waiting-${key}`);
                sock.join(roomId);
                sock.emit('joined', { color: player.color, mySeat: rooms[roomId].players.indexOf(player), wealth: userRec.totalWealth, relief, room: roomId });
            });

            // notify room
            io.to(roomId).emit('roomUpdate', { players: rooms[roomId].players, gameType: rooms[roomId].gameType, maxRounds: rooms[roomId].maxRounds });
            io.emit('rankingUpdate', getRankingData());

            // Do NOT auto-start random matches; require all players to toggle ready (same behavior as manual rooms).
        }
    });

    // leave random queue
    socket.on('leaveRandom', ({ gameType, buyInAmount }) => {
        const buyIn = parseInt(buyInAmount) || 100;
        const key = `${gameType}:${buyIn}`;
        if(randomQueues[key]) randomQueues[key] = randomQueues[key].filter(e => e.socketId !== socket.id);
        socket.leave(`waiting-${key}`);
        socket.emit('waitingCancelled');
    });

    socket.on('disconnect', () => handleLeave(socket));
    function handleLeave(sock) {
        for(let rid in rooms) {
            const r = rooms[rid];
            const idx = r.players.findIndex(p=>p.id===sock.id);
            if(idx!==-1) {
                const p = r.players[idx];
                if(!p.isCpu) {
                    if(p.uid && usersByUid[p.uid]) {
                        usersByUid[p.uid].totalWealth += p.score;
                        usersByUid[p.uid].cumulativeScore += (p.score - p.initialScore);
                        savePersistentData();
                    } else if(userDB[p.username]) {
                        userDB[p.username].totalWealth += p.score;
                        userDB[p.username].cumulativeScore += (p.score - p.initialScore);
                        savePersistentData();
                    }
                }
                r.players.splice(idx,1);
                if(!r.players.some(pl => !pl.isCpu)) delete rooms[rid];
                else {
                    r.gameActive = false;
                    r.players = r.players.filter(pl => !pl.isCpu);
                    r.players.forEach(pl => pl.ready = false);
                    io.to(rid).emit('roomUpdate', { players: r.players, gameType: r.gameType });
                }
                io.emit('rankingUpdate', getRankingData());
                break;
            }
        }
    }

    // Ready
    socket.on('toggleReady', ({ room }) => {
        const r = rooms[room]; if(!r || r.gameActive) return;
        const p = r.players.find(pl => pl.id === socket.id);
        if(p) {
            p.ready = !p.ready;
            io.to(room).emit('roomUpdate', { players: r.players, gameType: r.gameType });
            if(r.players.length > 0 && r.players.every(pl => pl.ready)) {
                if(r.gameType === 'uno') {
                    while(r.players.length < 4) {
                        r.players.push({ id: `cpu-${Date.now()}-${Math.random()}`, username: `CPU ${r.players.length+1}`, color: '#AAAAAA', isCpu: true, ready: true, score: 1000, initialScore: 1000, unoHand: [] });
                    }
                    io.to(room).emit('roomUpdate', { players: r.players, gameType: 'uno' });
                    setTimeout(() => startUnoMatch(room), 500);
                }
                else if(r.gameType === 'blackjack') startBjMatch(room);
                else if(r.gameType === 'override') startOvMatch(room);
            }
        }
    });

    socket.on('placeBet', ({ room, amount }) => {
        const r = rooms[room]; if(!r) return;
        const p = r.players.find(pl => pl.id === socket.id);
        if(p && p.currentBet === 0) {
            let bet = parseInt(amount); if(p.score < bet) bet = p.score;
            p.currentBet = bet; p.score -= bet;
            io.to(room).emit('roomUpdate', { players: r.players, gameType: r.gameType });
            if(r.players.filter(pl => pl.status !== 'bankrupt').every(pl => pl.currentBet > 0)) {
                if(r.gameType === 'blackjack') dealBjCards(room);
                if(r.gameType === 'override') startOvTurn(room);
            }
        }
    });

    socket.on('bjAction', ({ room, action }) => handleBjAction(room, socket.id, action));
    socket.on('ovAction', ({ room, choice }) => handleOvAction(room, socket.id, choice));
    
    // UNO ACTIONS
    socket.on('unoMove', (d) => processUnoMove(d.room, socket.id, d.cardIndex, d.colorChoice));
    socket.on('unoMultiMove', (d) => processUnoMultiMove(d.room, socket.id, d.cardIds || [], d.colorChoices || []));
    socket.on('unoDraw', ({ room }) => processUnoDraw(room, socket.id));
});

function getRankingData() {
    const arr = [];
    // UID users first
    Object.keys(usersByUid).forEach(uid => {
        const u = usersByUid[uid]; arr.push({ name: u.username, wealth: u.totalWealth, score: u.cumulativeScore });
    });
    // username-only users (avoid duplicates)
    Object.keys(userDB).forEach(name => {
        // skip if same name exists in usersByUid
        if(!Object.values(usersByUid).some(u => u.username === name)) {
            const u = userDB[name]; arr.push({ name: name, wealth: u.totalWealth, score: u.cumulativeScore });
        }
    });
    return arr.sort((a,b)=>b.score-a.score).slice(0,10);
}
function sendRanking(socket) { socket.emit('rankingUpdate', getRankingData()); }

// ==========================================
// UNO LOGIC
// ==========================================
function startUnoMatch(room) {
    const r = rooms[room];
    r.gameActive = true;
    r.unoDeck = createUnoDeck();
    r.unoPile = [r.unoDeck.pop()];
    
    // Initial Wild check
    while(r.unoPile[0].color === 'black') { 
        r.unoDeck.unshift(r.unoPile.pop()); 
        r.unoDeck = shuffle(r.unoDeck); 
        r.unoPile = [r.unoDeck.pop()]; 
    }
    
    r.unoTurn = 0; r.unoDirection = 1; r.unoDrawStack = 0; r.unoColor = r.unoPile[0].color;
    
    r.players.forEach(p => { 
        p.unoHand = []; 
        for(let i=0; i<7; i++) p.unoHand.push(r.unoDeck.pop()); 
        p.hasDrawnThisTurn = false;
        p.unoCalled = false;
    });
    
    updateUnoState(room);
    checkCpuTurn(room);
}

function canPlayUnoCard(r, card) {
    const top = r.unoPile[r.unoPile.length-1];
    if(r.unoDrawStack > 0) {
        if(top.type === 'draw2' && card.type === 'draw2') return true;
        if(top.type === 'draw4' && card.type === 'draw4') return true;
        return false;
    }
    if(card.color === 'black') return true;
    if(card.color === r.unoColor) return true;
    if(card.type === top.type) return true;
    return false;
}

function processUnoMove(room, playerId, cardIndex, colorChoice) {
    const r = rooms[room]; if(!r || !r.gameActive) return;
    const p = r.players[r.unoTurn]; if(p.id !== playerId) return;
    
    const card = p.unoHand[cardIndex];
    if(!card || !canPlayUnoCard(r, card)) return; // Invalid move
    // prevent finishing with a non-number card
    if(p.unoHand.length === 1 && !(/^\d+$/.test(card.type))) { socketEmitToPlayer(playerId,'error','記号上がりはできません'); return; }

    // Play
    p.unoHand.splice(cardIndex, 1);
    r.unoPile.push(card);
    // notify clients what card was played (so they can animate the face)
    io.to(room).emit('cardPlayed', { username: p.username, card: { color: card.color, type: card.type } });

    // NOTE: remove server-side automatic mass-play. Instead allow the player to
    // continue playing additional cards of the same `type` themselves (chain).
    
    // Color update
    if(card.color !== 'black') r.unoColor = card.color;
    else r.unoColor = colorChoice || 'red'; // Wild color set
    
    // Effects
    if(card.type === 'skip') {
        r._skipCount = (r._skipCount || 0) + 1;
    } else if(card.type === 'reverse') {
        if(r.players.length === 2) {
            // reverse in 2-player acts like a skip
            r._skipCount = (r._skipCount || 0) + 1;
        } else {
            r.unoDirection *= -1;
        }
    }
    else if(card.type === 'draw2') r.unoDrawStack += 2;
    else if(card.type === 'draw4') r.unoDrawStack += 4;
    
    // Win
    if(p.unoHand.length === 0) {
        // mark player finished but continue match
        p.finished = true;
        let pool = 0;
        r.players.forEach(pl => { 
            if(pl !== p) { let pen = 200; if(pl.score >= pen) { pl.score -= pen; pool += pen; } else { pool += pl.score; pl.score = 0; } } 
        });
        p.score += pool;
        io.to(room).emit('playerFinished', { username: p.username, reward: pool });
        // if only one active (not finished & not cpu) remains, end match
        const active = r.players.filter(pl => !pl.finished && !pl.isCpu);
        if(active.length <= 1) {
            const winners = r.players.filter(pl => !pl.isCpu).sort((a,b)=>b.score-a.score);
            const w = winners[0] || p;
            io.to(room).emit('gameOver', { winner: w.color, msg: `WINNER: ${w.username}` });
            r.gameActive = false;
            r.players = r.players.filter(pl => !pl.isCpu);
            r.players.forEach(pl => pl.ready = false);
            return;
        }
        // otherwise continue match without removing room
    }
    // reset draw flag when a play happens
    p.hasDrawnThisTurn = false;

    // Win
    if(p.unoHand.length === 0) {
        // mark player finished but continue match
        p.finished = true;
        let pool = 0;
        r.players.forEach(pl => { 
            if(pl !== p) { let pen = 200; if(pl.score >= pen) { pl.score -= pen; pool += pen; } else { pool += pl.score; pl.score = 0; } } 
        });
        p.score += pool;
        io.to(room).emit('playerFinished', { username: p.username, reward: pool });
        const active = r.players.filter(pl => !pl.finished && !pl.isCpu);
        if(active.length <= 1) {
            const winners = r.players.filter(pl => !pl.isCpu).sort((a,b)=>b.score-a.score);
            const w = winners[0] || p;
            io.to(room).emit('gameOver', { winner: w.color, msg: `WINNER: ${w.username}` });
            r.gameActive = false;
            r.players = r.players.filter(pl => !pl.isCpu);
            r.players.forEach(pl => pl.ready = false);
            return;
        }
        // otherwise continue match without removing room
    }

    // If the player still has cards of the same `type` as the just-played card,
    // allow them to continue (do not advance the turn). Emit a targeted event
    // to inform the client that chaining is allowed and which `type` is required.
    try {
        const lastType = card.type;
        const hasSameType = p.unoHand.some(c => String(c.type) === String(lastType));
        if(hasSameType) {
            // Inform only this player that they may continue chaining
            socketEmitToPlayer(p.id, 'chainAllowed', { requiredType: lastType });
            updateUnoState(room);
            // If the current player is a CPU, schedule next CPU action immediately
            checkCpuTurn(room);
            return; // keep turn with this player
        }
    } catch(e) { console.error('chain check error', e); }

    // UNO penalty: if player has 1 card and did NOT press UNO call before ending, force draw 2
    if(p.unoHand.length === 1 && !p.unoCalled) {
        const drawn = drawCards(r, p, 2);
        if(drawn.length>0) io.to(room).emit('cardDrawn', { username: p.username, cards: drawn.map(c=>({ color:c.color, type:c.type })) });
        io.to(room).emit('unoPenalty', { username: p.username });
    }

    advanceUnoTurn(room);
}

// Process multiple cards played at once (cardIds array, colorChoices parallel array)
function processUnoMultiMove(room, playerId, cardIds, colorChoices) {
    const r = rooms[room]; if(!r || !r.gameActive) return;
    const p = r.players[r.unoTurn]; if(p.id !== playerId) return;
    // Validate sequence first (simulate pile and state), do NOT mutate until validated
    const tempPile = r.unoPile.slice();
    let tempColor = r.unoColor;
    let tempDrawStack = r.unoDrawStack;

    function isPlayableSim(card) {
        const top = tempPile[tempPile.length - 1];
        if (tempDrawStack > 0) {
            if (top.type === 'draw2' && card.type === 'draw2') return true;
            if (top.type === 'draw4' && card.type === 'draw4') return true;
            return false;
        }
        if (card.color === 'black') return true;
        if (card.color === tempColor) return true;
        if (card.type === top.type) return true;
        return false;
    }

    // Build list of candidate cards from player's current hand (by id)
    const candidates = [];
    for (let cid of cardIds) {
        const idx = p.unoHand.findIndex(c => String(c.id) === String(cid));
        if (idx === -1) { socketEmitToPlayer(playerId, 'error', '選択したカードが見つかりません'); return; }
        candidates.push({ idx, card: p.unoHand[idx] });
    }

    // Require that the first card in the submitted sequence is playable against the current top.
    const origTop = r.unoPile[r.unoPile.length - 1];
    function isPlayableAgainstOriginal(card) {
        if (r.unoDrawStack > 0) {
            if (origTop.type === 'draw2' && card.type === 'draw2') return true;
            if (origTop.type === 'draw4' && card.type === 'draw4') return true;
            return false;
        }
        if (card.color === 'black') return true;
        if (card.color === r.unoColor) return true;
        if (card.type === origTop.type) return true;
        return false;
    }

    if (candidates.length === 0) return; // nothing to do
    const firstCard = candidates[0].card;
    if (!isPlayableAgainstOriginal(firstCard)) { socketEmitToPlayer(playerId, 'error', '最初のカードが現在の場に対して合法ではありません'); return; }

    // Enforce that bulk-play cards all share the same `type` as the first card
    // (allows multiple same-number across colors, or repeated action cards like multiple skips/reverses)
    const allSameType = candidates.every(c => String(c.card.type) === String(firstCard.type));
    if (!allSameType) { socketEmitToPlayer(playerId, 'error', 'まとめ出しは同じ数字または同じ記号のみ可能です'); return; }

    // Further validate the sequence: each subsequent card must be playable against
    // the previous card in the submitted order (simulate applying them to the pile).
    for (let k = 0; k < candidates.length; k++) {
        const card = candidates[k].card;
        const colorChoice = Array.isArray(colorChoices) ? colorChoices[k] : undefined;
        if (!isPlayableSim(card)) { socketEmitToPlayer(playerId, 'error', `シーケンス内のカードが${k+1}枚目で合法ではありません`); return; }
        // simulate applying the card
        tempPile.push(card);
        if (card.color === 'black') tempColor = colorChoice || tempColor || 'red';
        else tempColor = card.color;
        if (card.type === 'draw2') tempDrawStack += 2;
        else if (card.type === 'draw4') tempDrawStack += 4;
        // note: skip/reverse affect turn but do not affect playability simulation
    }

    // We've validated the first card, type-uniformity and full sequence; allow actual play.

    // prevent symbol finish: if after playing all candidates player's hand would be empty and last card is not numeric, reject
    const wouldRemain = p.unoHand.length - candidates.length;
    if(wouldRemain === 0) {
        const lastCard = candidates[candidates.length-1].card;
        if(!(/^\d+$/.test(lastCard.type))) { socketEmitToPlayer(playerId, 'error', '記号上がりはできません'); return; }
    }

    // All validated; now actually apply the plays in order
    for (let k = 0; k < candidates.length; k++) {
        const cid = cardIds[k];
        const colorChoice = Array.isArray(colorChoices) ? colorChoices[k] : undefined;
        const i = p.unoHand.findIndex(c => String(c.id) === String(cid));
        if (i === -1) continue; // already played earlier in this loop somehow

        const card = p.unoHand.splice(i, 1)[0];
        r.unoPile.push(card);

        // notify clients of the exact card played
        io.to(room).emit('cardPlayed', { username: p.username, card: { color: card.color, type: card.type } });

        if (card.color === 'black') r.unoColor = colorChoice || 'red';
        else r.unoColor = card.color;

        if (card.type === 'skip') {
            r._skipCount = (r._skipCount || 0) + 1;
        } else if (card.type === 'reverse') {
            if(r.players.length===2) r._skipCount = (r._skipCount || 0) + 1; else r.unoDirection *= -1;
        } else if (card.type === 'draw2') r.unoDrawStack += 2;
        else if (card.type === 'draw4') r.unoDrawStack += 4;
    }

    // Win check
    // Win check: mark finished and continue match; only end when <=1 active left
    if (p.unoHand.length === 0) {
        p.finished = true;
        let pool = 0;
        r.players.forEach(pl => { 
            if(pl !== p) { let pen = 200; if(pl.score >= pen) { pl.score -= pen; pool += pen; } else { pool += pl.score; pl.score = 0; } } 
        });
        p.score += pool;
        io.to(room).emit('playerFinished', { username: p.username, reward: pool });
        const active = r.players.filter(pl => !pl.finished && !pl.isCpu);
        if(active.length <= 1) {
            const winners = r.players.filter(pl => !pl.isCpu).sort((a,b)=>b.score-a.score);
            const w = winners[0] || p;
            io.to(room).emit('gameOver', { winner: w.color, msg: `WINNER: ${w.username}` });
            r.gameActive = false;
            r.players = r.players.filter(pl => !pl.isCpu);
            r.players.forEach(pl => pl.ready = false);
            return;
        }
        // otherwise continue
    }

    // reset draw flag when a play happens
    p.hasDrawnThisTurn = false;

    // Advance turn once after batch (advanceUnoTurn handles UNO penalty and skip)
    advanceUnoTurn(room);
}

// helper to emit to socket id safely
function socketEmitToPlayer(socketId, ev, msg) {
    const sock = io.sockets.sockets.get(socketId);
    if(sock) sock.emit(ev, msg);
}

function processUnoDraw(room, playerId) {
    const r = rooms[room]; const p = r.players[r.unoTurn]; if(p.id !== playerId) return;
    if(r.unoDrawStack > 0) {
        const drawn = drawCards(r, p, r.unoDrawStack);
        if(drawn.length>0) io.to(room).emit('cardDrawn', { username: p.username, cards: drawn.map(c=>({ color:c.color, type:c.type })) });
        r.unoDrawStack = 0;
        // drawing from stack counts as action and ends turn
        p.hasDrawnThisTurn = true;
        advanceUnoTurn(room);
        return;
    }

    // Prevent repeated manual draws within the same turn
    if(p.hasDrawnThisTurn) {
        io.to(playerId).emit('error', '既にドローしました');
        return;
    }

    // Normal single draw
    const drawn = drawCards(r, p, 1);
    // check the drawn card; if it cannot be played, end turn immediately
    const drawnCard = drawn && drawn.length? drawn[0] : null;
    if (!drawn) {
        // nothing drawn (deck empty) -> just update and advance
        p.hasDrawnThisTurn = true;
        updateUnoState(room);
        advanceUnoTurn(room);
        return;
    }

    // emit drawn event for animation (clients may show back->hand animation)
    if(drawn.length>0) io.to(room).emit('cardDrawn', { username: p.username, cards: drawn.map(c=>({ color:c.color, type:c.type })) });

    if (drawnCard && canPlayUnoCard(r, drawnCard)) {
        // player may play the drawn card; mark as drawn and update state
        p.hasDrawnThisTurn = true;
        updateUnoState(room);
        if(p.isCpu) setTimeout(() => cpuTryPlayAfterDraw(room, p), 1800);
    } else {
        // cannot play, end turn
        p.hasDrawnThisTurn = true;
        updateUnoState(room);
        advanceUnoTurn(room);
    }
}

function drawCards(r, p, count) {
    const drawn = [];
    for(let i=0; i<count; i++) {
        if(r.unoDeck.length === 0) { const top = r.unoPile.pop(); r.unoDeck = shuffle(r.unoPile); r.unoPile = [top]; }
        if(r.unoDeck.length > 0) {
            const card = r.unoDeck.pop();
            p.unoHand.push(card);
            drawn.push(card);
        }
    }
    return drawn;
}

function advanceUnoTurn(room) {
    const r = rooms[room];
    const prevIdx = r.unoTurn;
    const prevObj = r.players[prevIdx];
    const prevPlayer = prevObj ? prevObj.username : null;

    // Apply UNO penalty for prev player if they had 1 card and didn't call UNO
    try {
        if(prevObj && prevObj.unoHand && prevObj.unoHand.length === 1 && !prevObj.unoCalled) {
            const drawn = drawCards(r, prevObj, 2);
            if(drawn.length>0) io.to(room).emit('cardDrawn', { username: prevObj.username, cards: drawn.map(c=>({ color:c.color, type:c.type })) });
            io.to(room).emit('unoPenalty', { username: prevObj.username });
        }
    } catch(e) { console.error('advanceUnoTurn penalty error', e); }

    // compute next index; respect skip count set by plays
    let nextIdx = getNextTurn(r);
    const skip = r._skipCount || 0;
    for(let i=0;i<skip;i++) nextIdx = (nextIdx + r.unoDirection + r.players.length) % r.players.length;
    r._skipCount = 0;
    const nextPlayer = r.players[nextIdx] ? r.players[nextIdx].username : null;
    r.unoTurn = nextIdx;
    // reset draw flag and UNO-call flag for players
    r.players.forEach(pl => { pl.hasDrawnThisTurn = false; pl.unoCalled = false; });
    // notify clients about turn change so clients can play end-of-turn animation
    io.to(room).emit('turnChange', { prevUsername: prevPlayer, nextUsername: nextPlayer });
    updateUnoState(room); checkCpuTurn(room);
}
function getNextTurn(r) { return (r.unoTurn + r.unoDirection + r.players.length) % r.players.length; }
function checkCpuTurn(room) { const r = rooms[room]; if(!r.gameActive) return; const p = r.players[r.unoTurn]; if(p.isCpu) setTimeout(() => runCpuLogic(room, p), 2400); }

function runCpuLogic(room, p) {
    const r = rooms[room]; if(!r.gameActive) return;
    
    // Choose Color
    const counts = {red:0, blue:0, green:0, yellow:0};
    p.unoHand.forEach(c => { if(c.color!=='black') counts[c.color]++; });
    const fav = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);

    // Find Playable
    let idx = -1;
    // Prefer non-wild first
    idx = p.unoHand.findIndex(c => c.color !== 'black' && canPlayUnoCard(r, c));
    if(idx === -1) idx = p.unoHand.findIndex(c => c.color === 'black' && canPlayUnoCard(r, c));
    
    if(idx !== -1) {
        // If this play would leave the CPU with 1 card, mark unoCalled so it won't be penalized
        try { const candidate = p.unoHand[idx]; if(candidate && (p.unoHand.length - 1) === 1) p.unoCalled = true; } catch(e){}
        setTimeout(() => processUnoMove(room, p.id, idx, fav), 400);
    } else setTimeout(() => processUnoDraw(room, p.id), 400);
}

function cpuTryPlayAfterDraw(room, p) {
    const r = rooms[room]; const card = p.unoHand[p.unoHand.length-1];
    if(canPlayUnoCard(r, card)) {
        // if playing this card will result in 1 card, auto-call UNO
        try { if((p.unoHand.length - 1) === 1) p.unoCalled = true; } catch(e){}
        processUnoMove(room, p.id, p.unoHand.length-1, 'red');
    }
    else advanceUnoTurn(room);
}

function updateUnoState(room) {
    const r = rooms[room];
    r.players.forEach(p => {
        if(p.isCpu) return;
        const pub = r.players.map((pl, i) => ({ 
            username: pl.username, color: pl.color, handCount: pl.unoHand.length, isTurn: i === r.unoTurn, score: pl.score, isCpu: pl.isCpu 
        }));
        io.to(p.id).emit('unoUpdate', { 
            players: pub, myHand: p.unoHand, topCard: r.unoPile[r.unoPile.length-1], 
            currentColor: r.unoColor, drawStack: r.unoDrawStack, isMyTurn: r.players[r.unoTurn].id === p.id 
        });
    });
}

// --- BJ & OVERRIDE (Omitted details for brevity, logic remains same) ---
// (BJ/OV functions same as previous version - verified working)
function handleBjAction(room, pid, action) { const r=rooms[room]; const p=r.players[r.bjTurnIndex]; if(p.id!==pid)return; if(action==='hit'){p.hand.push(r.deck.pop()); if(getBjScore(p.hand)>21){p.status='bust';nextBjTurn(room);}else updateBjState(room);}else{p.status='stand';nextBjTurn(room);} }
function startBjMatch(room) { rooms[room].gameActive=true; rooms[room].currentRound=0; startBjRound(room); }
function startBjRound(room) { const r=rooms[room];r.currentRound++;r.bjPhase='betting';r.deck=createBjDeck();r.dealerHand=[]; r.players.forEach(p=>{p.hand=[];p.currentBet=0;p.status=(p.score<=0?'bankrupt':'playing');}); io.to(room).emit('bjRoundStart',{round:r.currentRound}); }
function dealBjCards(room) { const r=rooms[room];r.bjPhase='playing';r.dealerHand=[r.deck.pop(),r.deck.pop()]; r.players.forEach(p=>{if(p.status!=='bankrupt'){p.hand=[r.deck.pop(),r.deck.pop()];if(getBjScore(p.hand)===21)p.status='blackjack';}}); r.bjTurnIndex=0;updateBjState(room);checkBjSkip(room); }
function checkBjSkip(room){ const r=rooms[room];if(r.bjTurnIndex>=r.players.length)return runBjDealer(room); if(r.players[r.bjTurnIndex].status!=='playing')nextBjTurn(room); }
function nextBjTurn(room){ rooms[room].bjTurnIndex++;checkBjSkip(room);updateBjState(room); }
function runBjDealer(room){ const r=rooms[room];let ds=getBjScore(r.dealerHand); while(ds<17){r.dealerHand.push(r.deck.pop());ds=getBjScore(r.dealerHand);} const dBust=ds>21;const dBj=(ds===21&&r.dealerHand.length===2); r.players.forEach(p=>{if(p.status==='bankrupt')return; let ps=getBjScore(p.hand),m=0; if(p.status==='bust')m=0;else if(p.status==='blackjack')m=dBj?1:2.5;else if(dBust||ps>ds)m=2;else if(ps===ds)m=1; p.score+=Math.floor(p.currentBet*m); p.result=m===0?'LOSE':m===1?'PUSH':'WIN';}); io.to(room).emit('bjRoundOver',{dealerCards:r.dealerHand,players:r.players}); if(r.currentRound>=7)endMatch(room);else setTimeout(()=>startBjRound(room),5000); }
function updateBjState(room){ const r=rooms[room];const vd=(r.bjTurnIndex>=r.players.length)?r.dealerHand:[r.dealerHand[0],{suit:'?',rank:'?',val:0}]; io.to(room).emit('bjUpdate',{players:r.players,dealerHand:vd,turnIndex:r.bjTurnIndex,phase:r.bjPhase}); }
function handleOvAction(room,pid,c){ const r=rooms[room];const p=r.players.find(pl=>pl.id===pid); if(p&&p.status==='playing'){p.hand=[{choice:c}];p.status='locked';} io.to(room).emit('ovUpdate',{players:r.players,dealerCard:r.ovDealerCard,phase:'playing'}); if(r.players.filter(pl=>pl.currentBet>0).every(pl=>pl.status==='locked'))resolveOvTurn(room); }
function startOvMatch(room){ rooms[room].gameActive=true;rooms[room].currentRound=0;startOvRound(room); }
function startOvRound(room){ const r=rooms[room];r.currentRound++;r.ovPhase='betting';r.ovDeck=createBjDeck(); r.players.forEach(p=>{p.hand=[];p.currentBet=0;p.status=(p.score<=0?'bankrupt':'playing');}); io.to(room).emit('ovRoundStart',{round:r.currentRound}); }
function startOvTurn(room){ const r=rooms[room];r.ovPhase='playing';r.ovDealerCard=r.ovDeck.pop(); io.to(room).emit('ovUpdate',{players:r.players,dealerCard:r.ovDealerCard,phase:'playing'}); }
function resolveOvTurn(room){ const r=rooms[room];const next=r.ovDeck.pop();const base=r.ovDealerCard.power; r.players.forEach(p=>{if(p.status==='bankrupt'||p.currentBet===0)return;const c=p.hand[0].choice;let m=0;if(next.power===base)m=1;else if((c==='high'&&next.power>base)||(c==='low'&&next.power<base))m=2; p.score+=Math.floor(p.currentBet*m); p.result=m===0?'LOSE':m===1?'PUSH':'WIN';}); io.to(room).emit('ovRoundOver',{dealerCards:[r.ovDealerCard,next],players:r.players}); if(r.currentRound>=7)endMatch(room);else setTimeout(()=>startOvRound(room),5000); }
function endMatch(room){ const r=rooms[room];r.gameActive=false;let w=r.players.reduce((p,c)=>(p.score>c.score)?p:c); io.to(room).emit('gameOver',{winner:w.color,msg:`WINNER:${w.username}`}); r.players.forEach(p=>p.ready=false); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));