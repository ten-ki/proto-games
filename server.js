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
let globalChatLogs = [];
const LOG_RETENTION = 3600000;
const INITIAL_WEALTH = 3000;
const RELIEF_THRESHOLD = 100;
const RELIEF_AMOUNT = 1000;

setInterval(() => {
    const cut = Date.now() - LOG_RETENTION;
    globalChatLogs = globalChatLogs.filter(l => l.timestamp > cut);
}, 60000);

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

    // Chat
    socket.on('sendChat', (d) => {
        const msg = { id:Date.now(), timestamp:Date.now(), username:d.username||'GUEST', text:d.text, color:d.color, type:d.type };
        if(d.type==='global') { globalChatLogs.push(msg); io.emit('chatMsg', msg); }
        else if(d.type==='room' && rooms[d.room]) { io.to(d.room).emit('chatMsg', msg); }
    });

    // Join
    socket.on('joinRoom', ({ username, room, gameType, buyInAmount }) => {
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
        
        // Remove ghost
        const dupIdx = r.players.findIndex(p => p.username === username);
        if(dupIdx !== -1) r.players.splice(dupIdx, 1);

        if(r.players.length >= 6) return socket.emit('error', 'ROOM FULL');

        // DB
        if(!userDB[username]) userDB[username] = { totalWealth: INITIAL_WEALTH, cumulativeScore: 0 };
        let relief = false;
        if(userDB[username].totalWealth < RELIEF_THRESHOLD) { userDB[username].totalWealth = RELIEF_AMOUNT; relief = true; }

        let fee = parseInt(buyInAmount); if(isNaN(fee)||fee<100) fee=100;
        if(userDB[username].totalWealth < fee) return socket.emit('error', '資金不足です');
        userDB[username].totalWealth -= fee;

        const colors = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#FFFFFF', '#FF9FF3', '#54A0FF'];
        r.players.push({
            id: socket.id, username, color: colors[r.players.length % colors.length],
            isCpu: false, ready: false, score: fee, initialScore: fee, currentBet: 0, 
            hand: [], status: 'playing', result: '', unoHand: []
        });
        
        socket.join(room);
        const me = r.players.find(pl=>pl.id===socket.id);
        socket.emit('joined', { color: me.color, mySeat: r.players.indexOf(me), wealth: userDB[username].totalWealth, relief });
        io.to(room).emit('roomUpdate', { players: r.players, gameType: r.gameType, maxRounds: r.maxRounds });
        io.emit('rankingUpdate', getRankingData());
    });

    socket.on('disconnect', () => handleLeave(socket));
    function handleLeave(sock) {
        for(let rid in rooms) {
            const r = rooms[rid];
            const idx = r.players.findIndex(p=>p.id===sock.id);
            if(idx!==-1) {
                const p = r.players[idx];
                if(!p.isCpu && userDB[p.username]) {
                    userDB[p.username].totalWealth += p.score;
                    userDB[p.username].cumulativeScore += (p.score - p.initialScore);
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
    socket.on('unoDraw', ({ room }) => processUnoDraw(room, socket.id));
});

function getRankingData() { return Object.keys(userDB).map(k => ({ name: k, wealth: userDB[k].totalWealth, score: userDB[k].cumulativeScore })).sort((a, b) => b.score - a.score).slice(0, 10); }
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
    
    // Play
    p.unoHand.splice(cardIndex, 1);
    r.unoPile.push(card);

    // If a number card was played, allow playing all other cards with the same number/type at once
    if (/^\d+$/.test(card.type)) {
        // iterate and remove any matching-number cards from hand and push to pile
        let i = 0;
        while (i < p.unoHand.length) {
            if (p.unoHand[i].type === card.type) {
                const extra = p.unoHand.splice(i, 1)[0];
                r.unoPile.push(extra);
            } else {
                i++;
            }
        }
    }
    
    // Color update
    if(card.color !== 'black') r.unoColor = card.color;
    else r.unoColor = colorChoice || 'red'; // Wild color set
    
    // Effects
    if(card.type === 'skip') r.unoTurn = getNextTurn(r);
    else if(card.type === 'reverse') { if(r.players.length===2) r.unoTurn = getNextTurn(r); else r.unoDirection *= -1; }
    else if(card.type === 'draw2') r.unoDrawStack += 2;
    else if(card.type === 'draw4') r.unoDrawStack += 4;
    
    // Win
    if(p.unoHand.length === 0) {
        let pool = 0;
        r.players.forEach(pl => { 
            if(pl !== p) { let pen = 200; if(pl.score >= pen) { pl.score -= pen; pool += pen; } else { pool += pl.score; pl.score = 0; } } 
        });
        p.score += pool;
        io.to(room).emit('gameOver', { winner: p.color, msg: `WINNER: ${p.username} (+${pool})` });
        r.gameActive = false;
        r.players = r.players.filter(pl => !pl.isCpu);
        r.players.forEach(pl => pl.ready = false);
        return;
    }
    
    advanceUnoTurn(room);
}

function processUnoDraw(room, playerId) {
    const r = rooms[room]; const p = r.players[r.unoTurn]; if(p.id !== playerId) return;
    if(r.unoDrawStack > 0) { drawCards(r, p, r.unoDrawStack); r.unoDrawStack = 0; advanceUnoTurn(room); }
    else { drawCards(r, p, 1); updateUnoState(room); if(p.isCpu) setTimeout(() => cpuTryPlayAfterDraw(room, p), 1000); }
}

function drawCards(r, p, count) {
    for(let i=0; i<count; i++) {
        if(r.unoDeck.length === 0) { const top = r.unoPile.pop(); r.unoDeck = shuffle(r.unoPile); r.unoPile = [top]; }
        if(r.unoDeck.length > 0) p.unoHand.push(r.unoDeck.pop());
    }
}

function advanceUnoTurn(room) { const r = rooms[room]; r.unoTurn = getNextTurn(r); updateUnoState(room); checkCpuTurn(room); }
function getNextTurn(r) { return (r.unoTurn + r.unoDirection + r.players.length) % r.players.length; }
function checkCpuTurn(room) { const r = rooms[room]; if(!r.gameActive) return; const p = r.players[r.unoTurn]; if(p.isCpu) setTimeout(() => runCpuLogic(room, p), 1500); }

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
    
    if(idx !== -1) processUnoMove(room, p.id, idx, fav);
    else processUnoDraw(room, p.id);
}

function cpuTryPlayAfterDraw(room, p) {
    const r = rooms[room]; const card = p.unoHand[p.unoHand.length-1];
    if(canPlayUnoCard(r, card)) processUnoMove(room, p.id, p.unoHand.length-1, 'red');
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