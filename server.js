const express = require("express");
const { createClient } = require("@libsql/client");

const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Permalink ai viaggi: /1, /2, ... servono lo stesso index.html (routing lato client)
app.get(/^\/\d+$/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Database Turso (SQLite cloud) ---
const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function tableExists(name) {
  const r = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: [name],
  });
  return r.rows.length > 0;
}

async function columnExists(table, column) {
  try {
    const r = await db.execute(`PRAGMA table_info(${table})`);
    return r.rows.some((row) => row.name === column);
  } catch {
    return false;
  }
}

async function initDB() {
  // Tabella viaggi
  await db.execute(`CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )`);

  // Tabella spese stimate (singole voci che sommate danno la stima totale a persona)
  await db.execute(`CREATE TABLE IF NOT EXISTS estimated_expenses (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL,
    desc TEXT NOT NULL,
    amount REAL NOT NULL
  )`);

  const hadParticipants = await tableExists("participants");
  const needsMigration =
    hadParticipants && !(await columnExists("participants", "trip_id"));

  if (needsMigration) {
    // Migrazione da vecchio schema a nuovo schema (con trip_id)
    const defaultTripId = "trip-" + Date.now();
    const countRow = await db.execute("SELECT COUNT(*) AS c FROM participants");
    const hasOldData = Number(countRow.rows[0].c) > 0;

    if (hasOldData) {
      await db.execute({
        sql: "INSERT INTO trips (id, name) VALUES (?, ?)",
        args: [defaultTripId, "Viaggio principale"],
      });
    }

    // participants
    await db.execute("ALTER TABLE participants RENAME TO participants_old");
    await db.execute(`CREATE TABLE participants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      UNIQUE(trip_id, name)
    )`);
    if (hasOldData) {
      await db.execute({
        sql: "INSERT INTO participants (id, name, trip_id) SELECT id, name, ? FROM participants_old",
        args: [defaultTripId],
      });
    }
    await db.execute("DROP TABLE participants_old");

    // expenses
    if (await tableExists("expenses")) {
      await db.execute("ALTER TABLE expenses RENAME TO expenses_old");
      await db.execute(`CREATE TABLE expenses (
        id TEXT PRIMARY KEY,
        desc TEXT NOT NULL,
        amount REAL NOT NULL,
        payer TEXT NOT NULL,
        splitAmong TEXT NOT NULL,
        trip_id TEXT NOT NULL
      )`);
      if (hasOldData) {
        await db.execute({
          sql:
            "INSERT INTO expenses (id, desc, amount, payer, splitAmong, trip_id) " +
            "SELECT id, desc, amount, payer, splitAmong, ? FROM expenses_old",
          args: [defaultTripId],
        });
      }
      await db.execute("DROP TABLE expenses_old");
    }

    // refunds
    if (await tableExists("refunds")) {
      await db.execute("ALTER TABLE refunds RENAME TO refunds_old");
      await db.execute(`CREATE TABLE refunds (
        id TEXT PRIMARY KEY,
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        amount REAL NOT NULL,
        trip_id TEXT NOT NULL
      )`);
      if (hasOldData) {
        await db.execute({
          sql:
            'INSERT INTO refunds (id, "from", "to", amount, trip_id) ' +
            'SELECT id, "from", "to", amount, ? FROM refunds_old',
          args: [defaultTripId],
        });
      }
      await db.execute("DROP TABLE refunds_old");
    }
  } else if (!hadParticipants) {
    // Prima installazione
    await db.batch([
      `CREATE TABLE participants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        trip_id TEXT NOT NULL,
        UNIQUE(trip_id, name)
      )`,
      `CREATE TABLE expenses (
        id TEXT PRIMARY KEY,
        desc TEXT NOT NULL,
        amount REAL NOT NULL,
        payer TEXT NOT NULL,
        splitAmong TEXT NOT NULL,
        trip_id TEXT NOT NULL
      )`,
      `CREATE TABLE refunds (
        id TEXT PRIMARY KEY,
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        amount REAL NOT NULL,
        trip_id TEXT NOT NULL
      )`,
    ]);
  }
}

// --- Password admin ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "cambiami123";

function checkAdmin(req, res, next) {
  const pw = req.headers["x-admin-password"];
  if (pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Password admin errata" });
  }
  next();
}

function requireTripId(req, res) {
  const tripId = req.query.tripId || (req.body && req.body.tripId);
  if (!tripId) {
    res.status(400).json({ error: "tripId richiesto" });
    return null;
  }
  return tripId;
}

// --- API Viaggi ---
app.get("/api/trips", async (req, res) => {
  const r = await db.execute(
    "SELECT id, name, created_at FROM trips ORDER BY created_at DESC, name"
  );
  res.json(r.rows);
});

app.post("/api/trips", checkAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim())
    return res.status(400).json({ error: "Nome viaggio richiesto" });
  const id = "trip-" + Date.now();
  await db.execute({
    sql: "INSERT INTO trips (id, name) VALUES (?, ?)",
    args: [id, name.trim()],
  });
  res.json({ id, name: name.trim() });
});

app.delete("/api/trips/:id", checkAdmin, async (req, res) => {
  const id = req.params.id;
  await db.batch([
    { sql: "DELETE FROM participants WHERE trip_id = ?", args: [id] },
    { sql: "DELETE FROM expenses WHERE trip_id = ?", args: [id] },
    { sql: "DELETE FROM refunds WHERE trip_id = ?", args: [id] },
    { sql: "DELETE FROM estimated_expenses WHERE trip_id = ?", args: [id] },
    { sql: "DELETE FROM trips WHERE id = ?", args: [id] },
  ]);
  res.json({ ok: true });
});

// --- API lettura (pubblica) ---
app.get("/api/data", async (req, res) => {
  const tripId = requireTripId(req, res);
  if (!tripId) return;
  const [participants, expenses, refunds, estimated] = await Promise.all([
    db.execute({
      sql: "SELECT id, name FROM participants WHERE trip_id = ?",
      args: [tripId],
    }),
    db.execute({
      sql: "SELECT * FROM expenses WHERE trip_id = ?",
      args: [tripId],
    }),
    db.execute({
      sql: 'SELECT id, "from", "to", amount FROM refunds WHERE trip_id = ?',
      args: [tripId],
    }),
    db.execute({
      sql: "SELECT id, desc, amount FROM estimated_expenses WHERE trip_id = ?",
      args: [tripId],
    }),
  ]);
  res.json({
    participants: participants.rows,
    expenses: expenses.rows.map((e) => ({
      ...e,
      splitAmong: JSON.parse(e.splitAmong),
    })),
    refunds: refunds.rows,
    estimatedExpenses: estimated.rows,
  });
});

// --- API scrittura (protette da password) ---

// Partecipanti
app.post("/api/participants", checkAdmin, async (req, res) => {
  const { name, tripId } = req.body;
  if (!tripId) return res.status(400).json({ error: "tripId richiesto" });
  if (!name || !name.trim())
    return res.status(400).json({ error: "Nome richiesto" });
  const id = Date.now().toString();
  try {
    await db.execute({
      sql: "INSERT INTO participants (id, name, trip_id) VALUES (?, ?, ?)",
      args: [id, name.trim(), tripId],
    });
    res.json({ id, name: name.trim() });
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return res
        .status(400)
        .json({ error: "Partecipante gia' presente in questo viaggio" });
    }
    throw e;
  }
});

app.delete("/api/participants/:id", checkAdmin, async (req, res) => {
  const row = await db.execute({
    sql: "SELECT name, trip_id FROM participants WHERE id = ?",
    args: [req.params.id],
  });
  if (!row.rows.length) return res.status(404).json({ error: "Non trovato" });
  const { name, trip_id: tripId } = row.rows[0];
  await db.batch([
    {
      sql:
        "DELETE FROM expenses WHERE trip_id = ? AND (payer = ? OR splitAmong LIKE ?)",
      args: [tripId, name, `%"${name}"%`],
    },
    {
      sql: 'DELETE FROM refunds WHERE trip_id = ? AND ("from" = ? OR "to" = ?)',
      args: [tripId, name, name],
    },
    { sql: "DELETE FROM participants WHERE id = ?", args: [req.params.id] },
  ]);
  res.json({ ok: true });
});

// Spese
app.post("/api/expenses", checkAdmin, async (req, res) => {
  const { desc, amount, payer, splitAmong, tripId } = req.body;
  if (!tripId) return res.status(400).json({ error: "tripId richiesto" });
  if (!desc || !amount || !payer || !splitAmong || !splitAmong.length) {
    return res.status(400).json({ error: "Dati incompleti" });
  }
  const id = Date.now().toString();
  const expense = {
    id,
    desc: desc.trim(),
    amount: parseFloat(amount),
    payer,
    splitAmong,
  };
  await db.execute({
    sql:
      "INSERT INTO expenses (id, desc, amount, payer, splitAmong, trip_id) VALUES (?, ?, ?, ?, ?, ?)",
    args: [
      id,
      expense.desc,
      expense.amount,
      expense.payer,
      JSON.stringify(splitAmong),
      tripId,
    ],
  });
  res.json(expense);
});

app.delete("/api/expenses/:id", checkAdmin, async (req, res) => {
  await db.execute({
    sql: "DELETE FROM expenses WHERE id = ?",
    args: [req.params.id],
  });
  res.json({ ok: true });
});

// Restituzioni
app.post("/api/refunds", checkAdmin, async (req, res) => {
  const { from, to, amount, tripId } = req.body;
  if (!tripId) return res.status(400).json({ error: "tripId richiesto" });
  if (!from || !to || !amount) {
    return res.status(400).json({ error: "Dati incompleti" });
  }
  if (from === to) {
    return res.status(400).json({ error: "Devono essere persone diverse" });
  }
  const id = Date.now().toString();
  const refund = { id, from, to, amount: parseFloat(amount) };
  await db.execute({
    sql:
      'INSERT INTO refunds (id, "from", "to", amount, trip_id) VALUES (?, ?, ?, ?, ?)',
    args: [id, from, to, refund.amount, tripId],
  });
  res.json(refund);
});

app.delete("/api/refunds/:id", checkAdmin, async (req, res) => {
  await db.execute({
    sql: "DELETE FROM refunds WHERE id = ?",
    args: [req.params.id],
  });
  res.json({ ok: true });
});

// Spese stimate (singole voci a persona)
app.post("/api/estimated-expenses", checkAdmin, async (req, res) => {
  const { desc, amount, tripId } = req.body;
  if (!tripId) return res.status(400).json({ error: "tripId richiesto" });
  if (!desc || !desc.trim()) {
    return res.status(400).json({ error: "Descrizione richiesta" });
  }
  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) {
    return res.status(400).json({ error: "Importo non valido" });
  }
  const id = Date.now().toString();
  await db.execute({
    sql:
      "INSERT INTO estimated_expenses (id, trip_id, desc, amount) VALUES (?, ?, ?, ?)",
    args: [id, tripId, desc.trim(), parsed],
  });
  res.json({ id, desc: desc.trim(), amount: parsed });
});

app.delete("/api/estimated-expenses/:id", checkAdmin, async (req, res) => {
  await db.execute({
    sql: "DELETE FROM estimated_expenses WHERE id = ?",
    args: [req.params.id],
  });
  res.json({ ok: true });
});

// --- Start ---
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log("Server avviato su porta " + PORT);
  });
});
