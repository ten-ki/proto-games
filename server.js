const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 入室処理
    socket.on('joinRoom', ({ username, room }) => {
        if (!rooms[room]) {
            rooms[room] = { players: [], turn: 'black' };
        }
        const currentRoom = rooms[room];

        if (currentRoom.players.length >= 2) {
            socket.emit('error', 'この部屋は満員です。');
            return;
        }

        const color = currentRoom.players.length === 0 ? 'black' : 'white';
        const player = { id: socket.id, username, color, room };
        
        currentRoom.players.push(player);
        socket.join(room);

        socket.emit('playerColor', color); // あなたの色を通知

        // 2人揃ったらゲーム開始
        if (currentRoom.players.length === 2) {
            io.to(room).emit('gameStart', {
                blackName: currentRoom.players[0].username,
                whiteName: currentRoom.players[1].username,
                turn: 'black'
            });
        } else {
            socket.emit('waiting', '対戦相手を待っています...');
        }
    });

    // 石を置いた
    socket.on('makeMove', ({ room, x, y, color }) => {
        // 全員に盤面更新を通知
        io.to(room).emit('updateBoard', { x, y, color });
        // 次のターンへ
        const nextTurn = color === 'black' ? 'white' : 'black';
        rooms[room].turn = nextTurn;
        io.to(room).emit('changeTurn', nextTurn);
    });

    // パスした
    socket.on('passTurn', ({ room, color }) => {
        const nextTurn = color === 'black' ? 'white' : 'black';
        rooms[room].turn = nextTurn;
        io.to(room).emit('changeTurn', nextTurn);
    });

    // 切断
    socket.on('disconnect', () => {
        console.log('User disconnected');
        // ※簡易版のため部屋の削除処理は省略
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 入室処理
    socket.on('joinRoom', ({ username, room }) => {
        if (!rooms[room]) {
            rooms[room] = { players: [], turn: 'black' };
        }
        const currentRoom = rooms[room];

        if (currentRoom.players.length >= 2) {
            socket.emit('error', 'この部屋は満員です。');
            return;
        }

        const color = currentRoom.players.length === 0 ? 'black' : 'white';
        const player = { id: socket.id, username, color, room };
        
        currentRoom.players.push(player);
        socket.join(room);

        socket.emit('playerColor', color); // あなたの色を通知

        // 2人揃ったらゲーム開始
        if (currentRoom.players.length === 2) {
            io.to(room).emit('gameStart', {
                blackName: currentRoom.players[0].username,
                whiteName: currentRoom.players[1].username,
                turn: 'black'
            });
        } else {
            socket.emit('waiting', '対戦相手を待っています...');
        }
    });

    // 石を置いた
    socket.on('makeMove', ({ room, x, y, color }) => {
        // 全員に盤面更新を通知
        io.to(room).emit('updateBoard', { x, y, color });
        // 次のターンへ
        const nextTurn = color === 'black' ? 'white' : 'black';
        rooms[room].turn = nextTurn;
        io.to(room).emit('changeTurn', nextTurn);
    });

    // パスした
    socket.on('passTurn', ({ room, color }) => {
        const nextTurn = color === 'black' ? 'white' : 'black';
        rooms[room].turn = nextTurn;
        io.to(room).emit('changeTurn', nextTurn);
    });

    // 切断
    socket.on('disconnect', () => {
        console.log('User disconnected');
        // ※簡易版のため部屋の削除処理は省略
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
