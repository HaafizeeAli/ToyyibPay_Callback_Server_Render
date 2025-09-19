import express from "express";
import bodyParser from "body-parser";
import sql from "mssql";

const app = express();
const PORT = process.env.PORT || 3000;

// ====== ENV (set di Render) ======
// SQLSERVER_HOST, SQLSERVER_PORT (1433),
// SQLSERVER_DB, SQLSERVER_USER, SQLSERVER_PASSWORD,
// SQLSERVER_ENCRYPT ("true"/"false"), SQLSERVER_TRUST_CERT ("true"/"false")
// CALLBACK_TOKEN (contoh: f1zToyyib123)

// --- Config SQL Server (Azure SQL: encrypt=true, trustServerCertificate=false) ---
const sqlConfig = {
  server: process.env.SQLSERVER_HOST,
  port: Number(process.env.SQLSERVER_PORT || 1433),
  database: process.env.SQLSERVER_DB,
  user: process.env.SQLSERVER_USER,
  password: process.env.SQLSERVER_PASSWORD,
  options: {
    encrypt: String(process.env.SQLSERVER_ENCRYPT || "true") === "true",
    trustServerCertificate: String(process.env.SQLSERVER_TRUST_CERT || "false") === "true",
    enableArithAbort: true
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

const CALLBACK_TOKEN = process.env.CALLBACK_TOKEN || "";

// --- connect once, reuse pool ---
let poolPromise = sql.connect(sqlConfig);

// --- ensure schema on boot ---
async function ensureSchema() {
  const pool = await poolPromise;
  await pool.request().batch(`
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Orders' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
  CREATE TABLE dbo.Orders (
    Id               BIGINT IDENTITY(1,1) PRIMARY KEY,
    Order_Id         NVARCHAR(64) UNIQUE NOT NULL,
    Billcode         NVARCHAR(64) NULL,
    Amount_Cents     INT NOT NULL DEFAULT 0,
    Currency         CHAR(3) NOT NULL DEFAULT 'MYR',
    Status_Id        SMALLINT NOT NULL DEFAULT 0,      -- 1=PAID,2=PENDING,3=FAILED
    Status_Text      NVARCHAR(64) NOT NULL DEFAULT 'UNKNOWN',
    Payer_Email      NVARCHAR(255) NULL,
    Payer_Phone      NVARCHAR(64) NULL,
    Payer_Name       NVARCHAR(255) NULL,
    Remarks          NVARCHAR(MAX) NULL,
    Raw_Payload      NVARCHAR(MAX) NOT NULL,           -- simpan JSON sebagai text
    Paid_At          DATETIMEOFFSET NULL,
    Created_At       DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    Updated_At       DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
  );
  CREATE INDEX IX_Orders_Billcode ON dbo.Orders(Billcode);
END
`);
}
ensureSchema().catch(e => {
  console.error("Failed to ensure schema:", e);
  process.exit(1);
});

// ========== Helpers ==========
const mapStatus = s => (s === "1" ? "PAID" : s === "3" ? "FAILED" : "PENDING");
const toCents = v => {
  if (v == null) return 0;
  const str = String(v).trim();
  if (/^\d+$/.test(str)) return parseInt(str, 10); // sudah dalam sen
  const f = Number.parseFloat(str);
  if (Number.isNaN(f)) return 0;
  return Math.round(f * 100); // anggap RM → sen
};

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Healthcheck
app.get("/", (req, res) => {
  res.type("text").send("OK - ToyyibPay sandbox server is running");
});

// Return (user-facing)
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

// Callback (server-to-server) + token + validation + UPSERT (MERGE)
app.post("/toyyib/callback/:token", async (req, res) => {
  try {
    if (!CALLBACK_TOKEN || req.params.token !== CALLBACK_TOKEN) {
      return res.status(403).type("text").send("Forbidden");
    }

    const p = Object.keys(req.body).length ? req.body : req.query;

    const order_id = (p.order_id || "").toString().trim();
    const billcode = (p.billcode || "").toString().trim();
    const status_id = (p.status_id || "").toString().trim();
    if (!order_id || !status_id) {
      return res.status(400).type("text").send("Bad Request");
    }

    const status_text = mapStatus(status_id);
    const amount_cents = toCents(p.amount);
    const payer_email  = p.email || p.payer_email || null;
    const payer_phone  = p.phone || p.payer_phone || null;
    const payer_name   = p.name  || p.payer_name  || null;
    const remarks      = p.msg   || p.remark      || null;
    const paid_at      = status_id === "1" ? new Date().toISOString() : null;

    const pool = await poolPromise;

    // (Opsyen) Validasi amaun jika order sedia ada
    const existing = await pool.request()
      .input("order_id", sql.NVarChar(64), order_id)
      .query("SELECT Amount_Cents FROM dbo.Orders WHERE Order_Id=@order_id");

    let final_status_text = status_text;
    if (
      existing.recordset.length > 0 &&
      amount_cents > 0 &&
      existing.recordset[0].Amount_Cents > 0 &&
      existing.recordset[0].Amount_Cents !== amount_cents
    ) {
      final_status_text = status_text + "_AMOUNT_MISMATCH";
      console.warn("Amount mismatch for order:", order_id, {
        expected: existing.recordset[0].Amount_Cents, got: amount_cents
      });
    }

    // UPSERT guna MERGE
    const rawPayload = JSON.stringify(p);
    await pool.request()
      .input("Order_Id", sql.NVarChar(64), order_id)
      .input("Billcode", sql.NVarChar(64), billcode || null)
      .input("Amount_Cents", sql.Int, amount_cents)
      .input("Status_Id", sql.SmallInt, parseInt(status_id, 10) || 0)
      .input("Status_Text", sql.NVarChar(64), final_status_text)
      .input("Payer_Email", sql.NVarChar(255), payer_email)
      .input("Payer_Phone", sql.NVarChar(64), payer_phone)
      .input("Payer_Name", sql.NVarChar(255), payer_name)
      .input("Remarks", sql.NVarChar(sql.MAX), remarks)
      .input("Raw_Payload", sql.NVarChar(sql.MAX), rawPayload)
      .input("Paid_At", sql.DateTimeOffset, paid_at)
      .query(`
MERGE dbo.Orders AS target
USING (SELECT
  @Order_Id AS Order_Id, @Billcode AS Billcode, @Amount_Cents AS Amount_Cents,
  @Status_Id AS Status_Id, @Status_Text AS Status_Text,
  @Payer_Email AS Payer_Email, @Payer_Phone AS Payer_Phone, @Payer_Name AS Payer_Name,
  @Remarks AS Remarks, @Raw_Payload AS Raw_Payload, @Paid_At AS Paid_At
) AS src
ON target.Order_Id = src.Order_Id
WHEN MATCHED THEN UPDATE SET
  Billcode       = src.Billcode,
  Amount_Cents   = src.Amount_Cents,
  Status_Id      = src.Status_Id,
  Status_Text    = src.Status_Text,
  Payer_Email    = src.Payer_Email,
  Payer_Phone    = src.Payer_Phone,
  Payer_Name     = src.Payer_Name,
  Remarks        = src.Remarks,
  Raw_Payload    = src.Raw_Payload,
  Paid_At        = src.Paid_At,
  Updated_At     = SYSDATETIMEOFFSET()
WHEN NOT MATCHED THEN INSERT (
  Order_Id, Billcode, Amount_Cents, Currency, Status_Id, Status_Text,
  Payer_Email, Payer_Phone, Payer_Name, Remarks, Raw_Payload, Paid_At, Created_At, Updated_At
) VALUES (
  src.Order_Id, src.Billcode, src.Amount_Cents, 'MYR', src.Status_Id, src.Status_Text,
  src.Payer_Email, src.Payer_Phone, src.Payer_Name, src.Remarks, src.Raw_Payload, src.Paid_At,
  SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET()
);
`);

    console.log("[ToyyibPay callback OK]", { order_id, status_id, amount_cents });
    return res.type("text").send("OK");
  } catch (e) {
    console.error("Callback error:", e);
    return res.status(500).type("text").send("ERROR");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
