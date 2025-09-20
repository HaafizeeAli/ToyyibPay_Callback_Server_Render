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

// ===== REPLACE the whole /toyyib/return handler with this =====
app.all("/toyyib/return", async (req, res) => {
  try {
    const params    = Object.keys(req.query).length ? req.query : req.body;
    const status_id = (params.status_id || "").toString();
    const billcode  = (params.billcode  || "").toString();
    const order_id  = (params.order_id  || "").toString();
    const txid      = (params.transaction_id || "").toString();

    // status text + class
    const statusText = status_id === "1" ? "BERJAYA"
                     : status_id === "3" ? "GAGAL"
                     : "PENDING / TIDAK PASTI";
    const className  = status_id === "1" ? "ok"
                     : status_id === "3" ? "fail"
                     : "pending";

    // --- dapatkan amount (guna param jika ada; kalau tiada, cari di DB ikut order_id)
    const toCents = v => {
      if (v == null || v === "") return null;
      const s = String(v).trim();
      if (/^\d+$/.test(s)) return parseInt(s,10);     // sudah dalam sen
      const f = Number.parseFloat(s);
      return Number.isNaN(f) ? null : Math.round(f*100); // RM -> sen
    };
    let amountCents = toCents(params.amount);

    if ((amountCents == null || Number.isNaN(amountCents)) && order_id) {
      try {
        const q = await pool.query(
          "select amount_cents from orders where order_id = $1 order by id desc limit 1",
          [order_id]
        );
        if (q.rowCount > 0) amountCents = q.rows[0].amount_cents;
      } catch (e) {
        console.warn("Return lookup DB failed:", e.message);
      }
    }
    const amountStr = (amountCents != null && !Number.isNaN(amountCents))
      ? `RM ${(amountCents/100).toFixed(2)}`
      : "—";

    // --- (OPTIONAL) upsert supaya ada rekod walaupun callback lambat/tersekat
    try {
      if (order_id && status_id) {
        await pool.query(`
          insert into orders (order_id, billcode, amount_cents, status_id, status_text, raw_payload, paid_at, updated_at)
          values ($1,$2,$3,$4,$5,$6,$7, now())
          on conflict (order_id) do update set
            billcode = excluded.billcode,
            amount_cents = excluded.amount_cents,
            status_id = excluded.status_id,
            status_text = excluded.status_text,
            raw_payload = excluded.raw_payload,
            paid_at = excluded.paid_at,
            updated_at = now();
        `, [
          order_id,
          billcode || null,
          amountCents ?? 0,
          parseInt(status_id || "0", 10),
          (status_id==="1" ? "PAID" : status_id==="3" ? "FAILED" : "PENDING"),
          JSON.stringify(params),
          (status_id==="1" ? new Date() : null)
        ]);
      }
    } catch (e) {
      console.warn("Return upsert warn:", e.message);
    }

    // --- sediakan deep link ke app
    const appLink =
      `mizrahbeauty://payment-result` +
      `?status_id=${encodeURIComponent(status_id)}` +
      `&billcode=${encodeURIComponent(billcode||"")}` +
      `&order_id=${encodeURIComponent(order_id||"")}` +
      (amountCents!=null ? `&amount=${encodeURIComponent((amountCents/100).toFixed(2))}` : "") +
      (txid ? `&transaction_id=${encodeURIComponent(txid)}` : "");

    // fallback intent untuk Chrome Android
    const androidIntent =
      `intent://payment-result` +
      `?status_id=${encodeURIComponent(status_id)}` +
      `&billcode=${encodeURIComponent(billcode||"")}` +
      `&order_id=${encodeURIComponent(order_id||"")}` +
      (amountCents!=null ? `&amount=${encodeURIComponent((amountCents/100).toFixed(2))}` : "") +
      (txid ? `&transaction_id=${encodeURIComponent(txid)}` : "") +
      `#Intent;scheme=mizrahbeauty;package=com.tutorialworldskill.mizrahbeauty;end`;

    // --- render HTML + auto-redirect ke app
    res.type("html").send(`<!doctype html>
<html lang="ms"><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Resit / Return</title>
<style>
 body{font-family:system-ui,Arial,sans-serif;max-width:720px;margin:24px auto;padding:16px}
 .card{border:1px solid #eee;border-radius:14px;padding:18px;box-shadow:0 2px 10px rgba(0,0,0,.05)}
 .row{display:flex;gap:8px;align-items:center;margin:8px 0}
 .key{width:160px;color:#666}
 .val{font-weight:600}
 .ok{color:#0a7}.fail{color:#c00}.pending{color:#555}
 .btn{display:inline-block;margin-top:16px;padding:10px 14px;border-radius:10px;border:1px solid #ddd;text-decoration:none}
 small{color:#888}
</style>

<script>
(function(){
  var appLink = ${JSON.stringify(appLink)};
  var androidIntent = ${JSON.stringify(androidIntent)};
  var ua = navigator.userAgent || "";

  // Cuba invoke app selepas ~600ms
  setTimeout(function(){ window.location.href = appLink; }, 600);

  // Fallback intent untuk Chrome di Android
  setTimeout(function(){
    if (/Android/i.test(ua)) { window.location.href = androidIntent; }
  }, 1200);
})();
</script>

<h2>Maklumbalas Pembayaran</h2>
<div class="card">
  <div class="row"><div class="key">Status</div><div class="val ${className}">${statusText}</div></div>
  <div class="row"><div class="key">Billcode</div><div class="val">${billcode || "—"}</div></div>
  <div class="row"><div class="key">Order ID</div><div class="val">${order_id || "—"}</div></div>
  <div class="row"><div class="key">Amount</div><div class="val">${amountStr}</div></div>
  ${txid ? `<div class="row"><div class="key">Transaction ID</div><div class="val">${txid}</div></div>` : ""}
</div>

<a class="btn" href="${appLink}">Kembali ke aplikasi</a>
<br><small>Jika aplikasi tidak terbuka secara automatik, tekan butang di atas.</small>
</html>`);
  } catch (e) {
    console.error("Return error:", e);
    res.status(500).type("text").send("Internal error");
  }
});


// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
