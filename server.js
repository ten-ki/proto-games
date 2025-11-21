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

io.on('connection', (socket) => {
    // 入室
    socket.on('joinRoom', ({ username, room, gameType }) => {
        if (!rooms[room]) {
            rooms[room] = {
                gameType: gameType,
                players: [],
                board: null,
                turn: null,
                gameActive: false
            };
        }
        const r = rooms[room];

        if (r.players.length >= 2) {
            socket.emit('error', 'ROOM FULL (部屋が満員です)');
            return;
        }

        const actualGameType = r.players.length === 0 ? gameType : r.gameType;
        r.gameType = actualGameType;

        const isP1 = r.players.length === 0;
        const color = isP1 ? (actualGameType === 'othello' ? 'black' : 'red') 
                           : (actualGameType === 'othello' ? 'white' : 'cyan');

        r.players.push({ id: socket.id, username, color });
        socket.join(room);

        socket.emit('joined', { color, gameType: actualGameType });

        if (r.players.length === 2) {
            startGame(room);
        } else {
            socket.emit('waiting', 'OPPONENT SEARCHING... (対戦相手を待機中)');
        }
    });

    // --- Othello ---
    socket.on('othelloMove', ({ room, x, y, color }) => {
        const r = rooms[room];
        if (!r || !r.gameActive || r.turn !== color) return;

        const flipped = getOthelloFlips(r.board, x, y, color);
        if (flipped.length === 0) return;

        r.board[y][x] = color;
        flipped.forEach(p => r.board[p.y][p.x] = color);

        io.to(room).emit('othelloUpdate', { board: r.board });

        const opponent = color === 'black' ? 'white' : 'black';
        const p1CanMove = canMove(r.board, opponent);
        const p2CanMove = canMove(r.board, color);

        if (p1CanMove) {
            r.turn = opponent;
            io.to(room).emit('changeTurn', opponent);
        } else if (p2CanMove) {
            io.to(room).emit('passMessage', `${opponent.toUpperCase()} PASS!`);
            io.to(room).emit('changeTurn', color);
        } else {
            // --- GAME OVER (OTHELLO) ---
            const score = calcScore(r.board);
            let winner = 'draw';
            if (score.black > score.white) winner = 'black';
            if (score.white > score.black) winner = 'white';
            
            io.to(room).emit('gameOver', { 
                winner, 
                msg: `GAME OVER! BLACK:${score.black} / WHITE:${score.white}`
            });
            r.gameActive = false;

            // ★ 15秒後に部屋解体
            scheduleRoomDestruction(room);
        }
    });

    // --- Connect 4 ---
    socket.on('connect4Move', ({ room, col }) => {
        const r = rooms[room];
        if (!r || !r.gameActive) return;
        
        const player = r.players.find(p => p.id === socket.id);
        if (!player || player.color !== r.turn) return;

        let targetRow = -1;
        for (let row = C4_ROWS - 1; row >= 0; row--) {
            if (r.board[row][col] === null) {
                targetRow = row;
                break;
            }
        }
        if (targetRow === -1) return;

        r.board[targetRow][col] = player.color;
        io.to(room).emit('connect4Update', { row: targetRow, col, color: player.color });

        // 勝利判定
        const isWin = checkConnect4Win(r.board, player.color);
        const isDraw = !isWin && r.board[0].every(c => c !== null);

        if (isWin || isDraw) {
            // --- GAME OVER (CONNECT 4) ---
            const msg = isWin ? `${player.color.toUpperCase()} WINS!` : 'DRAW GAME';
            const winner = isWin ? player.color : 'draw';
            
            io.to(room).emit('gameOver', { winner, msg });
            r.gameActive = false;

            // ★ 15秒後に部屋解体
            scheduleRoomDestruction(room);

        } else {
            r.turn = r.turn === 'red' ? 'cyan' : 'red';
            io.to(room).emit('changeTurn', r.turn);
        }
    });

    socket.on('disconnect', () => {
        // 切断時の処理（今回は簡易版のため省略）
    });
});

// ★ 部屋解体用のヘルパー関数
function scheduleRoomDestruction(room) {
    console.log(`Room ${room} will be dismantled in 15 seconds...`);
    setTimeout(() => {
        if (rooms[room]) {
            io.to(room).emit('forceReset'); // クライアントを強制リロード
            delete rooms[room]; // サーバーメモリから削除
            console.log(`Room ${room} dismantled.`);
        }
    }, 15000); // 15000ms = 15秒
}

// --- Helpers ---
function startGame(room) {
    const r = rooms[room];
    r.gameActive = true;

    if (r.gameType === 'othello') {
        r.turn = 'black';
        r.board = Array(8).fill(null).map(() => Array(8).fill(null));
        r.board[3][3] = 'white'; r.board[4][4] = 'white';
        r.board[3][4] = 'black'; r.board[4][3] = 'black';
        
        io.to(room).emit('gameStart', {
            p1: r.players[0].username,
            p2: r.players[1].username,
            gameType: 'othello',
            turn: 'black',
            board: r.board
        });
    } else {
        r.turn = 'red';
        r.board = Array(C4_ROWS).fill(null).map(() => Array(C4_COLS).fill(null));
        io.to(room).emit('gameStart', {
            p1: r.players[0].username,
            p2: r.players[1].username,
            gameType: 'connect4',
            turn: 'red'
        });
    }
}

function getOthelloFlips(board, x, y, color) {
    if (board[y][x] !== null) return [];
    const directions = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
    let flipped = [];
    const opponent = color === 'black' ? 'white' : 'black';
    directions.forEach(dir => {
        let temp = [];
        let cx = x + dir[0], cy = y + dir[1];
        while(cx>=0 && cx<8 && cy>=0 && cy<8) {
            if(board[cy][cx] === opponent) temp.push({x:cx, y:cy});
            else if(board[cy][cx] === color) { flipped = flipped.concat(temp); break; }
            else { temp = []; break; }
            cx+=dir[0]; cy+=dir[1];
        }
    });
    return flipped;
}

function canMove(board, color) {
    for(let y=0; y<8; y++) for(let x=0; x<8; x++) 
        if(getOthelloFlips(board, x, y, color).length > 0) return true;
    return false;
}

function calcScore(board) {
    let black = 0, white = 0;
    board.forEach(row => row.forEach(c => { if(c==='black') black++; if(c==='white') white++; }));
    return { black, white };
}

function checkConnect4Win(board, color) {
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (let r = 0; r < C4_ROWS; r++) {
        for (let c = 0; c < C4_COLS; c++) {
            if (board[r][c] !== color) continue;
            for (let [dr, dc] of directions) {
                let count = 1;
                for (let k = 1; k < 4; k++) {
                    const nr = r + dr * k;
                    const nc = c + dc * k;
                    if (nr >= 0 && nr < C4_ROWS && nc >= 0 && nc < C4_COLS && board[nr][nc] === color) count++;
                    else break;
                }
                if (count >= 4) return true;
            }
        }
    }
    return false;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));