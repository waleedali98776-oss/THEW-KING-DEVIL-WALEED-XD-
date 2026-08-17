const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const multer = require("multer");
const axios = require("axios");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
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

// Directories
const dirs = ["temp", "uploads", "logs", "data"];
dirs.forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir); });

const upload = multer({ dest: "uploads/" });
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Maps
const activeClients = new Map();
const taskLogs = new Map();
const userSessions = new Map();

// System Statistics
const systemStats = {
    totalMessagesSent: 0, totalSessions: 0, totalTasks: 0,
    uptime: Date.now(), errors: 0, successfulTasks: 0,
    failedTasks: 0, requestsServed: 0, totalLogins: 0, rejectedLogins: 0
};
try {
    if (fs.existsSync("data/stats.json")) {
        Object.assign(systemStats, JSON.parse(fs.readFileSync("data/stats.json", "utf8")));
    }
} catch (e) {}

function generateShortSessionId() { return Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10); }
function generateShortTaskId() { return "t" + Math.random().toString(36).substring(2, 8); }
function saveStats() { try { fs.writeFileSync("data/stats.json", JSON.stringify(systemStats, null, 2)); } catch (e) {} }

// ============================================================
// 🔐 WALEED KEY APPROVAL SYSTEM (GitHub + Local approval.txt)
// ============================================================
// 1. GitHub pe public repo banao
// 2. Usme "approval.txt" file banao (har line pe ek key)
// 3. File ka RAW URL neeche paste karo 👇
// ============================================================
const APPROVAL_GITHUB_URL = process.env.APPROVAL_URL || "https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/approval.txt";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "WALEED-ADMIN-786";
const APPROVAL_FILE = path.join("data", "approval.txt");
const AUTH_FILE = path.join("data", "auth.json");

const githubKeys = new Set();
const localKeys = new Set();
const authSessions = new Map();   // token -> { key, loginTime }
const loginAttempts = new Map();  // ip -> { count, resetAt }

function normalizeKey(k) { return (k || "").trim().toUpperCase(); }

function parseKeysFromText(text) {
    const keys = new Set();
    String(text || "").split(/\r?\n/).forEach(line => {
        const k = line.trim();
        if (k && !k.startsWith("#")) keys.add(k.toUpperCase());
    });
    return keys;
}

function isKeyApproved(key) {
    const k = normalizeKey(key);
    return k.length > 0 && (githubKeys.has(k) || localKeys.has(k));
}

function totalApprovedKeys() { return new Set([...githubKeys, ...localKeys]).size; }

function loadLocalApproval() {
    try {
        if (fs.existsSync(APPROVAL_FILE)) {
            parseKeysFromText(fs.readFileSync(APPROVAL_FILE, "utf8")).forEach(k => localKeys.add(k));
            console.log(`🔑 Local approval.txt loaded | ${localKeys.size} keys`);
        } else {
            fs.writeFileSync(APPROVAL_FILE, "# WALEED APPROVAL KEYS\n# One key per line\n");
        }
    } catch (e) {}
}

async function fetchGithubApprovals() {
    try {
        if (APPROVAL_GITHUB_URL.includes("YOUR_USERNAME")) {
            console.log("⚠️ APPROVAL_URL set nahi - sirf local approval.txt use ho raha hai");
            return;
        }
        const sep = APPROVAL_GITHUB_URL.includes("?") ? "&" : "?";
        const res = await axios.get(APPROVAL_GITHUB_URL + sep + "t=" + Date.now(), {
            timeout: 10000,
            headers: { "User-Agent": "WALEED-WA-BOT" }
        });
        githubKeys.clear();
        parseKeysFromText(res.data).forEach(k => githubKeys.add(k));
        console.log(`✅ GitHub approval.txt synced | Total approved keys: ${totalApprovedKeys()}`);
    } catch (e) {
        console.error("❌ GitHub approval fetch failed:", e.message);
    }
}

function generateKey() {
    const seg = () => crypto.randomBytes(2).toString("hex").toUpperCase();
    return `WALEED-${seg()}-${seg()}-${seg()}`;
}

function saveAuthTokens() {
    try {
        const obj = {};
        for (const [t, s] of authSessions.entries()) obj[t] = s;
        fs.writeFileSync(AUTH_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {}
}
function loadAuthTokens() {
    try {
        if (fs.existsSync(AUTH_FILE)) {
            const obj = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
            for (const t in obj) authSessions.set(t, obj[t]);
        }
    } catch (e) {}
}

// ============================================================
// 🎨 LOGIN PAGE - WHITE RGB THEME (WALEED)
// ============================================================
const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🔐 WALEED | Approval Login</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;600;700;800&family=Orbitron:wght@700;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Poppins',sans-serif;background:#f5f7ff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;overflow:hidden;}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(circle at 15% 20%,rgba(255,0,110,.12),transparent 40%),radial-gradient(circle at 85% 30%,rgba(0,200,255,.12),transparent 40%),radial-gradient(circle at 50% 90%,rgba(140,0,255,.12),transparent 45%);}
.orb{position:fixed;border-radius:50%;filter:blur(90px);opacity:.30;z-index:0;animation:float 12s ease-in-out infinite;}
.o1{width:340px;height:340px;background:#ff0066;top:-80px;left:-80px;}
.o2{width:300px;height:300px;background:#00c8ff;bottom:-60px;right:-60px;animation-delay:4s;}
@keyframes float{0%,100%{transform:translateY(0) scale(1);}50%{transform:translateY(-35px) scale(1.08);}}
@keyframes rgbBorder{0%{border-color:#ff0044;box-shadow:0 0 26px rgba(255,0,68,.30);}25%{border-color:#ff9900;box-shadow:0 0 26px rgba(255,153,0,.30);}50%{border-color:#00c8ff;box-shadow:0 0 26px rgba(0,200,255,.30);}75%{border-color:#8c00ff;box-shadow:0 0 26px rgba(140,0,255,.30);}100%{border-color:#ff0044;box-shadow:0 0 26px rgba(255,0,68,.30);}}
@keyframes gradientShift{0%{background-position:0% 50%;}50%{background-position:100% 50%;}100%{background-position:0% 50%;}}
.login-card{position:relative;z-index:2;width:100%;max-width:440px;background:rgba(255,255,255,.85);backdrop-filter:blur(16px);border-radius:30px;padding:40px 32px;text-align:center;border:2px solid transparent;animation:rgbBorder 4s linear infinite;}
.badge{display:inline-block;padding:6px 20px;border-radius:50px;background:linear-gradient(135deg,#ff0044,#ff9900,#00c8ff,#8c00ff);background-size:300% 300%;animation:gradientShift 4s ease infinite;color:#fff;font-size:.72rem;font-weight:700;letter-spacing:2px;margin-bottom:16px;}
.logo{font-family:'Orbitron',sans-serif;font-size:2.6rem;font-weight:900;letter-spacing:4px;background:linear-gradient(45deg,#ff0044,#ff9900,#00c855,#00c8ff,#8c00ff,#ff0044);background-size:400% 400%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:gradientShift 4s ease infinite;}
.tagline{color:#555;letter-spacing:3px;margin:8px 0 25px;font-size:.8rem;font-weight:600;}
.key-input{width:100%;padding:15px 18px;border:1.5px solid #e4e7f5;border-radius:14px;font-size:15px;text-align:center;letter-spacing:2px;font-weight:600;background:#fbfcff;color:#222;text-transform:uppercase;transition:all .3s;}
.key-input:focus{outline:none;border-color:#00c8ff;box-shadow:0 0 0 4px rgba(0,200,255,.15);}
.unlock-btn{width:100%;margin-top:18px;padding:15px;border:none;border-radius:14px;color:#fff;font-size:16px;font-weight:700;letter-spacing:1px;cursor:pointer;background:linear-gradient(135deg,#ff0044,#ff9900,#00c8ff,#8c00ff);background-size:300% 300%;animation:gradientShift 5s ease infinite;box-shadow:0 8px 22px rgba(140,0,255,.25);transition:transform .25s;}
.unlock-btn:hover{transform:scale(1.02);}
.err{background:#ffe8ee;color:#e00040;border:1.5px solid #ffb3c4;padding:12px;border-radius:12px;font-size:.85rem;font-weight:600;margin-bottom:18px;}
.hint{margin-top:20px;font-size:.75rem;color:#999;letter-spacing:.5px;}
</style>
</head>
<body>
<div class="orb o1"></div>
<div class="orb o2"></div>
<div class="login-card">
<div class="badge">👑 PREMIUM APPROVAL SYSTEM</div>
<div class="logo"><i class="fab fa-whatsapp"></i> WALEED</div>
<div class="tagline">✦ ENTER YOUR APPROVAL KEY ✦</div>
{{ERROR}}
<form method="POST" action="/verify">
<input type="text" name="key" class="key-input" placeholder="WALEED-XXXX-XXXX-XXXX" required autocomplete="off">
<button type="submit" class="unlock-btn"><i class="fas fa-unlock"></i> UNLOCK DASHBOARD</button>
</form>
<p class="hint">🔑 Key admin se lein • Approval GitHub approval.txt se verify hota hai</p>
</div>
</body>
</html>`;

// ============================================================
// 🔓 PUBLIC ROUTES
// ============================================================
app.get("/login", (req, res) => {
    const err = req.query.error ? '<div class="err">❌ Invalid Key! Sahi approval key enter karein ya admin se lein.</div>' : "";
    res.send(LOGIN_PAGE.replace("{{ERROR}}", err));
});

app.post("/verify", (req, res) => {
    const ip = req.ip || "unknown";
    const now = Date.now();
    let attempt = loginAttempts.get(ip);
    if (!attempt || now > attempt.resetAt) {
        attempt = { count: 0, resetAt: now + 10 * 60 * 1000 };
        loginAttempts.set(ip, attempt);
    }
    if (attempt.count >= 5) {
        return res.status(429).send('<div style="font-family:sans-serif;text-align:center;padding:50px;"><h2>⛔ Too Many Attempts!</h2><p>10 minute baad dobara try karein.</p><a href="/login">Back</a></div>');
    }
    attempt.count++;

    const key = normalizeKey(req.body.key);
    if (!isKeyApproved(key)) {
        systemStats.rejectedLogins++;
        console.log(`🚫 Rejected key: "${key}" from ${ip}`);
        return res.redirect("/login?error=1");
    }

    loginAttempts.delete(ip);
    const token = crypto.randomBytes(24).toString("hex");
    authSessions.set(token, { key, loginTime: Date.now() });
    saveAuthTokens();
    systemStats.totalLogins++;
    console.log(`🔓 Approved login with key: ${key} from ${ip}`);
    res.setHeader("Set-Cookie", `wa_token=${token}; Path=/; HttpOnly; Max-Age=${7 * 24 * 60 * 60}; SameSite=Strict`);
    res.redirect("/");
});

app.get("/logout", (req, res) => {
    const token = req.cookies && req.cookies.wa_token;
    if (token) authSessions.delete(token);
    saveAuthTokens();
    res.setHeader("Set-Cookie", "wa_token=; Path=/; HttpOnly; Max-Age=0");
    res.redirect("/login");
});

app.get("/keygen", (req, res) => {
    if (req.query.admin !== ADMIN_SECRET) return res.status(403).send("❌ Galat admin secret!");
    const key = generateKey();
    fs.appendFileSync(APPROVAL_FILE, key + "\n");
    localKeys.add(key);
    res.send(`<!DOCTYPE html><html><head><title>WALEED KeyGen</title><style>body{font-family:sans-serif;background:#f5f7ff;padding:40px;text-align:center;}.box{max-width:600px;margin:0 auto;background:#fff;padding:35px;border-radius:24px;border:2px solid #8c00ff;box-shadow:0 15px 40px rgba(140,0,255,.2);}.key{font-size:26px;font-weight:900;letter-spacing:3px;padding:18px;background:linear-gradient(135deg,#ff0044,#8c00ff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;margin:15px 0;}</style></head><body><div class="box"><h2>🔑 New Key Generated!</h2><div class="key">${key}</div><p>✅ Local approval.txt mein save (foran active).</p><p>🌐 Permanent ke liye: yeh key GitHub ki <b>approval.txt</b> mein bhi add karein.</p><a href="/keygen?admin=${req.query.admin}">🔄 Ek aur key banao</a></div></body></html>`);
});

// ============================================================
// 🛡️ AUTH GUARD - neeche ki har route protected hai
// ============================================================
app.use((req, res, next) => {
    const token = req.cookies && req.cookies.wa_token;
    const sess = token ? authSessions.get(token) : null;
    if (sess && isKeyApproved(sess.key)) {
        req.approvedKey = sess.key;
        req.userIP = req.ip || req.connection.remoteAddress;
        systemStats.requestsServed++;
        return next();
    }
    res.redirect("/login");
});

// ============================================================
// API ROUTES
// ============================================================
app.get("/api/stats", (req, res) => {
    const uptime = Date.now() - systemStats.uptime;
    const hours = Math.floor(uptime / (1000 * 60 * 60));
    const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
    res.json({
        ...systemStats,
        uptime: `${hours}h ${minutes}m`,
        activeSessions: activeClients.size,
        activeTasks: Array.from(activeClients.values()).reduce((acc, c) => acc + (c.tasks ? c.tasks.length : 0), 0),
        approvedKeys: totalApprovedKeys(),
        timestamp: new Date().toISOString()
    });
});

app.get("/api/sessions", (req, res) => {
    res.json(Array.from(activeClients.entries()).map(([sessionId, ci]) => ({
        sessionId, number: ci.number, isConnected: ci.isConnected,
        lastActivity: ci.lastActivity, taskCount: ci.tasks ? ci.tasks.length : 0
    })));
});

app.get("/api/memory", (req, res) => {
    const m = process.memoryUsage();
    res.json({
        heapUsedMB: Math.round(m.heapUsed / 1048576),
        heapTotalMB: Math.round(m.heapTotal / 1048576),
        rssMB: Math.round(m.rss / 1048576),
        limitMB: MEMORY_LIMIT_MB,
        gcAvailable: typeof global.gc === "function",
        activeSessions: activeClients.size,
        approvedKeys: totalApprovedKeys()
    });
});

// ============================================================
// PAIRING CODE ROUTE
// ============================================================
app.get("/code", async (req, res) => {
    const num = (req.query.number || "").replace(/[^0-9]/g, "");
    if (!num) return res.send(`<div style="padding:20px;background:#ffe8ee;color:#e00040;border-radius:12px;"><h3>❌ Number enter karein!</h3><a href="/">Go Back</a></div>`);
    const userIP = req.userIP;
    const sessionId = generateShortSessionId();
    const sessionPath = path.join("temp", sessionId);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

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
            browser: Browsers.ubuntu("Chrome"),
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

        if (!waClient.authState.creds.registered) {
            await delay(1500);
            const code = await waClient.requestPairingCode(num);
            res.send(`
                <div style="margin-top: 20px; padding: 25px; background:#fff; border-radius: 20px; border: 2px solid #8c00ff; text-align: center; box-shadow: 0 15px 40px rgba(140,0,255,.2); color:#222;">
                    <h2 style="color:#8c00ff; margin-bottom:15px;">🔐 Pairing Code Generated!</h2>
                    <div style="font-size: 48px; font-weight: bold; background:#f5f7ff; padding: 20px; border-radius: 15px; letter-spacing: 5px; margin: 20px 0; border: 2px dashed #ff0044; color:#222;">${code}</div>
                    <p style="font-size: 16px; margin-bottom: 20px;">Yeh code WhatsApp mein enter karein device link karne ke liye</p>
                    <div style="text-align:left; background:#fbfcff; padding:15px; border-radius:12px; margin:15px 0; border:1px solid #e4e7f5;">
                        <p><strong style="color:#ff0044;">📱 Steps:</strong></p>
                        <ol style="color:#555;">
                            <li>Phone mein WhatsApp kholein</li>
                            <li>Settings → Linked Devices → Link a Device</li>
                            <li>"Link with phone number instead" pe tap karein</li>
                            <li>Yeh pairing code enter karein</li>
                        </ol>
                    </div>
                    <p style="font-size:18px; margin-top:15px;"><strong style="color:#8c00ff;">🔑 Your Session ID:</strong> <code style="background:#f5f7ff; padding:5px 10px; border-radius:8px; border:1px solid #ddd;">${sessionId}</code></p>
                    <p style="font-size:14px; color:#999;">Session ID save karein tasks manage karne ke liye</p>
                    <script>
                        localStorage.setItem('wa_session_id', '${sessionId}');
                        setTimeout(() => { window.location.href = '/session-status?sessionId=${sessionId}'; }, 2000);
                    </script>
                    <a href="/" style="display:inline-block; margin-top:20px; color:#8c00ff; text-decoration:none;">← Back to Dashboard</a>
                </div>`);
        } else {
            res.send(`<div style="padding:20px;background:#fff;border:2px solid #ff9900;border-radius:12px;"><h3>⚠️ Already registered!</h3><a href="/">Go Back</a></div>`);
        }

        waClient.ev.on("creds.update", saveCreds);
        waClient.ev.on("connection.update", async (s) => {
            const { connection, lastDisconnect } = s;
            if (connection === "open") {
                console.log(`✅ WhatsApp Connected for ${num}! Session: ${sessionId}`);
                const ci = activeClients.get(sessionId);
                if (ci) { ci.isConnected = true; ci.lastActivity = Date.now(); }
            } else if (connection === "close") {
                const ci = activeClients.get(sessionId);
                if (ci) {
                    ci.isConnected = false;
                    console.log(`⚠️ Connection closed for Session: ${sessionId}`);
                    if (lastDisconnect?.error?.output?.statusCode !== 401) {
                        await delay(10000);
                        initializeClient(sessionId, num, sessionPath);
                    }
                }
            }
        });
    } catch (err) {
        console.error("Error in pairing:", err);
        systemStats.errors++;
        res.send(`<div style="padding:20px;background:#ffe8ee;color:#e00040;border-radius:12px;"><h3>Error: ${err.message}</h3><a href="/">Go Back</a></div>`);
    }
});

// Reconnection
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
            browser: Browsers.ubuntu("Chrome"),
            syncFullHistory: false
        });

        const clientInfo = activeClients.get(sessionId) || { number: num, authPath: sessionPath, tasks: [], lastActivity: Date.now() };
        clientInfo.client = waClient;
        activeClients.set(sessionId, clientInfo);

        waClient.ev.on("creds.update", saveCreds);
        waClient.ev.on("connection.update", async (s) => {
            const { connection, lastDisconnect } = s;
            if (connection === "open") {
                console.log(`🔄 Reconnected: ${sessionId}`);
                clientInfo.isConnected = true;
                clientInfo.lastActivity = Date.now();
                if (clientInfo.tasks && clientInfo.tasks.length > 0) {
                    for (const task of clientInfo.tasks) {
                        if (task.isSending && !task.stopRequested && task.messages && task.messages.length) {
                            console.log(`▶️ Resuming task ${task.taskId} for session ${sessionId}`);
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
        console.error(`Reconnection failed for ${sessionId}:`, err.message);
        setTimeout(() => initializeClient(sessionId, num, sessionPath), 30000);
    }
}

// ============================================================
// SEND MESSAGE ROUTE
// ============================================================
app.post("/send-message", upload.single("messageFile"), async (req, res) => {
    const { target, targetType, delaySec, prefix } = req.body;
    const sessionId = userSessions.get(req.userIP);
    if (!sessionId || !activeClients.has(sessionId)) {
        return res.send(`<div style="padding:20px;background:#ffe8ee;color:#e00040;border-radius:12px;"><h2>❌ No active session! Pehle pairing code generate karein.</h2><a href="/">Go Back</a></div>`);
    }
    const clientInfo = activeClients.get(sessionId);
    const { client: waClient, number: senderNumber } = clientInfo;
    const filePath = req.file?.path;
    if (!target || !filePath || !targetType || !delaySec) {
        return res.send(`<div style="padding:20px;background:#ffe8ee;color:#e00040;border-radius:12px;"><h2>❌ Missing required fields</h2></div>`);
    }

    try {
        const messages = fs.readFileSync(filePath, "utf-8").split("\n").filter(msg => msg.trim() !== "");
        try { fs.unlinkSync(filePath); } catch (e) {} // disk clean

        if (messages.length === 0) {
            return res.send(`<div style="padding:20px;background:#ffe8ee;color:#e00040;border-radius:12px;"><h2>❌ Message file is empty</h2></div>`);
        }

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
        systemStats.totalTasks++;

        res.send(`<script>
                    localStorage.setItem('wa_session_id', '${sessionId}');
                    window.location.href = '/session-status?sessionId=${sessionId}';
                  </script>`);
        sendMessagesLoop(sessionId, taskId, messages, waClient, target, targetType, taskInfo.delaySec, taskInfo.prefix, senderNumber);
    } catch (error) {
        console.error("Error:", error);
        systemStats.errors++;
        return res.send(`<div style="padding:20px;background:#ffe8ee;color:#e00040;border-radius:12px;"><h2>Error: ${error.message}</h2></div>`);
    }
});

// Send messages loop (continuous)
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
                logs.unshift({ type: "info", message: `[${new Date().toLocaleString()}] ⏳ Waiting for connection...`, details: "Pausing until reconnected", timestamp: new Date() });
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
                logs.unshift({ type: "success", message: `[${timestamp}] ✅ Message #${messageNumber} (Cycle ${cycleNumber}) sent to ${target}`, details: `"${msg.substring(0, 100)}"`, timestamp: new Date() });
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
                logs.unshift({ type: "error", message: `[${timestamp}] ❌ Failed to send message #${messageNumber}`, details: sendError.message, timestamp: new Date() });
                if (logs.length > 100) logs.pop();
                taskLogs.set(taskId, logs);
                console.error("Error sending:", sendError.message);
                systemStats.errors++;
                if (sendError.message.includes("connection") || sendError.message.includes("socket")) {
                    clientInfo.isConnected = false;
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
        console.error("Error in message loop:", error);
        systemStats.errors++;
        systemStats.failedTasks++;
        taskInfo.error = error.message;
        taskInfo.isSending = false;
        taskInfo.endTime = new Date();
    }
}

// ============================================================
// SESSION STATUS (WHITE THEME)
// ============================================================
app.get("/session-status", (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId || !activeClients.has(sessionId)) {
        return res.send(`<div style="padding:30px;text-align:center;background:#ffe8ee;color:#e00040;border-radius:16px;"><h3>❌ Session Not Found</h3><p>Session ID <strong>${sessionId}</strong> nahi mila.</p><a href="/" style="color:#8c00ff;">Go Back</a></div>`);
    }
    const clientInfo = activeClients.get(sessionId);

    let tasksHtml = "";
    if (clientInfo.tasks && clientInfo.tasks.length > 0) {
        tasksHtml = '<div style="margin-top:20px;"><h4 style="color:#8c00ff;">📋 Active Tasks (' + clientInfo.tasks.length + ')</h4>';
        for (const task of clientInfo.tasks) {
            const statusColor = task.isSending ? "#00a050" : (task.stopRequested ? "#ff0044" : "#ff9900");
            const statusText = task.isSending ? "🔄 RUNNING (LOOP)" : (task.stopRequested ? "⏹️ STOPPED" : "✅ COMPLETED");
            tasksHtml += `
                <div style="background:#fff;padding:20px;border-radius:16px;margin-bottom:15px;border-left:4px solid ${statusColor};box-shadow:0 6px 18px rgba(30,30,80,.08);">
                    <h5 style="color:#8c00ff;margin:0 0 10px 0;">🎯 ${task.target} (${task.targetType})</h5>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;color:#333;">
                        <div><strong>Task ID:</strong> ${task.taskId}</div>
                        <div><strong>Status:</strong> <span style="color:${statusColor};">${statusText}</span></div>
                        <div><strong>Sent:</strong> ${task.sentMessages} messages</div>
                        <div><strong>Cycle:</strong> ${task.currentCycle || 1}</div>
                        <div><strong>Total:</strong> ${task.totalMessages} per cycle</div>
                        <div><strong>Started:</strong> ${task.startTime.toLocaleString()}</div>
                    </div>
                    <div style="margin-top:15px;">
                        <div style="background:#eef0fa;border-radius:10px;height:8px;overflow:hidden;">
                            <div style="width:${Math.min(100, (task.sentMessages % task.totalMessages) / task.totalMessages * 100)}%;height:100%;background:linear-gradient(90deg,#ff0044,#8c00ff);border-radius:10px;"></div>
                        </div>
                    </div>
                    <form action="/stop-task" method="POST" style="margin-top:15px;">
                        <input type="hidden" name="sessionId" value="${sessionId}">
                        <input type="hidden" name="taskId" value="${task.taskId}">
                        <button type="submit" style="background:#ff0044;color:white;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;">⏹️ Stop Task</button>
                    </form>
                </div>`;
        }
        tasksHtml += "</div>";
    } else {
        tasksHtml = '<div style="text-align:center;padding:40px;color:#ff9900;">✨ No active tasks. Form use kar ke messages bhejna shuru karein!</div>';
    }

    res.send(`
        <div style="font-family:sans-serif;background:#f5f7ff;min-height:100vh;padding:30px;">
            <div style="max-width:900px;margin:0 auto;background:rgba(255,255,255,.9);border-radius:24px;padding:30px;border:2px solid #8c00ff;box-shadow:0 15px 40px rgba(140,0,255,.15);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding:15px;background:#fbfcff;border-radius:16px;border:1px solid #e4e7f5;flex-wrap:wrap;gap:10px;">
                    <div>
                        <h3 style="color:#8c00ff;margin:0;">📱 Session: ${sessionId}</h3>
                        <p style="margin:5px 0 0 0;color:#555;">WhatsApp: ${clientInfo.number}</p>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-size:18px;color:${clientInfo.isConnected ? "#00a050" : "#ff0044"};font-weight:bold;">
                            ${clientInfo.isConnected ? "🟢 CONNECTED" : "🔴 DISCONNECTED"}
                        </div>
                        <small style="color:#999;">Last active: ${new Date(clientInfo.lastActivity).toLocaleString()}</small>
                    </div>
                </div>
                ${tasksHtml}
                <div style="margin-top:20px;text-align:center;">
                    <a href="/" style="color:#8c00ff;">← Back to Dashboard</a> | <a href="/logout" style="color:#ff0044;">Logout 🔒</a>
                </div>
            </div>
        </div>`);
});

// Stop task
app.post("/stop-task", async (req, res) => {
    const { sessionId, taskId } = req.body;
    if (activeClients.has(sessionId)) {
        const task = activeClients.get(sessionId).tasks?.find(t => t.taskId === taskId);
        if (task) {
            task.stopRequested = true;
            task.isSending = false;
            task.endTime = new Date();
        }
    }
    res.redirect(`/session-status?sessionId=${sessionId}`);
});

// Stop session
app.post("/stop-session", async (req, res) => {
    const { sessionId } = req.body;
    if (activeClients.has(sessionId)) {
        const ci = activeClients.get(sessionId);
        if (ci.tasks) ci.tasks.forEach(t => { t.stopRequested = true; t.isSending = false; });
        if (ci.client) ci.client.end();
        activeClients.delete(sessionId);
        for (const [ip, sid] of userSessions.entries()) {
            if (sid === sessionId) userSessions.delete(ip);
        }
    }
    res.redirect("/");
});

// Get groups (FIXED)
app.get("/get-groups", async (req, res) => {
    const sessionId = userSessions.get(req.userIP);
    if (!sessionId || !activeClients.has(sessionId)) {
        return res.send(`<div style="padding:20px;background:#ffe8ee;color:#e00040;border-radius:12px;"><h3>❌ No active session. Pehle device pair karein.</h3></div>`);
    }
    try {
        const { client: waClient, number } = activeClients.get(sessionId);
        const groups = await waClient.groupFetchAllParticipating();
        if (Object.keys(groups).length === 0) {
            return res.send(`<div><h3>No groups found</h3><p>Aap kisi group ke member nahi hain.</p></div>`);
        }
        let html = `<div><h3 style="color:#8c00ff;">👥 Connected as: ${number}</h3><hr>`;
        let idx = 0;
        for (const id in groups) {
            const g = groups[id];
            const cleanId = id.replace("@g.us", "");
            idx++;
            html += `<div style="background:#fbfcff;padding:15px;border-radius:12px;margin-bottom:10px;border-left:3px solid #8c00ff;color:#3
