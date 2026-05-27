import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ─── MONGO SETUP ─────────────────────────────────
if (!process.env.MONGO_URI) {
    console.error("❌ MONGO_URI is not set!");
    process.exit(1);
}

const mongoClient = new MongoClient(process.env.MONGO_URI);
let db;

const sessions = new Map();

function toObjectId(id) {
    if (!id) return null;
    if (ObjectId.isValid(id)) return new ObjectId(id);
    return null;
}

function normalizeLimit(limit, fallback = 10, max = 50) {
    const parsed = Number(limit);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

// ─── SSE ENDPOINT ────────────────────────────────
app.get("/sse", async (req, res) => {
    try {
    const mcpServer = new McpServer({
        name: "mongodb-events-server",
        version: "1.0.0",
    });

    mcpServer.tool(
        "search-events",
        "Search events by status, eventType, state, city, or meetingType.",
        {
            status: z.enum(["Pending", "In Progress", "Completed"]).optional(),
            eventType: z.enum(["conference", "festival", "venue"]).optional(),
            state: z.string().optional(),
            city: z.string().optional(),
            meetingType: z.enum(["medical", "business", "other"]).optional(),
            limit: z.number().optional().default(10),
        },
        async ({ status, eventType, state, city, meetingType, limit }) => {
            const query = { isDeleted: false };
            if (status) query.status = status;
            if (eventType) query["eventDetails.eventType"] = eventType;
            if (state) query["eventDetails.state"] = state;
            if (city) query["eventDetails.city"] = { $regex: city, $options: "i" };
            if (meetingType) query["eventDetails.meetingType"] = meetingType;
            const events = await db.collection("events").find(query).limit(normalizeLimit(limit)).toArray();
            return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
        }
    );

    mcpServer.tool(
        "get-events-summary",
        "Get count of events grouped by status.",
        {},
        async () => {
            const summary = await db.collection("events").aggregate([
                { $match: { isDeleted: false } },
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ]).toArray();
            return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
        }
    );

    mcpServer.tool(
        "get-events-by-date-range",
        "Get events between fromDate and toDate (YYYY-MM-DD).",
        {
            fromDate: z.string(),
            toDate: z.string(),
            status: z.enum(["Pending", "In Progress", "Completed"]).optional(),
            limit: z.number().optional().default(10),
        },
        async ({ fromDate, toDate, status, limit }) => {
            const startDate = new Date(fromDate);
            const endDate = new Date(toDate);
            if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
                return { content: [{ type: "text", text: "Invalid date format. Use YYYY-MM-DD." }] };
            }
            const query = {
                isDeleted: false,
                "eventDetails.startDate": { $gte: startDate, $lte: endDate },
            };
            if (status) query.status = status;
            const events = await db.collection("events").find(query).limit(normalizeLimit(limit)).toArray();
            return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
        }
    );

    mcpServer.tool(
        "search-events-by-company",
        "Find events by company name or contact email.",
        {
            companyName: z.string().optional(),
            email: z.string().optional(),
        },
        async ({ companyName, email }) => {
            const query = { isDeleted: false };
            if (companyName) query["company.name"] = { $regex: companyName, $options: "i" };
            if (email) query["company.contactPerson.email"] = { $regex: email, $options: "i" };
            const events = await db.collection("events").find(query).limit(20).toArray();
            return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
        }
    );

    mcpServer.tool(
        "get-events-by-staff",
        "Find events where a staff member appears in priority preference.",
        {
            email: z.string().optional(),
            staffId: z.string().optional(),
            role: z.enum(["paramedic", "emt", "rn", "physician"]).optional(),
        },
        async ({ email, staffId, role }) => {
            const query = { isDeleted: false };
            if (email) query["priorityPreference.email"] = { $regex: email, $options: "i" };
            if (staffId) query["priorityPreference.staffId"] = staffId;
            if (role) query["priorityPreference.role"] = role;
            const events = await db.collection("events").find(query).limit(20).toArray();
            return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
        }
    );

    mcpServer.tool(
        "get-events-by-coverage",
        "Filter events by coverage type or additional services.",
        {
            coverageType: z.enum(["12 Hours Coverage", "24 Hours Coverage"]).optional(),
            additionalService: z.string().optional(),
            limit: z.number().optional().default(10),
        },
        async ({ coverageType, additionalService, limit }) => {
            const query = { isDeleted: false };
            if (coverageType) query["eventDetails.coverageType"] = coverageType;
            if (additionalService) query["eventDetails.additionalServices"] = additionalService;
            const events = await db.collection("events").find(query).limit(normalizeLimit(limit)).toArray();
            return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
        }
    );

    mcpServer.tool(
        "get-event-by-id",
        "Get full details of a single event by its _id.",
        { id: z.string() },
        async ({ id }) => {
            const objectId = toObjectId(id);
            const query = objectId ? { _id: objectId } : { _id: id };
            const event = await db.collection("events").findOne(query);
            return { content: [{ type: "text", text: event ? JSON.stringify(event, null, 2) : "Event not found." }] };
        }
    );

    mcpServer.tool(
        "get-staff-assignments",
        "Get priority and assigned staff for a specific event.",
        { eventId: z.string() },
        async ({ eventId }) => {
            const objectId = toObjectId(eventId);
            const query = objectId ? { _id: objectId } : { _id: eventId };
            const event = await db.collection("events").findOne(
                query,
                { projection: { priorityPreference: 1, staffAssigned: 1, "eventDetails.name": 1, status: 1 } }
            );
            return { content: [{ type: "text", text: event ? JSON.stringify(event, null, 2) : "Event not found." }] };
        }
    );

    const transport = new SSEServerTransport("/messages", res);
    sessions.set(transport.sessionId, { transport, mcpServer });

    res.on("close", () => {
        sessions.delete(transport.sessionId);
        console.log(`🔌 Session closed: ${transport.sessionId}`);
    });

    await mcpServer.connect(transport);
    console.log(`🆕 New SSE session: ${transport.sessionId}`);
    } catch (error) {
        console.error("❌ Failed to establish SSE session:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to start MCP session" });
        }
    }
});

// ─── MESSAGES ENDPOINT ───────────────────────────
app.post("/messages", async (req, res) => {
    try {
        const sessionId = Array.isArray(req.query.sessionId) ? req.query.sessionId[0] : req.query.sessionId;
        if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

        const session = sessions.get(sessionId);
        if (!session) return res.status(404).json({ error: "Session not found" });

        await session.transport.handlePostMessage(req, res);
    } catch (error) {
        console.error("❌ Failed to process /messages request:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to process message" });
        }
    }
});

// ─── HEALTH CHECK ────────────────────────────────
app.get("/", (req, res) => {
    res.json({
        status: "ok",
        service: "MongoDB Events MCP Server",
        activeSessions: sessions.size,
        endpoints: { sse: "/sse", messages: "/messages" },
    });
});

// ─── GRACEFUL SHUTDOWN ───────────────────────────
async function shutdown() {
    console.log("🛑 Shutting down...");
    await mongoClient.close();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── START SERVER ────────────────────────────────
async function start() {
    try {
        await mongoClient.connect();
        console.log("✅ Mongo Connected");
        db = mongoClient.db(process.env.DB_NAME);

        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📡 SSE: /sse`);
            console.log(`📨 Messages: /messages`);
        });
    } catch (err) {
        console.error("❌ Failed to connect to MongoDB:", err.message);
        process.exit(1);
    }
}

start();