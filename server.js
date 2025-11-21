const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 部屋ごとのデータを管理
let rooms = {};

// --- ゲーム設定 ---
const OTHELLO_SIZE = 8;
const C4_ROWS = 6;
const C4_COLS = 7;

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 入室処理
    socket.on('joinRoom', ({ username, room, gameType }) => {
        // 部屋がなければ作成
        if (!rooms[room]) {
            rooms[room] = {
                gameType: gameType, // 'othello' or 'connect4'
                players: [],
                board: null, // ゲーム開始時に初期化
                turn: null,
                gameActive: false
            };
        }
        
        const r = rooms[room];

        // 満員チェック
        if (r.players.length >= 2) {
            socket.emit('error', 'この部屋は満員です。');
            return;
        }

        // 既存の部屋に参加する場合、ゲームタイプは部屋の設定に従う
        const actualGameType = r.gameType;

        // 色決め (Player 1 = 黒/赤, Player 2 = 白/黄)
        const isP1 = r.players.length === 0;
        const color = isP1 ? (actualGameType === 'othello' ? 'black' : 'red') 
                           : (actualGameType === 'othello' ? 'white' : 'yellow');
        
        const player = { id: socket.id, username, color };
        r.players.push(player);
        socket.join(room);

        // 自分の情報を返す
        socket.emit('joined', { color, gameType: actualGameType });

        // 2人揃ったらゲーム開始
        if (r.players.length === 2) {
            startGame(room);
        } else {
            socket.emit('waiting', '対戦相手を待っています...');
        }
    });

    // --- オセロの操作 ---
    socket.on('othelloMove', ({ room, x, y, color }) => {
        const r = rooms[room];
        if (!r || !r.gameActive || r.turn !== color) return;

        // 石を置く＆ひっくり返す計算（簡易実装：サーバーは承認してクライアントにアニメーション命令）
        io.to(room).emit('othelloUpdate', { x, y, color });
        
        // ターン交代
        const nextTurn = color === 'black' ? 'white' : 'black';
        r.turn = nextTurn;
        io.to(room).emit('changeTurn', nextTurn);
    });

    socket.on('othelloPass', ({ room, color }) => {
        const r = rooms[room];
        const nextTurn = color === 'black' ? 'white' : 'black';
        r.turn = nextTurn;
        io.to(room).emit('changeTurn', nextTurn);
    });

    // --- 四目並べの操作 ---
    socket.on('connect4Move', ({ room, col }) => {
        const r = rooms[room];
        if (!r || !r.gameActive) return;
        
        const player = r.players.find(p => p.id === socket.id);
        if (!player || player.color !== r.turn) return;

        // 重力処理：一番下の空きを探す
        let targetRow = -1;
        for (let row = C4_ROWS - 1; row >= 0; row--) {
            if (r.board[row][col] === null) {
                targetRow = row;
                break;
            }
        }

        if (targetRow === -1) return; // 列がいっぱい

        // 盤面更新
        r.board[targetRow][col] = player.color;
        io.to(room).emit('connect4Update', { row: targetRow, col, color: player.color });

        // 勝利判定
        if (checkConnect4Win(r.board, player.color)) {
            io.to(room).emit('gameOver', { winner: player.color });
            r.gameActive = false;
        } else if (r.board[0].every(c => c !== null)) {
            io.to(room).emit('gameOver', { winner: 'draw' });
            r.gameActive = false;
        } else {
            // ターン交代
            r.turn = r.turn === 'red' ? 'yellow' : 'red';
            io.to(room).emit('changeTurn', r.turn);
        }
    });

    socket.on('disconnect', () => {
        // 切断処理（簡易）
    });
});

// ゲーム開始処理
function startGame(room) {
    const r = rooms[room];
    r.gameActive = true;
    
    if (r.gameType === 'othello') {
        r.turn = 'black';
        // オセロはクライアント側で初期配置を行うため、サーバー側ボード変数は省略（本格実装ならここも管理推奨）
    } else {
        r.turn = 'red';
        r.board = Array(C4_ROWS).fill(null).map(() => Array(C4_COLS).fill(null));
    }

    io.to(room).emit('gameStart', {
        p1: r.players[0].username,
        p2: r.players[1].username,
        gameType: r.gameType,
        turn: r.turn
    });
}

// 四目並べの勝利判定
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