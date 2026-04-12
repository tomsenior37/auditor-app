const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = 3103;
const INSPECTIONS_FILE = path.join(__dirname, 'inspections.json');
const LISTS_FILE = path.join(__dirname, 'lists.json');
const ARCHIVE_FILE = path.join(__dirname, 'archive.json');
const TEMPLATES_FILE = path.join(__dirname, 'templates.json');
const EMAIL_CONFIG_FILE = path.join(__dirname, 'emailConfig.json');
const PHOTOS_DIR = path.join(__dirname, 'photos');

// Ensure photos dir exists
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTOS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use('/photos', express.static(PHOTOS_DIR));

// Read/write helpers
function readInspections() {
  if (!fs.existsSync(INSPECTIONS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(INSPECTIONS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeInspections(data) {
  fs.writeFileSync(INSPECTIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function readEmailConfig() {
  if (!fs.existsSync(EMAIL_CONFIG_FILE)) return { host:'', port:587, secure:false, user:'', password:'', fromName:'Auditor App', fromEmail:'', externalUrl:'http://tomsenior9999.ddns.net:3103' };
  try {
    const d = JSON.parse(fs.readFileSync(EMAIL_CONFIG_FILE, 'utf8'));
    if (!d.externalUrl) d.externalUrl = 'http://tomsenior9999.ddns.net:3103';
    return d;
  } catch { return {}; }
}

function writeEmailConfig(data) {
  fs.writeFileSync(EMAIL_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function readLists() {
  if (!fs.existsSync(LISTS_FILE)) return { locations: [], inspectors: [] };
  try {
    const data = JSON.parse(fs.readFileSync(LISTS_FILE, 'utf8'));
    // Migrate old format: { machines: [], locations: [] } where locations were strings
    const isOldFormat = Array.isArray(data.machines) ||
      (Array.isArray(data.locations) && data.locations.length > 0 && typeof data.locations[0] === 'string');
    if (isOldFormat) {
      const migrated = { locations: [], inspectors: [] };
      writeLists(migrated);
      return migrated;
    }
    if (!Array.isArray(data.locations)) return { locations: [], inspectors: [] };
    if (!Array.isArray(data.inspectors)) data.inspectors = [];
    if (!Array.isArray(data.planners)) data.planners = [];
    // Migrate machines from strings to objects with guards array
    let dirty = false;
    data.locations.forEach(loc => {
      if (!Array.isArray(loc.machines)) { loc.machines = []; dirty = true; }
      loc.machines = loc.machines.map(m => {
        if (typeof m === 'string') { dirty = true; return { name: m, guards: [] }; }
        if (!Array.isArray(m.guards)) { m.guards = []; dirty = true; }
        return m;
      });
    });
    if (dirty) writeLists(data);
    return data;
  } catch { return { locations: [], inspectors: [] }; }
}

function writeLists(data) {
  fs.writeFileSync(LISTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function readArchive() {
  if (!fs.existsSync(ARCHIVE_FILE)) return { guards: [], locations: [], inspectors: [] };
  try {
    const d = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
    if (!d.locations) d.locations = [];
    if (!d.inspectors) d.inspectors = [];
    return d;
  } catch {
    return { guards: [], locations: [], inspectors: [] };
  }
}

function writeArchive(data) {
  fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function readTemplates() {
  if (!fs.existsSync(TEMPLATES_FILE)) return { templates: [] };
  try { return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8')); }
  catch { return { templates: [] }; }
}

function writeTemplates(data) {
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Templates API ──────────────────────────────────────────
app.get('/api/templates', (req, res) => res.json(readTemplates()));

app.post('/api/templates', (req, res) => {
  const { name, standard, description, requiresComponent, componentType, questions } = req.body;
  if (!name || !questions) return res.status(400).json({ error: 'name and questions required' });
  const data = readTemplates();
  const tpl = {
    id: 'tpl-' + uuidv4().slice(0, 8),
    name, standard: standard || '', description: description || '',
    requiresComponent: !!requiresComponent,
    componentType: componentType || '',
    questions,
    createdAt: new Date().toISOString()
  };
  data.templates.push(tpl);
  writeTemplates(data);
  res.json({ success: true, template: tpl });
});

app.put('/api/templates/:id', (req, res) => {
  const data = readTemplates();
  const idx = data.templates.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.templates[idx] = { ...data.templates[idx], ...req.body, id: req.params.id };
  writeTemplates(data);
  res.json({ success: true, template: data.templates[idx] });
});

app.delete('/api/templates/:id', (req, res) => {
  const data = readTemplates();
  const idx = data.templates.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.templates.splice(idx, 1);
  writeTemplates(data);
  res.json({ success: true });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// POST /api/inspection
// GET /wr — work request entry page
app.get('/wr', (req, res) => res.sendFile(path.join(__dirname, 'wr.html')));

// GET /api/inspection/:id — single inspection
app.get('/api/inspection/:id', (req, res) => {
  const insp = readInspections().find(i => i.id === req.params.id);
  if (!insp) return res.status(404).json({ error: 'not found' });
  res.json(insp);
});

// PATCH /api/inspection/:id/wr — attach work request number
app.patch('/api/inspection/:id/wr', (req, res) => {
  const { workRequestNumber } = req.body;
  if (!workRequestNumber) return res.status(400).json({ error: 'workRequestNumber required' });
  const inspections = readInspections();
  const idx = inspections.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  inspections[idx].workRequestNumber = workRequestNumber;
  inspections[idx].status = 'WR_RAISED';
  inspections[idx].wrRaisedAt = new Date().toISOString();
  writeInspections(inspections);
  res.json({ success: true });
});

// PATCH /api/inspection/:id/serviceable — mark rectification complete
app.patch('/api/inspection/:id/serviceable', (req, res) => {
  const { notes, completionDate, workOrderNumber } = req.body;
  const inspections = readInspections();
  const idx = inspections.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  inspections[idx].status = 'SERVICEABLE';
  inspections[idx].serviceableAt = new Date().toISOString();
  if (notes) inspections[idx].rectificationNotes = notes;
  if (completionDate) inspections[idx].completionDate = completionDate;
  if (workOrderNumber) inspections[idx].rectificationWorkOrder = workOrderNumber;
  writeInspections(inspections);
  res.json({ success: true });
});

app.post('/api/inspection', (req, res) => {
  const body = req.body;
  if (!body.location || !body.machine || !body.inspector) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  // Calculate result from template questions
  let result = 'PASS';
  if (body.templateId) {
    const tplData = readTemplates();
    const tpl = tplData.templates.find(t => t.id === body.templateId);
    if (tpl) {
      const hasNo = tpl.questions.some(q => q.type === 'yesno' && body.answers && body.answers[q.id] === false);
      result = hasNo ? 'FAIL' : 'PASS';
    }
  } else {
    result = body.result || 'FAIL';
  }
  const inspections = readInspections();
  const record = {
    id: uuidv4(),
    templateId: body.templateId || null,
    templateName: body.templateName || null,
    guardId: body.guardId || body.componentId || null,
    componentId: body.componentId || body.guardId || null,
    location: body.location,
    machine: body.machine,
    timestamp: new Date().toISOString(),
    inspector: body.inspector,
    answers: body.answers || {},
    findings: body.findings || {},
    notes: body.notes || '',
    photo: body.photo || null,
    signature: body.signature || null,
    result
  };
  inspections.unshift(record);
  writeInspections(inspections);
  res.json({ success: true, id: record.id, result: record.result });
});

// GET /api/inspections
app.get('/api/inspections', (req, res) => {
  res.json(readInspections());
});

// GET /api/export/csv
app.get('/api/export/csv', (req, res) => {
  const inspections = readInspections();
  const questions = [
    'Guard present and in position',
    'Guard securely fixed / fasteners tight',
    'No visible damage/cracks/deformation',
    'No unauthorised modifications',
    'Adequate coverage of danger zone',
    'Minimum safety distances maintained',
    'Interlocking device functional',
    'Guard markings/labels legible',
    'No bypass or defeat detected',
    'No additional hazards created'
  ];

  const headers = [
    'ID', 'Timestamp', 'Inspector', 'Guard ID', 'Location', 'Machine',
    ...questions.map((q, i) => `Q${i + 1}: ${q}`),
    'Notes', 'Photo', 'Result'
  ];

  const rows = inspections.map(r => {
    const answerCols = Array.from({ length: 10 }, (_, i) => {
      const val = r.answers[`q${i + 1}`];
      if (val === true) return 'YES';
      if (val === false) return 'NO';
      if (val === 'na') return 'N/A';
      return '';
    });
    return [
      r.id,
      r.timestamp,
      r.inspector,
      r.guardId,
      r.location,
      r.machine,
      ...answerCols,
      (r.notes || '').replace(/"/g, '""'),
      r.photo || '',
      r.result
    ].map(v => `"${v}"`).join(',');
  });

  const csv = [headers.map(h => `"${h}"`).join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="guard-inspections.csv"');
  res.send(csv);
});

// GET /api/lists
app.get('/api/lists', (req, res) => {
  res.json(readLists());
});

// POST /api/lists/location — body: { name }
app.post('/api/lists/location', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const lists = readLists();
  if (!lists.locations.find(l => l.name === name)) {
    lists.locations.push({ name, machines: [] });
    lists.locations.sort((a, b) => a.name.localeCompare(b.name));
    writeLists(lists);
  }
  res.json({ success: true, locations: lists.locations });
});

// DELETE /api/lists/location — body: { name }
app.delete('/api/lists/location', (req, res) => {
  const name = (req.body.name || '').trim();
  const lists = readLists();
  lists.locations = lists.locations.filter(l => l.name !== name);
  writeLists(lists);
  res.json({ success: true, locations: lists.locations });
});

// POST /api/lists/machine — body: { location, machine }
app.post('/api/lists/machine', (req, res) => {
  const location = (req.body.location || '').trim();
  const machine = (req.body.machine || '').trim();
  if (!location || !machine) return res.status(400).json({ error: 'Location and machine required' });
  const lists = readLists();
  const loc = lists.locations.find(l => l.name === location);
  if (!loc) return res.status(404).json({ error: 'Location not found' });
  if (!loc.machines.find(m => m.name === machine)) {
    loc.machines.push({ name: machine, guards: [] });
    loc.machines.sort((a, b) => a.name.localeCompare(b.name));
    writeLists(lists);
  }
  res.json({ success: true, locations: lists.locations });
});

// DELETE /api/lists/machine — body: { location, machine }
app.delete('/api/lists/machine', (req, res) => {
  const location = (req.body.location || '').trim();
  const machine = (req.body.machine || '').trim();
  const lists = readLists();
  const loc = lists.locations.find(l => l.name === location);
  if (loc) {
    loc.machines = loc.machines.filter(m => m.name !== machine);
    writeLists(lists);
  }
  res.json({ success: true, locations: lists.locations });
});

// POST /api/lists/guard — body: { location, machine, guard }
app.post('/api/lists/guard', (req, res) => {
  const location = (req.body.location || '').trim();
  const machine = (req.body.machine || '').trim();
  const guard = (req.body.guard || '').trim();
  if (!location || !machine || !guard) return res.status(400).json({ error: 'location, machine, and guard required' });
  const lists = readLists();
  const loc = lists.locations.find(l => l.name === location);
  if (!loc) return res.status(404).json({ error: 'Location not found' });
  const mac = loc.machines.find(m => m.name === machine);
  if (!mac) return res.status(404).json({ error: 'Machine not found' });
  if (!mac.guards.includes(guard)) {
    mac.guards.push(guard);
    mac.guards.sort();
    writeLists(lists);
  }
  res.json({ success: true, locations: lists.locations });
});

// DELETE /api/lists/guard — body: { location, machine, guard }
app.delete('/api/lists/guard', (req, res) => {
  const location = (req.body.location || '').trim();
  const machine = (req.body.machine || '').trim();
  const guard = (req.body.guard || '').trim();
  const lists = readLists();
  const loc = lists.locations.find(l => l.name === location);
  if (loc) {
    const mac = loc.machines.find(m => m.name === machine);
    if (mac) {
      mac.guards = mac.guards.filter(g => g !== guard);
      writeLists(lists);
    }
  }
  res.json({ success: true, locations: lists.locations });
});

// POST /api/lists/inspector — body: { name }
app.post('/api/lists/inspector', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const lists = readLists();
  if (!lists.inspectors.includes(name)) {
    lists.inspectors.push(name);
    lists.inspectors.sort();
    writeLists(lists);
  }
  res.json({ success: true, inspectors: lists.inspectors });
});

// DELETE /api/lists/inspector — body: { name }
app.delete('/api/lists/inspector', (req, res) => {
  const name = (req.body.name || '').trim();
  const lists = readLists();
  lists.inspectors = lists.inspectors.filter(n => n !== name);
  writeLists(lists);
  res.json({ success: true, inspectors: lists.inspectors });
});

// ── Planners API ────────────────────────────────────
app.get('/api/planners', (req, res) => {
  const lists = readLists();
  res.json({ planners: lists.planners || [] });
});

app.post('/api/planners', (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  const lists = readLists();
  if (!lists.planners) lists.planners = [];
  if (!lists.planners.find(p => p.email === email)) lists.planners.push({ name, email });
  writeLists(lists);
  res.json({ success: true, planners: lists.planners });
});

app.delete('/api/planners', (req, res) => {
  const { email } = req.body;
  const lists = readLists();
  lists.planners = (lists.planners || []).filter(p => p.email !== email);
  writeLists(lists);
  res.json({ success: true, planners: lists.planners });
});

// ── Email Config API ─────────────────────────────────
app.get('/api/email/config', (req, res) => {
  const cfg = readEmailConfig();
  // Don't expose password in full
  res.json({ ...cfg, password: cfg.password ? '••••••••' : '' });
});

app.post('/api/email/config', (req, res) => {
  const existing = readEmailConfig();
  const { host, port, secure, user, password, fromName, fromEmail, externalUrl } = req.body;
  const updated = {
    host: host || existing.host,
    port: parseInt(port) || existing.port,
    secure: !!secure,
    user: user || existing.user,
    password: (password && password !== '••••••••') ? password : existing.password,
    fromName: fromName || existing.fromName,
    fromEmail: fromEmail || existing.fromEmail,
    externalUrl: externalUrl || existing.externalUrl || 'http://tomsenior9999.ddns.net:3103'
  };
  writeEmailConfig(updated);
  res.json({ success: true });
});

app.post('/api/email/test', async (req, res) => {
  const cfg = readEmailConfig();
  if (!cfg.host || !cfg.user) return res.status(400).json({ error: 'Email not configured' });
  try {
    const transporter = nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.password }
    });
    await transporter.verify();
    res.json({ success: true, message: 'Connection successful' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/email/send-report', async (req, res) => {
  const { inspectionId, plannerEmail, plannerName } = req.body;
  if (!inspectionId || !plannerEmail) return res.status(400).json({ error: 'inspectionId and plannerEmail required' });

  const cfg = readEmailConfig();
  if (!cfg.host || !cfg.user) return res.status(400).json({ error: 'Email server not configured. Go to Setup > Email.' });

  const inspections = readInspections();
  const insp = inspections.find(i => i.id === inspectionId);
  if (!insp) return res.status(404).json({ error: 'Inspection not found' });

  const templates = readTemplates();
  const template = templates.templates.find(t => t.id === insp.templateId);

  // Build PDF buffer
  const pdfBuffer = await buildPDFBuffer(insp, template);
  const d = new Date(insp.timestamp);
  const dateStr = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getFullYear()).slice(2)}`;
  const label = insp.guardId || insp.machine;
  const filename = `${label}-${dateStr}-${insp.result}.pdf`.replace(/[^a-zA-Z0-9.\-_]/g, '_');

  try {
    const transporter = nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.password }
    });
    await transporter.sendMail({
      from: `"${cfg.fromName}" <${cfg.fromEmail || cfg.user}>`,
      to: `"${plannerName}" <${plannerEmail}>`,
      subject: `FAILED Inspection Report — ${label} (${insp.location} / ${insp.machine})`,
      html: `
        <h2 style="color:#e05c3a;">❌ Failed Inspection Report</h2>
        <table style="border-collapse:collapse;margin-bottom:16px;">
          <tr><td style="padding:4px 12px 4px 0;color:#666;">Template</td><td style="padding:4px 0;"><strong>${insp.templateName || 'N/A'}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;">Location</td><td style="padding:4px 0;"><strong>${insp.location}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;">Equipment</td><td style="padding:4px 0;"><strong>${insp.machine}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;">Component</td><td style="padding:4px 0;"><strong>${insp.guardId || 'N/A'}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;">Inspector</td><td style="padding:4px 0;"><strong>${insp.inspector}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;">Date</td><td style="padding:4px 0;"><strong>${d.toLocaleDateString('en-AU')}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#666;">Result</td><td style="padding:4px 0;"><span style="background:#e05c3a;color:#fff;padding:2px 10px;border-radius:12px;font-weight:700;">FAIL</span></td></tr>
        </table>
        <p style="margin-bottom:16px;">Please see the attached PDF inspection report. Defects have been identified that require rectification.</p>
        <h3 style="color:#e05c3a;margin-bottom:12px;">Action Required</h3>
        <p style="margin-bottom:16px;">Raise a work request in your maintenance system to rectify the identified defects, then click the button below to record the work request number:</p>
        <p style="margin-bottom:24px;"><a href="${cfg.externalUrl}/wr?id=${insp.id}" style="display:inline-block;background:#ff9800;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;">&#128295; Input Work Request Number</a></p>
        <p style="font-size:12px;color:#888;">Clicking the button above will open a simple page where you enter the WR number. The inspection badge will update to <strong style="color:#ff9800;">WR Raised</strong> with the number displayed.<br><br>This email was sent from the Auditor inspection app.</p>
      `,
      attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }]
    });
    // Save planner info to inspection record
    const inspIdx = inspections.findIndex(i => i.id === inspectionId);
    if (inspIdx !== -1) {
      inspections[inspIdx].sentToPlanner = { name: plannerName, email: plannerEmail, sentAt: new Date().toISOString() };
      writeInspections(inspections);
    }
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Build PDF as buffer (for email attachment)
async function buildPDFBuffer(insp, template) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // Simple layout
    doc.fontSize(18).font('Helvetica-Bold').text(insp.templateName || 'Inspection Report', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica');
    doc.text(`Location: ${insp.location}  |  Equipment: ${insp.machine}${insp.guardId ? '  |  Component: '+insp.guardId : ''}`);
    doc.text(`Inspector: ${insp.inspector}  |  Date: ${new Date(insp.timestamp).toLocaleDateString('en-AU')}  |  Result: ${insp.result}`);
    doc.moveDown(1);
    if (template) {
      template.questions.forEach((q, i) => {
        const ans = insp.answers[q.id];
        let at = 'Not answered';
        if (ans === true) at = 'YES';
        else if (ans === false) at = 'NO';
        else if (ans === null) at = 'N/A';
        else if (ans !== undefined) at = String(ans);
        doc.fontSize(10).font('Helvetica').text(`${i+1}. ${q.text}`);
        doc.fontSize(10).font('Helvetica-Bold').fillColor(ans === false ? '#e05c3a' : ans === true ? '#3aad5c' : '#000').text(`   → ${at}`);
        doc.fillColor('#000');
        const ev = insp.findings && insp.findings[`q${i+1}`];
        if (ev && ev.comment) doc.fontSize(9).fillColor('#555').text(`   Finding: ${ev.comment}`);
        if (ev && ev.rectification) doc.fontSize(9).fillColor('#555').text(`   Suggested rectification: ${ev.rectification}`);
        doc.fillColor('#000').moveDown(0.3);
      });
    }
    if (insp.notes) { doc.moveDown(0.5).font('Helvetica-Bold').text('Notes:').font('Helvetica').text(insp.notes); }
    doc.end();
  });
}

// ── PDF helpers ────────────────────────────────────────────────────────────
const QUESTIONS = [
  'Guard is present and in position',
  'Guard is securely fixed / fasteners all present and tight',
  'Guard has no visible damage, cracks or deformation',
  'No unauthorised modifications to guard',
  'Guard provides adequate coverage of danger zone',
  'Minimum safety distances maintained (AS/NZS 4024.1801)',
  'Interlocking device functional (if applicable)',
  'Guard markings/labels are legible',
  'No bypass or defeat of guard detected',
  'Guard does not create additional hazards (sharp edges, pinch points)'
];

function answerLabel(val) {
  if (val === true)   return 'YES';
  if (val === false)  return 'NO';
  if (val === 'na')   return 'N/A';
  return '—';
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

function addFooter(doc, pageNum) {
  const generated = new Date().toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' });
  doc.fontSize(8).fillColor('#888888')
    .text(
      `AS/NZS 4024.1601:2014 — Safety of Machinery | Generated: ${generated}`,
      doc.page.margins.left,
      doc.page.height - doc.page.margins.bottom - 14,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 60, align: 'left' }
    )
    .text(
      `Page ${pageNum}`,
      doc.page.margins.left,
      doc.page.height - doc.page.margins.bottom - 14,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'right' }
    );
}

function buildSinglePDF(doc, rec, pageNum) {
  const margin = doc.page.margins.left;
  const pageW  = doc.page.width - margin * 2;

  let y = 0;

  // ── Guard reference photo — full width at very top ──
  const refPhotoFile = rec.photo || rec.referencePhoto || null;
  if (refPhotoFile) {
    const photoPath = path.join(PHOTOS_DIR, refPhotoFile);
    if (fs.existsSync(photoPath)) {
      try {
        doc.image(photoPath, 0, 0, { width: doc.page.width, height: 220, fit: [doc.page.width, 220], align: 'center', valign: 'center' });
        y = 220;
      } catch (e) { y = 0; }
    }
  }

  // ── Header bar (over or below photo) ──
  const headerY = y;
  doc.rect(0, headerY, doc.page.width, 70).fill('#1a1a1a');
  doc.fontSize(18).fillColor('#ffffff').font('Helvetica-Bold')
    .text('Machine Guard Inspection Report', margin, headerY + 12, { width: pageW });
  doc.fontSize(10).fillColor('#aaaaaa').font('Helvetica')
    .text('AS/NZS 4024.1601:2014 — Safety of Machinery', margin, headerY + 34);
  doc.fontSize(8).fillColor('#666666')
    .text(`Report ID: ${rec.id}`, margin, headerY + 50);
  y = headerY + 82;

  // ── Summary section ──
  doc.fontSize(22).fillColor('#111111').font('Helvetica-Bold')
    .text(rec.guardId, margin, y);
  y = doc.y + 8;

  doc.fontSize(11).fillColor('#333333').font('Helvetica')
    .text(`Location: ${rec.location}   |   Machine: ${rec.machine}`, margin, y);
  y = doc.y + 4;
  doc.text(`Inspector: ${rec.inspector}`, margin, y);
  y = doc.y + 4;
  doc.text(`Date/Time: ${formatDate(rec.timestamp)}`, margin, y);
  y = doc.y + 10;

  // Result chip
  const resultColor = rec.result === 'PASS' ? '#3aad5c' : '#e05c3a';
  doc.rect(margin, y, 90, 30).fill(resultColor);
  doc.fontSize(16).fillColor('#ffffff').font('Helvetica-Bold')
    .text(rec.result, margin, y + 7, { width: 90, align: 'center' });
  y += 44;

  // ── Checklist section ──
  doc.moveTo(margin, y).lineTo(margin + pageW, y).lineWidth(1).strokeColor('#dddddd').stroke();
  y += 8;
  doc.fontSize(12).fillColor('#555555').font('Helvetica-Bold')
    .text('INSPECTION CHECKLIST', margin, y);
  y = doc.y + 6;

  QUESTIONS.forEach((q, i) => {
    const key = `q${i + 1}`;
    const val = rec.answers ? rec.answers[key] : undefined;
    const label = answerLabel(val);
    const isNo = val === false;
    const finding = rec.findings && rec.findings[key];

    // Ensure enough space
    if (y > doc.page.height - doc.page.margins.bottom - 80) {
      addFooter(doc, pageNum++);
      doc.addPage();
      y = doc.page.margins.top;
    }

    // Row background for NO answers
    if (isNo) {
      doc.rect(margin - 4, y - 2, pageW + 8, 20).fill('rgba(224,92,58,0.08)');
    }

    // Answer chip
    const chipColor = label === 'YES' ? '#3aad5c' : label === 'NO' ? '#e05c3a' : '#6b7280';
    doc.rect(margin, y, 32, 16).fill(chipColor);
    doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold')
      .text(label, margin, y + 3, { width: 32, align: 'center' });

    // Question text
    doc.fontSize(10).fillColor(isNo ? '#c0392b' : '#222222').font('Helvetica')
      .text(`${i + 1}. ${q}`, margin + 40, y, { width: pageW - 40 });
    y = doc.y + 4;

    // Finding comment
    if (isNo && finding && finding.comment) {
      if (y > doc.page.height - doc.page.margins.bottom - 60) {
        addFooter(doc, pageNum++);
        doc.addPage();
        y = doc.page.margins.top;
      }
      doc.fontSize(9).fillColor('#888888').font('Helvetica-Oblique')
        .text(`  Finding: ${finding.comment}`, margin + 40, y, { width: pageW - 40 });
      y = doc.y + 4;
    }

    // Finding photo
    if (isNo && finding && finding.photo) {
      const photoPath = path.join(PHOTOS_DIR, finding.photo);
      if (fs.existsSync(photoPath)) {
        if (y > doc.page.height - doc.page.margins.bottom - 180) {
          addFooter(doc, pageNum++);
          doc.addPage();
          y = doc.page.margins.top;
        }
        try {
          doc.image(photoPath, margin + 40, y, { fit: [300, 160], align: 'left', valign: 'top' });
          y += 168; // fixed height + gap
        } catch (e) { /* skip bad image */ }
      }
    }

    doc.moveTo(margin, y).lineTo(margin + pageW, y).lineWidth(0.5).strokeColor('#eeeeee').stroke();
    y += 6;
  });

  // ── Notes ──
  if (rec.notes) {
    if (y > doc.page.height - doc.page.margins.bottom - 80) {
      addFooter(doc, pageNum++);
      doc.addPage();
      y = doc.page.margins.top;
    }
    y += 10;
    doc.moveTo(margin, y).lineTo(margin + pageW, y).lineWidth(1).strokeColor('#dddddd').stroke();
    y += 8;
    doc.fontSize(12).fillColor('#555555').font('Helvetica-Bold').text('INSPECTOR NOTES', margin, y);
    y = doc.y + 6;
    doc.fontSize(10).fillColor('#333333').font('Helvetica').text(rec.notes, margin, y, { width: pageW });
    y = doc.y + 10;
  }

  // ── Signature ──
  if (rec.signature) {
    if (y > doc.page.height - doc.page.margins.bottom - 120) {
      addFooter(doc, pageNum++);
      doc.addPage();
      y = doc.page.margins.top;
    }
    y += 10;
    doc.moveTo(margin, y).lineTo(margin + pageW, y).lineWidth(1).strokeColor('#dddddd').stroke();
    y += 8;
    doc.fontSize(12).fillColor('#555555').font('Helvetica-Bold').text('INSPECTOR SIGNATURE', margin, y);
    y = doc.y + 6;
    try {
      const base64Data = rec.signature.replace(/^data:image\/\w+;base64,/, '');
      const imgBuffer = Buffer.from(base64Data, 'base64');
      doc.image(imgBuffer, margin, y, { width: 220 });
      y = doc.y + 6;
    } catch (e) { /* skip bad signature */ }
    doc.fontSize(9).fillColor('#888888').font('Helvetica')
      .text(`${rec.inspector} · ${formatDate(rec.timestamp)}`, margin, y);
    y = doc.y + 6;
  }

  addFooter(doc, pageNum);
  return pageNum;
}

// GET /api/report/all — summary PDF
app.get('/api/report/all', (req, res) => {
  const inspections = readInspections();
  const doc = new PDFDocument({ margin: 50, size: 'A4', autoFirstPage: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="guard-audit-summary.pdf"');
  doc.pipe(res);

  const margin = 50;
  const pageW = doc.page.width - margin * 2;
  const generated = new Date().toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' });

  // ── Cover page ──
  doc.rect(0, 0, doc.page.width, 100).fill('#1a1a1a');
  doc.fontSize(24).fillColor('#ffffff').font('Helvetica-Bold')
    .text('Guard Audit Summary Report', margin, 20, { width: pageW });
  doc.fontSize(12).fillColor('#aaaaaa').font('Helvetica')
    .text('AS/NZS 4024.1601:2014 — Safety of Machinery', margin, 54);
  doc.fontSize(10).fillColor('#666666')
    .text(`Generated: ${generated}`, margin, 74);

  let y = 120;
  const total = inspections.length;
  const pass  = inspections.filter(r => r.result === 'PASS').length;
  const fail  = inspections.filter(r => r.result === 'FAIL').length;

  if (total > 0) {
    const dates = inspections.map(r => new Date(r.timestamp)).sort((a,b) => a-b);
    const dateRange = `${dates[0].toLocaleDateString('en-AU')} – ${dates[dates.length-1].toLocaleDateString('en-AU')}`;
    doc.fontSize(11).fillColor('#333333').font('Helvetica')
      .text(`Date range: ${dateRange}`, margin, y);
    y = doc.y + 6;
  }

  // Stat chips
  const chips = [
    { label: 'Total', val: total, color: '#444444' },
    { label: 'Pass',  val: pass,  color: '#3aad5c' },
    { label: 'Fail',  val: fail,  color: '#e05c3a' }
  ];
  chips.forEach((c, ci) => {
    const cx = margin + ci * 120;
    doc.rect(cx, y, 100, 56).fill(c.color);
    doc.fontSize(28).fillColor('#ffffff').font('Helvetica-Bold')
      .text(String(c.val), cx, y + 6, { width: 100, align: 'center' });
    doc.fontSize(11).fillColor('#ffffff').font('Helvetica')
      .text(c.label, cx, y + 36, { width: 100, align: 'center' });
  });
  y += 76;

  doc.fontSize(8).fillColor('#888888').font('Helvetica')
    .text(
      `AS/NZS 4024.1601:2014 — Safety of Machinery | Generated: ${generated}`,
      margin, doc.page.height - 50 - 14,
      { width: pageW - 60, align: 'left' }
    )
    .text('Page 1', margin, doc.page.height - 50 - 14,
      { width: pageW, align: 'right' }
    );

  // ── One condensed page per inspection ──
  let pageNum = 2;
  inspections.forEach(rec => {
    doc.addPage();
    const pmargin = doc.page.margins.left;
    const pw = doc.page.width - pmargin * 2;

    // Mini header
    doc.rect(0, 0, doc.page.width, 45).fill('#1a1a1a');
    doc.fontSize(14).fillColor('#ffffff').font('Helvetica-Bold')
      .text(`${rec.guardId}  —  ${rec.location} / ${rec.machine}`, pmargin, 10, { width: pw - 80 });
    const rc = rec.result === 'PASS' ? '#3aad5c' : '#e05c3a';
    doc.rect(doc.page.width - pmargin - 70, 8, 60, 26).fill(rc);
    doc.fontSize(13).fillColor('#ffffff').font('Helvetica-Bold')
      .text(rec.result, doc.page.width - pmargin - 70, 15, { width: 60, align: 'center' });

    let ry = 56;
    doc.fontSize(9).fillColor('#555555').font('Helvetica')
      .text(`Inspector: ${rec.inspector}   |   ${formatDate(rec.timestamp)}`, pmargin, ry);
    ry = doc.y + 8;

    doc.moveTo(pmargin, ry).lineTo(pmargin + pw, ry).lineWidth(0.5).strokeColor('#cccccc').stroke();
    ry += 6;

    QUESTIONS.forEach((q, i) => {
      const key = `q${i + 1}`;
      const val = rec.answers ? rec.answers[key] : undefined;
      const label = answerLabel(val);
      const isNo = val === false;
      const finding = rec.findings && rec.findings[key];

      if (ry > doc.page.height - doc.page.margins.bottom - 60) {
        addFooter(doc, pageNum++);
        doc.addPage();
        ry = doc.page.margins.top;
      }

      const chipColor = label === 'YES' ? '#3aad5c' : label === 'NO' ? '#e05c3a' : '#6b7280';
      doc.rect(pmargin, ry, 28, 13).fill(chipColor);
      doc.fontSize(7.5).fillColor('#ffffff').font('Helvetica-Bold')
        .text(label, pmargin, ry + 2, { width: 28, align: 'center' });

      doc.fontSize(9).fillColor(isNo ? '#c0392b' : '#333333').font('Helvetica')
        .text(`${i + 1}. ${q}`, pmargin + 34, ry, { width: pw - 34 });
      ry = doc.y + 2;

      if (isNo && finding && finding.comment) {
        doc.fontSize(8).fillColor('#888888').font('Helvetica-Oblique')
          .text(`  Finding: ${finding.comment}`, pmargin + 34, ry, { width: pw - 34 });
        ry = doc.y + 2;
      }

      doc.moveTo(pmargin, ry).lineTo(pmargin + pw, ry).lineWidth(0.3).strokeColor('#eeeeee').stroke();
      ry += 4;
    });

    if (rec.notes) {
      ry += 4;
      doc.fontSize(8.5).fillColor('#555555').font('Helvetica-Bold').text('Notes:', pmargin, ry);
      ry = doc.y + 2;
      doc.fontSize(8.5).fillColor('#333333').font('Helvetica').text(rec.notes, pmargin, ry, { width: pw });
      ry = doc.y + 4;
    }

    addFooter(doc, pageNum++);
  });

  doc.end();
});

// GET /api/report/:id — single inspection PDF
app.get('/api/report/:id', (req, res) => {
  const { id } = req.params;
  const inspections = readInspections();
  const rec = inspections.find(r => r.id === id);
  if (!rec) return res.status(404).json({ error: 'Inspection not found' });

  const doc = new PDFDocument({ margin: 50, size: 'A4', autoFirstPage: true });
  res.setHeader('Content-Type', 'application/pdf');
  // Format date as DD.MM.YY
  const d = new Date(rec.timestamp);
  const dateStr = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getFullYear()).slice(2)}`;
  const safeName = `${rec.guardId}-${dateStr}-${rec.result}.pdf`.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  doc.pipe(res);
  buildSinglePDF(doc, rec, 1);
  doc.end();
});

// POST /api/photo
app.post('/api/photo', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ filename: req.file.filename });
});

// GET /api/archive
app.get('/api/archive', (req, res) => {
  res.json(readArchive());
});

// POST /api/archive/guard — body: { guardId, location, machine }
app.post('/api/archive/guard', (req, res) => {
  const { guardId, location, machine } = req.body;
  if (!guardId || !location || !machine) return res.status(400).json({ error: 'guardId, location, machine required' });

  // Remove from lists.json
  const lists = readLists();
  const loc = lists.locations.find(l => l.name === location);
  if (loc) {
    const mac = loc.machines.find(m => m.name === machine);
    if (mac) {
      mac.guards = mac.guards.filter(g => g !== guardId);
      writeLists(lists);
    }
  }

  // Mark inspections as archived
  const inspections = readInspections();
  let count = 0;
  inspections.forEach(r => {
    if (r.guardId === guardId && r.location === location && r.machine === machine) {
      r.archived = true;
      count++;
    }
  });
  writeInspections(inspections);

  // Add to archive.json
  const archive = readArchive();
  archive.guards = archive.guards.filter(g => !(g.guardId === guardId && g.location === location && g.machine === machine));
  archive.guards.push({
    guardId,
    location,
    machine,
    archivedAt: new Date().toISOString(),
    inspectionCount: count
  });
  writeArchive(archive);

  res.json({ success: true, archive, locations: lists.locations });
});

// POST /api/archive/restore — body: { guardId, location, machine }
app.post('/api/archive/restore', (req, res) => {
  const { guardId, location, machine } = req.body;
  if (!guardId || !location || !machine) return res.status(400).json({ error: 'guardId, location, machine required' });

  // Remove from archive.json
  const archive = readArchive();
  archive.guards = archive.guards.filter(g => !(g.guardId === guardId && g.location === location && g.machine === machine));
  writeArchive(archive);

  // Un-archive inspections
  const inspections = readInspections();
  inspections.forEach(r => {
    if (r.guardId === guardId && r.location === location && r.machine === machine) {
      delete r.archived;
    }
  });
  writeInspections(inspections);

  // Add back to lists.json
  const lists = readLists();
  let loc = lists.locations.find(l => l.name === location);
  if (!loc) {
    loc = { name: location, machines: [] };
    lists.locations.push(loc);
    lists.locations.sort((a, b) => a.name.localeCompare(b.name));
  }
  let mac = loc.machines.find(m => m.name === machine);
  if (!mac) {
    mac = { name: machine, guards: [] };
    loc.machines.push(mac);
    loc.machines.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (!mac.guards.includes(guardId)) {
    mac.guards.push(guardId);
    mac.guards.sort();
  }
  writeLists(lists);

  res.json({ success: true, archive, locations: lists.locations });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Guard Audit server running on http://0.0.0.0:${PORT}`);
});
// POST /api/archive/location
app.post('/api/archive/location', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const lists = readLists();
  const loc = lists.locations.find(l => l.name === name);
  const archive = readArchive();
  if (!archive.locations.find(l => l.name === name)) {
    archive.locations.push({ name, archivedAt: new Date().toISOString(), machineCount: loc ? loc.machines.length : 0 });
  }
  lists.locations = lists.locations.filter(l => l.name !== name);
  writeLists(lists);
  writeArchive(archive);
  res.json({ success: true });
});

// POST /api/archive/location/restore
app.post('/api/archive/location/restore', (req, res) => {
  const { name } = req.body;
  const archive = readArchive();
  archive.locations = archive.locations.filter(l => l.name !== name);
  const lists = readLists();
  if (!lists.locations.find(l => l.name === name)) {
    lists.locations.push({ name, machines: [] });
    lists.locations.sort((a, b) => a.name.localeCompare(b.name));
  }
  writeLists(lists);
  writeArchive(archive);
  res.json({ success: true });
});

// POST /api/archive/inspector
app.post('/api/archive/inspector', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const lists = readLists();
  const archive = readArchive();
  if (!archive.inspectors.find(i => i.name === name)) {
    archive.inspectors.push({ name, archivedAt: new Date().toISOString() });
  }
  lists.inspectors = lists.inspectors.filter(i => i !== name);
  writeLists(lists);
  writeArchive(archive);
  res.json({ success: true });
});

// POST /api/archive/inspector/restore
app.post('/api/archive/inspector/restore', (req, res) => {
  const { name } = req.body;
  const archive = readArchive();
  archive.inspectors = archive.inspectors.filter(i => i.name !== name);
  const lists = readLists();
  if (!lists.inspectors.includes(name)) {
    lists.inspectors.push(name);
    lists.inspectors.sort();
  }
  writeLists(lists);
  writeArchive(archive);
  res.json({ success: true });
});


