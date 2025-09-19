import express from "express";
import bodyParser from "body-parser";

const app = express();
const PORT = process.env.PORT || 3000;

// ToyyibPay biasanya hantar form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/**
 * HEALTHCHECK – mudah untuk Render kira “alive”
 */
app.get("/", (req, res) => {
  res.type("text").send("OK - ToyyibPay sandbox server is running");
});

/**
 * RETURN URL – user akan di-redirect ke sini selepas bayar
 * Boleh styling ikut suka; ini versi simple yang papar param.
 */
app.all("/toyyib/return", (req, res) => {
  const params = Object.keys(req.query).length ? req.query : req.body;
  const status_id = params.status_id || "";
  const className =
    status_id === "1" ? "ok" : status_id === "3" ? "fail" : "pending";
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

/**
 * CALLBACK URL – server-to-server dari ToyyibPay
 * Wajib balas 200 "OK". Di sini tempat anda update DB.
 */
app.post("/toyyib/callback", async (req, res) => {
  const data = Object.keys(req.body).length ? req.body : req.query;

  // --- LOG ke console (Render Logs)
  console.log("[ToyyibPay callback]", {
    time: new Date().toISOString(),
    payload: data
  });

  // === CONTOH: Validasi tambahan (option) ===
  // 1) Anda boleh semak amount/order_id vs rekod tempahan dalam DB
  // 2) Atau panggil ToyyibPay getBillTransactions untuk confirm (production)

  // === TODO: KEMASKINI DB ===
  // Contoh pseudo:
  // await db.updateOrder(data.order_id, {
  //   status_id: data.status_id, billcode: data.billcode, amount: data.amount
  // });

  res.type("text").send("OK"); // penting!
});

// Jalankan server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
