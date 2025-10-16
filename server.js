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
   RETURN PAGE – versi auto-redirect ke app (Android intent)
   ========================================================= */
app.all("/toyyib/return", async (req, res) => {
  const p = Object.keys(req.query).length ? req.query : req.body;
  const status_id = (p.status_id || "").toString();
  const billcode  = (p.billcode  || "").toString();
  const order_id  = (p.order_id  || "").toString();
  const txid      = (p.transaction_id || "").toString();

  // Sync status ke DB
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

  // Ambil amount dari DB
  let amount = "";
  try {
    if (order_id) {
      const { rows } = await pool.query(
        "SELECT amount_cents FROM orders WHERE order_id=$1 LIMIT 1",
        [order_id]
      );
      if (rows.length) amount = (rows[0].amount_cents / 100).toFixed(2);
    }
  } catch (e) {
    console.error("DB lookup on return failed:", e);
  }
  if (!amount && p.amount) amount = p.amount;

  // === Construct Deep Link ===
  const scheme = "mizrahbeauty";
  const pkg = "com.tutorialworldskill.mizrahbeauty";
  const deeplink = `${scheme}://payment-result?status_id=${encodeURIComponent(status_id)}&order_id=${encodeURIComponent(order_id)}&billcode=${encodeURIComponent(billcode)}&amount=${encodeURIComponent(amount)}&transaction_id=${encodeURIComponent(txid)}`;
  const intentUri = `intent://payment-result?status_id=${encodeURIComponent(status_id)}&order_id=${encodeURIComponent(order_id)}&billcode=${encodeURIComponent(billcode)}&amount=${encodeURIComponent(amount)}&transaction_id=${encodeURIComponent(txid)}#Intent;scheme=${scheme};package=${pkg};S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3D${pkg};end`;

  // === Render auto redirect page ===
  res.type("html").send(`<!doctype html>
<html lang="ms">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Maklumbalas Pembayaran</title>
  <style>
    body{font-family:system-ui,Arial,sans-serif;max-width:700px;margin:24px auto;padding:16px;text-align:center}
    .card{border:1px solid #ddd;border-radius:14px;padding:20px;margin-top:10px;box-shadow:0 3px 10px rgba(0,0,0,0.05)}
    .ok{color:#15803d;font-weight:700}
    .fail{color:#dc2626;font-weight:700}
    .bar{height:8px;background:#eee;border-radius:10px;overflow:hidden;margin-top:10px}
    .bar>span{display:block;height:100%;width:0%;background:#16a34a;transition:width .2s linear}
    .btn{display:inline-block;margin-top:20px;padding:10px 14px;border-radius:8px;border:1px solid #2563eb;color:#2563eb;text-decoration:none}
  </style>
</head>
<body>
  <h2>Maklumbalas Pembayaran</h2>
  <p>Laman ini akan kembali ke aplikasi dalam <span id="count">5</span> saat...</p>
  <div class="bar"><span id="prog"></span></div>
  <div class="card">
    <p>Status: <span class="${status_id==="1"?"ok":"fail"}">${status_id==="1"?"BERJAYA":status_id==="3"?"GAGAL":"PENDING"}</span></p>
    <p>Order ID: ${order_id || "—"}</p>
    <p>Billcode: ${billcode || "—"}</p>
    <p>Amount: RM ${amount || "—"}</p>
    ${txid?`<p>Transaksi: ${txid}</p>`:""}
  </div>
  <a class="btn" href="${deeplink}" id="btn">Buka aplikasi sekarang</a>

  <script>
  const deeplink=${JSON.stringify(deeplink)};
  const intentUri=${JSON.stringify(intentUri)};
  let sec=5, total=5;
  const c=document.getElementById('count'), p=document.getElementById('prog');
  const t=setInterval(()=>{
    sec--; if(sec<0){clearInterval(t); go();}
    c.textContent=sec; p.style.width=((total-sec)/total*100)+'%';
  },1000);
  function go(){
    // try intent:// for Chrome
    window.location.replace(intentUri);
    // fallback to mizrahbeauty://
    setTimeout(()=>window.location.href=deeplink,1200);
  }
  document.getElementById('btn').addEventListener('click',e=>{
    e.preventDefault(); go();
  });
  </script>
</body>
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
