require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');

// ---------- Config ----------
const {
  DATABASE_URL,
  GOOGLE_CLIENT_ID,
  SESSION_SECRET,
  ADMIN_USER,
  ADMIN_PASS,
} = process.env;
const DOMAIN = (process.env.ALLOWED_DOMAIN || '@mitsgwl.ac.in').toLowerCase();
const PORT = process.env.PORT || 3000;

for (const [k, v] of Object.entries({ DATABASE_URL, GOOGLE_CLIENT_ID, SESSION_SECRET })) {
  if (!v) {
    console.error(`Missing environment variable: ${k}`);
    process.exit(1);
  }
}

const MACHINE_FLOORS = [2, 4, 6];
const MAX_PER_ROOM = 4;
// Valid rooms: [floor-prefixed first, last]
const ROOM_RANGES = [
  [101, 111],
  [201, 211],
  [301, 312],
  [401, 408],
  [501, 508],
  [601, 604],
  [701, 704],
];

function isValidRoom(n) {
  return Number.isInteger(n) && ROOM_RANGES.some(([a, b]) => n >= a && n <= b);
}

// Accepts "201" (string or number). Returns the number, or null if invalid.
function parseRoom(input) {
  const s = String(input ?? '').trim();
  if (!/^\d{3}$/.test(s)) return null;
  const n = Number(s);
  return isValidRoom(n) ? n : null;
}

const MSG_INVALID_ROOM = 'Invalid room number.';
const MSG_ROOM_FULL = 'This room is full. Enter your room number carefully or contact admin.';

// ---------- Database ----------
const isLocalDb = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
  max: 5,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      room INT NOT NULL,
      floor INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS users_room_idx ON users(room);

    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id),
      machine_floor INT NOT NULL CHECK (machine_floor IN (2,4,6)),
      start_time TIMESTAMPTZ NOT NULL DEFAULT now(),
      end_time TIMESTAMPTZ,
      duration_minutes INT
    );
    -- Database-level guarantees: one running session per machine, one per student
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_machine
      ON logs(machine_floor) WHERE end_time IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_user
      ON logs(user_id) WHERE end_time IS NULL;
    CREATE INDEX IF NOT EXISTS logs_floor_start_idx ON logs(machine_floor, start_time DESC);

    CREATE TABLE IF NOT EXISTS admins (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL
    );
  `);

  const { rowCount } = await pool.query('SELECT 1 FROM admins LIMIT 1');
  if (rowCount === 0) {
    if (!ADMIN_USER || !ADMIN_PASS) {
      console.error('No admin exists yet. Set ADMIN_USER and ADMIN_PASS to create one.');
      process.exit(1);
    }
    const hash = await bcrypt.hash(ADMIN_PASS, 10);
    await pool.query('INSERT INTO admins(username, password_hash) VALUES ($1, $2)', [ADMIN_USER, hash]);
    console.log('Admin account created.');
  }
}

// ---------- App + session helpers ----------
const app = express();
app.set('trust proxy', 1); // Render / Vercel sit behind a proxy
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const gClient = new OAuth2Client(GOOGLE_CLIENT_ID);

function setSession(req, res, payload) {
  const token = jwt.sign(payload, SESSION_SECRET, { expiresIn: '7d' });
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

app.use((req, res, next) => {
  const token = req.cookies.session;
  if (token) {
    try {
      req.session = jwt.verify(token, SESSION_SECRET);
    } catch (_) {
      /* invalid or expired: treat as logged out */
    }
  }
  next();
});

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const fail = (res, status, message, error) => res.status(status).json({ error: error || 'error', message });

function requireStudent(req, res, next) {
  if (req.session?.role !== 'student') return fail(res, 401, 'Please log in.', 'not_logged_in');
  next();
}

const requireRegistered = [
  requireStudent,
  wrap(async (req, res, next) => {
    const { rows } = await pool.query('SELECT id, name, email, room, floor FROM users WHERE email = $1', [
      req.session.email,
    ]);
    if (!rows.length) return fail(res, 403, 'Add your room number first.', 'no_room');
    req.user = rows[0];
    next();
  }),
];

function requireAdmin(req, res, next) {
  if (req.session?.role !== 'admin') return fail(res, 401, 'Admin login required.', 'not_admin');
  next();
}

// ---------- Public config ----------
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID, domain: DOMAIN });
});

// ---------- Auth ----------
app.post(
  '/api/auth/google',
  wrap(async (req, res) => {
    const credential = req.body?.credential;
    if (!credential) return fail(res, 400, 'Google sign-in failed. Try again.');

    let payload;
    try {
      const ticket = await gClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (_) {
      return fail(res, 401, 'Google sign-in failed. Try again.', 'bad_token');
    }

    const email = (payload.email || '').toLowerCase();
    if (!payload.email_verified || !email.endsWith(DOMAIN)) {
      return fail(res, 403, `Only college email IDs ending with ${DOMAIN} can log in.`, 'bad_domain');
    }

    const name = (payload.name || email.split('@')[0]).slice(0, 100);
    setSession(req, res, { role: 'student', email, name });

    const { rowCount } = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
    res.json({ registered: rowCount > 0 });
  })
);

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many attempts. Try again in 15 minutes.' },
});

app.post(
  '/api/auth/admin',
  adminLoginLimiter,
  wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return fail(res, 400, 'Enter username and password.');
    }
    const { rows } = await pool.query('SELECT username, password_hash FROM admins WHERE username = $1', [username.trim()]);
    const ok = rows.length && (await bcrypt.compare(password, rows[0].password_hash));
    if (!ok) return fail(res, 401, 'Wrong username or password.', 'bad_admin');
    setSession(req, res, { role: 'admin', username: rows[0].username });
    res.json({ ok: true });
  })
);

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get(
  '/api/me',
  wrap(async (req, res) => {
    const s = req.session;
    if (!s) return res.json({ role: null });
    if (s.role === 'admin') return res.json({ role: 'admin', username: s.username });
    const { rows } = await pool.query('SELECT id, name, email, room, floor FROM users WHERE email = $1', [s.email]);
    if (!rows.length) return res.json({ role: 'student', registered: false, name: s.name, email: s.email });
    res.json({ role: 'student', registered: true, ...rows[0] });
  })
);

// ---------- First-time room registration ----------
app.post(
  '/api/register',
  requireStudent,
  wrap(async (req, res) => {
    const room = parseRoom(req.body?.room);
    if (room === null) return fail(res, 400, MSG_INVALID_ROOM, 'invalid_room');

    const { email, name } = req.session;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise registrations for the same room so two people can't take the 4th and 5th seat at once
      await client.query('SELECT pg_advisory_xact_lock($1)', [room]);

      const exists = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (exists.rowCount) {
        await client.query('ROLLBACK');
        return fail(res, 409, 'You are already registered.', 'already_registered');
      }
      const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM users WHERE room = $1', [room]);
      if (rows[0].n >= MAX_PER_ROOM) {
        await client.query('ROLLBACK');
        return fail(res, 409, MSG_ROOM_FULL, 'room_full');
      }
      await client.query('INSERT INTO users(name, email, room, floor) VALUES ($1, $2, $3, $4)', [
        name,
        email,
        room,
        Math.floor(room / 100),
      ]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  })
);

// ---------- Washing machine logs ----------
const LOG_SELECT = `
  SELECT l.id, l.user_id, l.machine_floor, u.name, u.room,
         l.start_time, l.end_time, l.duration_minutes
  FROM logs l JOIN users u ON u.id = l.user_id`;

app.get(
  '/api/logs',
  requireRegistered,
  wrap(async (req, res) => {
    const floor = Number(req.query.floor);
    if (!MACHINE_FLOORS.includes(floor)) return fail(res, 400, 'Unknown floor.');

    const logs = (await pool.query(`${LOG_SELECT} WHERE l.machine_floor = $1 ORDER BY l.start_time DESC LIMIT 100`, [floor]))
      .rows;
    const active = logs.find((l) => l.end_time === null) || null;
    const mine = (
      await pool.query('SELECT id, machine_floor FROM logs WHERE user_id = $1 AND end_time IS NULL', [req.user.id])
    ).rows[0] || null;

    res.json({ logs, active, mine, meId: req.user.id });
  })
);

app.post(
  '/api/logs/start',
  requireRegistered,
  wrap(async (req, res) => {
    const floor = Number(req.body?.floor);
    if (!MACHINE_FLOORS.includes(floor)) return fail(res, 400, 'Unknown floor.');
    try {
      await pool.query('INSERT INTO logs(user_id, machine_floor) VALUES ($1, $2)', [req.user.id, floor]);
      res.json({ ok: true });
    } catch (e) {
      if (e.code === '23505') {
        if (e.constraint === 'one_active_per_user') {
          return fail(res, 409, 'You already have a machine running. Stop it first.', 'already_running');
        }
        return fail(res, 409, 'This machine is already in use.', 'machine_busy');
      }
      throw e;
    }
  })
);

const STOP_SQL = `
  UPDATE logs
  SET end_time = now(),
      duration_minutes = ROUND((EXTRACT(EPOCH FROM (now() - start_time)) / 60)::numeric)::int
  WHERE end_time IS NULL`;

app.post(
  '/api/logs/stop',
  requireRegistered,
  wrap(async (req, res) => {
    const r = await pool.query(`${STOP_SQL} AND user_id = $1 RETURNING id`, [req.user.id]);
    if (!r.rowCount) return fail(res, 404, 'You have no running machine.', 'nothing_running');
    res.json({ ok: true });
  })
);

// ---------- Admin ----------
app.get(
  '/api/admin/users',
  requireAdmin,
  wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT id, name, email, room, floor, created_at FROM users ORDER BY room, name');
    res.json({ users: rows });
  })
);

app.put(
  '/api/admin/users/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const room = parseRoom(req.body?.room);
    const name = String(req.body?.name ?? '').trim().slice(0, 100);
    if (!Number.isInteger(id)) return fail(res, 400, 'Bad user id.');
    if (room === null) return fail(res, 400, MSG_INVALID_ROOM, 'invalid_room');
    if (!name) return fail(res, 400, 'Name cannot be empty.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [room]);
      const cur = await client.query('SELECT room FROM users WHERE id = $1', [id]);
      if (!cur.rowCount) {
        await client.query('ROLLBACK');
        return fail(res, 404, 'Student not found.');
      }
      if (cur.rows[0].room !== room) {
        const c = await client.query('SELECT COUNT(*)::int AS n FROM users WHERE room = $1 AND id <> $2', [room, id]);
        if (c.rows[0].n >= MAX_PER_ROOM) {
          await client.query('ROLLBACK');
          return fail(res, 409, MSG_ROOM_FULL, 'room_full');
        }
      }
      await client.query('UPDATE users SET name = $1, room = $2, floor = $3 WHERE id = $4', [
        name,
        room,
        Math.floor(room / 100),
        id,
      ]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  })
);

app.post(
  '/api/admin/password',
  requireAdmin,
  wrap(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return fail(res, 400, 'Fill in both passwords.');
    }
    if (newPassword.length < 8) return fail(res, 400, 'New password must be at least 8 characters.');
    const { rows } = await pool.query('SELECT password_hash FROM admins WHERE username = $1', [req.session.username]);
    if (!rows.length || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
      return fail(res, 401, 'Current password is wrong.', 'bad_admin');
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE admins SET password_hash = $1 WHERE username = $2', [hash, req.session.username]);
    res.json({ ok: true });
  })
);

app.get(
  '/api/admin/logs',
  requireAdmin,
  wrap(async (req, res) => {
    const { rows } = await pool.query(`${LOG_SELECT} ORDER BY l.start_time DESC LIMIT 300`);
    res.json({ logs: rows });
  })
);

// Admin can stop a session someone forgot to stop
app.post(
  '/api/admin/logs/:id/stop',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return fail(res, 400, 'Bad log id.');
    const r = await pool.query(`${STOP_SQL} AND id = $1 RETURNING id`, [id]);
    if (!r.rowCount) return fail(res, 404, 'That session is not running.');
    res.json({ ok: true });
  })
);

// ---------- CSV export ----------
function fmtIST(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function sendCsv(res, filename, header, rows) {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.send('\uFEFF' + lines.join('\r\n'));
}

app.get(
  '/api/admin/export/logs.csv',
  requireAdmin,
  wrap(async (req, res) => {
    const { rows } = await pool.query(`
      SELECT l.id, l.machine_floor, u.name, u.room, u.email, l.start_time, l.end_time, l.duration_minutes
      FROM logs l JOIN users u ON u.id = l.user_id
      ORDER BY l.start_time DESC`);
    sendCsv(
      res,
      'washing-machine-logs.csv',
      ['Log ID', 'Machine floor', 'Name', 'Room', 'Email', 'Start time (IST)', 'Stop time (IST)', 'Duration (min)'],
      rows.map((r) => [r.id, r.machine_floor, r.name, r.room, r.email, fmtIST(r.start_time), fmtIST(r.end_time), r.duration_minutes])
    );
  })
);

app.get(
  '/api/admin/export/users.csv',
  requireAdmin,
  wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT id, name, email, room, floor, created_at FROM users ORDER BY room, name');
    sendCsv(
      res,
      'registrations.csv',
      ['ID', 'Name', 'Email', 'Room', 'Floor', 'Registered at (IST)'],
      rows.map((r) => [r.id, r.name, r.email, r.room, r.floor, fmtIST(r.created_at)])
    );
  })
);

// ---------- Static frontend + errors ----------
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server', message: 'Something went wrong. Try again.' });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Running on port ${PORT}`)))
  .catch((e) => {
    console.error('Startup failed:', e);
    process.exit(1);
  });
