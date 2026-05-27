/**
 * Boots the official MongoDB MCP Server (HTTP) for Railway / remote clients.
 * Docs: https://www.mongodb.com/docs/mcp-server/
 */
import dotenv from "dotenv";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

process.env.MDB_MCP_TRANSPORT ??= "http";
process.env.MDB_MCP_HTTP_HOST ??= "0.0.0.0";
process.env.MDB_MCP_HTTP_PORT ??= process.env.PORT ?? "3000";

if (!process.env.MDB_MCP_CONNECTION_STRING && process.env.MONGO_URI) {
    process.env.MDB_MCP_CONNECTION_STRING = process.env.MONGO_URI;
}

process.env.MDB_MCP_READ_ONLY ??= "true";

if (!process.env.MDB_MCP_CONNECTION_STRING) {
    console.error(
        "Missing MongoDB connection string. Set MDB_MCP_CONNECTION_STRING (or MONGO_URI) on Railway."
    );
    process.exit(1);
}

const entry = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "node_modules",
    "mongodb-mcp-server",
    "dist",
    "esm",
    "index.js"
);

const child = spawn(process.execPath, [entry], {
    stdio: "inherit",
    env: process.env,
});

child.on("exit", (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 1);
});
