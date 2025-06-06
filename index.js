require('dotenv').config();
const express = require('express');
const axios = require('axios'); // For making HTTP requests (e.g., to Turnitin)
const fs = require('fs');
const FormData = require('form-data');
const multer = require('multer');
const upload = multer();
const app = express();
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID.trim();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./botdata.db');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const mappingFile = 'reportUserMap.json';

// Create the table if it doesn't exist
// Stores user, input/output PDF/report URLs, file paths, export status, and timestamp
// You can add more columns as needed

db.run(`CREATE TABLE IF NOT EXISTS pdf_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT,
  input_pdf_url TEXT,
  output_report_url TEXT,
  input_pdf_path TEXT,
  output_pdf_path TEXT,
  exported INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  sent INTEGER DEFAULT 0,
  report_id TEXT
)`);

// Save a new input record (when a user sends a PDF)
function saveInputRecord(user, inputPdfUrl, reportId) {
  db.run('INSERT INTO pdf_records (user, input_pdf_url, report_id) VALUES (?, ?, ?)', [user, inputPdfUrl, reportId]);
}

// Save the output report URL (when the report is ready)
function saveOutputRecord(inputPdfUrl, outputReportUrl) {
  db.run('UPDATE pdf_records SET output_report_url = ? WHERE input_pdf_url = ?', [outputReportUrl, inputPdfUrl]);
}

// Export all new (not yet exported) records to a JSON file
function exportNewRecords() {
  db.all('SELECT * FROM pdf_records WHERE exported = 0', [], (err, rows) => {
    if (err) throw err;
    require('fs').writeFileSync('pdf_export.json', JSON.stringify(rows, null, 2));
    rows.forEach(row => {
      db.run('UPDATE pdf_records SET exported = 1 WHERE id = ?', [row.id]);
    });
  });
}
// To export, call exportNewRecords() manually or on a schedule.

// Save mapping to file
function saveMapping(report_id, user) {
  let map = {};
  if (fs.existsSync(mappingFile)) {
    map = JSON.parse(fs.readFileSync(mappingFile));
  }
  map[report_id] = user;
  fs.writeFileSync(mappingFile, JSON.stringify(map));
}

// Load mapping from file
function loadMapping(report_id) {
  if (!fs.existsSync(mappingFile)) return undefined;
  const map = JSON.parse(fs.readFileSync(mappingFile));
  return map[report_id];
}

// Delete mapping from file
function deleteMapping(report_id) {
  if (!fs.existsSync(mappingFile)) return;
  const map = JSON.parse(fs.readFileSync(mappingFile));
  delete map[report_id];
  fs.writeFileSync(mappingFile, JSON.stringify(map));
}

// Add or ensure 'sent' column exists in pdf_records
// Suppress error if column already exists

// sent column
 db.run('ALTER TABLE pdf_records ADD COLUMN sent INTEGER DEFAULT 0', (err) => {
   if (err && !/duplicate column name/.test(err.message)) {
     console.error(err);
   }
 });
// report_id column
 db.run('ALTER TABLE pdf_records ADD COLUMN report_id TEXT', (err) => {
   if (err && !/duplicate column name/.test(err.message)) {
     console.error(err);
   }
 });
// unique index
 db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_report_id ON pdf_records(report_id)', (err) => {
   if (err && !/already exists/.test(err.message)) {
     console.error(err);
   }
 });

// --- 1. Webhook verification endpoint for Facebook/WhatsApp ---
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.WEBHOOK_VERIFICATION_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// --- 2. WhatsApp webhook handler for incoming messages ---
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const entry = req.body.entry && req.body.entry[0];
  const changes = entry && entry.changes && entry.changes[0];
  const value = changes && changes.value;
  const messages = value && value.messages;
  if (!messages) return;
  const msg = messages[0];
  const from = msg.from;

  // Always reply to non-PDF messages (including 'Hi')
  if (!(msg.type === 'document' && msg.document && msg.document.mime_type === 'application/pdf')) {
    await sendWhatsAppText(from, 'Send your PDF to Check for Turnitin AI / Plagiarism');
    return;
  }

  // Handle PDF document
  await sendWhatsAppText(from, "Got your PDF! We're checking it now");
  try {
    // 1. Get the media ID from the message
    const mediaId = msg.document.id;
    // 2. Get a temporary download URL from WhatsApp
    const mediaUrl = await getWhatsAppMediaUrl(mediaId);
    // 3. Download the PDF file
    const pdfBuffer = await downloadFile(mediaUrl);
    // 4. Submit the PDF to Turnitin
    const reportId = await submitToTurnitin(pdfBuffer, msg.document.filename);
    // 5. Save the mapping so we know who to reply to when the report is ready
    saveMapping(reportId, from);
    // Save input record to database with reportId
    saveInputRecord(from, mediaUrl, reportId);
    await sendWhatsAppText(from, "Your file is being checked. We'll send you the report as a PDF soon");
  } catch (err) {
    console.error('Error processing PDF:', err);
    await sendWhatsAppText(from, 'Something went wrong. Please try again later');
  }
});

// --- Helper: Get WhatsApp media download URL ---
async function getWhatsAppMediaUrl(mediaId) {
  const url = `https://graph.facebook.com/${process.env.CLOUD_API_VERSION}/${mediaId}`;
  const resp = await axios.get(url, {
    headers: { 'Authorization': `Bearer ${process.env.CLOUD_API_ACCESS_TOKEN}` }
  });
  return resp.data.url;
}

// --- Helper: Download file from URL as Buffer ---
async function downloadFile(url) {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: {
      'Authorization': `Bearer ${process.env.CLOUD_API_ACCESS_TOKEN}`,
    },
  });
  return Buffer.from(resp.data, 'binary');
}

// --- Helper: Submit PDF to Turnitin ---
async function submitToTurnitin(pdfBuffer, filename) {
  const form = new FormData();
  form.append('email', process.env.TURNITIN_EMAIL);
  form.append('api_key', process.env.TURNITIN_API_KEY);
  form.append('environment', process.env.TURNITIN_ENVIRONMENT);
  form.append('submission_type', 'file');
  form.append('submitted_file', pdfBuffer, filename);
  form.append('exclude_bibliography', '1');
  form.append('exclude_quotes', '0');
  const resp = await axios.post('https://plagwise.com/api/submit-file', form, {
    headers: form.getHeaders(),
  });
  if (resp.data.success && resp.data.report_id) {
    return resp.data.report_id;
  } else {
    throw new Error('Turnitin submission failed: ' + JSON.stringify(resp.data.errors));
  }
}

// --- Helper: Send a WhatsApp document message ---
async function sendWhatsAppDocument(to, fileUrl, filename) {
  // 1. Download the PDF as a buffer
  const pdfResp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  const pdfBuffer = Buffer.from(pdfResp.data, 'binary');

  // 2. Upload the PDF to WhatsApp as multipart/form-data
  const form = new FormData();
  form.append('file', pdfBuffer, { filename: filename, contentType: 'application/pdf' });
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'document');

  const mediaResp = await axios.post(
    `https://graph.facebook.com/${process.env.CLOUD_API_VERSION}/${WA_PHONE_NUMBER_ID}/media`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${process.env.CLOUD_API_ACCESS_TOKEN}`,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }
  );
  const mediaId = mediaResp.data.id;

  // 3. Send the document to the user
  await axios.post(
    `https://graph.facebook.com/${process.env.CLOUD_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: to,
      type: 'document',
      document: {
        id: mediaId,
        filename: filename,
      },
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.CLOUD_API_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

// --- 4. Turnitin webhook handler ---
app.post('/turnitin-webhook', async (req, res) => {
  console.log('Webhook received:', req.body);
  res.sendStatus(200);
  const body = req.body;
  // Check if the report is completed and has a report link
  if (body.status === 'queueing') {
    const user = loadMapping(String(body.report_id));
    if (user) {
      await sendWhatsAppText(user, 'There is currently alot of people generating report, you have been placed in queue');
    }
    return;
  }
  if (body.status === 'completed' && body.plagiarism_report_url) {
    db.run(
      'UPDATE pdf_records SET output_report_url = ?, sent = 1 WHERE report_id = ? AND sent = 0',
      [body.plagiarism_report_url, body.report_id],
      function (err) {
        if (err) return;
        if (this.changes === 0) {
          // Already sent, do nothing
          return;
        }
        const user = loadMapping(String(body.report_id));
        if (user) {
          console.log('User found:', user, 'Sending WhatsApp document...');
          sendWhatsAppDocument(user, body.plagiarism_report_url, 'Turnitin_Report.pdf');
          sendWhatsAppText(user, 'Your report is ready. Check the attached PDF');
          deleteMapping(String(body.report_id));
        } else {
          console.log('No user found for this report_id. The mapping may have been lost if the file was deleted.');
        }
      }
    );
  }
});

// --- 3. Helper function to send a WhatsApp text message ---
async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/${process.env.CLOUD_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    text: { body: text },
  };
  try {
    await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${process.env.CLOUD_API_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('Error sending WhatsApp message:', err.response ? err.response.data : err.message);
  }
}

const PORT = process.env.LISTENER_PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});

