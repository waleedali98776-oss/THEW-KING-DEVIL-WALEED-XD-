const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const multer = require("multer");
const {
    makeInMemoryStore,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    makeWASocket,
    isJidBroadcast
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 20356;

// Create necessary directories
const dirs = ["temp", "uploads", "logs", "data"];
dirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

const upload = multer({ dest: "uploads/" });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store active client instances and tasks
const activeClients = new Map();
const taskLogs = new Map();
const userSessions = new Map();

// System Statistics
const systemStats = {
    totalMessagesSent: 0,
    totalSessions: 0,
    totalTasks: 0,
    uptime: Date.now(),
    errors: 0,
    successfulTasks: 0,
    failedTasks: 0,
    requestsServed: 0
};

// Load stats from file
try {
    if (fs.existsSync("data/stats.json")) {
        const savedStats = JSON.parse(fs.readFileSync("data/stats.json", "utf8"));
        Object.assign(systemStats, savedStats);
    }
} catch (e) {}

// Generate short unique session ID
function generateShortSessionId() {
    return Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
}

function generateShortTaskId() {
    return 't' + Math.random().toString(36).substring(2, 8);
}

function saveStats() {
    try {
        fs.writeFileSync("data/stats.json", JSON.stringify(systemStats, null, 2));
    } catch (e) {}
}

// Middleware to track user sessions
app.use((req, res, next) => {
    const userIP = req.ip || req.connection.remoteAddress;
    req.userIP = userIP;
    systemStats.requestsServed++;
    next();
});

// System Monitoring
setInterval(() => {
    systemStats.totalSessions = activeClients.size;
    systemStats.totalTasks = Array.from(activeClients.values()).reduce((acc, client) =>
        acc + (client.tasks ? client.tasks.length : 0), 0
    );
    saveStats();
}, 300000);

// Cleanup inactive sessions after 24 hours
setInterval(() => {
    const now = Date.now();
    for (let [sessionId, clientInfo] of activeClients.entries()) {
        if (clientInfo.lastActivity && (now - clientInfo.lastActivity > 24 * 60 * 60 * 1000)) {
            if (clientInfo.client) clientInfo.client.end();
            activeClients.delete(sessionId);
            for (let [ip, sessId] of userSessions.entries()) {
                if (sessId === sessionId) userSessions.delete(ip);
            }
            console.log(`Cleaned up inactive session: ${sessionId}`);
        }
    }
    for (let [taskId, logs] of taskLogs.entries()) {
        if (logs.length > 200) logs.splice(200);
    }
}, 60 * 60 * 1000);

// API Routes
app.get("/api/stats", (req, res) => {
    const uptime = Date.now() - systemStats.uptime;
    const hours = Math.floor(uptime / (1000 * 60 * 60));
    const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
    res.json({
        ...systemStats,
        uptime: `${hours}h ${minutes}m`,
        activeSessions: activeClients.size,
        activeTasks: Array.from(activeClients.values()).reduce((acc, client) =>
            acc + (client.tasks ? client.tasks.length : 0), 0
        ),
        timestamp: new Date().toISOString()
    });
});

app.get("/api/sessions", (req, res) => {
    const sessions = Array.from(activeClients.entries()).map(([sessionId, clientInfo]) => ({
        sessionId, number: clientInfo.number, isConnected: clientInfo.isConnected,
        lastActivity: clientInfo.lastActivity, taskCount: clientInfo.tasks ? clientInfo.tasks.length : 0
    }));
    res.json(sessions);
});

// ============ PAIRING CODE ROUTE - FIXED WORKING ============
app.get("/code", async (req, res) => {
    const num = req.query.number.replace(/[^0-9]/g, "");
    const userIP = req.userIP;
    const sessionId = generateShortSessionId();
    const sessionPath = path.join("temp", sessionId);
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        const waClient = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" }))
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            generateHighQualityLinkPreview: true,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            getMessage: async key => ({})
        });
        // Store client immediately
        activeClients.set(sessionId, {
            client: waClient,
            number: num,
            authPath: sessionPath,
            isConnected: false,
            tasks: [],
            lastActivity: Date.now()
        });
        userSessions.set(userIP, sessionId);
        if (!waClient.authState.creds.registered) {
            await delay(1500);
            const phoneNumber = num.replace(/[^0-9]/g, "");
            const code = await waClient.requestPairingCode(phoneNumber);
            res.send(`
                <div style="margin-top: 20px; padding: 25px; background: linear-gradient(135deg, #ffffff, #f0f9f6); border-radius: 20px; border: 2px solid #00a884; text-align: center; box-shadow: 0 8px 30px rgba(7,94,84,0.15);">
                    <h2 style="color: #075e54; margin-bottom: 15px;">🔐 Pairing Code Generated!</h2>
                    <div style="font-size: 48px; font-weight: bold; background: #ffffff; color: #075e54; padding: 20px; border-radius: 15px; letter-spacing: 5px; margin: 20px 0; border: 2px dashed #00a884;">
                        ${code}
                    </div>
                    <p style="font-size: 16px; margin-bottom: 20px; color: #374151;">Enter this code in WhatsApp to link your device</p>
                    <div style="text-align: left; background: #f8fafc; padding: 15px; border-radius: 12px; margin: 15px 0; border: 1px solid #e5e7eb;">
                        <p><strong style="color: #075e54;">📱 Steps to pair:</strong></p>
                        <ol style="color: #4b5563;">
                            <li>Open WhatsApp on your phone</li>
                            <li>Go to Settings → Linked Devices → Link a Device</li>
                            <li>Enter this pairing code when prompted</li>
                            <li>Wait for connection (takes a few seconds)</li>
                        </ol>
                    </div>
                    <p style="font-size: 18px; margin-top: 15px; color: #111827;"><strong style="color: #075e54;">🔑 Your Session ID:</strong> <code style="background: #f1f5f9; color: #075e54; padding: 5px 10px; border-radius: 8px;">${sessionId}</code></p>
                    <p style="font-size: 14px; color: #6b7280;">Save this Session ID to manage your tasks</p>
                    <script>
                        localStorage.setItem('wa_session_id', '${sessionId}');
                        setTimeout(() => { window.location.href = '/session-status?sessionId=${sessionId}'; }, 2000);
                    </script>
                    <a href="/" style="display: inline-block; margin-top: 20px; color: #00a884; text-decoration: none; font-weight: 600;">← Back to Dashboard</a>
                </div>
            `);
        } else {
            res.send(`<div style="padding:20px;background:#fee2e2;border:1px solid #fca5a5;color:#7f1d1d;border-radius:12px;"><h3>Already registered!</h3><a href="/" style="color:#075e54;font-weight:600;">Go Back</a></div>`);
        }
        waClient.ev.on("creds.update", saveCreds);
        waClient.ev.on("connection.update", async (s) => {
            const { connection, lastDisconnect } = s;
            if (connection === "open") {
                console.log(`✅ WhatsApp Connected for ${num}! Session: ${sessionId}`);
                const clientInfo = activeClients.get(sessionId);
                if (clientInfo) {
                    clientInfo.isConnected = true;
                    clientInfo.lastActivity = Date.now();
                }
            } else if (connection === "close") {
                const clientInfo = activeClients.get(sessionId);
                if (clientInfo) {
                    clientInfo.isConnected = false;
                    console.log(`⚠️ Connection closed for Session: ${sessionId}`);
                    if (lastDisconnect?.error?.output?.statusCode !== 401) {
                        console.log(`🔄 Attempting to reconnect for Session: ${sessionId}...`);
                        await delay(10000);
                        initializeClient(sessionId, num, sessionPath);
                    }
                }
            }
        });
    } catch (err) {
        console.error("Error in pairing:", err);
        res.send(`<div style="padding:20px;background:#fee2e2;border:1px solid #fca5a5;color:#7f1d1d;border-radius:12px;"><h3>Error: ${err.message}</h3><a href="/" style="color:#075e54;font-weight:600;">Go Back</a></div>`);
    }
});

// Initialize client for reconnection
async function initializeClient(sessionId, num, sessionPath) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        const waClient = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" }))
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false
        });
        const clientInfo = activeClients.get(sessionId) || {
            number: num,
            authPath: sessionPath,
            tasks: [],
            lastActivity: Date.now()
        };
        clientInfo.client = waClient;
        activeClients.set(sessionId, clientInfo);
        waClient.ev.on("creds.update", saveCreds);
        waClient.ev.on("connection.update", async (s) => {
            const { connection, lastDisconnect } = s;
            if (connection === "open") {
                console.log(`🔄 Reconnected successfully: ${sessionId}`);
                clientInfo.isConnected = true;
                clientInfo.lastActivity = Date.now();
                if (clientInfo.tasks && clientInfo.tasks.length > 0) {
                    for (const task of clientInfo.tasks) {
                        if (task.isSending && !task.stopRequested && task.messages && task.messages.length) {
                            console.log(`▶️ Resuming task ${task.taskId} for session ${sessionId}`);
                            sendMessagesLoop(
                                sessionId,
                                task.taskId,
                                task.messages,
                                waClient,
                                task.target,
                                task.targetType,
                                task.delaySec,
                                task.prefix,
                                clientInfo.number
                            );
                        }
                    }
                }
            } else if (connection === "close") {
                clientInfo.isConnected = false;
                console.log(`⚠️ Connection closed again: ${sessionId}`);
                if (lastDisconnect?.error?.output?.statusCode !== 401) {
                    console.log(`🔄 Reconnecting again: ${sessionId}...`);
                    await delay(10000);
                    initializeClient(sessionId, num, sessionPath);
                }
            }
        });
    } catch (err) {
        console.error(`Reconnection failed for ${sessionId}:`, err);
        setTimeout(() => initializeClient(sessionId, num, sessionPath), 30000);
    }
}

// Send message route
app.post("/send-message", upload.single("messageFile"), async (req, res) => {
    const { target, targetType, delaySec, prefix } = req.body;
    const sessionId = userSessions.get(req.userIP);
    if (!sessionId || !activeClients.has(sessionId)) {
        return res.send(`<div style="padding:20px;background:#fee2e2;border:1px solid #fca5a5;color:#7f1d1d;border-radius:12px;"><h2>❌ No active session found! Please generate a pairing code first.</h2><a href="/" style="color:#075e54;font-weight:600;">Go Back</a></div>`);
    }
    const clientInfo = activeClients.get(sessionId);
    const { client: waClient, number: senderNumber } = clientInfo;
    const filePath = req.file?.path;
    if (!target || !filePath || !targetType || !delaySec) {
        return res.send(`<div style="padding:20px;background:#fee2e2;border:1px solid #fca5a5;color:#7f1d1d;border-radius:12px;"><h2>❌ Missing required fields</h2></div>`);
    }
    try {
        const messages = fs.readFileSync(filePath, "utf-8").split("\n").filter(msg => msg.trim() !== "");
        if (messages.length === 0) {
            return res.send(`<div style="padding:20px;background:#fee2e2;border:1px solid #fca5a5;color:#7f1d1d;border-radius:12px;"><h2>❌ Message file is empty</h2></div>`);
        }
        const taskId = generateShortTaskId();
        const taskInfo = {
            taskId,
            target,
            targetType,
            messages,
            delaySec: parseInt(delaySec),
            prefix: prefix || "",
            isSending: true,
            stopRequested: false,
            totalMessages: messages.length,
            sentMessages: 0,
            currentMessageIndex: 0,
            startTime: new Date(),
            logs: []
        };
        if (!clientInfo.tasks) clientInfo.tasks = [];
        clientInfo.tasks.push(taskInfo);
        clientInfo.lastActivity = Date.now();
        taskLogs.set(taskId, []);
        systemStats.totalMessagesSent += messages.length;
        systemStats.totalTasks++;
        res.send(`<script>
                    localStorage.setItem('wa_session_id', '${sessionId}');
                    window.location.href = '/session-status?sessionId=${sessionId}';
                  </script>`);
        sendMessagesLoop(sessionId, taskId, messages, waClient, target, targetType, taskInfo.delaySec, taskInfo.prefix, senderNumber);
    } catch (error) {
        console.error(`Error:`, error);
        systemStats.errors++;
        return res.send(`<div style="padding:20px;background:#fee2e2;border:1px solid #fca5a5;color:#7f1d1d;border-radius:12px;"><h2>Error: ${error.message}</h2></div>`);
    }
});

// Send messages loop - continuous mode
async function sendMessagesLoop(sessionId, taskId, messages, waClient, target, targetType, delaySec, prefix, senderNumber) {
    const clientInfo = activeClients.get(sessionId);
    if (!clientInfo) return;
    const taskInfo = clientInfo.tasks.find(t => t.taskId === taskId);
    if (!taskInfo) return;
    const logs = taskLogs.get(taskId) || [];
    try {
        let index = taskInfo.currentMessageIndex;
        const recipient = targetType === "group" ? target + "@g.us" : target + "@s.whatsapp.net";
        while (taskInfo.isSending && !taskInfo.stopRequested) {
            if (!clientInfo.isConnected) {
                logs.unshift({
                    type: "info",
                    message: `[${new Date().toLocaleString()}] ⏳ Waiting for connection...`,
                    details: "Pausing until reconnected",
                    timestamp: new Date()
                });
                if (logs.length > 100) logs.pop();
                taskLogs.set(taskId, logs);
                await delay(10000);
                continue;
            }
            let msg = messages[index];
            if (prefix && prefix.trim() !== "") {
                msg = `${prefix.trim()} ${msg}`;
            }
            const timestamp = new Date().toLocaleString();
            const messageNumber = taskInfo.sentMessages + 1;
            const cycleNumber = Math.floor(taskInfo.sentMessages / messages.length) + 1;
            try {
                await waClient.sendMessage(recipient, { text: msg });
                logs.unshift({
                    type: "success",
                    message: `[${timestamp}] ✅ Message #${messageNumber} (Cycle ${cycleNumber}) sent to ${target}`,
                    details: `"${msg.substring(0, 100)}"`,
                    timestamp: new Date()
                });
                if (logs.length > 100) logs.pop();
                taskLogs.set(taskId, logs);
                console.log(`[${sessionId}] Sent #${messageNumber} (Cycle ${cycleNumber}) to ${target}`);
                taskInfo.sentMessages++;
                systemStats.totalMessagesSent++;
                index = (index + 1) % messages.length;
                taskInfo.currentMessageIndex = index;
                taskInfo.currentCycle = cycleNumber;
                clientInfo.lastActivity = Date.now();
            } catch (sendError) {
                logs.unshift({
                    type: "error",
                    message: `[${timestamp}] ❌ Failed to send message #${messageNumber}`,
                    details: sendError.message,
                    timestamp: new Date()
                });
                if (logs.length > 100) logs.pop();
                taskLogs.set(taskId, logs);
                console.error(`Error sending:`, sendError.message);
                systemStats.errors++;
                if (sendError.message.includes("connection") || sendError.message.includes("socket")) {
                    clientInfo.isConnected = false;
                    await delay(5000);
                    continue;
                }
                await delay(5000);
            }
            await delay(delaySec * 1000);
        }
        taskInfo.endTime = new Date();
        taskInfo.isSending = false;
        if (taskInfo.stopRequested) systemStats.failedTasks++;
        else systemStats.successfulTasks++;
    } catch (error) {
        console.error(`Error in message loop:`, error);
        systemStats.errors++;
        systemStats.failedTasks++;
        taskInfo.error = error.message;
        taskInfo.isSending = false;
        taskInfo.endTime = new Date();
    }
}

// Session status route
app.get("/session-status", (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId || !activeClients.has(sessionId)) {
        return res.send(`<div style="padding: 30px; text-align: center; background: #fee2e2; border: 1px solid #fca5a5; border-radius: 16px; color: #7f1d1d;"> <h3 style="color: #dc2626;">❌ Session Not Found</h3> <p>The Session ID <strong>${sessionId}</strong> was not found.</p> <a href="/" style="color: #075e54; font-weight: 600;">Go Back</a> </div>`);
    }
    const clientInfo = activeClients.get(sessionId);
    let tasksHtml = '';
    if (clientInfo.tasks && clientInfo.tasks.length > 0) {
        tasksHtml = '<div style="margin-top:20px;"><h4 style="color:#075e54;">📋 Active Tasks (' + clientInfo.tasks.length + ')</h4>';
        for (const task of clientInfo.tasks) {
            const statusColor = task.isSending ? '#16a34a' : (task.stopRequested ? '#dc2626' : '#d97706');
            const statusText = task.isSending ? '🔄 RUNNING (LOOP)' : (task.stopRequested ? '⏹️ STOPPED' : '✅ COMPLETED');
            tasksHtml += `
                <div style="background:#ffffff;padding:20px;border-radius:16px;margin-bottom:15px;border:1px solid #e5e7eb;border-left:4px solid ${statusColor};box-shadow:0 4px 12px rgba(0,0,0,0.05);">
                    <h5 style="color:#075e54;margin:0 0 10px 0;">🎯 ${task.target} (${task.targetType})</h5>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;color:#374151;">
                        <div><strong>Task ID:</strong> ${task.taskId}</div>
                        <div><strong>Status:</strong> <span style="color:${statusColor};font-weight:600;">${statusText}</span></div>
                        <div><strong>Sent:</strong> ${task.sentMessages} messages</div>
                        <div><strong>Cycle:</strong> ${task.currentCycle || 1}</div>
                        <div><strong>Total:</strong> ${task.totalMessages} per cycle</div>
                        <div><strong>Started:</strong> ${task.startTime.toLocaleString()}</div>
                    </div>
                    <div style="margin-top:15px;">
                        <div style="background:#e5e7eb;border-radius:10px;height:8px;overflow:hidden;">
                            <div style="width:${Math.min(100, (task.sentMessages % task.totalMessages) / task.totalMessages * 100)}%;height:100%;background:linear-gradient(90deg,#075e54,#25d366);border-radius:10px;"></div>
                        </div>
                    </div>
                    <form action="/stop-task" method="POST" style="margin-top:15px;">
                        <input type="hidden" name="sessionId" value="${sessionId}">
                        <input type="hidden" name="taskId" value="${task.taskId}">
                        <button type="submit" style="background:#ef4444;color:white;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;font-weight:600;">⏹️ Stop Task</button>
                    </form>
                </div>
            `;
        }
        tasksHtml += '</div>';
    } else {
        tasksHtml = '<div style="text-align:center;padding:40px;color:#d97706;">✨ No active tasks. Use the form above to start sending messages!</div>';
    }
    res.send(`
        <div style="font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding:15px;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 4px 12px rgba(0,0,0,0.06);">
                <div>
                    <h3 style="color:#075e54;margin:0;">📱 Session: ${sessionId}</h3>
                    <p style="margin:5px 0 0 0;color:#4b5563;">WhatsApp: ${clientInfo.number}</p>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:18px;font-weight:bold;color:${clientInfo.isConnected ? '#16a34a' : '#dc2626'}">
                        ${clientInfo.isConnected ? '🟢 CONNECTED' : '🔴 DISCONNECTED'}
                    </div>
                    <small style="color:#6b7280;">Last active: ${new Date(clientInfo.lastActivity).toLocaleString()}</small>
                </div>
            </div>
            ${tasksHtml}
            <div style="margin-top:20px;text-align:center;">
                <a href="/" style="color:#00a884;font-weight:600;">← Back to Dashboard</a>
            </div>
        </div>
    `);
});

// Stop task route
app.post("/stop-task", async (req, res) => {
    const { sessionId, taskId } = req.body;
    if (activeClients.has(sessionId)) {
        const clientInfo = activeClients.get(sessionId);
        const task = clientInfo.tasks?.find(t => t.taskId === taskId);
        if (task) {
            task.stopRequested = true;
            task.isSending = false;
            task.endTime = new Date();
        }
    }
    res.redirect(`/session-status?sessionId=${sessionId}`);
});

// Stop session route
app.post("/stop-session", async (req, res) => {
    const { sessionId } = req.body;
    if (activeClients.has(sessionId)) {
        const ci = activeClients.get(sessionId);
        if (ci.tasks) {
            for (const task of ci.tasks) {
                task.stopRequested = true;
                task.isSending = false;
            }
        }
        if (ci.client) ci.client.end();
        activeClients.delete(sessionId);
        for (let [ip, sid] of userSessions.entries()) {
            if (sid === sessionId) userSessions.delete(ip);
        }
    }
    res.redirect('/');
});

// Get groups route
app.get("/get-groups", async (req, res) => {
    const sessionId = userSessions.get(req.userIP);
    if (!sessionId || !activeClients.has(sessionId)) {
        return res.send(`<div style="padding:20px;background:#fee2e2;border:1px solid #fca5a5;color:#7f1d1d;border-radius:12px;"><h3>❌ No active session. Please pair your device first.</h3></div>`);
    }
    try {
        const { client: waClient, number } = activeClients.get(sessionId);
        const groups = await waClient.groupFetchAllParticipating();
        if (Object.keys(groups).length === 0) {
            return res.send(`<div style="color:#374151;"><h3>No groups found</h3><p>You are not a member of any WhatsApp groups.</p></div>`);
        }
        let html = `<div><h3 style="color:#075e54;">👥 Connected as: ${number}</h3><hr style="border-color:#e5e7eb;">`;
        let idx = 0;
        for (const id in groups) {
            const g = groups[id];
            const cleanId = id.replace('@g.us', '');
            idx++;
            html += `<div style="background:#f8fafc;padding:15px;border-radius:12px;margin-bottom:10px;border-left:3px solid #00a884;color:#111827;"> <strong>${idx}. ${g.subject || 'Unnamed Group'}</strong><br> <code style="background:#ffffff;color:#075e54;padding:4px 8px;border-radius:6px;border:1px solid #e5e7eb;">${cleanId}</code><br> Members: ${g.participants ? g.participants.length : 0}<br> <button onclick="copyToClipboard('${cleanId}')" style="margin-top:10px;background:#00a884;color:white;border:none;padding:5px 12px;border-radius:8px;cursor:pointer;font-weight:600;">📋 Copy UID</button> </div>`;
        }
        html += `<script>function copyToClipboard(t){navigator.clipboard.writeText(t);alert("Copied: "+t);}</script></div>`;
        res.send(html);
    } catch (error) {
        res.send(`<div style="color:#7f1d1d;"><h3>Error: ${error.message}</h3></div>`);
    }
});

// ============ MAIN HOME PAGE - WALEED WHITE THEME ============
app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>💎 WALEED WHATSAPP BOT | WHITE EDITION</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/css/bootstrap.min.css" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        background: linear-gradient(135deg, #f5f7fa 0%, #e8eef5 50%, #f0f9f6 100%);
        min-height: 100vh;
        padding: 20px;
        color: #1f2937;
    }
    .container {
        max-width: 1400px;
        margin: 0 auto;
        background: rgba(255,255,255,0.85);
        backdrop-filter: blur(12px);
        border-radius: 28px;
        padding: 30px;
        border: 1px solid rgba(7,94,84,0.15);
        box-shadow: 0 20px 60px rgba(7,94,84,0.12);
    }
    .header {
        text-align: center;
        margin-bottom: 35px;
        padding: 30px;
        background: #ffffff;
        border-radius: 24px;
        border: 1px solid #e5e7eb;
        box-shadow: 0 8px 24px rgba(0,0,0,0.06);
    }
    .logo {
        font-size: 3rem;
        font-weight: 800;
        background: linear-gradient(135deg, #075e54, #00a884, #25d366);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
    }
    .tagline { color: #00a884; letter-spacing: 3px; margin-top: 10px; font-weight: 600; }
    .system-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 20px;
        margin: 25px 0;
    }
    .stat-card {
        background: #ffffff;
        padding: 20px;
        border-radius: 20px;
        text-align: center;
        border: 1px solid #e5e7eb;
        box-shadow: 0 4px 14px rgba(0,0,0,0.05);
        transition: all 0.3s ease;
    }
    .stat-card:hover { transform: translateY(-5px) scale(1.02); border-color: #00a884; box-shadow: 0 10px 30px rgba(0,168,132,0.18); }
    .stat-number { font-size: 2.2rem; font-weight: bold; background: linear-gradient(135deg, #075e54, #25d366); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
    .stat-label { font-size: 0.85rem; color: #6b7280; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 25px; margin-bottom: 35px; }
    .card {
        background: #ffffff;
        padding: 25px;
        border-radius: 24px;
        border: 1px solid #e5e7eb;
        box-shadow: 0 6px 18px rgba(0,0,0,0.06);
        transition: all 0.3s ease;
    }
    .card:hover { transform: translateY(-8px); box-shadow: 0 14px 34px rgba(7,94,84,0.14); border-color: #b7e6dc; }
    .card-header { display: flex; align-items: center; gap: 15px; margin-bottom: 25px; }
    .card-icon {
        width: 55px; height: 55px;
        background: linear-gradient(135deg, #075e54, #00a884);
        border-radius: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.8rem;
        color: white;
        box-shadow: 0 6px 16px rgba(0,168,132,0.35);
    }
    .card-title { font-size: 1.4rem; font-weight: 700; background: linear-gradient(135deg, #075e54, #00a884); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
    .form-group { margin-bottom: 18px; }
    .form-label { display: block; margin-bottom: 8px; font-weight: 600; color: #075e54; }
    .form-input, .form-select {
        width: 100%;
        padding: 14px 18px;
        background: #f8fafc;
        border: 1px solid #d1d5db;
        border-radius: 14px;
        color: #111827;
        font-size: 14px;
    }
    .form-input:focus, .form-select:focus { outline: none; border-color: #00a884; box-shadow: 0 0 0 3px rgba(0,168,132,0.18); background: #ffffff; }
    .btn {
        width: 100%;
        padding: 14px;
        background: linear-gradient(135deg, #00a884, #075e54);
        color: white;
        border: none;
        border-radius: 14px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s ease;
        margin-top: 10px;
        box-shadow: 0 6px 16px rgba(0,168,132,0.3);
    }
    .btn:hover { transform: scale(1.02); box-shadow: 0 10px 22px rgba(0,168,132,0.4); }
    .btn-secondary { background: linear-gradient(135deg, #64748b, #475569); box-shadow: 0 6px 16px rgba(71,85,105,0.3); }
    .btn-danger { background: linear-gradient(135deg, #ef4444, #b91c1c); box-shadow: 0 6px 16px rgba(239,68,68,0.3); }
    .btn-warning { background: linear-gradient(135deg, #f59e0b, #d97706); box-shadow: 0 6px 16px rgba(245,158,11,0.3); }
    .btn-info { background: linear-gradient(135deg, #0ea5e9, #0369a1); box-shadow: 0 6px 16px rgba(14,165,233,0.3); }
    .system-panel {
        background: #ffffff;
        padding: 25px;
        border-radius: 24px;
        margin-bottom: 25px;
        border: 1px solid #e5e7eb;
        box-shadow: 0 6px 18px rgba(0,0,0,0.06);
    }
    .system-controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .live-data {
        background: #f8fafc;
        padding: 18px;
        border-radius: 16px;
        font-family: monospace;
        font-size: 12px;
        max-height: 200px;
        overflow-y: auto;
        color: #075e54;
        border: 1px solid #d1fae5;
    }
    .console-footer {
        background: #ffffff;
        padding: 25px;
        border-radius: 24px;
        margin-top: 30px;
        border: 1px solid #e5e7eb;
        box-shadow: 0 6px 18px rgba(0,0,0,0.06);
    }
    .console-output {
        background: #f8fafc;
        padding: 20px;
        border-radius: 16px;
        max-height: 250px;
        overflow-y: auto;
        font-family: 'Courier New', monospace;
        font-size: 13px;
        color: #075e54;
        border: 1px solid #d1fae5;
    }
    .console-log { padding: 6px 12px; margin: 4px 0; border-left: 3px solid #00a884; border-radius: 4px; background: #ffffff; }
    .console-info { color: #0369a1; border-left-color: #0ea5e9; }
    .console-success { color: #15803d; border-left-color: #22c55e; }
    .console-error { color: #b91c1c; border-left-color: #ef4444; }
    hr { border-color: #e5e7eb; margin: 20px 0; }
    @media (max-width: 768px) { .container { padding: 15px; } .grid { grid-template-columns: 1fr; } .logo { font-size: 2rem; } }
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <div class="logo"><i class="fab fa-whatsapp"></i> WALEED WA BOT</div>
        <div class="tagline">✦ WHITE EDITION | 24/7 NONSTOP ✦</div>
        <div class="system-stats" id="systemStats">
            <div class="stat-card"> <div class="stat-number" id="statMessages">0</div> <div class="stat-label"> <i class="fas fa-envelope"></i> Messages </div> </div>
            <div class="stat-card"> <div class="stat-number" id="statSessions">0</div> <div class="stat-label"> <i class="fas fa-mobile-alt"></i> Sessions </div> </div>
            <div class="stat-card"> <div class="stat-number" id="statTasks">0</div> <div class="stat-label"> <i class="fas fa-tasks"></i> Active Tasks </div> </div>
            <div class="stat-card"> <div class="stat-number" id="statUptime">0h</div> <div class="stat-label"> <i class="fas fa-clock"></i> Uptime </div> </div>
        </div>
    </div>
    <div class="system-panel">
        <div class="card-header"><div class="card-icon"><i class="fas fa-crown"></i></div><div class="card-title">VIP Control Center</div></div>
        <div class="system-controls">
            <button class="btn btn-secondary" onclick="refreshStats()"><i class="fas fa-sync-alt"></i> Refresh Stats</button>
            <button class="btn btn-warning" onclick="showSystemInfo()"><i class="fas fa-chart-line"></i> System Info</button>
            <button class="btn btn-info" onclick="showAllSessions()"><i class="fas fa-users"></i> All Sessions</button>
            <button class="btn btn-danger" onclick="clearLogs()"><i class="fas fa-broom"></i> Clear Logs</button>
        </div>
        <div class="live-data" id="systemInfo">✨ System Ready | White Mode Active ✨</div>
    </div>
    <div class="grid">
        <div class="card">
            <div class="card-header"><div class="card-icon"><i class="fas fa-link"></i></div><div class="card-title">Pair Device</div></div>
            <div class="form-group"><label class="form-label"><i class="fas fa-phone"></i> WhatsApp Number</label><input type="text" class="form-input" id="numberInput" placeholder="+919876543210"></div>
            <button class="btn" onclick="generateCode()"><i class="fas fa-code"></i> Generate Pairing Code</button>
            <div id="pairingResult" style="margin-top: 15px;"></div>
        </div>
        <div class="card">
            <div class="card-header"><div class="card-icon"><i class="fas fa-paper-plane"></i></div><div class="card-title">Broadcast Engine</div></div>
            <form action="/send-message" method="POST" enctype="multipart/form-data">
                <div class="form-group"><label class="form-label">Target Type</label><select class="form-select" name="targetType" required><option value="">Select</option><option value="number">Phone Number</option><option value="group">Group ID</option></select></div>
                <div class="form-group"><label class="form-label">Target</label><input type="text" class="form-input" name="target" placeholder="918766998510" required></div>
                <div class="form-group"><label class="form-label">Messages File (.txt)</label><input type="file" class="form-input" name="messageFile" accept=".txt" required></div>
                <div class="form-group"><label class="form-label">Prefix (Optional)</label><input type="text" class="form-input" name="prefix" placeholder="🔥 Special: "></div>
                <div class="form-group"><label class="form-label">Delay (Seconds)</label><input type="number" class="form-input" name="delaySec" min="5" value="10" required></div>
                <button type="submit" class="btn"><i class="fas fa-play"></i> Start Broadcasting</button>
            </form>
        </div>
        <div class="card">
            <div class="card-header"><div class="card-icon"><i class="fas fa-user-shield"></i></div><div class="card-title">Session Vault</div></div>
            <div class="form-group"><label class="form-label">Your Number</label><input type="text" class="form-input" id="numberInputForSession" placeholder="+919876543210"></div>
            <button class="btn" onclick="generateCodeForSession()"><i class="fas fa-key"></i> Get Pairing Code</button>
            <hr>
            <div class="form-group"><label class="form-label">Session ID</label><input type="text" class="form-input" id="sessionIdDisplay" readonly placeholder="Your session will appear here"></div>
            <button class="btn btn-secondary" onclick="showMySession()"><i class="fas fa-id-card"></i> Show My Session</button>
            <button class="btn btn-info" onclick="getMyGroups()" style="margin-top: 10px;"><i class="fas fa-users"></i> My Groups</button>
            <button class="btn btn-danger" onclick="stopMySession()" style="margin-top: 10px;"><i class="fas fa-power-off"></i> Stop Session</button>
        </div>
        <div class="card">
            <div class="card-header"><div class="card-icon"><i class="fas fa-chart-simple"></i></div><div class="card-title">Task Monitor</div></div>
            <div class="form-group"><label class="form-label">Session ID</label><input type="text" class="form-input" id="sessionIdInput" placeholder="Enter your session ID"></div>
            <button class="btn" onclick="viewTasks()"><i class="fas fa-eye"></i> View My Tasks</button>
            <div id="sessionTasksResult" style="margin-top: 15px;"></div>
        </div>
    </div>
    <div class="console-footer">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <h4 style="color: #075e54; margin: 0;"><i class="fas fa-terminal"></i> Live Console</h4>
            <button onclick="clearConsole()" style="background: #ef4444; color: white; border: none; padding: 8px 18px; border-radius: 12px; cursor: pointer; font-weight: 600;"><i class="fas fa-trash"></i> Clear</button>
        </div>
        <div id="consoleOutput" class="console-output"></div>
    </div>
</div>
<script>
    async function refreshStats() {
        try {
            const res = await fetch('/api/stats');
            const stats = await res.json();
            document.getElementById('statMessages').innerText = stats.totalMessagesSent.toLocaleString();
            document.getElementById('statSessions').innerText = stats.activeSessions;
            document.getElementById('statTasks').innerText = stats.activeTasks;
            document.getElementById('statUptime').innerText = stats.uptime;
        } catch(e) {}
    }
    async function showSystemInfo() {
        try {
            const res = await fetch('/api/stats');
            const stats = await res.json();
            document.getElementById('systemInfo').innerHTML = '📊 SYSTEM STATS<br>✨ Messages: ' + stats.totalMessagesSent.toLocaleString() + '<br>🔗 Active Sessions: ' + stats.activeSessions + '<br>⚡ Running Tasks: ' + stats.activeTasks + '<br>⏰ Uptime: ' + stats.uptime + '<br>❌ Errors: ' + stats.errors;
        } catch(e) {}
    }
    async function showAllSessions() {
        try {
            const res = await fetch('/api/sessions');
            const sessions = await res.json();
            if(sessions.length === 0) { document.getElementById('systemInfo').innerHTML = 'No active sessions'; return; }
            let html = '👥 ACTIVE SESSIONS:<br><br>';
            sessions.forEach(s => { html += '🔹 ID: ' + s.sessionId + '<br>📱 Number: ' + s.number + '<br>🔌 Status: ' + (s.isConnected ? '🟢 CONNECTED' : '🔴 DISCONNECTED') + '<br>📋 Tasks: ' + s.taskCount + '<br><br>'; });
            document.getElementById('systemInfo').innerHTML = html;
        } catch(e) {}
    }
    function clearLogs() { if(confirm('Clear logs?')) { document.getElementById('systemInfo').innerHTML = '✨ Logs cleared ✨'; showNotif('Logs cleared', 'warning'); } }
    async function generateCode() {
        const number = document.getElementById('numberInput').value;
        if(!number) { showNotif('Enter number', 'error'); return; }
        try {
            const res = await fetch('/code?number=' + encodeURIComponent(number));
            const result = await res.text();
            document.getElementById('pairingResult').innerHTML = result;
            refreshStats();
        } catch(e) { showNotif('Error', 'error'); }
    }
    async function generateCodeForSession() {
        const number = document.getElementById('numberInputForSession').value;
        if(!number) { showNotif('Enter number', 'error'); return; }
        try {
            const res = await fetch('/code?number=' + encodeURIComponent(number));
            const result = await res.text();
            document.getElementById('pairingResult').innerHTML = result;
            refreshStats();
        } catch(e) { showNotif('Error', 'error'); }
    }
    function showMySession() {
        const id = localStorage.getItem('wa_session_id');
        if(id) { document.getElementById('sessionIdDisplay').value = id; showNotif('Session: ' + id, 'success'); }
        else { showNotif('No session found', 'warning'); }
    }
    async function getMyGroups() {
        try {
            const btn = event.target;
            const original = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
            btn.disabled = true;
            const res = await fetch('/get-groups');
            const result = await res.text();
            showGroupsModal(result);
            btn.innerHTML = original;
            btn.disabled = false;
        } catch(e) { showNotif('Error: ' + e.message, 'error'); }
    }
    async function stopMySession() {
        const id = localStorage.getItem('wa_session_id');
        if(!id) { showNotif('No session', 'warning'); return; }
        if(confirm('Stop session?')) {
            try {
                await fetch('/stop-session', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'sessionId=' + encodeURIComponent(id) });
                showNotif('Session stopped', 'success');
                localStorage.removeItem('wa_session_id');
                document.getElementById('sessionIdDisplay').value = '';
                refreshStats();
            } catch(e) { showNotif('Error', 'error'); }
        }
    }
    async function viewTasks() {
        const id = document.getElementById('sessionIdInput').value.trim();
        if(!id) { showNotif('Enter Session ID', 'error'); return; }
        try {
            window.location.href = '/session-status?sessionId=' + encodeURIComponent(id);
        } catch(e) { showNotif('Error', 'error'); }
    }
    function showGroupsModal(html) {
        const modal = document.createElement('div');
        modal.id = 'groupsModal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(245,247,250,0.9);display:flex;justify-content:center;align-items:center;z-index:10000;backdrop-filter:blur(15px);';
        modal.innerHTML = '<div style="background:#ffffff;border:2px solid #00a884;border-radius:28px;padding:30px;max-width:90%;max-height:90vh;width:800px;overflow-y:auto;color:#111827;box-shadow:0 20px 60px rgba(7,94,84,0.25);"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;"><h2 style="color:#075e54;"><i class="fas fa-users"></i> Your Groups</h2><button onclick="closeGroupsModal()" style="background:#ef4444;color:white;border:none;border-radius:50%;width:40px;height:40px;font-size:20px;cursor:pointer;">✕</button></div><div>' + html + '</div><div style="margin-top:20px;"><button onclick="closeGroupsModal()" style="background:#00a884;color:white;padding:10px 20px;border-radius:12px;border:none;font-weight:bold;cursor:pointer;">Close</button></div></div>';
        document.body.appendChild(modal);
    }
    function closeGroupsModal() { const m = document.getElementById('groupsModal'); if(m) m.remove(); }
    function showNotif(msg, type) {
        const n = document.createElement('div');
        const bg = type === 'error' ? '#ef4444' : type === 'success' ? '#00a884' : '#f59e0b';
        const color = 'white';
        n.style.cssText = 'position:fixed;top:20px;right:20px;padding:15px 25px;background:' + bg + ';color:' + color + ';border-radius:16px;z-index:10001;font-weight:bold;box-shadow:0 5px 20px rgba(0,0,0,0.2);';
        n.innerHTML = msg;
        document.body.appendChild(n);
        setTimeout(() => n.remove(), 4000);
    }
    function addLog(msg, type) {
        const div = document.getElementById('consoleOutput');
        const entry = document.createElement('div');
        entry.className = 'console-log console-' + (type || 'info');
        entry.innerHTML = '[' + new Date().toLocaleTimeString() + '] ' + msg;
        div.insertBefore(entry, div.firstChild);
        while(div.children.length > 100) div.removeChild(div.lastChild);
    }
    function clearConsole() { document.getElementById('consoleOutput').innerHTML = ''; addLog('Console cleared', 'info'); }
    document.addEventListener('DOMContentLoaded', function() {
        const id = localStorage.getItem('wa_session_id');
        if(id) { document.getElementById('sessionIdDisplay').value = id; document.getElementById('sessionIdInput').value = id; }
        refreshStats();
        setInterval(refreshStats, 30000);
        addLog('🔥 WALEED WHITE SYSTEM ACTIVATED', 'success');
        addLog('✨ Waleed WhatsApp Bot Ready | Pair your device to start', 'info');
    });
    window.closeGroupsModal = closeGroupsModal;
</script>
</body>
</html>`);
});

// Error handlers
process.on('uncaughtException', (error) => console.error('Uncaught:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
process.on('SIGINT', () => {
    activeClients.forEach(({ client }) => { if (client) client.end(); });
    process.exit();
});

app.listen(PORT, () => {
    console.log(`💎 WALEED WHITE WHATSAPP BOT RUNNING`);
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`✨ Pairing working | 24/7 Mode Active`);
});
