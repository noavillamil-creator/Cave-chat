require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { Server } = require("socket.io");
const cookie = require("cookie");

const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL. Add your separate CaveChat Neon connection string.");
  process.exit(1);
}
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("Missing or weak JWT_SECRET. Set a random secret of at least 32 characters.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /neon\.tech/i.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on("error", (err) => console.error("Unexpected PostgreSQL pool error:", err));

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const onlineUsers = new Map(); // userId -> Set(socketId)

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const COOKIE_NAME = "cavechat_session";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function setSessionCookie(res, userId) {
  const token = jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "7d" });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    path: "/"
  });
}

function getUserIdFromToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

async function requireAuth(req, res, next) {
  const userId = getUserIdFromToken(req.cookies[COOKIE_NAME]);
  if (!userId) return res.status(401).json({ error: "Please sign in again." });
  try {
    const result = await pool.query(
      "SELECT id, username, email, created_at FROM users WHERE id = $1",
      [userId]
    );
    if (!result.rowCount) return res.status(401).json({ error: "Account not found." });
    req.user = result.rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

function cleanName(value, max = 80) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, max);
}

function cleanChannelName(value) {
  return cleanName(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

async function isCommunityMember(communityId, userId) {
  const result = await pool.query(
    "SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2",
    [communityId, userId]
  );
  return result.rowCount > 0;
}

async function channelAccess(channelId, userId) {
  const result = await pool.query(
    `SELECT c.id, c.community_id
       FROM channels c
       JOIN community_members cm ON cm.community_id = c.community_id
      WHERE c.id = $1 AND cm.user_id = $2`,
    [channelId, userId]
  );
  return result.rows[0] || null;
}

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, app: "CaveChat" });
  } catch {
    res.status(503).json({ ok: false, app: "CaveChat" });
  }
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const username = cleanName(req.body.username, 24);
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (!/^[a-zA-Z0-9_]{2,24}$/.test(username)) {
      return res.status(400).json({ error: "Username must be 2–24 letters, numbers, or underscores." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: "Password must be between 8 and 128 characters." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, created_at`,
      [username, email, passwordHash]
    );
    setSessionCookie(res, result.rows[0].id);
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "That username or email is already registered." });
    }
    next(err);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const identity = typeof req.body.identity === "string" ? req.body.identity.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const result = await pool.query(
      `SELECT id, username, email, password_hash, created_at
         FROM users WHERE lower(email) = $1 OR lower(username) = $1`,
      [identity]
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Incorrect username/email or password." });
    }
    setSessionCookie(res, user.id);
    delete user.password_hash;
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => res.json({ user: req.user }));

app.get("/api/communities", requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.owner_id, cm.role
         FROM community_members cm
         JOIN communities c ON c.id = cm.community_id
        WHERE cm.user_id = $1
        ORDER BY c.created_at ASC`,
      [req.user.id]
    );
    res.json({ communities: result.rows });
  } catch (err) { next(err); }
});

app.post("/api/communities", requireAuth, async (req, res, next) => {
  const name = cleanName(req.body.name, 80);
  if (name.length < 2) return res.status(400).json({ error: "Community name must be at least 2 characters." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inviteCode = crypto.randomBytes(6).toString("hex");
    const created = await client.query(
      `INSERT INTO communities (name, owner_id, invite_code)
       VALUES ($1, $2, $3) RETURNING id, name, owner_id`,
      [name, req.user.id, inviteCode]
    );
    const community = created.rows[0];
    await client.query(
      "INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'owner')",
      [community.id, req.user.id]
    );
    await client.query(
      `INSERT INTO channels (community_id, name, type, position)
       VALUES ($1, 'general', 'text', 0), ($1, 'voice-chat', 'voice', 1)`,
      [community.id]
    );
    await client.query("COMMIT");
    res.status(201).json({ community });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

app.get("/api/communities/:id/channels", requireAuth, async (req, res, next) => {
  try {
    if (!(await isCommunityMember(req.params.id, req.user.id))) {
      return res.status(403).json({ error: "You are not a member of this community." });
    }
    const result = await pool.query(
      "SELECT id, community_id, name, type, position FROM channels WHERE community_id = $1 ORDER BY position, created_at",
      [req.params.id]
    );
    res.json({ channels: result.rows });
  } catch (err) { next(err); }
});

app.post("/api/communities/:id/channels", requireAuth, async (req, res, next) => {
  try {
    const name = cleanChannelName(req.body.name);
    const type = req.body.type === "voice" ? "voice" : "text";
    if (!name) return res.status(400).json({ error: "Enter a channel name." });
    const member = await pool.query(
      "SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    if (!member.rowCount) return res.status(403).json({ error: "You are not a member of this community." });
    if (!["owner", "admin"].includes(member.rows[0].role)) {
      return res.status(403).json({ error: "Only community owners and admins can add channels." });
    }
    const result = await pool.query(
      `INSERT INTO channels (community_id, name, type, position)
       SELECT $1, $2, $3, COALESCE(MAX(position), 0) + 1
         FROM channels WHERE community_id = $1
       RETURNING id, community_id, name, type, position`,
      [req.params.id, name, type]
    );
    res.status(201).json({ channel: result.rows[0] });
  } catch (err) { next(err); }
});

app.get("/api/communities/:id/members", requireAuth, async (req, res, next) => {
  try {
    if (!(await isCommunityMember(req.params.id, req.user.id))) {
      return res.status(403).json({ error: "You are not a member of this community." });
    }
    const result = await pool.query(
      `SELECT u.id, u.username, cm.role
         FROM community_members cm
         JOIN users u ON u.id = cm.user_id
        WHERE cm.community_id = $1
        ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, lower(u.username)`,
      [req.params.id]
    );
    res.json({
      members: result.rows.map((member) => ({
        ...member,
        online: (onlineUsers.get(member.id)?.size || 0) > 0
      }))
    });
  } catch (err) { next(err); }
});

app.post("/api/communities/:id/invite", requireAuth, async (req, res, next) => {
  try {
    if (!(await isCommunityMember(req.params.id, req.user.id))) {
      return res.status(403).json({ error: "You are not a member of this community." });
    }
    let result = await pool.query("SELECT invite_code FROM communities WHERE id = $1", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Community not found." });
    res.json({ inviteCode: result.rows[0].invite_code });
  } catch (err) { next(err); }
});

app.post("/api/join/:inviteCode", requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT id, name, owner_id FROM communities WHERE lower(invite_code) = lower($1)",
      [cleanName(req.params.inviteCode, 32)]
    );
    if (!result.rowCount) return res.status(404).json({ error: "That invite code wasn't found." });
    const community = result.rows[0];
    await pool.query(
      `INSERT INTO community_members (community_id, user_id, role)
       VALUES ($1, $2, 'member') ON CONFLICT (community_id, user_id) DO NOTHING`,
      [community.id, req.user.id]
    );
    res.json({ community });
  } catch (err) { next(err); }
});

app.get("/api/channels/:id/messages", requireAuth, async (req, res, next) => {
  try {
    const access = await channelAccess(req.params.id, req.user.id);
    if (!access) return res.status(403).json({ error: "You cannot view this channel." });
    const result = await pool.query(
      `SELECT m.id, m.channel_id, m.content, m.created_at,
              u.id AS user_id, u.username
         FROM messages m
         JOIN users u ON u.id = m.user_id
        WHERE m.channel_id = $1
        ORDER BY m.created_at DESC
        LIMIT 100`,
      [req.params.id]
    );
    res.json({
      messages: result.rows.reverse().map((m) => ({
        id: m.id,
        channelId: m.channel_id,
        content: m.content,
        createdAt: m.created_at,
        user: { id: m.user_id, username: m.username }
      }))
    });
  } catch (err) { next(err); }
});

io.use(async (socket, next) => {
  try {
    const cookies = cookie.parse(socket.handshake.headers.cookie || "");
    const userId = getUserIdFromToken(cookies[COOKIE_NAME]);
    if (!userId) return next(new Error("Please sign in."));
    const result = await pool.query("SELECT id, username FROM users WHERE id = $1", [userId]);
    if (!result.rowCount) return next(new Error("Account not found."));
    socket.data.user = result.rows[0];
    next();
  } catch (err) { next(err); }
});

io.on("connection", (socket) => {
  const user = socket.data.user;
  if (!onlineUsers.has(user.id)) onlineUsers.set(user.id, new Set());
  onlineUsers.get(user.id).add(socket.id);
  io.emit("presence:update", { userId: user.id, online: true });

  socket.on("channel:join", async (channelId) => {
    if (typeof channelId !== "string") return;
    try {
      const access = await channelAccess(channelId, user.id);
      if (!access) return;
      socket.join(`channel:${channelId}`);
      socket.data.joinedChannels ||= new Set();
      socket.data.joinedChannels.add(channelId);
    } catch (err) {
      console.error("Channel join failed:", err);
    }
  });

  socket.on("channel:leave", (channelId) => {
    if (typeof channelId !== "string") return;
    socket.leave(`channel:${channelId}`);
    socket.data.joinedChannels?.delete(channelId);
  });

  socket.on("chat:send", async (payload, acknowledge) => {
    const reply = typeof acknowledge === "function" ? acknowledge : () => {};
    try {
      const channelId = typeof payload?.channelId === "string" ? payload.channelId : "";
      const content = typeof payload?.content === "string" ? payload.content.trim() : "";
      if (!channelId || !content || content.length > 2000) {
        return reply({ ok: false, error: "Messages must be between 1 and 2,000 characters." });
      }
      if (!socket.data.joinedChannels?.has(channelId)) {
        return reply({ ok: false, error: "Join the channel before sending a message." });
      }
      const access = await channelAccess(channelId, user.id);
      if (!access) return reply({ ok: false, error: "You cannot send messages here." });
      const result = await pool.query(
        `INSERT INTO messages (channel_id, user_id, content)
         VALUES ($1, $2, $3)
         RETURNING id, channel_id, content, created_at`,
        [channelId, user.id, content]
      );
      const row = result.rows[0];
      const message = {
        id: row.id,
        channelId: row.channel_id,
        content: row.content,
        createdAt: row.created_at,
        user: { id: user.id, username: user.username }
      };
      io.to(`channel:${channelId}`).emit("chat:message", message);
      reply({ ok: true });
    } catch (err) {
      console.error("Message send failed:", err);
      reply({ ok: false, error: "Couldn't send that message. Try again." });
    }
  });

  socket.on("disconnect", () => {
    const sockets = onlineUsers.get(user.id);
    if (sockets) {
      sockets.delete(socket.id);
      if (!sockets.size) {
        onlineUsers.delete(user.id);
        io.emit("presence:update", { userId: user.id, online: false });
      }
    }
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong on the server." });
});

async function start() {
  await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  server.listen(PORT, () => {
    console.log(`CaveChat listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("CaveChat failed to start:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  server.close(() => {});
  await pool.end();
  process.exit(0);
});
