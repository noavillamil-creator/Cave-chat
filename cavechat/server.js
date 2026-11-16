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
const multer = require("multer");

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const allowed = new Set([
      "image/png", "image/jpeg", "image/gif", "image/webp",
      "application/pdf", "text/plain", "text/csv",
      "application/zip", "application/x-zip-compressed",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "audio/mpeg", "audio/mp4", "video/mp4"
    ]);
    if (!allowed.has(file.mimetype)) return callback(new Error("That file type is not allowed."));
    callback(null, true);
  }
});

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


async function dmAccess(conversationId, userId) {
  const result = await pool.query(
    `SELECT id, user_one_id, user_two_id
       FROM dm_conversations
      WHERE id = $1 AND (user_one_id = $2 OR user_two_id = $2)`,
    [conversationId, userId]
  );
  return result.rows[0] || null;
}

function cleanMediaUrl(value) {
  if (typeof value !== "string" || value.length > 2000) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !(url.hostname === "giphy.com" || url.hostname.endsWith(".giphy.com"))) return "";
    return url.toString();
  } catch { return ""; }
}

function cleanFileName(value) {
  const name = path.basename(String(value || "upload")).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return (name || "upload").slice(0, 180);
}

function attachmentUrl(scope, parentId, messageId) {
  return `/api/${scope}/${parentId}/messages/${messageId}/file`;
}

function sendStoredFile(res, row) {
  if (!row || !row.file_data) return res.status(404).json({ error: "File not found." });
  const safeName = cleanFileName(row.file_name || "download");
  const inline = ["image/png", "image/jpeg", "image/gif", "image/webp", "audio/mpeg", "audio/mp4", "video/mp4", "application/pdf"].includes(row.file_mime);
  res.setHeader("Content-Type", row.file_mime || "application/octet-stream");
  res.setHeader("Content-Length", row.file_data.length);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(safeName)}`);
  res.send(row.file_data);
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
      `SELECT m.id, m.channel_id, m.content, m.media_url, m.media_kind,
              m.file_name, m.file_mime, m.file_size, m.created_at,
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
        mediaUrl: m.media_url,
        mediaKind: m.media_kind,
        fileName: m.file_name,
        fileMime: m.file_mime,
        fileSize: m.file_size,
        fileUrl: m.file_name ? attachmentUrl("channels", req.params.id, m.id) : null,
        createdAt: m.created_at,
        user: { id: m.user_id, username: m.username }
      }))
    });
  } catch (err) { next(err); }
});


// Public profile lookup: usernames only, never email addresses.
app.get("/api/users/search", requireAuth, async (req, res, next) => {
  try {
    const query = cleanName(req.query.q, 24);
    if (query.length < 2) return res.json({ users: [] });
    const result = await pool.query(
      `SELECT id, username FROM users
        WHERE id <> $1 AND lower(username) LIKE lower($2)
        ORDER BY CASE WHEN lower(username) = lower($3) THEN 0 ELSE 1 END, lower(username)
        LIMIT 12`,
      [req.user.id, `%${query}%`, query]
    );
    res.json({ users: result.rows.map((u) => ({ ...u, online: (onlineUsers.get(u.id)?.size || 0) > 0 })) });
  } catch (err) { next(err); }
});

app.get("/api/config", requireAuth, (_req, res) => {
  // GIPHY explicitly requires its Search API call to be made client-side; this is a public app key.
  res.json({ giphyApiKey: process.env.GIPHY_API_KEY || "", gifsEnabled: Boolean(process.env.GIPHY_API_KEY) });
});

app.get("/api/dms", requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT dc.id,
              CASE WHEN dc.user_one_id = $1 THEN u2.id ELSE u1.id END AS other_user_id,
              CASE WHEN dc.user_one_id = $1 THEN u2.username ELSE u1.username END AS other_username,
              latest.content AS last_message,
              latest.created_at AS last_message_at
         FROM dm_conversations dc
         JOIN users u1 ON u1.id = dc.user_one_id
         JOIN users u2 ON u2.id = dc.user_two_id
         LEFT JOIN LATERAL (
           SELECT content, created_at FROM direct_messages
            WHERE conversation_id = dc.id ORDER BY created_at DESC LIMIT 1
         ) latest ON TRUE
        WHERE dc.user_one_id = $1 OR dc.user_two_id = $1
        ORDER BY COALESCE(latest.created_at, dc.created_at) DESC`,
      [req.user.id]
    );
    res.json({ dms: result.rows.map((dm) => ({ ...dm, online: (onlineUsers.get(dm.other_user_id)?.size || 0) > 0 })) });
  } catch (err) { next(err); }
});

app.post("/api/dms/:userId", requireAuth, async (req, res, next) => {
  try {
    const otherId = req.params.userId;
    if (otherId === req.user.id) return res.status(400).json({ error: "You cannot start a DM with yourself." });
    const other = await pool.query("SELECT id, username FROM users WHERE id = $1", [otherId]);
    if (!other.rowCount) return res.status(404).json({ error: "Account not found." });
    const [one, two] = [req.user.id, otherId].sort();
    const result = await pool.query(
      `INSERT INTO dm_conversations (user_one_id, user_two_id)
       VALUES ($1, $2)
       ON CONFLICT (user_one_id, user_two_id) DO UPDATE SET user_one_id = EXCLUDED.user_one_id
       RETURNING id`,
      [one, two]
    );
    res.status(200).json({ conversation: { id: result.rows[0].id, other_user_id: other.rows[0].id, other_username: other.rows[0].username, online: (onlineUsers.get(otherId)?.size || 0) > 0 } });
  } catch (err) { next(err); }
});

app.get("/api/dms/:id/messages", requireAuth, async (req, res, next) => {
  try {
    if (!(await dmAccess(req.params.id, req.user.id))) return res.status(403).json({ error: "You cannot view this conversation." });
    const result = await pool.query(
      `SELECT m.id, m.conversation_id, m.content, m.media_url, m.media_kind,
              m.file_name, m.file_mime, m.file_size, m.created_at,
              u.id AS user_id, u.username
         FROM direct_messages m JOIN users u ON u.id = m.user_id
        WHERE m.conversation_id = $1 ORDER BY m.created_at DESC LIMIT 100`,
      [req.params.id]
    );
    res.json({ messages: result.rows.reverse().map((m) => ({
      id: m.id, conversationId: m.conversation_id, content: m.content,
      mediaUrl: m.media_url, mediaKind: m.media_kind,
      fileName: m.file_name, fileMime: m.file_mime, fileSize: m.file_size,
      fileUrl: m.file_name ? attachmentUrl("dms", req.params.id, m.id) : null,
      createdAt: m.created_at, user: { id: m.user_id, username: m.username }
    })) });
  } catch (err) { next(err); }
});

app.post("/api/channels/:id/upload", requireAuth, (req, res, next) => {
  upload.single("file")(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(uploadErr.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: uploadErr.code === "LIMIT_FILE_SIZE" ? "Files must be 8 MB or smaller." : uploadErr.message });
    try {
      if (!req.file) return res.status(400).json({ error: "Choose a file first." });
      const channel = await channelAccess(req.params.id, req.user.id);
      if (!channel) return res.status(403).json({ error: "You cannot upload to this channel." });
      const result = await pool.query(
        `INSERT INTO messages (channel_id, user_id, content, file_name, file_mime, file_size, file_data)
         VALUES ($1, $2, '', $3, $4, $5, $6)
         RETURNING id, channel_id, content, created_at, file_name, file_mime, file_size`,
        [req.params.id, req.user.id, cleanFileName(req.file.originalname), req.file.mimetype, req.file.size, req.file.buffer]
      );
      const row = result.rows[0];
      const message = { id: row.id, channelId: row.channel_id, content: row.content, fileName: row.file_name, fileMime: row.file_mime, fileSize: row.file_size, fileUrl: attachmentUrl("channels", req.params.id, row.id), createdAt: row.created_at, user: { id: req.user.id, username: req.user.username } };
      io.to(`channel:${req.params.id}`).emit("chat:message", message);
      res.status(201).json({ message });
    } catch (err) { next(err); }
  });
});

app.get("/api/channels/:channelId/messages/:messageId/file", requireAuth, async (req, res, next) => {
  try {
    const channel = await channelAccess(req.params.channelId, req.user.id);
    if (!channel) return res.status(403).json({ error: "You cannot access this file." });
    const result = await pool.query(
      "SELECT file_name, file_mime, file_data FROM messages WHERE id = $1 AND channel_id = $2",
      [req.params.messageId, req.params.channelId]
    );
    sendStoredFile(res, result.rows[0]);
  } catch (err) { next(err); }
});

app.post("/api/dms/:id/upload", requireAuth, (req, res, next) => {
  upload.single("file")(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(uploadErr.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: uploadErr.code === "LIMIT_FILE_SIZE" ? "Files must be 8 MB or smaller." : uploadErr.message });
    try {
      if (!req.file) return res.status(400).json({ error: "Choose a file first." });
      if (!(await dmAccess(req.params.id, req.user.id))) return res.status(403).json({ error: "You cannot upload to this conversation." });
      const result = await pool.query(
        `INSERT INTO direct_messages (conversation_id, user_id, content, file_name, file_mime, file_size, file_data)
         VALUES ($1, $2, '', $3, $4, $5, $6)
         RETURNING id, conversation_id, content, created_at, file_name, file_mime, file_size`,
        [req.params.id, req.user.id, cleanFileName(req.file.originalname), req.file.mimetype, req.file.size, req.file.buffer]
      );
      const row = result.rows[0];
      const message = { id: row.id, conversationId: row.conversation_id, content: row.content, fileName: row.file_name, fileMime: row.file_mime, fileSize: row.file_size, fileUrl: attachmentUrl("dms", req.params.id, row.id), createdAt: row.created_at, user: { id: req.user.id, username: req.user.username } };
      io.to(`dm:${req.params.id}`).emit("dm:message", message);
      res.status(201).json({ message });
    } catch (err) { next(err); }
  });
});

app.get("/api/dms/:conversationId/messages/:messageId/file", requireAuth, async (req, res, next) => {
  try {
    if (!(await dmAccess(req.params.conversationId, req.user.id))) return res.status(403).json({ error: "You cannot access this file." });
    const result = await pool.query(
      "SELECT file_name, file_mime, file_data FROM direct_messages WHERE id = $1 AND conversation_id = $2",
      [req.params.messageId, req.params.conversationId]
    );
    sendStoredFile(res, result.rows[0]);
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


  socket.on("dm:join", async (conversationId) => {
    if (typeof conversationId !== "string") return;
    try {
      if (!(await dmAccess(conversationId, user.id))) return;
      socket.join(`dm:${conversationId}`);
      socket.data.joinedDMs ||= new Set();
      socket.data.joinedDMs.add(conversationId);
    } catch (err) { console.error("DM join failed:", err); }
  });

  socket.on("dm:leave", (conversationId) => {
    if (typeof conversationId !== "string") return;
    socket.leave(`dm:${conversationId}`);
    socket.data.joinedDMs?.delete(conversationId);
  });

  socket.on("dm:send", async (payload, acknowledge) => {
    const reply = typeof acknowledge === "function" ? acknowledge : () => {};
    try {
      const conversationId = typeof payload?.conversationId === "string" ? payload.conversationId : "";
      const content = typeof payload?.content === "string" ? payload.content.trim() : "";
      const mediaUrl = cleanMediaUrl(payload?.mediaUrl);
      if (!conversationId || (!content && !mediaUrl) || content.length > 2000 || (payload?.mediaUrl && !mediaUrl)) {
        return reply({ ok: false, error: "That message is invalid." });
      }
      if (!socket.data.joinedDMs?.has(conversationId)) return reply({ ok: false, error: "Join the conversation before sending." });
      if (!(await dmAccess(conversationId, user.id))) return reply({ ok: false, error: "You cannot send messages here." });
      const result = await pool.query(
        `INSERT INTO direct_messages (conversation_id, user_id, content, media_url, media_kind)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, conversation_id, content, media_url, media_kind, created_at`,
        [conversationId, user.id, content, mediaUrl || null, mediaUrl ? "gif" : null]
      );
      const row = result.rows[0];
      const message = { id: row.id, conversationId: row.conversation_id, content: row.content, mediaUrl: row.media_url, mediaKind: row.media_kind, createdAt: row.created_at, user: { id: user.id, username: user.username } };
      io.to(`dm:${conversationId}`).emit("dm:message", message);
      reply({ ok: true });
    } catch (err) {
      console.error("DM send failed:", err);
      reply({ ok: false, error: "Couldn't send that direct message." });
    }
  });

  socket.on("chat:send", async (payload, acknowledge) => {
    const reply = typeof acknowledge === "function" ? acknowledge : () => {};
    try {
      const channelId = typeof payload?.channelId === "string" ? payload.channelId : "";
      const content = typeof payload?.content === "string" ? payload.content.trim() : "";
      const mediaUrl = cleanMediaUrl(payload?.mediaUrl);
      if (!channelId || (!content && !mediaUrl) || content.length > 2000 || (payload?.mediaUrl && !mediaUrl)) {
        return reply({ ok: false, error: "That message is invalid." });
      }
      if (!socket.data.joinedChannels?.has(channelId)) {
        return reply({ ok: false, error: "Join the channel before sending a message." });
      }
      const access = await channelAccess(channelId, user.id);
      if (!access) return reply({ ok: false, error: "You cannot send messages here." });
      const result = await pool.query(
        `INSERT INTO messages (channel_id, user_id, content, media_url, media_kind)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, channel_id, content, media_url, media_kind, created_at`,
        [channelId, user.id, content, mediaUrl || null, mediaUrl ? "gif" : null]
      );
      const row = result.rows[0];
      const message = {
        id: row.id,
        channelId: row.channel_id,
        content: row.content,
        mediaUrl: row.media_url,
        mediaKind: row.media_kind,
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
