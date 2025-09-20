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

// Save the order (amount, payer info, etc.) *before* sending user to ToyyibPay
app.post("/order/register", async (req, res) => {
  try {
    const { order_id, amount_cents, currency = "MYR", payer_email, payer_phone, payer_name } = req.body || {};
    if (!order_id || !Number.isInteger(amount_cents)) {
      return res.status(400).json({ ok: false, error: "order_id / amount_cents invalid" });
    }

    await pool.query(`
      insert into orders (order_id, amount_cents, currency, status_id, status_text, payer_email, payer_phone, payer_name, raw_payload)
      values ($1,$2,$3,0,'PENDING',$4,$5,$6,$7)
      on conflict (order_id) do update set
        amount_cents = excluded.amount_cents,
        currency = excluded.currency,
        payer_email = excluded.payer_email,
        payer_phone = excluded.payer_phone,
        payer_name = excluded.payer_name,
        updated_at = now()
    `, [
      order_id, amount_cents, currency,
      payer_email || null, payer_phone || null, payer_name || null,
      JSON.stringify({ source: "app-pre-register" })
    ]);

    res.json({ ok: true });
  } catch (e) {
    console.error("pre-register error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
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

// ===== REPLACE the whole /toyyib/return handler with this =====
app.all("/toyyib/return", async (req, res) => {
  const p = Object.keys(req.query).length ? req.query : req.body;
  const status_id = (p.status_id || "").toString();
  const billcode  = (p.billcode  || "").toString();
  const order_id  = (p.order_id  || "").toString();
  const txid      = (p.transaction_id || "").toString();
  const amount    = p.amount && /^\d+(\.\d{1,2})?$/.test(p.amount) ? p.amount : "";

  const appLink =
    `mizrahbeauty://payment-result` +
    `?status_id=${encodeURIComponent(status_id)}` +
    `&order_id=${encodeURIComponent(order_id)}` +
    (billcode ? `&billcode=${encodeURIComponent(billcode)}` : "") +
    (amount   ? `&amount=${encodeURIComponent(amount)}` : "") +
    (txid     ? `&transaction_id=${encodeURIComponent(txid)}` : "");

  const androidIntent =
    `intent://payment-result` +
    `?status_id=${encodeURIComponent(status_id)}` +
    `&order_id=${encodeURIComponent(order_id)}` +
    (billcode ? `&billcode=${encodeURIComponent(billcode)}` : "") +
    (amount   ? `&amount=${encodeURIComponent(amount)}`   : "") +
    (txid     ? `&transaction_id=${encodeURIComponent(txid)}` : "") +
    `#Intent;scheme=mizrahbeauty;package=com.tutorialworldskill.mizrahbeauty;end`;

  res.type("html").send(`<!doctype html>
<html lang="ms"><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Resit / Return</title>

<!-- 1) meta refresh segera -->
<meta http-equiv="refresh" content="0;url=${appLink}">

<script>
  // 2) cubaan onload
  window.addEventListener('load', function(){
    try { window.location.replace(${JSON.stringify(appLink)}); } catch(e){}
    // 3) fallback untuk Chrome Android
    setTimeout(function(){
      var ua = navigator.userAgent || '';
      if (/Android/i.test(ua)) { window.location.href = ${JSON.stringify(androidIntent)}; }
    }, 800);
  });
</script>

<style>
 body{font-family:system-ui,Arial,sans-serif;max-width:720px;margin:24px auto;padding:16px}
 .card{border:1px solid #eee;border-radius:14px;padding:18px;box-shadow:0 2px 10px rgba(0,0,0,.05)}
 .row{display:flex;gap:8px;align-items:center;margin:8px 0}
 .key{width:160px;color:#666}
 .val{font-weight:600}
 .btn{display:inline-block;margin-top:16px;padding:10px 14px;border-radius:10px;border:1px solid #ddd;text-decoration:none}
</style>

<h2>Maklumbalas Pembayaran</h2>
<div class="card">
  <div class="row"><div class="key">Status</div><div class="val">${status_id==="1"?"BERJAYA":status_id==="3"?"GAGAL":"PENDING"}</div></div>
  <div class="row"><div class="key">Order ID</div><div class="val">${order_id||"—"}</div></div>
  <div class="row"><div class="key">Billcode</div><div class="val">${billcode||"—"}</div></div>
  <div class="row"><div class="key">Amount</div><div class="val">${amount?("RM "+amount):"—"}</div></div>
</div>

<a class="btn" href="${appLink}">Kembali ke aplikasi</a>
</html>`);
});



// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
