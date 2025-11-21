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

// --- BJ CONFIG ---
const INIT_POINTS = 30;
const BET_OPTS = { low: 2, mid: 5, high: 10 };

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
    // Chat & Join Logic (Keep mostly same)
    socket.on('lobbyMsg', (d) => io.emit('lobbyMsg', d));
    socket.on('roomMsg', (d) => { if(rooms[d.room]) io.to(d.room).emit('roomMsg', d); });

    socket.on('joinRoom', ({ username, room, gameType }) => {
        if (!rooms[room]) {
            rooms[room] = {
                gameType: gameType,
                players: [],
                board: null,
                turn: null,
                gameActive: false,
                // BJ Specifics
                deck: [],
                dealerHand: [],
                bjTurnIndex: 0,
                bjPhase: 'lobby', // lobby, betting, playing, finished
                maxRounds: 5,
                currentRound: 0
            };
        }
        const r = rooms[room];
        const limit = (r.gameType === 'blackjack') ? 4 : 2;
        if (r.players.length >= limit) { socket.emit('error', 'ROOM FULL'); return; }
        
        // Game type sync
        const actualGameType = r.players.length === 0 ? gameType : r.gameType;
        r.gameType = actualGameType;

        const colors = ['#ff0055', '#00eaff', '#00ff41', '#ffff00'];
        const newPlayer = { 
            id: socket.id, username, color: colors[r.players.length],
            ready: false, 
            score: INIT_POINTS, 
            currentBet: 0,
            hand: [], 
            status: 'playing', // playing, stand, bust, blackjack, bankrupt
            result: ''
        };
        r.players.push(newPlayer);
        socket.join(room);
        socket.emit('joined', { color: newPlayer.color, gameType: actualGameType, mySeat: r.players.length - 1 });
        io.to(room).emit('roomUpdate', { players: r.players, gameType: actualGameType });

        if (actualGameType !== 'blackjack' && r.players.length === 2) startGame(room);
    });

    // --- BJ: SETTINGS & START ---
    socket.on('bjVoteStart', ({ room, rounds }) => {
        const r = rooms[room];
        if(!r || r.gameType !== 'blackjack' || r.gameActive) return;
        const p = r.players.find(pl => pl.id === socket.id);
        if(p) {
            p.ready = !p.ready;
            // Host (Seat 0) sets the rounds
            if(r.players.indexOf(p) === 0 && rounds) r.maxRounds = parseInt(rounds);

            io.to(room).emit('roomUpdate', { players: r.players, gameType: 'blackjack', maxRounds: r.maxRounds });

            if(r.players.length > 0 && r.players.every(pl => pl.ready)) {
                startBjMatch(room);
            }
        }
    });

    // --- BJ: BETTING ---
    socket.on('bjBet', ({ room, amount }) => {
        const r = rooms[room];
        if(!r || r.bjPhase !== 'betting') return;
        const p = r.players.find(pl => pl.id === socket.id);
        
        if(p && p.currentBet === 0) {
            // Check if player has enough points
            let bet = parseInt(amount);
            if(p.score < bet) bet = p.score; // All in if low funds
            
            p.currentBet = bet;
            p.score -= bet; // Deduct immediately (casino style)
            
            io.to(room).emit('bjBetUpdate', { seatIndex: r.players.indexOf(p), bet: p.currentBet, score: p.score });

            // Check if everyone bet or is bankrupt
            const activePlayers = r.players.filter(pl => pl.status !== 'bankrupt');
            if(activePlayers.every(pl => pl.currentBet > 0)) {
                dealBjCards(room);
            }
        }
    });

    // --- BJ: ACTION ---
    socket.on('bjAction', ({ room, action }) => {
        const r = rooms[room];
        if(!r || r.bjPhase !== 'playing') return;
        const p = r.players[r.bjTurnIndex];
        if(p.id !== socket.id) return;

        if(action === 'hit') {
            const card = r.deck.pop();
            p.hand.push(card);
            const score = getHandScore(p.hand);
            if(score > 21) {
                p.status = 'bust';
                nextBjTurn(room);
            } else {
                updateBjState(room); // Update UI but stay on turn
            }
        } else { // Stand
            p.status = 'stand';
            nextBjTurn(room);
        }
    });

    // Existing Othello/C4 logic (Shortened for brevity)
    socket.on('othelloMove', (d) => handleOthello(d, io, rooms));
    socket.on('connect4Move', (d) => handleC4(d, io, rooms));
});

// --- BJ LOGIC FLOW ---

function startBjMatch(room) {
    const r = rooms[room];
    r.gameActive = true;
    r.currentRound = 0;
    // Reset scores
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
        p.hand = [];
        p.currentBet = 0;
        p.result = '';
        if(p.score <= 0) p.status = 'bankrupt';
        else p.status = 'playing';
    });

    if(r.players.every(p => p.status === 'bankrupt')) {
        endBjMatch(room, "ALL PLAYERS BANKRUPT");
        return;
    }

    io.to(room).emit('bjRoundStart', { 
        round: r.currentRound, 
        maxRounds: r.maxRounds,
        players: r.players
    });
}

function dealBjCards(room) {
    const r = rooms[room];
    r.bjPhase = 'playing';
    
    // Deal 2 cards each
    r.dealerHand = [r.deck.pop(), r.deck.pop()];
    r.players.forEach(p => {
        if(p.status !== 'bankrupt') {
            p.hand = [r.deck.pop(), r.deck.pop()];
            if(getHandScore(p.hand) === 21) p.status = 'blackjack';
        }
    });

    r.bjTurnIndex = 0;
    updateBjState(room);
    
    // Skip bankrupt/blackjack players
    checkSkipTurn(room);
}

function checkSkipTurn(room) {
    const r = rooms[room];
    if(r.bjTurnIndex >= r.players.length) {
        runDealerTurn(room);
        return;
    }
    const p = r.players[r.bjTurnIndex];
    if(p.status === 'bankrupt' || p.status === 'blackjack') {
        nextBjTurn(room);
    }
}

function nextBjTurn(room) {
    const r = rooms[room];
    r.bjTurnIndex++;
    if(r.bjTurnIndex >= r.players.length) {
        runDealerTurn(room);
    } else {
        checkSkipTurn(room);
    }
    updateBjState(room);
}

function runDealerTurn(room) {
    const r = rooms[room];
    let dScore = getHandScore(r.dealerHand);
    while(dScore < 17) {
        r.dealerHand.push(r.deck.pop());
        dScore = getHandScore(r.dealerHand);
    }

    // Calculate Payouts
    const dealerBust = dScore > 21;
    const dealerBj = (dScore === 21 && r.dealerHand.length === 2);

    r.players.forEach(p => {
        if(p.status === 'bankrupt') return;

        const pScore = getHandScore(p.hand);
        let winMult = 0; // 0 = lost bet, 1 = push (return bet), 2 = win, 2.5 = bj

        if(p.status === 'bust') {
            p.result = 'BUST';
            winMult = 0;
        } else if (p.status === 'blackjack') {
            if(dealerBj) { p.result = 'PUSH (BJ)'; winMult = 1; }
            else { p.result = 'BLACKJACK!'; winMult = 2.5; }
        } else if (dealerBust) {
            p.result = 'WIN'; winMult = 2;
        } else if (pScore > dScore) {
            p.result = 'WIN'; winMult = 2;
        } else if (pScore === dScore) {
            p.result = 'PUSH'; winMult = 1;
        } else {
            p.result = 'LOSE'; winMult = 0;
        }

        if(winMult > 0) {
            // Return bet * multiplier (Floored)
            p.score += Math.floor(p.currentBet * winMult);
        }
    });

    io.to(room).emit('bjRoundOver', { 
        dealerHand: r.dealerHand, 
        players: r.players,
        isMatchOver: r.currentRound >= r.maxRounds
    });

    if(r.currentRound >= r.maxRounds) {
        endBjMatch(room, "MATCH COMPLETE");
    } else {
        setTimeout(() => startBjRound(room), 5000); // 5 sec delay next round
    }
}

function endBjMatch(room, msg) {
    const r = rooms[room];
    r.gameActive = false;
    // Find winner
    let winner = r.players.reduce((prev, curr) => (prev.score > curr.score) ? prev : curr);
    io.to(room).emit('gameOver', { 
        winner: winner.color, 
        msg: `${msg} - WINNER: ${winner.username} (${winner.score} PTS)` 
    });
    setTimeout(() => { if(rooms[room]) { io.to(room).emit('forceReset'); delete rooms[room]; } }, 15000);
}

function updateBjState(room) {
    const r = rooms[room];
    // Hide dealer 2nd card during play
    const visibleDealer = (r.bjTurnIndex >= r.players.length) 
        ? r.dealerHand 
        : [r.dealerHand[0], { suit: '?', rank: '?', val: 0 }];

    io.to(room).emit('bjUpdate', {
        players: r.players,
        dealerHand: visibleDealer,
        turnIndex: r.bjTurnIndex,
        phase: r.bjPhase
    });
}

// --- EXISTING HANDLERS (Stubbed for size, use previous logic) ---
function handleOthello(d, io, rooms) { /* ...Previous Logic... */ }
function handleC4(d, io, rooms) { /* ...Previous Logic... */ }
// NOTE: You should paste the Othello/C4 logic from the previous response here for full functionality.

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));