const express = require('express');
const app = express();
const http = require('http').createServer(app);
const cors = require('cors');
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const fs = require('fs');
const path = require('path');

// Middleware configuration
app.use(cors());
app.use(express.json({ limit: '15mb' })); // Support base64 image uploads for snapshots

// Serve static assets from both the root directory and 'public' folder (if present)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve index.html as the landing page
app.get('/', (req, res) => {
    const publicIndexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(publicIndexPath)) {
        res.sendFile(publicIndexPath);
    } else {
        res.sendFile(path.join(__dirname, 'index.html'));
    }
});

let sessionStart = null;
let sessionLogs = [];
const historyFilePath = path.join(__dirname, 'history.json');

// Load historical database logs on startup if file exists
if (fs.existsSync(historyFilePath)) {
    try {
        sessionLogs = JSON.parse(fs.readFileSync(historyFilePath, 'utf8'));
    } catch (e) {
        sessionLogs = [];
    }
}

// Ensure uploads folder exists
const uploadsBasePath = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsBasePath)) {
    fs.mkdirSync(uploadsBasePath, { recursive: true });
}

// Handle new client connections and immediately send current history/state
io.on('connection', (socket) => {
    socket.emit('live-update', {
        isMoving: sessionStart !== null,
        startTime: sessionStart ? sessionStart.toLocaleTimeString() : '--',
        history: sessionLogs
    });
});

// ---------------------------------------------------------------------------
// 1. TELEMETRY & RUN DATA ENDPOINT (Called by ESP32 or Testing Scripts)
// ---------------------------------------------------------------------------
app.post('/api/telemetry', (req, res) => {
    const data = req.body;
    let now = new Date();

    // Track session start/end durations
    if (data.moving && !sessionStart) {
        sessionStart = now;
    } else if (!data.moving && sessionStart) {
        let durationSec = Math.floor((now - sessionStart) / 1000);
        let mins = Math.floor(durationSec / 60);
        let secs = durationSec % 60;
        let durationFormatted = `${mins}m ${secs}s`;

        // Push completed run session to database history array
        sessionLogs.unshift({
            id: Date.now(),
            date: sessionStart.toISOString().split('T')[0], // YYYY-MM-DD
            startTime: sessionStart.toLocaleTimeString(),
            duration: durationFormatted,
            pathTracked: data.currentWaypoint || "Pipeline Route A",
            snapshots: []
        });

        fs.writeFileSync(historyFilePath, JSON.stringify(sessionLogs, null, 2));
        sessionStart = null;
    }

    // Broadcast live telemetry, motion status, and logs to all connected dashboards
    io.emit('live-update', {
        ...data,
        isMoving: sessionStart !== null,
        startTime: sessionStart ? sessionStart.toLocaleTimeString() : '--',
        history: sessionLogs
    });

    res.status(200).send({ status: 'Telemetry recorded successfully' });
});

// ---------------------------------------------------------------------------
// 2. CRACK SNAPSHOT CAPTURE ENDPOINT
// ---------------------------------------------------------------------------
app.post('/api/snapshot', (req, res) => {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
        return res.status(400).json({ success: false, error: 'No image data provided' });
    }

    const dateStr = new Date().toISOString().split('T')[0];
    const uploadDir = path.join(__dirname, 'uploads', dateStr);

    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }

    const filename = `crack_${Date.now()}.png`;
    const filepath = path.join(uploadDir, filename);

    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    fs.writeFileSync(filepath, base64Data, 'base64');

    const fileUrl = `/uploads/${dateStr}/${filename}`;

    if (sessionLogs.length > 0) {
        if (!sessionLogs[0].snapshots) sessionLogs[0].snapshots = [];
        sessionLogs[0].snapshots.push(fileUrl);
    } else {
        sessionLogs.unshift({
            id: Date.now(),
            date: dateStr,
            startTime: new Date().toLocaleTimeString(),
            duration: '0m 0s',
            pathTracked: 'Manual Inspection Point',
            snapshots: [fileUrl]
        });
    }

    fs.writeFileSync(historyFilePath, JSON.stringify(sessionLogs, null, 2));

    // Broadcast updated history logs to UI clients
    io.emit('live-update', { history: sessionLogs });

    res.json({ success: true, url: fileUrl });
});

// ---------------------------------------------------------------------------
// 3. START SERVER
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`==================================================`);
    console.log(` Rover Portal Backend Server running on port ${PORT}`);
    console.log(`==================================================`);
});