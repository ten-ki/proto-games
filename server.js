const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// --- DATA STORAGE ---
let rooms = {};
let globalChatLogs = []; // グローバルチャットの履歴
const LOG_RETENTION_MS = 60 * 60 * 1000; // 1時間

// --- BJ CONSTANTS ---
const INIT_POINTS = 30;
const FIXED_ROUNDS = 7;
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

// --- HELPERS ---
function createDeck() {
    let deck = [];
    for(let s of SUITS) {
        for(let r of RANKS) {
            let val = parseInt(r);
            if(['J','Q','K'].includes(r)) val = 10;
            if(r === 'A') val = 11;
            deck.push({ suit: s, rank: r, val: val });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function getHandScore(hand) {
    let score = 0, aces = 0;
    for(let c of hand) {
        score += c.val;
        if(c.rank === 'A') aces++;
    }
    while(score > 21 && aces > 0) { score -= 10; aces--; }
    return score;
}

// 1時間以上前のログを削除する定期処理 (1分ごとに実行)
setInterval(() => {
    const cutoff = Date.now() - LOG_RETENTION_MS;
    
    // Global logs clean
    globalChatLogs = globalChatLogs.filter(log => log.timestamp > cutoff);

    // Room logs clean
    for(let roomId in rooms) {
        if(rooms[roomId].chatLogs) {
            rooms[roomId].chatLogs = rooms[roomId].chatLogs.filter(log => log.timestamp > cutoff);
        }
    }
}, 60000);

io.on('connection', (socket) => {
    
    // 接続時にグローバルチャット履歴を送信
    socket.emit('chatHistory', { type: 'global', logs: globalChatLogs });

    // --- CHAT SYSTEM ---
    socket.on('sendChat', ({ type, room, username, text, color }) => {
        const msgObj = {
            id: Date.now() + Math.random(),
            timestamp: Date.now(),
            username: username || 'ANONYMOUS',
            text: text,
            color: color || '#fff',
            type: type // 'global' or 'room'
        };

        if (type === 'global') {
            globalChatLogs.push(msgObj);
            io.emit('chatMsg', msgObj);
        } else if (type === 'room' && rooms[room]) {
            rooms[room].chatLogs.push(msgObj);
            io.to(room).emit('chatMsg', msgObj);
        }
    });

    // --- JOIN ROOM ---
    socket.on('joinRoom', ({ username, room }) => {
        if (!rooms[room]) {
            rooms[room] = {
                players: [],
                gameActive: false,
                // BJ State
                deck: [], dealerHand: [], bjTurnIndex: 0, bjPhase: 'lobby',
                maxRounds: FIXED_ROUNDS, currentRound: 0,
                // Room Chat History
                chatLogs: []
            };
        }
        const r = rooms[room];
        
        // 多重参加防止
        const existing = r.players.find(p => p.id === socket.id);
        if (!existing && r.players.length >= 4) {
            socket.emit('error', 'ROOM FULL');
            return;
        }

        const colors = ['#ff0055', '#00eaff', '#00ff41', '#ffff00'];
        
        if (!existing) {
            const newPlayer = { 
                id: socket.id, username, color: colors[r.players.length],
                ready: false, score: INIT_POINTS, currentBet: 0, hand: [], status: 'playing', result: ''
            };
            r.players.push(newPlayer);
        }
        
        socket.join(room);
        
        const me = r.players.find(p => p.id === socket.id);
        
        // クライアントへ初期情報を送信
        socket.emit('joined', { color: me.color, mySeat: r.players.indexOf(me) });
        
        // ルームチャット履歴を送信
        socket.emit('chatHistory', { type: 'room', logs: r.chatLogs });

        // ルーム更新通知
        io.to(room).emit('roomUpdate', { players: r.players, maxRounds: FIXED_ROUNDS });
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const r = rooms[roomId];
            const idx = r.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                r.players.splice(idx, 1);
                if (r.players.length === 0) {
                    delete rooms[roomId]; // 空になったら部屋削除
                } else {
                    io.to(roomId).emit('roomUpdate', { players: r.players, maxRounds: FIXED_ROUNDS });
                }
                break;
            }
        }
    });

    // --- BJ LOGIC ---
    socket.on('bjToggleReady', ({ room }) => {
        const r = rooms[room];
        if(!r || r.gameActive) return;
        const p = r.players.find(pl => pl.id === socket.id);
        if(p) {
            p.ready = !p.ready;
            io.to(room).emit('roomUpdate', { players: r.players, maxRounds: FIXED_ROUNDS });
            if(r.players.length > 0 && r.players.every(pl => pl.ready)) startBjMatch(room);
        }
    });

    socket.on('bjBet', ({ room, amount }) => {
        const r = rooms[room];
        if(!r || r.bjPhase !== 'betting') return;
        const p = r.players.find(pl => pl.id === socket.id);
        if(p && p.currentBet === 0) {
            let bet = parseInt(amount);
            if(p.score < bet) bet = p.score; 
            p.currentBet = bet; p.score -= bet;
            io.to(room).emit('roomUpdate', { players: r.players, maxRounds: FIXED_ROUNDS }); // Update scores
            
            const active = r.players.filter(pl => pl.status !== 'bankrupt');
            if(active.every(pl => pl.currentBet > 0)) dealBjCards(room);
        }
    });

    socket.on('bjAction', ({ room, action }) => {
        const r = rooms[room];
        if(!r || r.bjPhase !== 'playing') return;
        const p = r.players[r.bjTurnIndex];
        if(p.id !== socket.id) return;

        if(action === 'hit') {
            p.hand.push(r.deck.pop());
            if(getHandScore(p.hand) > 21) { p.status = 'bust'; nextBjTurn(room); }
            else updateBjState(room);
        } else {
            p.status = 'stand'; nextBjTurn(room);
        }
    });
});

// --- BJ FLOW ---
function startBjMatch(room) {
    const r = rooms[room];
    r.gameActive = true; r.currentRound = 0;
    r.players.forEach(p => { p.score = INIT_POINTS; p.status = 'playing'; });
    startBjRound(room);
}
function startBjRound(room) {
    const r = rooms[room];
    r.currentRound++;
    r.bjPhase = 'betting';
    r.deck = createDeck();
    r.dealerHand = [];
    r.players.forEach(p => {
        p.hand = []; p.currentBet = 0; p.result = '';
        p.status = (p.score <= 0) ? 'bankrupt' : 'playing';
    });
    if(r.players.every(p => p.status === 'bankrupt')) return endBjMatch(room, "ALL BANKRUPT");
    io.to(room).emit('bjRoundStart', { round: r.currentRound, maxRounds: r.maxRounds });
}
function dealBjCards(room) {
    const r = rooms[room];
    r.bjPhase = 'playing';
    r.dealerHand = [r.deck.pop(), r.deck.pop()];
    r.players.forEach(p => {
        if(p.status !== 'bankrupt') {
            p.hand = [r.deck.pop(), r.deck.pop()];
            if(getHandScore(p.hand) === 21) p.status = 'blackjack';
        }
    });
    r.bjTurnIndex = 0;
    updateBjState(room);
    checkSkipTurn(room);
}
function checkSkipTurn(room) {
    const r = rooms[room];
    if(r.bjTurnIndex >= r.players.length) return runDealerTurn(room);
    const p = r.players[r.bjTurnIndex];
    if(p.status === 'bankrupt' || p.status === 'blackjack') nextBjTurn(room);
}
function nextBjTurn(room) {
    const r = rooms[room];
    r.bjTurnIndex++;
    if(r.bjTurnIndex >= r.players.length) runDealerTurn(room);
    else checkSkipTurn(room);
    updateBjState(room);
}
function runDealerTurn(room) {
    const r = rooms[room];
    let dScore = getHandScore(r.dealerHand);
    while(dScore < 17) { r.dealerHand.push(r.deck.pop()); dScore = getHandScore(r.dealerHand); }
    const dBust = dScore > 21;
    const dBj = (dScore === 21 && r.dealerHand.length === 2);
    r.players.forEach(p => {
        if(p.status === 'bankrupt') return;
        const pScore = getHandScore(p.hand);
        let mult = 0;
        if(p.status === 'bust') { p.result = 'BUST'; mult = 0; }
        else if(p.status === 'blackjack') { 
            if(dBj) { p.result = 'PUSH (BJ)'; mult = 1; } else { p.result = 'BLACKJACK!'; mult = 2.5; }
        }
        else if(dBust || pScore > dScore) { p.result = 'WIN'; mult = 2; }
        else if(pScore === dScore) { p.result = 'PUSH'; mult = 1; }
        else { p.result = 'LOSE'; mult = 0; }
        p.score += Math.floor(p.currentBet * mult);
    });
    io.to(room).emit('bjRoundOver', { dealerHand: r.dealerHand, players: r.players, isMatchOver: r.currentRound >= r.maxRounds });
    if(r.currentRound >= r.maxRounds) endBjMatch(room, "MATCH COMPLETE");
    else setTimeout(() => startBjRound(room), 5000);
}
function endBjMatch(room, msg) {
    const r = rooms[room];
    r.gameActive = false;
    let winner = r.players.reduce((p, c) => (p.score > c.score) ? p : c);
    io.to(room).emit('gameOver', { winner: winner.color, msg: `${msg} - WINNER: ${winner.username}` });
    setTimeout(() => { if (rooms[room]) { io.to(room).emit('forceReset'); delete rooms[room]; } }, 15000);
}
function updateBjState(room) {
    const r = rooms[room];
    const visibleDealer = (r.bjTurnIndex >= r.players.length) ? r.dealerHand : [r.dealerHand[0], {suit:'?',rank:'?',val:0}];
    io.to(room).emit('bjUpdate', { players: r.players, dealerHand: visibleDealer, turnIndex: r.bjTurnIndex, phase: r.bjPhase });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));