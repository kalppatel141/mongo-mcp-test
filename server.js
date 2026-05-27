import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

/**
 * Mongo Connection
 */
const client = new MongoClient(process.env.MONGO_URI);

async function startServer() {
    try {
        await client.connect();

        console.log("✅ Connected to MongoDB");

        // Uses DB name from URI
        const db = client.db();

        /**
         * Health Check
         */
        app.get("/", (req, res) => {
            res.json({
                success: true,
                message: "Mongo MCP Server Running",
            });
        });

        /**
         * Get Events
         */
        app.get("/events", async (req, res) => {
            try {
                const events = await db
                    .collection("events")
                    .find({})
                    .limit(10)
                    .toArray();

                res.json({
                    success: true,
                    count: events.length,
                    data: events,
                });
            } catch (error) {
                console.error(error);

                res.status(500).json({
                    success: false,
                    error: error.message,
                });
            }
        });

        /**
         * MCP Tool Endpoint
         */
        app.post("/tools/get-events", async (req, res) => {
            try {
                const events = await db
                    .collection("events")
                    .find({})
                    .limit(10)
                    .toArray();

                res.json({
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(events, null, 2),
                        },
                    ],
                });
            } catch (error) {
                console.error(error);

                res.status(500).json({
                    error: error.message,
                });
            }
        });

        const port = process.env.PORT || 3000;

        app.listen(port, () => {
            console.log(`🚀 Server running on port ${port}`);
        });

    } catch (error) {
        console.error("❌ MongoDB Connection Failed");
        console.error(error);
    }
}

startServer();