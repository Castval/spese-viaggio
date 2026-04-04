const express = require("express");
const { createClient } = require("@libsql/client");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// --- Database Turso (SQLite cloud) ---
const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDB() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      desc TEXT NOT NULL,
      amount REAL NOT NULL,
      payer TEXT NOT NULL,
      splitAmong TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS refunds (
      id TEXT PRIMARY KEY,
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      amount REAL NOT NULL
    )`,
  ]);
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

// --- API lettura (pubblica) ---
app.get("/api/data", async (req, res) => {
  const [participants, expenses, refunds] = await Promise.all([
    db.execute("SELECT * FROM participants"),
    db.execute("SELECT * FROM expenses"),
    db.execute('SELECT id, "from", "to", amount FROM refunds'),
  ]);
  res.json({
    participants: participants.rows,
    expenses: expenses.rows.map((e) => ({
      ...e,
      splitAmong: JSON.parse(e.splitAmong),
    })),
    refunds: refunds.rows,
  });
});

// --- API scrittura (protette da password) ---

// Partecipanti
app.post("/api/participants", checkAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Nome richiesto" });
  const id = Date.now().toString();
  try {
    await db.execute({
      sql: "INSERT INTO participants (id, name) VALUES (?, ?)",
      args: [id, name.trim()],
    });
    res.json({ id, name: name.trim() });
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return res.status(400).json({ error: "Partecipante gia' presente" });
    }
    throw e;
  }
});

app.delete("/api/participants/:id", checkAdmin, async (req, res) => {
  const row = await db.execute({
    sql: "SELECT name FROM participants WHERE id = ?",
    args: [req.params.id],
  });
  if (!row.rows.length) return res.status(404).json({ error: "Non trovato" });
  const name = row.rows[0].name;
  await db.batch([
    { sql: "DELETE FROM expenses WHERE payer = ? OR splitAmong LIKE ?", args: [name, `%"${name}"%`] },
    { sql: 'DELETE FROM refunds WHERE "from" = ? OR "to" = ?', args: [name, name] },
    { sql: "DELETE FROM participants WHERE id = ?", args: [req.params.id] },
  ]);
  res.json({ ok: true });
});

// Spese
app.post("/api/expenses", checkAdmin, async (req, res) => {
  const { desc, amount, payer, splitAmong } = req.body;
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
    sql: "INSERT INTO expenses (id, desc, amount, payer, splitAmong) VALUES (?, ?, ?, ?, ?)",
    args: [id, expense.desc, expense.amount, expense.payer, JSON.stringify(splitAmong)],
  });
  res.json(expense);
});

app.delete("/api/expenses/:id", checkAdmin, async (req, res) => {
  await db.execute({ sql: "DELETE FROM expenses WHERE id = ?", args: [req.params.id] });
  res.json({ ok: true });
});

// Restituzioni
app.post("/api/refunds", checkAdmin, async (req, res) => {
  const { from, to, amount } = req.body;
  if (!from || !to || !amount) {
    return res.status(400).json({ error: "Dati incompleti" });
  }
  if (from === to) {
    return res.status(400).json({ error: "Devono essere persone diverse" });
  }
  const id = Date.now().toString();
  const refund = { id, from, to, amount: parseFloat(amount) };
  await db.execute({
    sql: 'INSERT INTO refunds (id, "from", "to", amount) VALUES (?, ?, ?, ?)',
    args: [id, from, to, refund.amount],
  });
  res.json(refund);
});

app.delete("/api/refunds/:id", checkAdmin, async (req, res) => {
  await db.execute({ sql: "DELETE FROM refunds WHERE id = ?", args: [req.params.id] });
  res.json({ ok: true });
});

// --- Start ---
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log("Server avviato su porta " + PORT);
  });
});
