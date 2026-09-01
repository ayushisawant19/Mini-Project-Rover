const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');

// Middleware configuration
app.use(express.json({ limit: '15mb' })); // Support base64 image uploads for snapshots
app.use(express.static('public'));       // Serve frontend from 'public' folder
app.use('/uploads', express.static('uploads')); // Serve saved crack snapshots

let sessionStart = null;
let sessionLogs = [];

// Load historical database logs on startup if file exists
if (fs.existsSync('history.json')) {
    try {
        sessionLogs = JSON.parse(fs.readFileSync('history.json'));
    } catch (e) {
        sessionLogs = [];
    }
}

// ---------------------------------------------------------------------------
// 1. TELEMETRY & RUN DATA ENDPOINT (Called by ESP32 or Testing Scripts)
// ---------------------------------------------------------------------------
app.post('/api/telemetry', (req, res) => {
    const data = req.body; 
    /* Expected JSON payload from hardware:
       {
           "moving": true/false,
           "battery": 3.85,
           "humidity": 45.2,
           "front": 120,
           "rear": 95,
           "left": 40,
           "right": 55,
           "currentWaypoint": "Node B (Segment 2)"
       }
    */
    
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
        
        fs.writeFileSync('history.json', JSON.stringify(sessionLogs, null, 2));
        sessionStart = null;
    }

    // Broadcast live telemetry, motion status, and logs to all open browser dashboards
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

    // Create dated folder hierarchy if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }

    const filename = `crack_${Date.now()}.png`;
    const filepath = path.join(uploadDir, filename);
    
    // Clean base64 header and save file locally
    const base64Data = imageBase64.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(filepath, base64Data, 'base64');

    const fileUrl = `/uploads/${dateStr}/${filename}`;

    // Link snapshot evidence to the current active session log or create a static entry
    if (sessionLogs.length > 0) {
        if (!sessionLogs[0].snapshots) sessionLogs[0].snapshots = [];
        sessionLogs[0].snapshots.push(fileUrl);
    } else {
        // Fallback log entry if snapshot is captured while idle
        sessionLogs.unshift({
            id: Date.now(),
            date: dateStr,
            startTime: new Date().toLocaleTimeString(),
            duration: '0m 0s',
            pathTracked: 'Manual Inspection Point',
            snapshots: [fileUrl]
        });
    }

    fs.writeFileSync('history.json', JSON.stringify(sessionLogs, null, 2));

    // Broadcast updated history logs to UI clients
    io.emit('live-update', { history: sessionLogs });

    res.json({ success: true, url: fileUrl });
});

// ---------------------------------------------------------------------------
// 3. START SERVER
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(` Rover Portal Backend Server running smoothly!`);
    console.log(` Access your dashboard via: http://localhost:${PORT}`);
    console.log(`==================================================`);
});