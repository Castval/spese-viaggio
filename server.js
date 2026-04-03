const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// --- Database JSON su disco ---
const DB_PATH = path.join(__dirname, ".data", "db.json");

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return { participants: [], expenses: [], refunds: [] };
  }
}

function writeDB(data) {
  // .data e' la cartella persistente di Glitch
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Inizializza il db se non esiste
if (!fs.existsSync(DB_PATH)) {
  writeDB({ participants: [], expenses: [], refunds: [] });
}

// --- Password admin (cambiala!) ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "cambiami123";

function checkAdmin(req, res, next) {
  const pw = req.headers["x-admin-password"];
  if (pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Password admin errata" });
  }
  next();
}

// --- API lettura (pubbliche) ---
app.get("/api/data", (req, res) => {
  res.json(readDB());
});

// --- API scrittura (protette da password) ---

// Partecipanti
app.post("/api/participants", checkAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Nome richiesto" });
  const db = readDB();
  if (db.participants.some((p) => p.name === name.trim())) {
    return res.status(400).json({ error: "Partecipante gia' presente" });
  }
  const participant = { id: Date.now().toString(), name: name.trim() };
  db.participants.push(participant);
  writeDB(db);
  res.json(participant);
});

app.delete("/api/participants/:id", checkAdmin, (req, res) => {
  const db = readDB();
  const p = db.participants.find((p) => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Non trovato" });
  // Rimuovi spese e restituzioni associate
  db.expenses = db.expenses.filter(
    (e) => e.payer !== p.name && !e.splitAmong.includes(p.name)
  );
  db.refunds = db.refunds.filter(
    (r) => r.from !== p.name && r.to !== p.name
  );
  db.participants = db.participants.filter((x) => x.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// Spese
app.post("/api/expenses", checkAdmin, (req, res) => {
  const { desc, amount, payer, splitAmong } = req.body;
  if (!desc || !amount || !payer || !splitAmong || !splitAmong.length) {
    return res.status(400).json({ error: "Dati incompleti" });
  }
  const db = readDB();
  const expense = {
    id: Date.now().toString(),
    desc: desc.trim(),
    amount: parseFloat(amount),
    payer,
    splitAmong,
  };
  db.expenses.push(expense);
  writeDB(db);
  res.json(expense);
});

app.delete("/api/expenses/:id", checkAdmin, (req, res) => {
  const db = readDB();
  db.expenses = db.expenses.filter((e) => e.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// Restituzioni
app.post("/api/refunds", checkAdmin, (req, res) => {
  const { from, to, amount } = req.body;
  if (!from || !to || !amount) {
    return res.status(400).json({ error: "Dati incompleti" });
  }
  if (from === to) {
    return res.status(400).json({ error: "Devono essere persone diverse" });
  }
  const db = readDB();
  const refund = {
    id: Date.now().toString(),
    from,
    to,
    amount: parseFloat(amount),
  };
  db.refunds.push(refund);
  writeDB(db);
  res.json(refund);
});

app.delete("/api/refunds/:id", checkAdmin, (req, res) => {
  const db = readDB();
  db.refunds = db.refunds.filter((r) => r.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server avviato su porta " + PORT);
});
