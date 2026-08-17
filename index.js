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

const dirs = ["temp", "uploads", "logs", "data"];
dirs.forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir); });

const upload = multer({ dest: "uploads/" });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const activeClients = new Map();
const taskLogs = new Map();
const userSessions = new Map();

const systemStats = {
    totalMessagesSent: 0, totalSessions: 0, totalTasks: 0,
    uptime: Date.now(), errors: 0, successfulTasks: 0,
    failedTasks: 0, requestsServed: 0
};

try {
    if (fs.existsSync("data/stats.json")) {
        const savedStats = JSON.parse(fs.readFileSync("data/stats.json", "utf8"));
        Object.assign(systemStats, savedStats);
    }
} catch (e) {}

function generateShortSessionId() {
    return Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
}
function generateShortTaskId() {
    return 't' + Math.random().toString(36).substring(2, 8);
}
function saveStats() {
    try { fs.writeFileSync("data/stats.json", JSON.stringify(systemStats, null, 2)); } catch (e) {}
}

app.use((req, res, next) => {
    req.userIP = req.ip || req.connection.remoteAddress;
    systemStats.requestsServed++;
    next();
});

setInterval(() => {
    systemStats.totalSessions = activeClients.size;
    systemStats.totalTasks = Array.from(activeClients.values()).reduce((acc, c) => acc + (c.tasks ? c.tasks.length : 0), 0);
    saveStats();
}, 300000);

setInterval(() => {
    const now = Date.now();
    for (let [sessionId, clientInfo] of activeClients.entries()) {
        if (clientInfo.lastActivity && (now - clientInfo.lastActivity > 24 * 60 * 60 * 1000)) {
            if (clientInfo.client) clientInfo.client.end();
            activeClients.delete(sessionId);
            for (let [ip, sessId] of userSessions.entries()) {
                if (sessId === sessionId) userSessions.delete(ip);
            }
        }
    }
    for (let [taskId, logs] of taskLogs.entries()) {
        if (logs.length > 200) logs.splice(200);
    }
}, 60 * 60 * 1000);

// ==================== API ROUTES ====================
app.get("/api/stats", (req, res) => {
    const uptime = Date.now() - systemStats.uptime;
    const hours = Math.floor(uptime / (1000 * 60 * 60));
    const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
    res.json({
        ...systemStats,
        uptime: `${hours}h ${minutes}m`,
        activeSessions: activeClients.size,
        activeTasks: Array.from(activeClients.values()).reduce((acc, c) => acc + (c.tasks ? c.tasks.length : 0), 0),
        timestamp: new Date().toISOString()
    });
});

app.get("/api/sessions", (req, res) => {
    const sessions = Array.from(activeClients.entries()).map(([sessionId, ci]) => ({
        sessionId, number: ci.number, isConnected: ci.isConnected,
        lastActivity: ci.lastActivity, taskCount: ci.tasks ? ci.tasks.length : 0
    }));
    res.json(sessions);
});

// ==================== PAIRING CODE — FIXED ====================
app.get("/code", async (req, res) => {
    const num = (req.query.number || "").replace(/[^0-9]/g, "");
    if (!num) return res.send(`<div style="padding:20px;text-align:center;color:#d32f2f;"><h3>❌ Number missing</h3><a href="/">Go Back</a></div>`);

    const userIP = req.userIP;
    const sessionId = generateShortSessionId();
    const sessionPath = path.join("temp", sessionId);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    let responseSent = false;

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
            getMessage: async () => ({})
        });

        activeClients.set(sessionId, {
            client: waClient, number: num, authPath: sessionPath,
            isConnected: false, tasks: [], lastActivity: Date.now()
        });
        userSessions.set(userIP, sessionId);

        waClient.ev.on("creds.update", saveCreds);

        waClient.ev.on("connection.update", async (s) => {
            const { connection, lastDisconnect, qr } = s;

            // ✅ PAIRING CODE — QR event pe request karo (connection ready hai)
            if (qr !== undefined && !responseSent) {
                try {
                    const code = await waClient.requestPairingCode(num);
                    responseSent = true;
                    res.send(`
                        <div style="margin-top:20px;padding:25px;background:#fff;border-radius:20px;border:2px solid #e0e0e0;text-align:center;box-shadow:0 4px 30px rgba(0,0,0,0.08);">
                            <h2 style="color:#1a1a2e;margin-bottom:15px;">🔐 Pairing Code Generated!</h2>
                            <div style="font-size:48px;font-weight:bold;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:20px;border-radius:15px;letter-spacing:5px;margin:20px 0;">
                                ${code}
                            </div>
                            <p style="font-size:16px;color:#555;margin-bottom:20px;">Enter this code in WhatsApp to link your device</p>
                            <div style="text-align:left;background:#f5f5f5;padding:15px;border-radius:12px;margin:15px 0;">
                                <p><strong style="color:#333;">📱 Steps to pair:</strong></p>
                                <ol style="color:#666;">
                                    <li>Open WhatsApp on your phone</li>
                                    <li>Go to Settings → Linked Devices → Link a Device</li>
                                    <li>Tap "Link with phone number instead"</li>
                                    <li>Enter this pairing code</li>
                                </ol>
                            </div>
                            <p style="font-size:18px;margin-top:15px;"><strong style="color:#667eea;">🔑 Session ID:</strong> <code style="background:#f0f0f0;padding:5px 10px;border-radius:8px;">${sessionId}</code></p>
                            <script>
                                localStorage.setItem('wa_session_id', '${sessionId}');
                                setTimeout(() => { window.location.href = '/session-status?sessionId=${sessionId}'; }, 3000);
                            </script>
                            <a href="/" style="display:inline-block;margin-top:20px;color:#667eea;text-decoration:none;">← Back to Dashboard</a>
                        </div>
                    `);
                } catch (err) {
                    if (!responseSent) {
                        responseSent = true;
                        res.send(`<div style="padding:20px;background:#fff3f3;border-radius:12px;border:1px solid #ffcdd2;"><h3 style="color:#d32f2f;">❌ Pairing Error: ${err.message}</h3><a href="/">Go Back</a></div>`);
                    }
                }
            }

            if (connection === "open") {
                console.log(`✅ WhatsApp Connected for ${num}! Session: ${sessionId}`);
                const ci = activeClients.get(sessionId);
                if (ci) { ci.isConnected = true; ci.lastActivity = Date.now(); }
                if (!responseSent && waClient.authState.creds.registered) {
                    responseSent = true;
                    res.send(`<div style="padding:20px;background:#e8f5e9;border-radius:12px;border:1px solid #c8e6c9;"><h3 style="color:#2e7d32;">✅ Already registered & connected!</h3><a href="/">Go Back</a></div>`);
                }
            } else if (connection === "close") {
                const ci = activeClients.get(sessionId);
                if (ci) ci.isConnected = false;
                if (lastDisconnect?.error?.output?.statusCode !== 401) {
                    await delay(10000);
                    initializeClient(sessionId, num, sessionPath);
                }
            }
        });

        // Timeout fallback
        setTimeout(() => {
            if (!responseSent) {
                responseSent = true;
                res.send(`<div style="padding:20px;background:#fff8e1;border-radius:12px;border:1px solid #ffe082;"><h3 style="color:#f57f17;">⏳ Timeout — Check number & try again</h3><a href="/">Go Back</a></div>`);
            }
        }, 45000);

    } catch (err) {
        console.error("Pairing error:", err);
        if (!responseSent) {
            responseSent = true;
            res.send(`<div style="padding:20px;background:#fff3f3;border-radius:12px;"><h3 style="color:#d32f2f;">Error: ${err.message}</h3><a href="/">Go Back</a></div>`);
        }
    }
});

// ==================== RECONNECT ====================
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
            number: num, authPath: sessionPath, tasks: [], lastActivity: Date.now()
        };
        clientInfo.client = waClient;
        activeClients.set(sessionId, clientInfo);

        waClient.ev.on("creds.update", saveCreds);
        waClient.ev.on("connection.update", async (s) => {
            const { connection, lastDisconnect } = s;
            if (connection === "open") {
                clientInfo.isConnected = true;
                clientInfo.lastActivity = Date.now();
                if (clientInfo.tasks && clientInfo.tasks.length > 0) {
                    for (const task of clientInfo.tasks) {
                        if (task.isSending && !task.stopRequested && task.messages && task.messages.length) {
                            sendMessagesLoop(sessionId, task.taskId, task.messages, waClient, task.target, task.targetType, task.delaySec, task.prefix, clientInfo.number);
                        }
                    }
                }
            } else if (connection === "close") {
                clientInfo.isConnected = false;
                if (lastDisconnect?.error?.output?.statusCode !== 401) {
                    await delay(10000);
                    initializeClient(sessionId, num, sessionPath);
                }
            }
        });
    } catch (err) {
        setTimeout(() => initializeClient(sessionId, num, sessionPath), 30000);
    }
}

// ==================== SEND MESSAGE ====================
app.post("/send-message", upload.single("messageFile"), async (req, res) => {
    const { target, targetType, delaySec, prefix } = req.body;
    const sessionId = userSessions.get(req.userIP);
    if (!sessionId || !activeClients.has(sessionId)) {
        return res.send(`<div style="padding:20px;background:#fff3f3;border-radius:12px;"><h2 style="color:#d32f2f;">❌ No active session! Pair first.</h2><a href="/">Go Back</a></div>`);
    }
    const clientInfo = activeClients.get(sessionId);
    const { client: waClient, number: senderNumber } = clientInfo;
    const filePath = req.file?.path;
    if (!target || !filePath || !targetType || !delaySec) {
        return res.send(`<div style="padding:20px;background:#fff3f3;border-radius:12px;"><h2 style="color:#d32f2f;">❌ Missing required fields</h2></div>`);
    }
    try {
        const messages = fs.readFileSync(filePath, "utf-8").split("\n").filter(m => m.trim() !== "");
        if (messages.length === 0) return res.send(`<div style="padding:20px;background:#fff3f3;border-radius:12px;"><h2 style="color:#d32f2f;">❌ Message file is empty</h2></div>`);

        const taskId = generateShortTaskId();
        const taskInfo = {
            taskId, target, targetType, messages,
            delaySec: parseInt(delaySec), prefix: prefix || "",
            isSending: true, stopRequested: false,
            totalMessages: messages.length, sentMessages: 0,
            currentMessageIndex: 0, startTime: new Date(), logs: []
        };
        if (!clientInfo.tasks) clientInfo.tasks = [];
        clientInfo.tasks.push(taskInfo);
        clientInfo.lastActivity = Date.now();
        taskLogs.set(taskId, []);
        systemStats.totalMessagesSent += messages.length;
        systemStats.totalTasks++;

        res.send(`<script>localStorage.setItem('wa_session_id','${sessionId}');window.location.href='/session-status?sessionId=${sessionId}';</script>`);
        sendMessagesLoop(sessionId, taskId, messages, waClient, target, targetType, taskInfo.delaySec, taskInfo.prefix, senderNumber);
    } catch (error) {
        systemStats.errors++;
        return res.send(`<div style="padding:20px;background:#fff3f3;border-radius:12px;"><h2 style="color:#d32f2f;">Error: ${error.message}</h2></div>`);
    }
});

// ==================== MESSAGE LOOP ====================
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
                logs.unshift({ type: "info", message: `[${new Date().toLocaleString()}] ⏳ Waiting for connection...`, timestamp: new Date() });
                if (logs.length > 100) logs.pop();
                taskLogs.set(taskId, logs);
                await delay(10000);
                continue;
            }
            let msg = messages[index];
            if (prefix && prefix.trim() !== "") msg = `${prefix.trim()} ${msg}`;

            const timestamp = new Date().toLocaleString();
            const messageNumber = taskInfo.sentMessages + 1;
            const cycleNumber = Math.floor(taskInfo.sentMessages / messages.length) + 1;

            try {
                await waClient.sendMessage(recipient, { text: msg });
                logs.unshift({ type: "success", message: `[${timestamp}] ✅ #${messageNumber} (Cycle ${cycleNumber}) sent to ${target}`, timestamp: new Date() });
                if (logs.length > 100) logs.pop();
                taskLogs.set(taskId, logs);
                taskInfo.sentMessages++;
                systemStats.totalMessagesSent++;
                index = (index + 1) % messages.length;
                taskInfo.currentMessageIndex = index;
                taskInfo.currentCycle = cycleNumber;
                clientInfo.lastActivity = Date.now();
            } catch (sendError) {
                logs.unshift({ type: "error", message: `[${timestamp}] ❌ Failed #${messageNumber}: ${sendError.message}`, timestamp: new Date() });
                if (logs.length > 100) logs.pop();
                taskLogs.set(taskId, logs);
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
        systemStats.errors++;
        systemStats.failedTasks++;
        taskInfo.error = error.message;
        taskInfo.isSending = false;
        taskInfo.endTime = new Date();
    }
}

// ==================== SESSION STATUS ====================
app.get("/session-status", (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId || !activeClients.has(sessionId)) {
        return res.send(`<div style="padding:30px;text-align:center;background:#fff;border-radius:16px;box-shadow:0 2px 20px rgba(0,0,0,0.1);"><h3 style="color:#d32f2f;">❌ Session Not Found</h3><a href="/" style="color:#667eea;">Go Back</a></div>`);
    }
    const ci = activeClients.get(sessionId);
    let tasksHtml = '';
    if (ci.tasks && ci.tasks.length > 0) {
        tasksHtml = `<div style="margin-top:20px;"><h4 style="color:#1a1a2e;">📋 Active Tasks (${ci.tasks.length})</h4>`;
        for (const task of ci.tasks) {
            const statusColor = task.isSending ? '#4caf50' : (task.stopRequested ? '#f44336' : '#ff9800');
            const statusText = task.isSending ? '🔄 RUNNING (LOOP)' : (task.stopRequested ? '⏹️ STOPPED' : '✅ COMPLETED');
            tasksHtml += `
                <div style="background:#fff;padding:20px;border-radius:16px;margin-bottom:15px;border-left:4px solid ${statusColor};box-shadow:0 2px 10px rgba(0,0,0,0.06);">
                    <h5 style="color:#1a1a2e;margin:0 0 10px 0;">🎯 ${task.target} (${task.targetType})</h5>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;color:#555;">
                        <div><strong>Task ID:</strong> ${task.taskId}</div>
                        <div><strong>Status:</strong> <span style="color:${statusColor};">${statusText}</span></div>
                        <div><strong>Sent:</strong> ${task.sentMessages}</div>
                        <div><strong>Cycle:</strong> ${task.currentCycle || 1}</div>
                        <div><strong>Total:</strong> ${task.totalMessages} per cycle</div>
                        <div><strong>Started:</strong> ${task.startTime.toLocaleString()}</div>
                    </div>
                    <form action="/stop-task" method="POST" style="margin-top:15px;">
                        <input type="hidden" name="sessionId" value="${sessionId}">
                        <input type="hidden" name="taskId" value="${task.taskId}">
                        <button type="submit" style="background:#f44336;color:white;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;">⏹️ Stop Task</button>
                    </form>
                </div>`;
        }
        tasksHtml += '</div>';
    } else {
        tasksHtml = '<div style="text-align:center;padding:40px;color:#ff9800;">✨ No active tasks. Start sending messages!</div>';
    }
    res.send(`
        <div style="max-width:900px;margin:20px auto;padding:20px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding:15px;background:#fff;border-radius:16px;box-shadow:0 2px 15px rgba(0,0,0,0.06);">
                <div>
                    <h3 style="color:#1a1a2e;margin:0;">📱 Session: ${sessionId}</h3>
                    <p style="margin:5px 0 0 0;color:#777;">WhatsApp: ${ci.number}</p>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:18px;color:${ci.isConnected ? '#4caf50' : '#f44336'}">
                        ${ci.isConnected ? '🟢 CONNECTED' : '🔴 DISCONNECTED'}
                    </div>
                    <small style="color:#999;">Last active: ${new Date(ci.lastActivity).toLocaleString()}</small>
                </div>
            </div>
            ${tasksHtml}
            <div style="margin-top:20px;text-align:center;">
                <a href="/" style="color:#667eea;">← Back to Dashboard</a>
            </div>
        </div>
    `);
});

// ==================== STOP TASK / SESSION ====================
app.post("/stop-task", async (req, res) => {
    const { sessionId, taskId } = req.body;
    if (activeClients.has(sessionId)) {
        const ci = activeClients.get(sessionId);
        const task = ci.tasks?.find(t => t.taskId === taskId);
        if (task) { task.stopRequested = true; task.isSending = false; task.endTime = new Date(); }
    }
    res.redirect(`/session-status?sessionId=${sessionId}`);
});

app.post("/stop-session", async (req, res) => {
    const { sessionId } = req.body;
    if (activeClients.has(sessionId)) {
        const ci = activeClients.get(sessionId);
        if (ci.tasks) { for (const t of ci.tasks) { t.stopRequested = true; t.isSending = false; } }
        if (ci.client) ci.client.end();
        activeClients.delete(sessionId);
        for (let [ip, sid] of userSessions.entries()) { if (sid === sessionId) userSessions.delete(ip); }
    }
    res.redirect('/');
});

// ==================== GET GROUPS — FIXED ====================
app.get("/get-groups", async (req, res) => {
    const sessionId = userSessions.get(req.userIP);
    if (!sessionId || !activeClients.has(sessionId)) {
        return res.send(`<div style="padding:20px;background:#fff3f3;border-radius:12px;"><h3 style="color:#d32f2f;">❌ No active session. Pair first.</h3></div>`);
    }
    try {
        const { client: waClient, number } = activeClients.get(sessionId);
        const groups = await waClient.groupFetchAllParticipating();
        if (Object.keys(groups).length === 0) {
            return res.send(`<div><h3>No groups found</h3></div>`);
        }
        let html = `<div><h3 style="color:#1a1a2e;">👥 Connected as: ${number}</h3><hr>`;
        let idx = 0;
        for (const id in groups) {
            const g = groups[id];
            const cleanId = id.replace('@g.us', '');
            idx++;
            html += `<div style="background:#f9f9f9;padding:15px;border-radius:12px;margin-bottom:10px;border-left:3px solid #667eea;">
                <strong>${idx}. ${g.subject || 'Unnamed Group'}</strong><br>
                <code style="background:#eee;padding:4px 8px;border-radius:6px;">${cleanId}</code><br>
                Members: ${g.participants ? g.participants.length : 0}<br>
                <button onclick="copyToClipboard('${cleanId}')" style="margin-top:10px;background:#667eea;color:white;border:none;padding:5px 12px;border-radius:8px;cursor:pointer;">📋 Copy ID</button>
            </div>`;
        }
        html += `<script>function copyToClipboard(t){navigator.clipboard.writeText(t);alert("Copied: "+t);}</script></div>`;
        res.send(html);
    } catch (error) {
        res.send(`<div><h3>Error: ${error.message}</h3></div>`);
    }
});

// ==================== MAIN HOME — WHITE RGB THEME ====================
app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>💎 Waleed Paid Tool Offline | White RGB</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/css/bootstrap.min.css" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{
    font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;
    background:linear-gradient(135deg,#f5f7fa 0%,#e4e9f2 50%,#f0f4ff 100%);
    min-height:100vh;padding:20px;color:#1a1a2e;
}
@keyframes rgbBorder{
    0%{border-color:#ff0000;box-shadow:0 0 20px rgba(255,0,0,0.15);}
    25%{border-color:#ff00ff;box-shadow:0 0 20px rgba(255,0,255,0.15);}
    50%{border-color:#0066ff;box-shadow:0 0 20px rgba(0,102,255,0.15);}
    75%{border-color:#00ffcc;box-shadow:0 0 20px rgba(0,255,204,0.15);}
    100%{border-color:#00ff00;box-shadow:0 0 20px rgba(0,255,0,0.15);}
}
@keyframes gradientShift{
    0%{background-position:0% 50%;}
    50%{background-position:100% 50%;}
    100%{background-position:0% 50%;}
}
.container-main{
    max-width:1400px;margin:0 auto;background:rgba(255,255,255,0.85);
    backdrop-filter:blur(12px);border-radius:28px;padding:30px;
    border:2px solid;animation:rgbBorder 3s linear infinite;
    box-shadow:0 8px 40px rgba(0,0,0,0.06);
}
.header{
    text-align:center;margin-bottom:35px;padding:30px;
    background:rgba(255,255,255,0.7);backdrop-filter:blur(10px);
    border-radius:24px;animation:rgbBorder 4s linear infinite;
}
.logo{
    font-size:3rem;font-weight:800;
    background:linear-gradient(45deg,#ff0000,#ff00ff,#0066ff,#00ffcc,#00cc00);
    background-size:300% 300%;
    -webkit-background-clip:text;background-clip:text;
    -webkit-text-fill-color:transparent;
    animation:gradientShift 3s ease infinite;
}
.tagline{color:#667eea;letter-spacing:3px;margin-top:10px;font-weight:600;}
.system-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:20px;margin:25px 0;}
.stat-card{
    background:#fff;padding:20px;border-radius:20px;text-align:center;
    border:1px solid #e0e0e0;transition:all 0.3s ease;
    box-shadow:0 2px 10px rgba(0,0,0,0.04);
}
.stat-card:hover{transform:translateY(-5px) scale(1.02);border-color:#667eea;box-shadow:0 4px 25px rgba(102,126,234,0.2);}
.stat-number{font-size:2.2rem;font-weight:bold;background:linear-gradient(135deg,#667eea,#764ba2);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}
.stat-label{font-size:0.85rem;color:#888;}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:25px;margin-bottom:35px;}
.card{
    background:rgba(255,255,255,0.8);backdrop-filter:blur(12px);
    padding:25px;border-radius:24px;border:1px solid #e0e0e0;
    transition:all 0.3s ease;animation:rgbBorder 5s linear infinite;
    box-shadow:0 2px 15px rgba(0,0,0,0.04);
}
.card:hover{transform:translateY(-8px);}
.card-header{display:flex;align-items:center;gap:15px;margin-bottom:25px;}
.card-icon{
    width:55px;height:55px;
    background:linear-gradient(135deg,#667eea,#764ba2,#f093fb);
    background-size:200% 200%;border-radius:16px;
    display:flex;align-items:center;justify-content:center;
    font-size:1.8rem;color:white;animation:gradientShift 3s ease infinite;
}
.card-title{font-size:1.4rem;font-weight:700;color:#1a1a2e;}
.form-group{margin-bottom:18px;}
.form-label{display:block;margin-bottom:8px;font-weight:600;color:#555;}
.form-input,.form-select{
    width:100%;padding:14px 18px;background:#f8f9fa;
    border:1px solid #ddd;border-radius:14px;color:#333;font-size:14px;
}
.form-input:focus,.form-select:focus{outline:none;border-color:#667eea;box-shadow:0 0 15px rgba(102,126,234,0.2);}
.btn{
    width:100%;padding:14px;
    background:linear-gradient(135deg,#667eea,#764ba2);
    background-size:200% 200%;color:white;border:none;border-radius:14px;
    font-size:16px;font-weight:600;cursor:pointer;
    transition:all 0.3s ease;margin-top:10px;
}
.btn:hover{transform:scale(1.02);background-position:100% 50%;}
.btn-secondary{background:linear-gradient(135deg,#6c757d,#495057);}
.btn-danger{background:linear-gradient(135deg,#ff416c,#ff4b2b);}
.btn-warning{background:linear-gradient(135deg,#f7971e,#ffd200);color:#333;}
.btn-info{background:linear-gradient(135deg,#00c6ff,#0072ff);}
.system-panel{
    background:rgba(255,255,255,0.8);backdrop-filter:blur(12px);
    padding:25px;border-radius:24px;margin-bottom:25px;
    animation:rgbBorder 6s linear infinite;box-shadow:0 2px 15px rgba(0,0,0,0.04);
}
.system-controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px;}
.live-data{
    background:#f8f9fa;padding:18px;border-radius:16px;
    font-family:monospace;font-size:12px;max-height:200px;
    overflow-y:auto;color:#333;border:1px solid #e0e0e0;
}
.console-footer{
    background:rgba(255,255,255,0.8);backdrop-filter:blur(12px);
    padding:25px;border-radius:24px;margin-top:30px;
    animation:rgbBorder 4s linear infinite;box-shadow:0 2px 15px rgba(0,0,0,0.04);
}
.console-output{
    background:#fafafa;padding:20px;border-radius:16px;
    max-height:250px;overflow-y:auto;
    font-family:'Courier New',monospace;font-size:13px;
    color:#333;border:1px solid #e0e0e0;
}
.console-log{padding:6px 12px;margin:4px 0;border-left:3px solid #667eea;border-radius:4px;}
.console-info{color:#2196f3;border-left-color:#2196f3;}
.console-success{color:#4caf50;border-left-color:#4caf50;}
.console-error{color:#f44336;border-left-color:#f44336;}
hr{border-color:#e0e0e0;margin:20px 0;}
@media(max-width:768px){.container-main{padding:15px;}.grid{grid-template-columns:1fr;}.logo{font-size:2rem;}}
</style>
</head>
<body>
<div class="container-main">
    <div class="header">
        <div class="logo"><i class="fab fa-whatsapp"></i> Waleed Paid Tool Offline</div>
        <div class="tagline">✦ WHITE RGB EDITION | 24/7 NONSTOP ✦</div>
        <div class="system-stats">
            <div class="stat-card"><div class="stat-number" id="statMessages">0</div><div class="stat-label"><i class="fas fa-envelope"></i> Messages</div></div>
            <div class="stat-card"><div class="stat-number" id="statSessions">0</div><div class="stat-label"><i class="fas fa-mobile-alt"></i> Sessions</div></div>
            <div class="stat-card"><div class="stat-number" id="statTasks">0</div><div class="stat-label"><i class="fas fa-tasks"></i> Active Tasks</div></div>
            <div class="stat-card"><div class="stat-number" id="statUptime">0h</div><div class="stat-label"><i class="fas fa-clock"></i> Uptime</div></div>
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
        <div class="live-data" id="systemInfo">✨ System Ready | White RGB Mode Active ✨</div>
    </div>

    <div class="grid">
        <div class="card">
            <div class="card-header"><div class="card-icon"><i class="fas fa-link"></i></div><div class="card-title">Pair Device</div></div>
            <div class="form-group"><label class="form-label"><i class="fas fa-phone"></i> WhatsApp Number</label><input type="text" class="form-input" id="numberInput" placeholder="923001234567"></div>
            <button class="btn" onclick="generateCode()"><i class="fas fa-code"></i> Generate Pairing Code</button>
            <div id="pairingResult" style="margin-top:15px;"></div>
        </div>

        <div class="card">
            <div class="card-header"><div class="card-icon"><i class="fas fa-paper-plane"></i></div><div class="card-title">Broadcast Engine</div></div>
            <form action="/send-message" method="POST" enctype="multipart/form-data">
                <div class="form-group"><label class="form-label">Target Type</label><select class="form-select" name="targetType" required><option value="">Select</option><option value="number">Phone Number</option><option value="group">Group ID</option></select></div>
                <div class="form-group"><label class="form-label">Target</label><input type="text" class="form-input" name="target" placeholder="923001234567" required></div>
                <div class="form-group"><label class="form-label">Messages File (.txt)</label><input type="file" class="form-input" name="messageFile" accept=".txt" required></div>
                <div class="form-group"><label class="form-label">Prefix (Optional)</label><input type="text" class="form-input" name="prefix" placeholder="🔥 Special: "></div>
                <div class="form-group"><label class="form-label">Delay (Seconds)</label><input type="number" class="form-input" name="delaySec" min="5" value="10" required></div>
                <button type="submit" class="btn"><i class="fas fa-play"></i> Start Broadcasting</button>
            </form>
        </div>

        <div class="card">
            <div class="card-header"><div class="card-icon"><i class="fas fa-user-shield"></i></div><div class="card-title">Session Vault</div></div>
            <div class="form-group"><label class="form-label">Your Number</label><input type="text" class="form-input" id="numberInputForSession" placeholder="923001234567"></div>
            <button class="btn" onclick="generateCodeForSession()"><i class="fas fa-key"></i> Get Pairing Code</button>
            <hr>
            <div class="form-group"><label class="form-label">Session ID</label><input type="text" class="form-input" id="sessionIdDisplay" readonly placeholder="Your session will appear here"></div>
            <button class="btn btn-secondary" onclick="showMySession()"><i class="fas fa-id-card"></i> Show My Session</button>
            <button class="btn btn-info" onclick="getMyGroups()" style="margin-top:10px;"><i class="fas fa-users"></i> My Groups</button>
            <button class="btn btn-danger" onclick="stopMySession()" style="margin-top:10px;"><i class="fas fa-power-off"></i> Stop Session</button>
        </div>

        <div class="card">
            <div class="card-header"><div class="card-icon"><i class="fas fa-chart-simple"></i></div><div class="card-title">Task Monitor</div></div>
            <div class="form-group"><label class="form-label">Session ID</label><input type="text" class="form-input" id="sessionIdInput" placeholder="Enter your session ID"></div>
            <button class="btn" onclick="viewTasks()"><i class="fas fa-eye"></i> View My Tasks</button>
            <div id="sessionTasksResult" style="margin-top:15px;"></div>
        </div>
    </div>

    <div class="console-footer">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px;">
            <h4 style="color:#1a1a2e;margin:0;"><i class="fas fa-terminal"></i> Live Console</h4>
            <button onclick="clearConsole()" style="background:#f44336;color:white;border:none;padding:8px 18px;border-radius:12px;cursor:pointer;"><i class="fas fa-trash"></i> Clear</button>
        </div>
        <div id="consoleOutput" class="console-output"></div>
    </div>
</div>

<script>
async function refreshStats(){
    try{
        const res=await fetch('/api/stats');
        const s=await res.json();
        document.getElementById('statMessages').innerText=s.totalMessagesSent.toLocaleString();
        document.getElementById('statSessions').innerText=s.activeSessions;
        document.getElementById('statTasks').innerText=s.activeTasks;
        document.getElementById('statUptime').innerText=s.uptime;
    }catch(e){}
}
async function showSystemInfo(){
    try{
        const res=await fetch('/api/stats');
        const s=await res.json();
        document.getElementById('systemInfo').innerHTML='📊 SYSTEM STATS<br>✨ Messages: '+s.totalMessagesSent.toLocaleString()+'<br>🔗 Sessions: '+s.activeSessions+'<br>⚡ Tasks: '+s.activeTasks+'<br>⏰ Uptime: '+s.uptime+'<br>❌ Errors: '+s.errors;
    }catch(e){}
}
async function showAllSessions(){
    try{
        const res=await fetch('/api/sessions');
        const sessions=await res.json();
        if(sessions.length===0){document.getElementById('systemInfo').innerHTML='No active sessions';return;}
        let html='👥 ACTIVE SESSIONS:<br><br>';
        sessions.forEach(s=>{html+='🔹 ID: '+s.sessionId+'<br>📱 Number: '+s.number+'<br>🔌 '+(s.isConnected?'🟢 CONNECTED':'🔴 DISCONNECTED')+'<br>📋 Tasks: '+s.taskCount+'<br><br>';});
        document.getElementById('systemInfo').innerHTML=html;
    }catch(e){}
}
function clearLogs(){if(confirm('Clear logs?')){document.getElementById('systemInfo').innerHTML='✨ Logs cleared ✨';showNotif('Logs cleared','warning');}}
async function generateCode(){
    const number=document.getElementById('numberInput').value;
    if(!number){showNotif('Enter number','error');return;}
    document.getElementById('pairingResult').innerHTML='<div style="text-align:center;color:#667eea;"><i class="fas fa-spinner fa-spin"></i> Generating...</div>';
    try{
        const res=await fetch('/code?number='+encodeURIComponent(number));
        const result=await res.text();
        document.getElementById('pairingResult').innerHTML=result;
        refreshStats();
    }catch(e){showNotif('Error: '+e.message,'error');}
}
async function generateCodeForSession(){
    const number=document.getElementById('numberInputForSession').value;
    if(!number){showNotif('Enter number','error');return;}
    document.getElementById('pairingResult').innerHTML='<div style="text-align:center;color:#667eea;"><i class="fas fa-spinner fa-spin"></i> Generating...</div>';
    try{
        const res=await fetch('/code?number='+encodeURIComponent(number));
        const result=await res.text();
        document.getElementById('pairingResult').innerHTML=result;
        refreshStats();
    }catch(e){showNotif('Error: '+e.message,'error');}
}
function showMySession(){
    const id=localStorage.getItem('wa_session_id');
    if(id){document.getElementById('sessionIdDisplay').value=id;showNotif('Session: '+id,'success');}
    else{showNotif('No session found','warning');}
}
async function getMyGroups(){
    try{
        const res=await fetch('/get-groups');
        const result=await res.text();
        showGroupsModal(result);
    }catch(e){showNotif('Error: '+e.message,'error');}
}
async function stopMySession(){
    const id=localStorage.getItem('wa_session_id');
    if(!id){showNotif('No session','warning');return;}
    if(confirm('Stop session?')){
        try{
            await fetch('/stop-session',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'sessionId='+encodeURIComponent(id)});
            showNotif('Session stopped','success');
            localStorage.removeItem('wa_session_id');
            document.getElementById('sessionIdDisplay').value='';
            refreshStats();
        }catch(e){showNotif('Error','error');}
    }
}
function viewTasks(){
    const id=document.getElementById('sessionIdInput').value.trim();
    if(!id){showNotif('Enter Session ID','error');return;}
    window.location.href='/session-status?sessionId='+encodeURIComponent(id);
}
function showGroupsModal(html){
    const modal=document.createElement('div');
    modal.id='groupsModal';
    modal.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);display:flex;justify-content:center;align-items:center;z-index:10000;backdrop-filter:blur(8px);';
    modal.innerHTML='<div style="background:#fff;border-radius:28px;padding:30px;max-width:90%;max-height:90vh;width:800px;overflow-y:auto;color:#333;box-shadow:0 10px 50px rgba(0,0,0,0.2);"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;"><h2 style="color:#1a1a2e;"><i class="fas fa-users"></i> Your Groups</h2><button onclick="closeGroupsModal()" style="background:#f44336;color:white;border:none;border-radius:50%;width:40px;height:40px;font-size:20px;cursor:pointer;">✕</button></div><div>'+html+'</div><div style="margin-top:20px;"><button onclick="closeGroupsModal()" style="background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:10px 20px;border-radius:12px;border:none;font-weight:bold;cursor:pointer;">Close</button></div></div>';
    document.body.appendChild(modal);
}
function closeGroupsModal(){const m=document.getElementById('groupsModal');if(m)m.remove();}
function showNotif(msg,type){
    const n=document.createElement('div');
    const bg=type==='error'?'linear-gradient(135deg,#ff416c,#ff4b2b)':type==='success'?'linear-gradient(135deg,#667eea,#764ba2)':'linear-gradient(135deg,#f7971e,#ffd200)';
    const color=type==='warning'?'#333':'white';
    n.style.cssText='position:fixed;top:20px;right:20px;padding:15px 25px;background:'+bg+';color:'+color+';border-radius:16px;z-index:10001;font-weight:bold;box-shadow:0 5px 20px rgba(0,0,0,0.15);';
    n.innerHTML=msg;
    document.body.appendChild(n);
    setTimeout(()=>n.remove(),4000);
}
function addLog(msg,type){
    const div=document.getElementById('consoleOutput');
    const entry=document.createElement('div');
    entry.className='console-log console-'+(type||'info');
    entry.innerHTML='['+new Date().toLocaleTimeString()+'] '+msg;
    div.insertBefore(entry,div.firstChild);
    while(div.children.length>100)div.removeChild(div.lastChild);
}
function clearConsole(){document.getElementById('consoleOutput').innerHTML='';addLog('Console cleared','info');}
document.addEventListener('DOMContentLoaded',function(){
    const id=localStorage.getItem('wa_session_id');
    if(id){document.getElementById('sessionIdDisplay').value=id;document.getElementById('sessionIdInput').value=id;}
    refreshStats();
    setInterval(refreshStats,30000);
    addLog('🔥 Waleed Paid Tool Offline — White RGB Active','success');
    addLog('✨ Pair your device to start','info');
});
window.closeGroupsModal=closeGroupsModal;
</script>
</body>
</html>`);
});

// ==================== ERROR HANDLERS ====================
process.on('uncaughtException', (error) => console.error('Uncaught:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
process.on('SIGINT', () => {
    activeClients.forEach(({ client }) => { if (client) client.end(); });
    process.exit();
});

app.listen(PORT, () => {
    console.log(`💎 Waleed Paid Tool Offline — White RGB Running`);
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`✨ Pairing Fixed | 24/7 Mode Active`);
});
