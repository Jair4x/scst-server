import express from "express";
import { WebSocketServer } from "ws";
import * as http from "http";
import { fetch } from "bun";
import { config } from "dotenv";
import db from './db.js';

config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT;
const clientId = process.env.TWITCH_CLIENT_ID;

app.use(express.json());

// Websocket config
const wss = new WebSocketServer({ noServer: true });
let widgetClients: WebSocket[] = [];

interface StreamerSession {
    token: string;
    channelId: string;
    ws: WebSocket;
    sessionId: string | null;
}
const streamerSessions: Record<string, StreamerSession> = {};

// Main page
app.get("/", (_req, res) => res.send("Twitch server Proxy OK"));

// Save user tokens
app.post('/api/save_token', async (req, res) => {
    const { userId, token } = req.body;

    if (!userId || !token) {
        return res.status(400).json({ error: 'User ID and token are required' });
    }

    if (!db.data) db.data = {};
    if (!db.data.tokens) db.data.tokens = [];

    const existing = db.data.tokens.find(t => t.userId === userId);
    if (existing) {
        existing.token = token;
    } else {
        db.data.tokens.push({ userId, token });
    }

    await db.write();

    try {
        const response = await fetch(`http://localhost:${PORT}/registerStreamer`, {
            method: "POST",
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, token })
        });

        if (!response.ok) {
            console.error("Failed to register streamer:", await response.text());
        }
    } catch (error) {
        console.error("Error while registering streamer:", error);
    }

    res.status(200).json({ success: true });
});

app.get("/redirect", (_req, res) => {
    res.sendFile("/redirect.html", { root: "." });
});

// Add streamer to websocket backend
app.post("/registerStreamer", async (req, res) => {
    const { userId, token } = req.body;
    if (!userId || !token) return res.status(400).json({ error: "User ID and token are required" });

    try {
        const channelId = userId;

        // Not reconnect if it exists
        if (!streamerSessions[channelId]) {
            await connectTwitchWS(token, channelId);
        }

        return res.json({ success: true, channelId });
    } catch (err: any) {
        console.error("Error registering streamer:", err);
        return res.status(500).json({ error: err.message });
    }
});


// Connect to Twitch WebSocket
async function connectTwitchWS(token: string, channelId: string) {
    const ws = new WebSocket("wss://eventsub.wss.twitch.tv/ws");

    const session: StreamerSession = {
        token,
        channelId,
        ws,
        sessionId: null,
    };
    streamerSessions[channelId] = session;

    ws.on("open", () => {
        console.log(`[${channelId}] Connected to Twitch EventSub WS.`);
    });

    ws.on("error", (err) => {
        console.error(`[${channelId}] WS error:`, err);
    });

    ws.on("message", async (msg) => {
        const data = JSON.parse(msg.toString());

        if (data.metadata?.message_type === "session_welcome") {
            session.sessionId = data.payload.session.id;
            console.log(`[${channelId}] Session ID: ${session.sessionId}`);
            await subscribeToEvents(token, channelId, session.sessionId!);
        }

        if (data.metadata?.message_type === "notification") {
            const event = data.payload.event;
            console.log(`[${channelId}] Received event: `, event);

            widgetClients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        channelId,
                        eventType: data.payload.subscription.type,
                        event,
                        userId: event.user_id || null,
                        userName: event.user_name || null
                    }));
                }
            });
        }

        if (data.metadata?.message_type === "session_reconnect") {
            console.log(`[${channelId}] Reconnecting to Twitch WS...`);
            ws.close();
            connectTwitchWS(token, channelId);
        }
    });

    ws.on("close", (code, reason) => {
        console.log(`[${channelId}] Connection closed: code=${code}, reason=${reason.toString()}`);
    });
}

server.listen(PORT, () => {
    console.log(`Server is running on PORT ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
        widgetClients.push(ws);
        console.log("Widget client connected. Total clients:", widgetClients.length);

        ws.on("close", () => {
            widgetClients = widgetClients.filter((client) => client !== ws);
            console.log("Widget client disconnected. Total clients:", widgetClients.length);
        });
    });
});

// Subscribe to Twitch EventSub Hype train notifications
async function subscribeToEvents(token: string, channelId: string, sessionId: string) {
    const events = ["begin", "progress", "end"];
    for (const e of events) {
        const res = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
            method: "POST",
            headers: {
                "Client-ID": clientId,
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                type: `channel.hype_train.${e}`,
                version: "1",
                condition: { broadcaster_user_id: channelId },
                transport: { method: "websocket", session_id: sessionId }
            })
        });
        console.log(`[${channelId}] Subscribed hype_train.${e} -> status: ${res.status}`);
    }
}
