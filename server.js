const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

let rooms = {};
const C4_ROWS = 6;
const C4_COLS = 7;
const INIT_POINTS = 30;

// --- CARD HELPERS ---
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

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

io.on('connection', (socket) => {
    
    // --- CHAT SYSTEM ---
    // ロビーチャット
    socket.on('lobbyMsg', (d) => io.emit('lobbyMsg', d));
    // ルームチャット
    socket.on('roomMsg', (d) => { 
        if(rooms[d.room]) io.to(d.room).emit('roomMsg', d); 
    });

    // --- JOIN ROOM ---
    socket.on('joinRoom', ({ username, room, gameType }) => {
        if (!rooms[room]) {
            rooms[room] = {
                gameType: gameType,
                players: [],
                board: null,
                turn: null,
                gameActive: false,
                // BJ State
                deck: [],
                dealerHand: [],
                bjTurnIndex: 0,
                bjPhase: 'lobby',
                maxRounds: 5,
                currentRound: 0
            };
        }
        const r = rooms[room];
        const limit = (r.gameType === 'blackjack') ? 4 : 2;
        if (r.players.length >= limit) { socket.emit('error', 'ROOM FULL'); return; }
        
        const actualGameType = r.players.length === 0 ? gameType : r.gameType;
        r.gameType = actualGameType;

        const colors = ['#ff0055', '#00eaff', '#00ff41', '#ffff00'];
        const newPlayer = { 
            id: socket.id, username, color: colors[r.players.length],
            ready: false, score: INIT_POINTS, currentBet: 0, hand: [], status: 'playing', result: ''
        };
        r.players.push(newPlayer);
        socket.join(room);
        socket.emit('joined', { color: newPlayer.color, gameType: actualGameType, mySeat: r.players.length - 1 });
        io.to(room).emit('roomUpdate', { players: r.players, gameType: actualGameType });

        // Board games auto-start
        if (actualGameType !== 'blackjack' && r.players.length === 2) startGame(room);
    });

    // --- BJ LOGIC ---
    socket.on('bjVoteStart', ({ room, rounds }) => {
        const r = rooms[room];
        if(!r || r.gameType !== 'blackjack' || r.gameActive) return;
        const p = r.players.find(pl => pl.id === socket.id);
        if(p) {
            p.ready = !p.ready;
            if(r.players.indexOf(p) === 0 && rounds) r.maxRounds = parseInt(rounds);
            io.to(room).emit('roomUpdate', { players: r.players, gameType: 'blackjack', maxRounds: r.maxRounds });
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
            p.currentBet = bet;
            p.score -= bet;
            io.to(room).emit('bjBetUpdate', { seatIndex: r.players.indexOf(p), bet: p.currentBet, score: p.score });
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

    // --- BOARD GAMES ---
    socket.on('othelloMove', ({ room, x, y, color }) => {
        const r = rooms[room];
        if (!r || !r.gameActive || r.turn !== color) return;
        const flipped = getOthelloFlips(r.board, x, y, color);
        if (flipped.length === 0) return;
        r.board[y][x] = color;
        flipped.forEach(p => r.board[p.y][p.x] = color);
        io.to(room).emit('othelloUpdate', { board: r.board });
        
        const opp = color === 'black' ? 'white' : 'black';
        if(canMove(r.board, opp)) { r.turn = opp; io.to(room).emit('changeTurn', opp); }
        else if(canMove(r.board, color)) { io.to(room).emit('passMessage', `${opp.toUpperCase()} PASS!`); io.to(room).emit('changeTurn', color); }
        else {
            const s = calcScore(r.board);
            let w = s.black > s.white ? 'black' : (s.white > s.black ? 'white' : 'draw');
            io.to(room).emit('gameOver', { winner: w, msg: `FINISH! B:${s.black}/W:${s.white}` });
            r.gameActive = false; scheduleRoomDestruction(room);
        }
    });

    socket.on('connect4Move', ({ room, col }) => {
        const r = rooms[room];
        if (!r || !r.gameActive) return;
        const p = r.players.find(pl => pl.id === socket.id);
        if (!p || p.color !== r.turn) return;
        let tr = -1;
        for(let row=C4_ROWS-1; row>=0; row--) { if(r.board[row][col]===null){ tr=row; break; } }
        if(tr === -1) return;
        r.board[tr][col] = p.color;
        io.to(room).emit('connect4Update', { row: tr, col, color: p.color });
        if(checkConnect4Win(r.board, p.color)) {
            io.to(room).emit('gameOver', { winner: p.color, msg: `${p.color.toUpperCase()} WINS!` });
            r.gameActive = false; scheduleRoomDestruction(room);
        } else if(r.board[0].every(c=>c!==null)) {
            io.to(room).emit('gameOver', { winner: 'draw', msg: 'DRAW' });
            r.gameActive = false; scheduleRoomDestruction(room);
        } else {
            r.turn = r.turn === 'red' ? 'cyan' : 'red';
            io.to(room).emit('changeTurn', r.turn);
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
            if(dBj) { p.result = 'PUSH(BJ)'; mult = 1; } else { p.result = 'BLACKJACK!'; mult = 2.5; }
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
    scheduleRoomDestruction(room);
}
function updateBjState(room) {
    const r = rooms[room];
    const visibleDealer = (r.bjTurnIndex >= r.players.length) ? r.dealerHand : [r.dealerHand[0], {suit:'?',rank:'?',val:0}];
    io.to(room).emit('bjUpdate', { players: r.players, dealerHand: visibleDealer, turnIndex: r.bjTurnIndex, phase: r.bjPhase });
}

// --- HELPERS ---
function startGame(room) {
    const r = rooms[room];
    r.gameActive = true;
    if (r.gameType === 'othello') {
        r.turn = 'black'; r.board = Array(8).fill(null).map(() => Array(8).fill(null));
        r.board[3][3] = 'white'; r.board[4][4] = 'white'; r.board[3][4] = 'black'; r.board[4][3] = 'black';
        io.to(room).emit('gameStart', { p1: r.players[0].username, p2: r.players[1].username, gameType: 'othello', turn: 'black', board: r.board });
    } else {
        r.turn = 'red'; r.board = Array(C4_ROWS).fill(null).map(() => Array(C4_COLS).fill(null));
        io.to(room).emit('gameStart', { p1: r.players[0].username, p2: r.players[1].username, gameType: 'connect4', turn: 'red' });
    }
}
function scheduleRoomDestruction(room) { setTimeout(() => { if (rooms[room]) { io.to(room).emit('forceReset'); delete rooms[room]; } }, 15000); }
function getOthelloFlips(b,x,y,c){if(b[y][x])return[];const d=[[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];let f=[];const o=c==='black'?'white':'black';d.forEach(r=>{let t=[],cx=x+r[0],cy=y+r[1];while(cx>=0&&cx<8&&cy>=0&&cy<8){if(b[cy][cx]===o)t.push({x:cx,y:cy});else if(b[cy][cx]===c){f=f.concat(t);break}else break;cx+=r[0];cy+=r[1]}});return f}
function canMove(b,c){for(let y=0;y<8;y++)for(let x=0;x<8;x++)if(getOthelloFlips(b,x,y,c).length>0)return true;return false}
function calcScore(b){let k=0,w=0;b.forEach(r=>r.forEach(c=>{if(c==='black')k++;if(c==='white')w++}));return{black:k,white:w}}
function checkConnect4Win(b,c){const d=[[0,1],[1,0],[1,1],[1,-1]];for(let r=0;r<C4_ROWS;r++)for(let l=0;l<C4_COLS;l++){if(b[r][l]!==c)continue;for(let[dr,dc]of d){let k=1;for(let i=1;i<4;i++){let nr=r+dr*i,nc=l+dc*i;if(nr>=0&&nr<C4_ROWS&&nc>=0&&nc<C4_COLS&&b[nr][nc]===c)k++;else break}if(k>=4)return true}}return false}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));