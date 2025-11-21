const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let rooms = {};
const C4_ROWS = 6;
const C4_COLS = 7;

// --- BLACKJACK HELPERS ---
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
    // Fisher-Yates Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function getHandScore(hand) {
    let score = 0;
    let aces = 0;
    for(let c of hand) {
        score += c.val;
        if(c.rank === 'A') aces++;
    }
    while(score > 21 && aces > 0) {
        score -= 10;
        aces--;
    }
    return score;
}

io.on('connection', (socket) => {

    // --- CHAT ---
    socket.on('lobbyMsg', ({ username, text }) => io.emit('lobbyMsg', { username: username||'ANONYMOUS', text }));
    socket.on('roomMsg', ({ room, username, text, color }) => {
        if(rooms[room]) io.to(room).emit('roomMsg', { username, text, color });
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
                // BJ specific
                deck: [],
                dealerHand: [],
                bjTurnIndex: 0
            };
        }
        const r = rooms[room];

        // 人数制限チェック
        const limit = (r.gameType === 'blackjack') ? 4 : 2;
        if (r.players.length >= limit) {
            socket.emit('error', 'ROOM FULL (部屋が満員です)');
            return;
        }

        // ゲームタイプの整合性
        const actualGameType = r.players.length === 0 ? gameType : r.gameType;
        if(r.gameType !== actualGameType && r.players.length > 0) {
             socket.emit('error', 'GAME TYPE MISMATCH (異なるゲームが進行中です)');
             return;
        }
        r.gameType = actualGameType;

        // 色割り当て (BJは座席番号のみで管理するが、チャット用に色は適当に割り振る)
        const colors = ['#ff0055', '#00eaff', '#00ff41', '#ffff00']; // Red, Cyan, Green, Yellow
        const color = colors[r.players.length];

        const newPlayer = { 
            id: socket.id, 
            username, 
            color, 
            ready: false, // for BJ voting
            hand: [],
            status: 'playing' // playing, stand, bust, blackjack
        };
        r.players.push(newPlayer);
        socket.join(room);

        // 自分に情報を送る
        socket.emit('joined', { color, gameType: actualGameType, mySeat: r.players.length - 1 });
        
        // 全員に更新を送る
        io.to(room).emit('roomUpdate', { 
            players: r.players.map(p => ({ username: p.username, color: p.color, ready: p.ready })),
            gameType: actualGameType
        });

        // 2人対戦ゲームは2人揃ったら自動開始
        if (actualGameType !== 'blackjack' && r.players.length === 2) {
            startGame(room);
        }
    });

    // --- BLACKJACK: VOTE START ---
    socket.on('bjVoteStart', ({ room }) => {
        const r = rooms[room];
        if(!r || r.gameType !== 'blackjack' || r.gameActive) return;

        const p = r.players.find(pl => pl.id === socket.id);
        if(p) {
            p.ready = !p.ready; // Toggle
            // 全員Readyかつ1人以上なら開始
            const allReady = r.players.length > 0 && r.players.every(pl => pl.ready);
            
            io.to(room).emit('roomUpdate', { 
                players: r.players.map(pl => ({ username: pl.username, color: pl.color, ready: pl.ready })),
                gameType: 'blackjack'
            });

            if(allReady) startBlackjack(room);
        }
    });

    // --- BLACKJACK: ACTION (HIT/STAND) ---
    socket.on('bjAction', ({ room, action }) => {
        const r = rooms[room];
        if(!r || !r.gameActive || r.gameType !== 'blackjack') return;

        const currentPlayer = r.players[r.bjTurnIndex];
        if(currentPlayer.id !== socket.id) return; // 自分のターンじゃない

        if(action === 'hit') {
            const card = r.deck.pop();
            currentPlayer.hand.push(card);
            const score = getHandScore(currentPlayer.hand);
            if(score > 21) {
                currentPlayer.status = 'bust';
                io.to(room).emit('roomMsg', { username: 'SYSTEM', text: `${currentPlayer.username} BUSTED!`, color: '#ff0055' });
                nextBjTurn(room);
            } else {
                // 21でも自動スタンドせず、プレイヤーに任せる（あるいは自動化してもいいが今回は手動）
                updateBjState(room);
            }
        } else if (action === 'stand') {
            currentPlayer.status = 'stand';
            io.to(room).emit('roomMsg', { username: 'SYSTEM', text: `${currentPlayer.username} STANDS.`, color: '#aaa' });
            nextBjTurn(room);
        }
    });


    // --- EXISTING GAME LOGIC (Othello / Connect4) ---
    // ... (省略なしで書きますが、既存ロジックと同じです) ...
    socket.on('othelloMove', ({ room, x, y, color }) => {
        const r = rooms[room];
        if (!r || !r.gameActive || r.turn !== color) return;
        const flipped = getOthelloFlips(r.board, x, y, color);
        if (flipped.length === 0) return;
        r.board[y][x] = color;
        flipped.forEach(p => r.board[p.y][p.x] = color);
        io.to(room).emit('othelloUpdate', { board: r.board });
        const opponent = color === 'black' ? 'white' : 'black';
        if (canMove(r.board, opponent)) {
            r.turn = opponent; io.to(room).emit('changeTurn', opponent);
        } else if (canMove(r.board, color)) {
            io.to(room).emit('passMessage', `${opponent.toUpperCase()} PASS!`); io.to(room).emit('changeTurn', color);
        } else {
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

    socket.on('disconnect', () => {});
});

// --- BLACKJACK LOGIC ---
function startBlackjack(room) {
    const r = rooms[room];
    r.gameActive = true;
    r.deck = createDeck();
    r.dealerHand = [r.deck.pop(), r.deck.pop()];
    r.bjTurnIndex = 0;

    // 各プレイヤーに2枚配る & ステータスリセット
    r.players.forEach(p => {
        p.hand = [r.deck.pop(), r.deck.pop()];
        p.status = 'playing';
        // ナチュラルブラックジャック判定
        if(getHandScore(p.hand) === 21) {
            p.status = 'blackjack';
        }
    });

    // 全員ブラックジャックなら即終了などの細かいルールは省略し、順番に回す
    updateBjState(room);
}

function nextBjTurn(room) {
    const r = rooms[room];
    r.bjTurnIndex++;

    // 全プレイヤー終了 -> ディーラーターン
    if(r.bjTurnIndex >= r.players.length) {
        runDealerTurn(room);
    } else {
        const nextPlayer = r.players[r.bjTurnIndex];
        if(nextPlayer.status === 'blackjack') {
            // ブラックジャックの人はスキップ
            nextBjTurn(room);
        } else {
            updateBjState(room);
        }
    }
}

function runDealerTurn(room) {
    const r = rooms[room];
    let score = getHandScore(r.dealerHand);
    
    // ディーラーは17以上になるまで引く
    // アニメーション用に少しラグを入れてもいいが、サーバー側は一瞬で計算して結果を送る
    while(score < 17) {
        r.dealerHand.push(r.deck.pop());
        score = getHandScore(r.dealerHand);
    }

    // 結果判定
    let msg = '';
    let dealerBust = score > 21;
    
    r.players.forEach(p => {
        const pScore = getHandScore(p.hand);
        let result = '';
        
        if(p.status === 'bust') result = 'LOSE';
        else if(p.status === 'blackjack') {
             // ディーラーもBJならPushだが、簡易的にPlayer Winとする
             result = 'WIN (BJ)';
        } else if (dealerBust) {
            result = 'WIN';
        } else if (pScore > score) {
            result = 'WIN';
        } else if (pScore === score) {
            result = 'PUSH';
        } else {
            result = 'LOSE';
        }
        p.result = result; // クライアント表示用
    });

    io.to(room).emit('bjGameOver', { 
        dealerHand: r.dealerHand,
        players: r.players
    });

    r.gameActive = false;
    scheduleRoomDestruction(room);
}

function updateBjState(room) {
    const r = rooms[room];
    // プレイヤーに現状を送る。ディーラーの2枚目は隠す
    const visibleDealer = [r.dealerHand[0], { suit: '?', rank: '?', val: 0 }];
    
    io.to(room).emit('bjUpdate', {
        players: r.players,
        dealerHand: visibleDealer,
        turnIndex: r.bjTurnIndex
    });
}


// --- EXISTING HELPERS ---
function startGame(room) {
    const r = rooms[room];
    if(r.gameType === 'blackjack') return; // BJは別ルート

    r.gameActive = true;
    if (r.gameType === 'othello') {
        r.turn = 'black';
        r.board = Array(8).fill(null).map(() => Array(8).fill(null));
        r.board[3][3] = 'white'; r.board[4][4] = 'white'; r.board[3][4] = 'black'; r.board[4][3] = 'black';
        io.to(room).emit('gameStart', { p1: r.players[0].username, p2: r.players[1].username, gameType: 'othello', turn: 'black', board: r.board });
    } else {
        r.turn = 'red';
        r.board = Array(C4_ROWS).fill(null).map(() => Array(C4_COLS).fill(null));
        io.to(room).emit('gameStart', { p1: r.players[0].username, p2: r.players[1].username, gameType: 'connect4', turn: 'red' });
    }
}

function scheduleRoomDestruction(room) {
    setTimeout(() => {
        if (rooms[room]) {
            io.to(room).emit('forceReset');
            delete rooms[room];
        }
    }, 15000);
}

// Othello/Connect4 Logic (Compact)
function getOthelloFlips(b,x,y,c){if(b[y][x])return[];const d=[[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];let f=[];const o=c==='black'?'white':'black';d.forEach(r=>{let t=[],cx=x+r[0],cy=y+r[1];while(cx>=0&&cx<8&&cy>=0&&cy<8){if(b[cy][cx]===o)t.push({x:cx,y:cy});else if(b[cy][cx]===c){f=f.concat(t);break}else break;cx+=r[0];cy+=r[1]}});return f}
function canMove(b,c){for(let y=0;y<8;y++)for(let x=0;x<8;x++)if(getOthelloFlips(b,x,y,c).length>0)return true;return false}
function calcScore(b){let k=0,w=0;b.forEach(r=>r.forEach(c=>{if(c==='black')k++;if(c==='white')w++}));return{black:k,white:w}}
function checkConnect4Win(b,c){const d=[[0,1],[1,0],[1,1],[1,-1]];for(let r=0;r<C4_ROWS;r++)for(let l=0;l<C4_COLS;l++){if(b[r][l]!==c)continue;for(let[dr,dc]of d){let k=1;for(let i=1;i<4;i++){let nr=r+dr*i,nc=l+dc*i;if(nr>=0&&nr<C4_ROWS&&nc>=0&&nc<C4_COLS&&b[nr][nc]===c)k++;else break}if(k>=4)return true}}return false}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));