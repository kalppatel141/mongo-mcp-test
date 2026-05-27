/**
 * Claude Web-compatible Remote MCP:
 * - Exposes OAuth discovery + auth code w/ PKCE (S256)
 * - Protects `/mcp` with Bearer tokens
 * - Proxies requests to the official `mongodb-mcp-server` running locally
 *
 * This is a POC-grade OAuth server (single shared login key) intended for quick
 * Claude Web connector setup. For production, use a real IdP (Auth0/Okta/etc).
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ====== Required env ======
if (!process.env.MDB_MCP_CONNECTION_STRING && process.env.MONGO_URI) {
    process.env.MDB_MCP_CONNECTION_STRING = process.env.MONGO_URI;
}
process.env.MDB_MCP_READ_ONLY ??= "true";

if (!process.env.MDB_MCP_CONNECTION_STRING) {
    console.error(
        "Missing MongoDB connection string. Set MDB_MCP_CONNECTION_STRING (or MONGO_URI)."
    );
    process.exit(1);
}

// A simple “login” gate for the consent screen.
// Set this in Railway variables.
const LOGIN_KEY = process.env.CONNECTOR_LOGIN_KEY;
if (!LOGIN_KEY) {
    console.error("Missing CONNECTOR_LOGIN_KEY. Set it in Railway variables.");
    process.exit(1);
}

// ====== Internal official MCP server (localhost) ======
const INTERNAL_MCP_PORT = Number(process.env.INTERNAL_MCP_PORT ?? 4010);

const mcpEntry = path.join(
    __dirname,
    "node_modules",
    "mongodb-mcp-server",
    "dist",
    "esm",
    "index.js"
);

const mcpChild = spawn(process.execPath, [mcpEntry], {
    stdio: "inherit",
    env: {
        ...process.env,
        MDB_MCP_TRANSPORT: "http",
        MDB_MCP_HTTP_HOST: "127.0.0.1",
        MDB_MCP_HTTP_PORT: String(INTERNAL_MCP_PORT),
        // Keep default response type "sse" (Claude supports it).
    },
});

mcpChild.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
});

// ====== OAuth POC implementation ======
const externalBaseUrl =
    process.env.PUBLIC_BASE_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : undefined);

// If PUBLIC_BASE_URL isn't set, we'll infer from request headers dynamically.
function inferBaseUrl(req) {
    const proto =
        (req.headers["x-forwarded-proto"] && String(req.headers["x-forwarded-proto"])) ||
        "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    return `${proto}://${host}`;
}

function baseUrl(req) {
    return externalBaseUrl ?? inferBaseUrl(req);
}

const app = express();
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "1mb" }));

// In-memory stores (POC). Railway restarts will invalidate sessions/tokens.
const authCodes = new Map(); // code -> { clientId, redirectUri, codeChallenge, resource, scope, expiresAt }
const accessTokens = new Map(); // token -> { resource, scope, expiresAt, clientId }

function now() {
    return Date.now();
}

function randomId(bytes = 32) {
    return crypto.randomBytes(bytes).toString("hex");
}

function sha256Base64Url(input) {
    return crypto
        .createHash("sha256")
        .update(input)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function bad(res, status, error, error_description) {
    res.status(status).json({ error, error_description });
}

function requireBearer(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
        // The WWW-Authenticate header is what triggers Claude's OAuth discovery.
        const b = baseUrl(req);
        res.setHeader(
            "WWW-Authenticate",
            `Bearer realm="mcp", resource_metadata="${b}/.well-known/oauth-protected-resource", scope="mcp"`
        );
        return res.status(401).json({ error: "unauthorized" });
    }

    const token = auth.slice("bearer ".length).trim();
    const info = accessTokens.get(token);
    if (!info || info.expiresAt <= now()) {
        accessTokens.delete(token);
        const b = baseUrl(req);
        res.setHeader(
            "WWW-Authenticate",
            `Bearer error="invalid_token", resource_metadata="${b}/.well-known/oauth-protected-resource"`
        );
        return res.status(401).json({ error: "invalid_token" });
    }
    req.auth = info;
    next();
}

// ====== OAuth discovery endpoints (Claude Web expects these) ======
app.get("/.well-known/oauth-protected-resource", (req, res) => {
    const b = baseUrl(req);
    res.json({
        resource: `${b}/mcp`,
        authorization_servers: [`${b}`],
    });
});

app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const b = baseUrl(req);
    res.json({
        issuer: b,
        authorization_endpoint: `${b}/oauth/authorize`,
        token_endpoint: `${b}/oauth/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        // This unblocks Claude Web without requiring DCR.
        client_id_metadata_document_supported: true,
    });
});

// ====== OAuth authorize (simple HTML login) ======
app.get("/oauth/authorize", (req, res) => {
    const {
        client_id,
        redirect_uri,
        response_type,
        code_challenge,
        code_challenge_method,
        state,
        scope,
        resource,
    } = req.query;

    if (response_type !== "code") {
        return bad(res, 400, "unsupported_response_type", "Only response_type=code supported");
    }
    if (!client_id || !redirect_uri) {
        return bad(res, 400, "invalid_request", "Missing client_id or redirect_uri");
    }
    if (!code_challenge || code_challenge_method !== "S256") {
        return bad(res, 400, "invalid_request", "Missing code_challenge or unsupported method");
    }

    // Minimal consent screen with a shared login key.
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect to MongoDB MCP</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0b0b10;color:#fff;margin:0;padding:24px}
      .card{max-width:520px;margin:0 auto;background:#151524;border:1px solid #2a2a40;border-radius:16px;padding:20px}
      input{width:100%;padding:12px;border-radius:10px;border:1px solid #2a2a40;background:#0f0f1a;color:#fff}
      button{margin-top:12px;width:100%;padding:12px;border-radius:10px;border:0;background:#6e56cf;color:#fff;font-weight:600;cursor:pointer}
      .muted{opacity:.75;font-size:13px;margin-top:10px}
      code{background:#0f0f1a;padding:2px 6px;border-radius:6px}
    </style>
  </head>
  <body>
    <div class="card">
      <h2>Authorize Claude to access MongoDB MCP</h2>
      <p class="muted">This is a POC sign-in screen. Enter your connector key to continue.</p>
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="client_id" value="${String(client_id)}"/>
        <input type="hidden" name="redirect_uri" value="${String(redirect_uri)}"/>
        <input type="hidden" name="response_type" value="${String(response_type)}"/>
        <input type="hidden" name="code_challenge" value="${String(code_challenge)}"/>
        <input type="hidden" name="code_challenge_method" value="${String(code_challenge_method)}"/>
        <input type="hidden" name="state" value="${state ? String(state) : ""}"/>
        <input type="hidden" name="scope" value="${scope ? String(scope) : ""}"/>
        <input type="hidden" name="resource" value="${resource ? String(resource) : ""}"/>
        <label>Connector login key</label>
        <input name="login_key" placeholder="Enter CONNECTOR_LOGIN_KEY" />
        <button type="submit">Authorize</button>
      </form>
      <p class="muted">Requested scope: <code>${scope ? String(scope) : "mcp"}</code></p>
    </div>
  </body>
</html>`;
    res.status(200).setHeader("content-type", "text/html; charset=utf-8").send(html);
});

app.post("/oauth/authorize", (req, res) => {
    const {
        login_key,
        client_id,
        redirect_uri,
        code_challenge,
        state,
        scope,
        resource,
    } = req.body ?? {};

    if (login_key !== LOGIN_KEY) {
        return res.status(403).send("Invalid connector key");
    }

    const code = randomId(24);
    authCodes.set(code, {
        clientId: String(client_id),
        redirectUri: String(redirect_uri),
        codeChallenge: String(code_challenge),
        resource: String(resource || ""),
        scope: String(scope || "mcp"),
        expiresAt: now() + 5 * 60 * 1000,
    });

    const u = new URL(String(redirect_uri));
    u.searchParams.set("code", code);
    if (state) u.searchParams.set("state", String(state));
    res.redirect(302, u.toString());
});

// ====== OAuth token exchange ======
app.post("/oauth/token", (req, res) => {
    const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body ?? {};

    if (grant_type !== "authorization_code") {
        return bad(res, 400, "unsupported_grant_type", "Only authorization_code supported");
    }
    if (!code || !redirect_uri || !client_id || !code_verifier) {
        return bad(res, 400, "invalid_request", "Missing required fields");
    }

    const record = authCodes.get(String(code));
    if (!record) return bad(res, 400, "invalid_grant", "Unknown or expired code");
    if (record.expiresAt <= now()) {
        authCodes.delete(String(code));
        return bad(res, 400, "invalid_grant", "Code expired");
    }
    if (record.clientId !== String(client_id)) return bad(res, 400, "invalid_grant", "client_id mismatch");
    if (record.redirectUri !== String(redirect_uri))
        return bad(res, 400, "invalid_grant", "redirect_uri mismatch");

    const computed = sha256Base64Url(String(code_verifier));
    if (computed !== record.codeChallenge) {
        return bad(res, 400, "invalid_grant", "PKCE verification failed");
    }

    authCodes.delete(String(code));

    const token = randomId(32);
    const expiresIn = 60 * 60; // 1 hour
    accessTokens.set(token, {
        resource: record.resource,
        scope: record.scope,
        expiresAt: now() + expiresIn * 1000,
        clientId: record.clientId,
    });

    res.json({
        access_token: token,
        token_type: "Bearer",
        expires_in: expiresIn,
        scope: record.scope,
    });
});

// ====== Protected MCP proxy ======
const proxy = createProxyMiddleware({
    target: `http://127.0.0.1:${INTERNAL_MCP_PORT}`,
    changeOrigin: false,
    ws: false,
    xfwd: true,
    logLevel: "warn",
});

app.use("/mcp", requireBearer, proxy);

app.get("/", (req, res) => {
    res.json({
        status: "ok",
        service: "MongoDB MCP (Claude Web OAuth POC)",
        endpoints: {
            mcp: "/mcp",
            protectedResourceMetadata: "/.well-known/oauth-protected-resource",
            authServerMetadata: "/.well-known/oauth-authorization-server",
            authorize: "/oauth/authorize",
            token: "/oauth/token",
        },
    });
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
    console.log(`OAuth gateway listening on :${PORT}`);
    console.log(`Proxying MCP to 127.0.0.1:${INTERNAL_MCP_PORT}/mcp`);
});
