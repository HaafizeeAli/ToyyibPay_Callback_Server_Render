import express from "express";
import bodyParser from "body-parser";
import { Pool } from "pg";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ENV (set di Render) =====
// - DATABASE_URL   : postgresql://postgres:...@...supabase.co:5432/postgres?sslmode=require
// - CALLBACK_TOKEN : contohnya "f1zToyyib123"
const CALLBACK_TOKEN = process.env.CALLBACK_TOKEN || "";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Pool Postgres (Supabase)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Tambahan untuk berjaga-jaga jika sslmode tak dihormati oleh driver:
  ssl: { rejectUnauthorized: false }
});

// Buat jadual jika belum ada
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id            BIGSERIAL PRIMARY KEY,
      order_id      VARCHAR(64) UNIQUE NOT NULL,
      billcode      VARCHAR(64),
      amount_cents  INTEGER NOT NULL DEFAULT 0,
      currency      VARCHAR(3) NOT NULL DEFAULT 'MYR',
      status_id     SMALLINT NOT NULL DEFAULT 0,   -- 1=PAID,2=PENDING,3=FAILED
      status_text   VARCHAR(32) NOT NULL DEFAULT 'UNKNOWN',
      payer_email   VARCHAR(255),
      payer_phone   VARCHAR(64),
      payer_name    VARCHAR(255),
      remarks       TEXT,
      raw_payload   JSONB NOT NULL,
      paid_at       TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_orders_billcode ON orders(billcode);
  `);
}
ensureSchema().catch(e => {
  console.error("Failed to ensure schema:", e);
  process.exit(1);
});

// Helpers
const mapStatus = s => (s === "1" ? "PAID" : s === "3" ? "FAILED" : "PENDING");
const toCents = v => {
  if (v == null) return 0;
  const str = String(v).trim();
  if (/^\d+$/.test(str)) return parseInt(str, 10); // sudah sen
  const f = Number.parseFloat(str);
  if (Number.isNaN(f)) return 0;
  return Math.round(f * 100);                       // RM → sen
};

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Healthcheck
app.get("/", (req, res) => {
  res.type("text").send("OK - ToyyibPay sandbox server is running");
});

// RETURN (papar resit ringkas)
app.all("/toyyib/return", (req, res) => {
  const params = Object.keys(req.query).length ? req.query : req.body;
  const status_id = params.status_id || "";
  const className = status_id === "1" ? "ok" : status_id === "3" ? "fail" : "pending";
  res.type("html").send(`<!doctype html>
<html lang="ms"><meta charset="utf-8" />
<title>Resit / Return</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
 body{font-family:system-ui,Arial,sans-serif;max-width:680px;margin:24px auto;padding:16px}
 .card{border:1px solid #eee;border-radius:12px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,.05)}
 .ok{color:#0a7}.fail{color:#c00}.pending{color:#555}
 pre{background:#fafafa;border:1px solid #eee;padding:12px;border-radius:8px;overflow:auto}
 a.btn{display:inline-block;margin-top:12px;padding:10px 14px;border-radius:8px;border:1px solid #ddd;text-decoration:none}
</style>
<h2>Maklumbalas Pembayaran</h2>
<div class="card">
  <p><strong>Status:</strong> <span class="${className}">
    ${status_id === "1" ? "BERJAYA" : status_id === "3" ? "GAGAL" : "PENDING / TIDAK PASTI"}
  </span></p>
  <p><strong>Billcode:</strong> ${params.billcode || ""}</p>
  <p><strong>Order ID:</strong> ${params.order_id || ""}</p>
  <p><strong>Amount:</strong> ${params.amount || ""}</p>
</div>
<h3>Semua Parameter</h3>
<pre>${JSON.stringify(params, null, 2)}</pre>
<a class="btn" href="/">Kembali</a>
</html>`);
});

// CALLBACK (server→server) + token + validation + UPSERT
app.post("/toyyib/callback/:token", async (req, res) => {
  try {
    // 1) Token check
    if (!CALLBACK_TOKEN || req.params.token !== CALLBACK_TOKEN) {
      return res.status(403).type("text").send("Forbidden");
    }

    // 2) Payload
    const p = Object.keys(req.body).length ? req.body : req.query;

    // 3) Require fields
    const order_id = (p.order_id || "").toString().trim();
    const billcode = (p.billcode || "").toString().trim();
    const status_id = (p.status_id || "").toString().trim();
    if (!order_id || !status_id) {
      return res.status(400).type("text").send("Bad Request");
    }

    // 4) Normalize
    const status_text = mapStatus(status_id);
    const amount_cents = toCents(p.amount);
    const payer_email  = p.email || p.payer_email || null;
    const payer_phone  = p.phone || p.payer_phone || null;
    const payer_name   = p.name  || p.payer_name  || null;
    const remarks      = p.msg   || p.remark      || null;
    const paid_at      = status_id === "1" ? new Date() : null;

    // 5) Optional validation: amount mismatch flag
    const existing = await pool.query(
      "SELECT amount_cents FROM orders WHERE order_id = $1",
      [order_id]
    );
    let final_status_text = status_text;
    if (
      existing.rowCount > 0 &&
      amount_cents > 0 &&
      existing.rows[0].amount_cents > 0 &&
      existing.rows[0].amount_cents !== amount_cents
    ) {
      final_status_text = status_text + "_AMOUNT_MISMATCH";
      console.warn("Amount mismatch for order:", order_id, {
        expected: existing.rows[0].amount_cents, got: amount_cents
      });
    }

    // 6) UPSERT
    await pool.query(
      `
      INSERT INTO orders (
        order_id, billcode, amount_cents, status_id, status_text,
        payer_email, payer_phone, payer_name, remarks, raw_payload, paid_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      ON CONFLICT (order_id) DO UPDATE SET
        billcode     = EXCLUDED.billcode,
        amount_cents = EXCLUDED.amount_cents,
        status_id    = EXCLUDED.status_id,
        status_text  = EXCLUDED.status_text,
        payer_email  = EXCLUDED.payer_email,
        payer_phone  = EXCLUDED.payer_phone,
        payer_name   = EXCLUDED.payer_name,
        remarks      = EXCLUDED.remarks,
        raw_payload  = EXCLUDED.raw_payload,
        paid_at      = EXCLUDED.paid_at,
        updated_at   = NOW();
      `,
      [
        order_id,
        billcode || null,
        amount_cents,
        parseInt(status_id, 10) || 0,
        final_status_text,
        payer_email,
        payer_phone,
        payer_name,
        remarks,
        JSON.stringify(p),
        paid_at
      ]
    );

    console.log("[ToyyibPay callback OK]", { order_id, status_id, amount_cents });
    return res.type("text").send("OK");
  } catch (e) {
    console.error("Callback error:", e);
    return res.status(500).type("text").send("ERROR");
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
