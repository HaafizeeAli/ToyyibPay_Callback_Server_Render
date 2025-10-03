import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { Pool } from "pg";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ENV (set di Render) =====
// - DATABASE_URL   : postgresql://postgres:...@...supabase.co:5432/postgres?sslmode=require
// - CALLBACK_TOKEN : contoh "f1zToyyib123"
const CALLBACK_TOKEN = process.env.CALLBACK_TOKEN || "";

// (Hanya untuk bypass cert self-signed pada sesetengah host)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Pool Postgres (Supabase)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
      status_id     SMALLINT NOT NULL DEFAULT 0,   -- 0=REGISTERED,1=PAID,2=PENDING,3=FAILED
      status_text   VARCHAR(32) NOT NULL DEFAULT 'REGISTERED',
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
    CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status_id);
  `);
}
ensureSchema().catch(e => {
  console.error("Failed to ensure schema:", e);
  process.exit(1);
});

// Helpers
const toCents = v => {
  if (v == null) return 0;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10); // sudah dalam sen
  const f = Number.parseFloat(s);
  if (Number.isNaN(f)) return 0;
  return Math.round(f * 100); // RM → sen
};
const statusText = s => (s === "1" ? "PAID" : s === "3" ? "FAILED" : "PENDING");

// Middleware
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false })); // ToyyibPay hantar form-urlencoded
app.use(bodyParser.json());

// Healthcheck
app.get("/", (req, res) => {
  res.type("text").send("OK - ToyyibPay sandbox server is running");
});

/* =========================================================
   REGISTER ORDER (dipanggil sebelum redirect ke ToyyibPay)
   ========================================================= */
app.post("/order/register", async (req, res) => {
  try {
    const {
      order_id,
      amount_cents,
      currency = "MYR",
      payer_name,
      payer_phone,
      payer_email,
      billcode // optional – kalau anda sudah tahu selepas create-bill dari app
    } = req.body || {};

    if (!order_id || !Number.isInteger(amount_cents)) {
      return res.status(400).json({ ok: false, error: "order_id / amount_cents invalid" });
    }

    await pool.query(`
      INSERT INTO orders (order_id, amount_cents, currency, status_id, status_text, payer_email, payer_phone, payer_name, billcode, raw_payload)
      VALUES ($1,$2,$3,0,'REGISTERED',$4,$5,$6,$7,$8)
      ON CONFLICT (order_id) DO UPDATE SET
        amount_cents = EXCLUDED.amount_cents,
        currency     = EXCLUDED.currency,
        payer_email  = EXCLUDED.payer_email,
        payer_phone  = EXCLUDED.payer_phone,
        payer_name   = EXCLUDED.payer_name,
        billcode     = COALESCE(EXCLUDED.billcode, orders.billcode),
        updated_at   = NOW()
    `, [
      order_id, amount_cents, currency,
      payer_email || null, payer_phone || null, payer_name || null,
      billcode || null,
      JSON.stringify({ source: "app-pre-register" })
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error("register failed", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =========================================================
   (PILIHAN) ATTACH BILL – ikat billcode kepada order_id
   ========================================================= */
app.post("/order/attach-bill", async (req, res) => {
  try {
    const { order_id, billcode } = req.body || {};
    if (!order_id || !billcode) {
      return res.status(400).json({ ok: false, error: "order_id & billcode diperlukan" });
    }
    const { rowCount } = await pool.query(
      "UPDATE orders SET billcode=$1, updated_at=NOW() WHERE order_id=$2",
      [billcode, order_id]
    );
    res.json({ ok: true, updated: rowCount });
  } catch (e) {
    console.error("attach-bill failed", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   STATUS ENDPOINT – dipanggil oleh QrDisplayActivity (polling)
   ========================================================= */
app.get("/order/status", async (req, res) => {
  try {
    const order_id = (req.query.order_id || "").toString();
    if (!order_id) return res.status(400).json({ ok: false, error: "order_id diperlukan" });

    const { rows } = await pool.query(
      "SELECT order_id, billcode, amount_cents, status_id, status_text, paid_at FROM orders WHERE order_id=$1 LIMIT 1",
      [order_id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "order tidak ditemui" });

    const r = rows[0];
    const isPaid = r.status_id === 1 || r.status_text === "PAID" || !!r.paid_at;

    // Pulangkan bentuk yang Option-B anda akan faham
    res.json({
      ok: true,
      order_id: r.order_id,
      billcode: r.billcode || null,
      amount_cents: r.amount_cents,
      amount: (r.amount_cents / 100).toFixed(2),
      status_id: String(r.status_id),           // "1" | "2" | "3"
      status: isPaid ? "PAID" : r.status_text,  // "PAID" | "PENDING" | "FAILED" | ...
      paid: isPaid,
      paid_at: r.paid_at
    });
  } catch (e) {
    console.error("status failed", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================================================
   RETURN PAGE – papar resit + deeplink; juga sync status cepat
   ========================================================= */
app.all("/toyyib/return", async (req, res) => {
  const p = Object.keys(req.query).length ? req.query : req.body;
  const status_id = (p.status_id || "").toString();
  const billcode  = (p.billcode  || "").toString();
  const order_id  = (p.order_id  || "").toString();
  const txid      = (p.transaction_id || "").toString();

  // Sync status ke DB (jika ada order_id / billcode)
  try {
    if (status_id || billcode) {
      const fields = {
        status_id: parseInt(status_id || "2", 10) || 2,
        status_text: statusText(status_id || "2"),
        billcode: billcode || null,
        updated_at: new Date().toISOString()
      };
      if (status_id === "1") fields["paid_at"] = new Date().toISOString();

      const setCols = Object.keys(fields).map((k, i) => `${k} = $${i + 1}`).join(", ");
      const setVals = Object.values(fields);

      let result = { rowCount: 0 };
      if (order_id) {
        result = await pool.query(
          `UPDATE orders SET ${setCols} WHERE order_id = $${setVals.length + 1}`,
          [...setVals, order_id]
        );
      }
      if (result.rowCount === 0 && billcode) {
        result = await pool.query(
          `UPDATE orders SET ${setCols} WHERE billcode = $${setVals.length + 1}`,
          [...setVals, billcode]
        );
      }
    }
  } catch (e) {
    console.error("DB sync on return failed:", e);
  }

  // NEW: ambil amount dari DB ikut order_id (fallback guna query param)
  let amount = "";
  try {
    if (order_id) {
      const { rows } = await pool.query(
        "SELECT amount_cents, billcode FROM orders WHERE order_id=$1 LIMIT 1",
        [order_id]
      );
      if (rows.length) {
        if (typeof rows[0].amount_cents === "number") {
          amount = (rows[0].amount_cents / 100).toFixed(2);
        }
      }
    }
  } catch (e) {
    console.error("DB lookup on return failed:", e);
  }
  if (!amount && p.amount && /^\d+(\.\d{1,2})?$/.test(p.amount)) {
    amount = p.amount;
  }

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

  // Papar 10s sebelum redirect
  res.type("html").send(`<!doctype html>
<html lang="ms"><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Resit / Return</title>
<meta http-equiv="refresh" content="10;url=${appLink}">
<style>
 body{font-family:system-ui,Arial,sans-serif;max-width:720px;margin:24px auto;padding:16px}
 .card{border:1px solid #eee;border-radius:14px;padding:18px;box-shadow:0 2px 10px rgba(0,0,0,.05)}
 .row{display:flex;gap:8px;align-items:center;margin:8px 0}
 .key{width:160px;color:#666}
 .val{font-weight:600}
 .btn{display:inline-block;margin-top:16px;padding:10px 14px;border-radius:10px;border:1px solid #ddd;text-decoration:none}
 .muted{color:#666}
 .count{font-weight:700}
 .bar{height:10px;background:#eee;border-radius:999px;overflow:hidden;margin-top:8px}
 .bar>span{display:block;height:100%;width:0%;background:#16a34a;transition:width .2s linear}
</style>
<h2>Maklumbalas Pembayaran</h2>
<p class="muted">Laman ini akan kembali ke aplikasi dalam <span class="count" id="count">10</span> saat…</p>
<div class="bar"><span id="prog"></span></div>
<div class="card">
  <div class="row"><div class="key">Status</div><div class="val">${status_id==="1"?"BERJAYA":status_id==="3"?"GAGAL":"PENDING"}</div></div>
  <div class="row"><div class="key">Order ID</div><div class="val">${order_id||"—"}</div></div>
  <div class="row"><div class="key">Billcode</div><div class="val">${billcode||"—"}</div></div>
  <div class="row"><div class="key">Amount</div><div class="val">${amount?("RM "+amount):"—"}</div></div>
  ${txid?`<div class="row"><div class="key">Transaksi</div><div class="val">${txid}</div></div>`:""}
</div>
<a class="btn" id="openNow" href="${appLink}">Buka aplikasi sekarang</a>

<script>
(function(){
  var wait = 10;
  var countEl = document.getElementById('count');
  var progEl  = document.getElementById('prog');
  var appLink = ${JSON.stringify(appLink)};
  var androidIntent = ${JSON.stringify(androidIntent)};
  var total = wait, elapsed = 0;

  function tick(){
    elapsed++;
    var left = total - elapsed;
    if (left < 0) left = 0;
    countEl.textContent = String(left);
    progEl.style.width = ((elapsed/total)*100) + '%';
    if (elapsed >= total) {
      redirect();
      clearInterval(tmr);
    }
  }

  function redirect(){
    try { window.location.replace(appLink); } catch(e){}
    setTimeout(function(){
      var ua = navigator.userAgent || '';
      if (/Android/i.test(ua)) { window.location.href = androidIntent; }
    }, 800);
  }

  var tmr = setInterval(tick, 1000);
  countEl.textContent = String(wait);
  progEl.style.width = '0%';

  document.getElementById('openNow').addEventListener('click', function(e){
    setTimeout(function(){
      var ua = navigator.userAgent || '';
      if (/Android/i.test(ua)) { window.location.href = androidIntent; }
    }, 100);
  });
})();
</script>
</html>`);
});

/* =========================================================
   CALLBACK dari ToyyibPay (server-to-server)
   ========================================================= */
app.post("/toyyib/callback/:token", async (req, res) => {
  try {
    if (!CALLBACK_TOKEN || req.params.token !== CALLBACK_TOKEN) {
      console.warn("Invalid callback token");
      return res.status(403).type("text").send("Forbidden");
    }

    const p = Object.keys(req.body).length ? req.body : req.query;
    const billcode = (p.billcode || "").toString();
    const order_id = (p.order_id || "").toString();
    const sId = (p.status_id || "").toString();
    const txid = (p.transaction_id || "").toString();
    const amtCents = p.amount ? toCents(p.amount) : null;

    const fields = {
      billcode: billcode || null,
      status_id: parseInt(sId || "0", 10) || 0,
      status_text: statusText(sId),
      raw_payload: JSON.stringify(p),
      updated_at: new Date().toISOString(),
    };
    if (amtCents !== null) fields.amount_cents = amtCents;
    if (sId === "1") fields.paid_at = new Date().toISOString();

    const setCols = Object.keys(fields).map((k, i) => `${k} = $${i + 1}`).join(", ");
    const setVals = Object.values(fields);

    let result = { rowCount: 0 };
    if (order_id) {
      result = await pool.query(
        `UPDATE orders SET ${setCols} WHERE order_id = $${setVals.length + 1}`,
        [...setVals, order_id]
      );
    }
    if (result.rowCount === 0 && billcode) {
      result = await pool.query(
        `UPDATE orders SET ${setCols} WHERE billcode = $${setVals.length + 1}`,
        [...setVals, billcode]
      );
    }
    if (result.rowCount === 0) {
      await pool.query(
        `INSERT INTO orders (order_id, billcode, amount_cents, currency, status_id, status_text, raw_payload, paid_at)
         VALUES ($1,$2,$3,'MYR',$4,$5,$6,$7)
         ON CONFLICT (order_id) DO NOTHING`,
        [
          order_id || `ORD-${Date.now()}`,
          billcode || null,
          amtCents || 0,
          parseInt(sId || "0", 10) || 0,
          statusText(sId),
          JSON.stringify(p),
          sId === "1" ? new Date().toISOString() : null
        ]
      );
    }

    console.log("[ToyyibPay callback]", {
      time: new Date().toISOString(),
      order_id, billcode, status_id: sId, transaction_id: txid
    });

    res.type("text").send("OK");
  } catch (e) {
    console.error("callback error:", e);
    res.status(500).type("text").send("ERROR");
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
