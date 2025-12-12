const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// --- DATABASE (MEMORY) ---
let userDB = {}; 
let rooms = {};
let globalChatLogs = [];
const LOG_RETENTION = 3600000;
const INITIAL_WEALTH = 3000;
const RELIEF_THRESHOLD = 100;
const RELIEF_AMOUNT = 1000;

// --- COMMON CONFIG ---
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
            deck.push({ color: c, type: v, id: Math.random() });
            if(v !== '0') deck.push({ color: c, type: v, id: Math.random() });
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

    socket.on('sendChat', (d) => {
        const msg = { id:Date.now(), timestamp:Date.now(), username:d.username||'GUEST', text:d.text, color:d.color, type:d.type };
        if(d.type==='global') { globalChatLogs.push(msg); io.emit('chatMsg', msg); }
        else if(d.type==='room' && rooms[d.room]) { io.to(d.room).emit('chatMsg', msg); }
    });

    socket.on('joinRoom', ({ username, room, gameType, buyInAmount }) => {
        if(!rooms[room]) {
            rooms[room] = {
                gameType, players: [], gameActive: false,
                // UNO
                unoDeck: [], unoPile: [], unoTurn: 0, unoDirection: 1, unoDrawStack: 0, unoColor: null,
                // BJ
                deck: [], dealerHand: [], bjTurnIndex: 0, bjPhase: 'lobby', maxRounds: 7, currentRound: 0
            };
        }
        const r = rooms[room];
        // ★ 最大6人に変更
        if(r.players.length >= 6) return socket.emit('error', 'ROOM FULL');
        
        // DB Init
        if(!userDB[username]) userDB[username] = { totalWealth: INITIAL_WEALTH, cumulativeScore: 0 };
        if(userDB[username].totalWealth < RELIEF_THRESHOLD) {
            userDB[username].totalWealth = RELIEF_AMOUNT;
            socket.emit('error', '>>> RELIEF FUND APPLIED <<<');
        }

        let fee = parseInt(buyInAmount);
        if(isNaN(fee) || fee < 100) fee = 100;
        if(userDB[username].totalWealth < fee) return socket.emit('error', 'INSUFFICIENT FUNDS');
        userDB[username].totalWealth -= fee;

        const colors = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#FFFFFF', '#FF9FF3', '#54A0FF'];
        r.players.push({
            id: socket.id, username, color: colors[r.players.length % colors.length],
            isCpu: false, // Human
            ready: false, score: fee, initialScore: fee, currentBet: 0, 
            hand: [], status: 'playing', result: '', unoHand: []
        });
        
        socket.join(room);
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
                // CPUも全員削除（人間がいなくなったら解散）
                if(!r.players.some(pl => !pl.isCpu)) {
                    delete rooms[rid];
                } else {
                    r.gameActive = false; // ゲーム中断
                    // CPU除去
                    r.players = r.players.filter(pl => !pl.isCpu);
                    r.players.forEach(pl => pl.ready = false);
                    io.to(rid).emit('roomUpdate', { players: r.players, gameType: r.gameType });
                }
                io.emit('rankingUpdate', getRankingData());
                break;
            }
        }
    }

    // --- TOGGLE READY & START ---
    socket.on('toggleReady', ({ room }) => {
        const r = rooms[room];
        if(!r || r.gameActive) return;
        const p = r.players.find(pl => pl.id === socket.id);
        if(p) {
            p.ready = !p.ready;
            io.to(room).emit('roomUpdate', { players: r.players, gameType: r.gameType });
            
            // 全員Readyなら開始処理
            if(r.players.length > 0 && r.players.every(pl => pl.ready)) {
                if(r.gameType === 'uno') {
                    // ★ UNO: 4人未満ならCPU追加
                    while(r.players.length < 4) {
                        r.players.push({
                            id: `cpu-${Date.now()}-${Math.random()}`,
                            username: `CPU ${r.players.length+1}`,
                            color: '#AAAAAA',
                            isCpu: true,
                            ready: true,
                            score: 1000, initialScore: 1000,
                            unoHand: []
                        });
                    }
                    io.to(room).emit('roomUpdate', { players: r.players, gameType: 'uno' }); // CPU追加を通知
                    startUnoMatch(room);
                }
                // BJなどはCPU追加なし（ディーラーがいるため）
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

    // Game Actions
    socket.on('bjAction', ({ room, action }) => handleBjAction(room, socket.id, action));
    socket.on('ovAction', ({ room, choice }) => handleOvAction(room, socket.id, choice));
    
    // UNO: Human move
    socket.on('unoMove', ({ room, cardIndex, colorChoice }) => processUnoMove(room, socket.id, cardIndex, colorChoice));
    socket.on('unoDraw', ({ room }) => processUnoDraw(room, socket.id));
});

function getRankingData() {
    return Object.keys(userDB).map(k => ({ name: k, wealth: userDB[k].totalWealth, score: userDB[k].cumulativeScore }))
        .sort((a, b) => b.score - a.score).slice(0, 10);
}
function sendRanking(socket) { socket.emit('rankingUpdate', getRankingData()); }

// ==========================================
// UNO LOGIC (CPU Supported)
// ==========================================
function startUnoMatch(room) {
    const r = rooms[room];
    r.gameActive = true;
    r.unoDeck = createUnoDeck();
    r.unoPile = [r.unoDeck.pop()];
    while(r.unoPile[0].color === 'black') { // 初期カードがワイルドならやり直し
        r.unoDeck.unshift(r.unoPile.pop());
        r.unoDeck = shuffle(r.unoDeck);
        r.unoPile = [r.unoDeck.pop()];
    }
    r.unoTurn = 0;
    r.unoDirection = 1;
    r.unoDrawStack = 0;
    r.unoColor = r.unoPile[0].color;

    r.players.forEach(p => {
        p.unoHand = [];
        for(let i=0; i<7; i++) p.unoHand.push(r.unoDeck.pop());
    });

    updateUnoState(room);
    checkCpuTurn(room);
}

// 共通処理: カードを出す
function processUnoMove(room, playerId, cardIndex, colorChoice) {
    const r = rooms[room];
    if(!r || !r.gameActive) return;
    const p = r.players[r.unoTurn];
    if(p.id !== playerId) return;

    const card = p.unoHand[cardIndex];
    const top = r.unoPile[r.unoPile.length-1];

    // バリデーション
    let isValid = false;
    if(r.unoDrawStack > 0) {
        // 重ね出しルール
        if(top.type === 'draw2' && card.type === 'draw2') isValid = true;
        else if(top.type === 'draw4' && card.type === 'draw4') isValid = true;
    } else {
        if(card.color === 'black') isValid = true;
        else if(card.color === r.unoColor) isValid = true;
        else if(card.type === top.type) isValid = true;
    }

    if(!isValid) return;

    // 出す
    p.unoHand.splice(cardIndex, 1);
    r.unoPile.push(card);
    r.unoColor = card.color;

    // 効果
    if(card.type === 'skip') r.unoTurn = getNextTurn(r);
    else if(card.type === 'reverse') {
        if(r.players.length === 2) r.unoTurn = getNextTurn(r);
        else r.unoDirection *= -1;
    } else if(card.type === 'draw2') r.unoDrawStack += 2;
    else if(card.type === 'wild') r.unoColor = colorChoice || 'red';
    else if(card.type === 'draw4') { r.unoDrawStack += 4; r.unoColor = colorChoice || 'red'; }

    // 勝利判定
    if(p.unoHand.length === 0) {
        let pool = 0;
        r.players.forEach(pl => {
            if(pl !== p) {
                let pen = 200; // 負け額
                if(pl.score >= pen) { pl.score -= pen; pool += pen; }
                else { pool += pl.score; pl.score = 0; }
            }
        });
        p.score += pool;
        io.to(room).emit('gameOver', { winner: p.color, msg: `UNO WINNER: ${p.username} (+${pool})` });
        r.gameActive = false;
        r.players = r.players.filter(pl => !pl.isCpu); // CPU削除
        r.players.forEach(pl => pl.ready = false);
        return;
    }

    advanceUnoTurn(room);
}

// 共通処理: ドロー
function processUnoDraw(room, playerId) {
    const r = rooms[room];
    const p = r.players[r.unoTurn];
    if(p.id !== playerId) return;

    if(r.unoDrawStack > 0) {
        drawCards(r, p, r.unoDrawStack);
        r.unoDrawStack = 0;
        advanceUnoTurn(room);
    } else {
        drawCards(r, p, 1);
        updateUnoState(room);
        // 人間ならここで操作待ち。CPUなら引いたカードを出せるかチェックしてターン終了
        if(p.isCpu) setTimeout(() => cpuTryPlayAfterDraw(room, p), 1000);
    }
}

function drawCards(r, p, count) {
    for(let i=0; i<count; i++) {
        if(r.unoDeck.length === 0) {
            const top = r.unoPile.pop();
            r.unoDeck = shuffle(r.unoPile);
            r.unoPile = [top];
        }
        if(r.unoDeck.length > 0) p.unoHand.push(r.unoDeck.pop());
    }
}

function advanceUnoTurn(room) {
    const r = rooms[room];
    r.unoTurn = getNextTurn(r);
    updateUnoState(room);
    checkCpuTurn(room);
}

function getNextTurn(r) {
    return (r.unoTurn + r.unoDirection + r.players.length) % r.players.length;
}

function checkCpuTurn(room) {
    const r = rooms[room];
    if(!r.gameActive) return;
    const p = r.players[r.unoTurn];
    if(p.isCpu) {
        setTimeout(() => runCpuLogic(room, p), 1500); // 思考時間
    }
}

// --- CPU AI ---
function runCpuLogic(room, p) {
    const r = rooms[room];
    if(!r.gameActive) return;

    // 出せるカードを探す
    let validIdx = -1;
    let chosenColor = 'red';

    // 手札の中で一番多い色を計算（ワイルド用）
    const counts = {red:0, blue:0, green:0, yellow:0};
    p.unoHand.forEach(c => { if(c.color!=='black') counts[c.color]++; });
    chosenColor = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);

    const top = r.unoPile[r.unoPile.length-1];

    // ドロー累積時
    if(r.unoDrawStack > 0) {
        validIdx = p.unoHand.findIndex(c => 
            (top.type==='draw2' && c.type==='draw2') || 
            (top.type==='draw4' && c.type==='draw4')
        );
        if(validIdx === -1) {
            // 出せなければドローしてターン終了
            processUnoDraw(room, p.id);
            return;
        }
    } else {
        // 通常時: 数字/記号一致 or 色一致 or ワイルド
        // 戦略: ワイルドは温存し、色/数字一致を優先
        validIdx = p.unoHand.findIndex(c => c.color!=='black' && (c.color===r.unoColor || c.type===top.type));
        
        if(validIdx === -1) {
            // ワイルドを探す
            validIdx = p.unoHand.findIndex(c => c.color==='black');
        }
    }

    if(validIdx !== -1) {
        processUnoMove(room, p.id, validIdx, chosenColor);
    } else {
        processUnoDraw(room, p.id);
    }
}

function cpuTryPlayAfterDraw(room, p) {
    // 引いた直後のカード（最後尾）をチェック
    const r = rooms[room];
    const idx = p.unoHand.length - 1;
    const card = p.unoHand[idx];
    const top = r.unoPile[r.unoPile.length-1];
    
    // 出せるなら出す
    let canPlay = false;
    if(card.color === 'black') canPlay = true;
    else if(card.color === r.unoColor || card.type === top.type) canPlay = true;

    if(canPlay) {
        // 色指定は適当に
        processUnoMove(room, p.id, idx, 'red'); 
    } else {
        advanceUnoTurn(room);
    }
}

function updateUnoState(room) {
    const r = rooms[room];
    r.players.forEach(p => {
        if(p.isCpu) return; // CPUには送信不要
        const publicPlayers = r.players.map((pl, i) => ({
            username: pl.username,
            color: pl.color,
            handCount: pl.unoHand.length,
            isTurn: i === r.unoTurn,
            score: pl.score,
            isCpu: pl.isCpu
        }));
        io.to(p.id).emit('unoUpdate', {
            players: publicPlayers,
            myHand: p.unoHand,
            topCard: r.unoPile[r.unoPile.length-1],
            currentColor: r.unoColor,
            drawStack: r.unoDrawStack,
            direction: r.unoDirection,
            isMyTurn: r.players[r.unoTurn].id === p.id
        });
    });
}

// ... (BJ / Override Logic is same as previous, omitted for brevity but included in full file) ...
// (前回のコードのBJ/Override部分はそのまま使用)
function handleBjAction(room, pid, action) {
    const r = rooms[room]; if(r.bjPhase!=='playing' || r.players[r.bjTurnIndex].id!==pid) return;
    const p = r.players[r.bjTurnIndex];
    if(action==='hit') {
        p.hand.push(r.deck.pop());
        if(getBjScore(p.hand)>21) { p.status='bust'; nextBjTurn(room); } else updateBjState(room);
    } else { p.status='stand'; nextBjTurn(room); }
}
function startBjMatch(room) { rooms[room].gameActive=true; rooms[room].currentRound=0; startBjRound(room); }
function startBjRound(room) {
    const r = rooms[room]; r.currentRound++; r.bjPhase='betting'; r.deck=createBjDeck(); r.dealerHand=[];
    r.players.forEach(p=>{p.hand=[];p.currentBet=0;p.status=(p.score<=0?'bankrupt':'playing');p.result='';});
    io.to(room).emit('bjRoundStart', { round: r.currentRound, max: 7 });
}
function dealBjCards(room) {
    const r = rooms[room]; r.bjPhase='playing'; r.dealerHand=[r.deck.pop(),r.deck.pop()];
    r.players.forEach(p=>{ if(p.status!=='bankrupt'){ p.hand=[r.deck.pop(),r.deck.pop()]; if(getBjScore(p.hand)===21)p.status='blackjack'; }});
    r.bjTurnIndex=0; updateBjState(room); checkBjSkip(room);
}
function checkBjSkip(room){ const r=rooms[room]; if(r.bjTurnIndex>=r.players.length)return runBjDealer(room); const p=r.players[r.bjTurnIndex]; if(p.status==='bankrupt'||p.status==='blackjack') nextBjTurn(room); }
function nextBjTurn(room){ rooms[room].bjTurnIndex++; if(rooms[room].bjTurnIndex>=rooms[room].players.length) runBjDealer(room); else checkBjSkip(room); updateBjState(room); }
function runBjDealer(room){
    const r = rooms[room]; let ds = getBjScore(r.dealerHand);
    while(ds<17) { r.dealerHand.push(r.deck.pop()); ds = getBjScore(r.dealerHand); }
    r.players.forEach(p=>{
        if(p.status==='bankrupt')return;
        let ps = getBjScore(p.hand), m=0;
        if(p.status==='bust') m=0; else if(p.status==='blackjack') m=(ds===21&&r.dealerHand.length===2)?1:2.5; else if(ds>21 || ps>ds) m=2; else if(ps===ds) m=1;
        if(m===0)p.result='LOSE'; if(m===1)p.result='PUSH'; if(m>=2)p.result='WIN'; if(p.status==='blackjack')p.result='BJ!';
        p.score += Math.floor(p.currentBet * m);
    });
    io.to(room).emit('bjRoundOver', { dealerCards: r.dealerHand, players: r.players });
    if(r.currentRound>=7) endMatch(room); else setTimeout(()=>startBjRound(room), 5000);
}
function updateBjState(room){ const r=rooms[room]; const vd = (r.bjTurnIndex>=r.players.length)?r.dealerHand:[r.dealerHand[0],{suit:'?',rank:'?',val:0}]; io.to(room).emit('bjUpdate', { players:r.players, dealerHand:vd, turnIndex:r.bjTurnIndex, phase:r.bjPhase }); }

function handleOvAction(room, pid, choice) {
    const r=rooms[room]; const p=r.players.find(pl=>pl.id===pid);
    if(p && p.status==='playing') { p.hand=[{choice}]; p.status='locked'; }
    io.to(room).emit('ovUpdate', { players:r.players, dealerCard:r.ovDealerCard, phase:'playing' });
    if(r.players.filter(pl=>pl.currentBet>0).every(pl=>pl.status==='locked')) resolveOvTurn(room);
}
function startOvMatch(room) { rooms[room].gameActive=true; rooms[room].currentRound=0; startOvRound(room); }
function startOvRound(room) {
    const r=rooms[room]; r.currentRound++; r.ovPhase='betting'; r.ovDeck=createBjDeck();
    r.players.forEach(p=>{p.hand=[];p.currentBet=0;p.status=(p.score<=0?'bankrupt':'playing');p.result='';});
    io.to(room).emit('ovRoundStart', { round: r.currentRound });
}
function startOvTurn(room) { const r=rooms[room]; r.ovPhase='playing'; r.ovDealerCard=r.ovDeck.pop(); io.to(room).emit('ovUpdate', { players:r.players, dealerCard:r.ovDealerCard, phase:'playing' }); }
function resolveOvTurn(room) {
    const r=rooms[room]; const next=r.ovDeck.pop(); const base=r.ovDealerCard.power;
    r.players.forEach(p=>{
        if(p.status==='bankrupt'||p.currentBet===0)return;
        const c=p.hand[0].choice; let m=0;
        if(next.power===base) m=1; else if((c==='high'&&next.power>base)||(c==='low'&&next.power<base)) m=2;
        p.score+=Math.floor(p.currentBet*m); p.result = m===0?'LOSE':(m===1?'PUSH':'WIN');
    });
    io.to(room).emit('ovRoundOver', { dealerCards:[r.ovDealerCard, next], players:r.players });
    if(r.currentRound>=7) endMatch(room); else setTimeout(()=>startOvRound(room), 5000);
}

function endMatch(room) {
    const r = rooms[room]; r.gameActive=false;
    let w = r.players.reduce((p,c)=>(p.score>c.score)?p:c);
    io.to(room).emit('gameOver', { winner: w.color, msg: `WINNER: ${w.username}` });
    r.players.forEach(p=>p.ready=false);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));