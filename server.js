import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
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

const sessions = {};

// ─── SSE ENDPOINT ────────────────────────────────
app.get("/sse", async (req, res) => {
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
            const events = await db.collection("events").find(query).limit(Math.min(limit, 50)).toArray();
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
            const query = {
                isDeleted: false,
                "eventDetails.startDate": { $gte: new Date(fromDate), $lte: new Date(toDate) },
            };
            if (status) query.status = status;
            const events = await db.collection("events").find(query).limit(Math.min(limit, 50)).toArray();
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
            const events = await db.collection("events").find(query).limit(Math.min(limit, 50)).toArray();
            return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
        }
    );

    mcpServer.tool(
        "get-event-by-id",
        "Get full details of a single event by its _id.",
        { id: z.string() },
        async ({ id }) => {
            const event = await db.collection("events").findOne({ _id: id });
            return { content: [{ type: "text", text: event ? JSON.stringify(event, null, 2) : "Event not found." }] };
        }
    );

    mcpServer.tool(
        "get-staff-assignments",
        "Get priority and assigned staff for a specific event.",
        { eventId: z.string() },
        async ({ eventId }) => {
            const event = await db.collection("events").findOne(
                { _id: eventId },
                { projection: { priorityPreference: 1, staffAssigned: 1, "eventDetails.name": 1, status: 1 } }
            );
            return { content: [{ type: "text", text: event ? JSON.stringify(event, null, 2) : "Event not found." }] };
        }
    );

    const transport = new SSEServerTransport("/messages", res);
    sessions[transport.sessionId] = { transport, mcpServer };

    res.on("close", () => {
        delete sessions[transport.sessionId];
        console.log(`🔌 Session closed: ${transport.sessionId}`);
    });

    await mcpServer.connect(transport);
    console.log(`🆕 New SSE session: ${transport.sessionId}`);
});

// ─── MESSAGES ENDPOINT ───────────────────────────
app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
    const session = sessions[sessionId];
    if (!session) return res.status(404).json({ error: "Session not found" });
    await session.transport.handlePostMessage(req, res);
});

// ─── HEALTH CHECK ────────────────────────────────
app.get("/", (req, res) => {
    res.json({
        status: "ok",
        service: "MongoDB Events MCP Server",
        activeSessions: Object.keys(sessions).length,
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
        db = mongoClient.db();

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