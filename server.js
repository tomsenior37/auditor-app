const express = require('express');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const crypto = require('crypto');

const app = express();
const PORT = 3105;
const INSPECTIONS_FILE = path.join(__dirname, 'inspections.json');
const LISTS_FILE = path.join(__dirname, 'lists.json');
const ARCHIVE_FILE = path.join(__dirname, 'archive.json');
const TEMPLATES_FILE = path.join(__dirname, 'templates.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const ROLES_FILE = path.join(__dirname, 'roles.json');
const SESSION_SECRET_FILE = path.join(__dirname, '.session-secret');
const ANSWER_SETS_FILE = path.join(__dirname, 'answer-sets.json');
const EMAIL_CONFIG_FILE = path.join(__dirname, 'emailConfig.json');
const ASSETS_FILE = path.join(__dirname, 'assets.json');
const RECTS_FILE = path.join(__dirname, 'rectifications.json');
const PHOTOS_DIR = path.join(__dirname, 'photos');
const DOCS_DIR = path.join(__dirname, 'documents');
const TEMPLATE_MEDIA_DIR = path.join(__dirname, 'template-media');
const TEMPLATE_SOURCES_DIR = path.join(__dirname, 'template-sources');

// Ensure dirs exist
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
if (!fs.existsSync(TEMPLATE_MEDIA_DIR)) fs.mkdirSync(TEMPLATE_MEDIA_DIR, { recursive: true });
if (!fs.existsSync(TEMPLATE_SOURCES_DIR)) fs.mkdirSync(TEMPLATE_SOURCES_DIR, { recursive: true });

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTOS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '5mb' }));

// ── Auth: users & sessions ──────────────────────────────
function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}
function writeUsers(data) { fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), 'utf8'); }
function sanitizeUser(u) { const { passwordHash, ...rest } = u || {}; return rest; }

// ── Roles & permissions ──────────────────────────────────
const PERMISSION_KEYS = [
  'view_inspections', 'create_inspections', 'delete_inspections',
  'view_templates', 'edit_templates',
  'view_assets', 'edit_assets', 'import_assets',
  'view_rectifications', 'create_rectifications', 'edit_rectifications',
  'send_emails',
  'manage_settings'  // locations, machines, component types, response sets, email config
];
const ROLE_DEFAULTS = {
  admin: Object.fromEntries(PERMISSION_KEYS.map(k => [k, true])),
  planner: {
    view_inspections: true, create_inspections: true, delete_inspections: false,
    view_templates: true, edit_templates: true,
    view_assets: true, edit_assets: true, import_assets: true,
    view_rectifications: true, create_rectifications: true, edit_rectifications: true,
    send_emails: true,
    manage_settings: false
  },
  inspector: {
    view_inspections: true, create_inspections: true, delete_inspections: false,
    view_templates: true, edit_templates: false,
    view_assets: true, edit_assets: false, import_assets: false,
    view_rectifications: true, create_rectifications: true, edit_rectifications: false,
    send_emails: false,
    manage_settings: false
  }
};
function readRoles() {
  if (!fs.existsSync(ROLES_FILE)) { writeRoles(ROLE_DEFAULTS); return JSON.parse(JSON.stringify(ROLE_DEFAULTS)); }
  try {
    const r = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
    // Merge in any missing keys from defaults
    ['admin', 'planner', 'inspector'].forEach(role => {
      if (!r[role]) r[role] = {};
      PERMISSION_KEYS.forEach(k => { if (r[role][k] === undefined) r[role][k] = ROLE_DEFAULTS[role][k]; });
    });
    // Admin always has all
    PERMISSION_KEYS.forEach(k => r.admin[k] = true);
    return r;
  } catch { return JSON.parse(JSON.stringify(ROLE_DEFAULTS)); }
}
function writeRoles(data) { fs.writeFileSync(ROLES_FILE, JSON.stringify(data, null, 2), 'utf8'); }
function hasPermission(user, perm) {
  if (!user) return false;
  const roles = readRoles();
  return !!(roles[user.role] && roles[user.role][perm]);
}
function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!hasPermission(req.user, perm)) return res.status(403).json({ error: `Missing permission: ${perm}` });
    next();
  };
}

// Bootstrap: ensure a default admin exists if no users
(function bootstrapUsers() {
  const users = readUsers();
  if (!users.length) {
    users.push({
      id: uuidv4(),
      username: 'admin',
      role: 'admin',
      passwordHash: bcrypt.hashSync('admin', 10),
      mustChangePassword: true,
      createdAt: new Date().toISOString()
    });
    writeUsers(users);
    console.log('Bootstrapped default admin user: username "admin" / password "admin" (must change on first login)');
  }
})();

// Persist session secret across restarts
let SESSION_SECRET;
if (fs.existsSync(SESSION_SECRET_FILE)) {
  SESSION_SECRET = fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
} else {
  SESSION_SECRET = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SESSION_SECRET_FILE, SESSION_SECRET, { mode: 0o600 });
}

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 } // 12h
}));

// Routes that bypass auth: login + static assets + root HTML
const PUBLIC_PATHS = new Set(['/', '/api/auth/login', '/api/auth/me', '/api/auth/set-password', '/api/auth/logout']);
function isPublicPath(url) {
  if (PUBLIC_PATHS.has(url)) return true;
  // allow static asset prefixes
  if (url.startsWith('/photos/') || url.startsWith('/documents/') || url.startsWith('/template-media/') ||
      url.startsWith('/template-sources/') || url.startsWith('/docs/')) return true;
  return false;
}

// Require-auth middleware for all /api/* except the public ones
app.use((req, res, next) => {
  if (!req.url.startsWith('/api/')) return next();
  if (isPublicPath(req.url.split('?')[0])) return next();
  if (!req.session.userId) return res.status(401).json({ error: 'Authentication required' });
  // Reject user if flagged mustChangePassword except for the set-password route
  const u = readUsers().find(x => x.id === req.session.userId);
  if (!u) { req.session.destroy(() => {}); return res.status(401).json({ error: 'Session invalid' }); }
  req.user = u;
  next();
});

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

// ── Auth API ─────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, email, password } = req.body;
  const identifier = (email || username || '').toString().trim().toLowerCase();
  if (!identifier || !password) return res.status(400).json({ error: 'email and password required' });
  const users = readUsers();
  const u = users.find(x =>
    x.username.toLowerCase() === identifier ||
    (x.email && x.email.toLowerCase() === identifier)
  );
  if (!u || !bcrypt.compareSync(password, u.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  u.lastLogin = new Date().toISOString();
  writeUsers(users);
  req.session.userId = u.id;
  res.json({ success: true, user: sanitizeUser(u) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false });
  const u = readUsers().find(x => x.id === req.session.userId);
  if (!u) { req.session.destroy(() => {}); return res.json({ authenticated: false }); }
  const roles = readRoles();
  res.json({ authenticated: true, user: sanitizeUser(u), permissions: roles[u.role] || {} });
});

// ── Roles & Permissions API ─────────────────────────────
app.get('/api/roles', (req, res) => {
  res.json({ roles: readRoles(), permissionKeys: PERMISSION_KEYS });
});
app.put('/api/roles', requireRole('admin'), (req, res) => {
  const body = req.body || {};
  const current = readRoles();
  ['planner', 'inspector'].forEach(role => {
    if (body[role]) {
      PERMISSION_KEYS.forEach(k => {
        if (typeof body[role][k] === 'boolean') current[role][k] = body[role][k];
      });
    }
  });
  writeRoles(current);
  res.json({ success: true, roles: current });
});

app.post('/api/auth/set-password', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const { newPassword, currentPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const users = readUsers();
  const idx = users.findIndex(x => x.id === req.session.userId);
  if (idx === -1) return res.status(401).json({ error: 'User not found' });
  // If not first-login, verify current password
  if (!users[idx].mustChangePassword) {
    if (!currentPassword || !bcrypt.compareSync(currentPassword, users[idx].passwordHash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
  }
  users[idx].passwordHash = bcrypt.hashSync(newPassword, 10);
  users[idx].mustChangePassword = false;
  users[idx].passwordChangedAt = new Date().toISOString();
  writeUsers(users);
  res.json({ success: true });
});

// ── User Management (admin only) ─────────────────────────
app.get('/api/users', (req, res, next) => requireRole('admin')(req, res, next), (req, res) => {
  res.json(readUsers().map(sanitizeUser));
});

async function sendWelcomeEmail(user, initialPassword, appUrl) {
  const cfg = readEmailConfig();
  if (!cfg.host || !cfg.user || !user.email) return { sent: false, reason: 'email not configured or user has no email' };
  const transporter = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.password }
  });
  const loginUrl = (appUrl || cfg.externalUrl || '').replace(/\/$/, '');
  const safeUrl = loginUrl || '(your Auditor app URL)';
  await transporter.sendMail({
    from: `"${cfg.fromName || 'Auditor App'}" <${cfg.fromEmail || cfg.user}>`,
    to: `"${user.displayName || user.username}" <${user.email}>`,
    subject: `Your Auditor account has been created`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2 style="color:#01696f;">Welcome to Auditor 👋</h2>
        <p>An account has been created for you. You can now log in to run inspections, manage assets, and generate reports.</p>
        <table style="border-collapse:collapse;margin:18px 0;background:#f7f6f2;padding:12px;border-radius:8px;">
          <tr><td style="padding:6px 14px 6px 12px;color:#555;">Username</td><td style="padding:6px 0;"><strong>${user.username}</strong></td></tr>
          <tr><td style="padding:6px 14px 6px 12px;color:#555;">Role</td><td style="padding:6px 0;"><strong>${user.role}</strong></td></tr>
          <tr><td style="padding:6px 14px 6px 12px;color:#555;">Temporary password</td><td style="padding:6px 0;font-family:monospace;background:#fff3d6;padding:4px 10px;border-radius:4px;"><strong>${initialPassword}</strong></td></tr>
        </table>
        ${safeUrl !== '(your Auditor app URL)' ? `<p style="margin:18px 0;"><a href="${safeUrl}" style="display:inline-block;background:#01696f;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;">🔐 Open Auditor</a></p>` : ''}
        <h3 style="color:#01696f;">How to log in</h3>
        <ol>
          <li>Open the app at <strong>${safeUrl}</strong></li>
          <li>Enter your username and the temporary password above</li>
          <li>You'll be prompted to set a new password immediately — choose something at least 6 characters that only you know</li>
          <li>From then on, sign in with your new password</li>
        </ol>
        <p style="color:#666;font-size:13px;margin-top:20px;">If you didn't expect this email, you can safely ignore it. Contact your administrator if you have questions.</p>
      </div>`
  });
  return { sent: true };
}

app.post('/api/users', (req, res, next) => requireRole('admin')(req, res, next), async (req, res) => {
  const { role, password, email, displayName } = req.body;
  const cleanEmail = (email || '').trim();
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'Valid email is required' });
  if (!role || !['admin', 'planner', 'inspector'].includes(role)) return res.status(400).json({ error: 'invalid role' });
  const users = readUsers();
  if (users.find(u => (u.email && u.email.toLowerCase() === cleanEmail.toLowerCase()) || u.username.toLowerCase() === cleanEmail.toLowerCase())) {
    return res.status(400).json({ error: 'A user with that email already exists' });
  }
  const initial = password || Math.random().toString(36).slice(-10);
  const user = {
    id: uuidv4(),
    username: cleanEmail,
    email: cleanEmail,
    displayName: (displayName || cleanEmail.split('@')[0]).trim(),
    role,
    passwordHash: bcrypt.hashSync(initial, 10),
    mustChangePassword: true,
    createdAt: new Date().toISOString()
  };
  users.push(user);
  writeUsers(users);
  let emailResult = { sent: false };
  if (user.email) {
    try {
      const appUrl = `${req.protocol}://${req.get('host')}`;
      emailResult = await sendWelcomeEmail(user, initial, appUrl);
    } catch (e) {
      emailResult = { sent: false, reason: e.message };
    }
  }
  res.json({ success: true, initialPassword: initial, emailSent: emailResult.sent, emailError: emailResult.reason });
});

// Directory of users suitable for inspector/planner dropdowns (auth required, any role)
app.get('/api/users/public', (req, res) => {
  const users = readUsers().map(u => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName || u.username,
    email: u.email || '',
    role: u.role
  }));
  res.json(users);
});

async function sendPasswordResetEmail(user, newPassword, appUrl) {
  const cfg = readEmailConfig();
  if (!cfg.host || !cfg.user || !user.email) return { sent: false, reason: 'email not configured or user has no email' };
  const transporter = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.password }
  });
  const loginUrl = (appUrl || cfg.externalUrl || '').replace(/\/$/, '');
  const safeUrl = loginUrl || '(your Auditor app URL)';
  await transporter.sendMail({
    from: `"${cfg.fromName || 'Auditor App'}" <${cfg.fromEmail || cfg.user}>`,
    to: `"${user.displayName || user.username}" <${user.email}>`,
    subject: `Your Auditor password has been reset`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2 style="color:#01696f;">🔑 Password reset</h2>
        <p>An administrator has reset your Auditor password. Use the temporary password below to sign in — you'll be prompted to choose a new one immediately.</p>
        <table style="border-collapse:collapse;margin:18px 0;background:#f7f6f2;padding:12px;border-radius:8px;">
          <tr><td style="padding:6px 14px 6px 12px;color:#555;">Email</td><td style="padding:6px 0;"><strong>${user.email}</strong></td></tr>
          <tr><td style="padding:6px 14px 6px 12px;color:#555;">Temporary password</td><td style="padding:6px 0;font-family:monospace;background:#fff3d6;padding:4px 10px;border-radius:4px;"><strong>${newPassword}</strong></td></tr>
        </table>
        ${safeUrl !== '(your Auditor app URL)' ? `<p style="margin:18px 0;"><a href="${safeUrl}" style="display:inline-block;background:#01696f;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;">🔐 Sign in</a></p>` : ''}
        <p style="color:#666;font-size:13px;margin-top:20px;">If you didn't request this reset, contact your administrator immediately.</p>
      </div>`
  });
  return { sent: true };
}

app.put('/api/users/:id', (req, res, next) => requireRole('admin')(req, res, next), async (req, res) => {
  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const { role, resetPassword, email, displayName } = req.body;
  if (role && ['admin', 'planner', 'inspector'].includes(role)) users[idx].role = role;
  if (email !== undefined) users[idx].email = (email || '').trim();
  if (displayName !== undefined) users[idx].displayName = (displayName || '').trim();
  let initialPassword;
  let emailResult = { sent: false };
  if (resetPassword) {
    initialPassword = Math.random().toString(36).slice(-10);
    users[idx].passwordHash = bcrypt.hashSync(initialPassword, 10);
    users[idx].mustChangePassword = true;
    writeUsers(users);
    if (users[idx].email) {
      try {
        const appUrl = `${req.protocol}://${req.get('host')}`;
        emailResult = await sendPasswordResetEmail(users[idx], initialPassword, appUrl);
      } catch (e) { emailResult = { sent: false, reason: e.message }; }
    }
  } else {
    writeUsers(users);
  }
  res.json({ success: true, initialPassword, emailSent: emailResult.sent, emailError: emailResult.reason });
});

app.delete('/api/users/:id', (req, res, next) => requireRole('admin')(req, res, next), (req, res) => {
  if (req.user.id === req.params.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  const users = readUsers();
  const filtered = users.filter(u => u.id !== req.params.id);
  if (filtered.length === users.length) return res.status(404).json({ error: 'not found' });
  writeUsers(filtered);
  res.json({ success: true });
});
app.use('/photos', express.static(PHOTOS_DIR));
app.use('/docs', express.static(path.join(__dirname, 'docs')));
app.use('/template-media', express.static(TEMPLATE_MEDIA_DIR));

const templateMediaStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMPLATE_MEDIA_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${uuidv4()}${ext}`);
  }
});
const templateMediaUpload = multer({
  storage: templateMediaStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\//.test(file.mimetype) || file.mimetype === 'application/pdf';
    cb(ok ? null : new Error('Only images or PDFs are allowed'), ok);
  }
});

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
  if (!fs.existsSync(LISTS_FILE)) return { locations: [], inspectors: [], componentTypes: [] };
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
    if (!Array.isArray(data.componentTypes)) data.componentTypes = [];
    // Migrate string componentTypes to objects { name, fields }
    data.componentTypes = data.componentTypes.map(ct => typeof ct === 'string' ? { name: ct, fields: [] } : { name: ct.name, fields: Array.isArray(ct.fields) ? ct.fields : [] });
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

function readAssets() {
  if (!fs.existsSync(ASSETS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(ASSETS_FILE, 'utf8')); } catch { return {}; }
}

function writeAssets(data) {
  fs.writeFileSync(ASSETS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function assetKey(location, machine, component) {
  return [location || '', machine || '', component || ''].join('::');
}

function readRects() {
  if (!fs.existsSync(RECTS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(RECTS_FILE, 'utf8')); } catch { return []; }
}

function writeRects(data) {
  fs.writeFileSync(RECTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function nextRectId(rects) {
  const nums = rects.map(i => parseInt((i.id || '').replace('REC-', '')) || 0);
  return 'REC-' + String(Math.max(0, ...nums) + 1).padStart(4, '0');
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

app.post('/api/templates', requirePermission('edit_templates'), (req, res) => {
  const { name, standard, description, requiresComponent, componentType, questions, items, version, scoringEnabled } = req.body;
  if (!name || (!questions && !items)) return res.status(400).json({ error: 'name and questions required' });
  const data = readTemplates();
  const tpl = {
    id: 'tpl-' + uuidv4().slice(0, 8),
    name, standard: standard || '', description: description || '',
    requiresComponent: !!requiresComponent,
    componentType: componentType || '',
    questions: questions || [],
    ...(items ? { items, version: version || 2, scoringEnabled: !!scoringEnabled } : {}),
    createdAt: new Date().toISOString()
  };
  data.templates.push(tpl);
  writeTemplates(data);
  res.json({ success: true, template: tpl });
});

// Upload template from file (DOC, DOCX, XML, PDF, JSON)
app.post('/api/templates/upload', requirePermission('edit_templates'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  
  const fileBuffer = fs.readFileSync(req.file.path);
  const fileType = req.file.mimetype;
  const fileName = req.file.originalname.toLowerCase();
  
  try {
    let templateData;
    
    // Handle JSON files directly
    if (fileName.endsWith('.json')) {
      templateData = JSON.parse(fileBuffer.toString());
    }
    // Handle XML files
    else if (fileName.endsWith('.xml')) {
      const xml = require('xml2js').parseStringSync(fileBuffer.toString());
      templateData = xml.template || xml.Template || {};
    }
    // For DOC/DOCX/PDF, we'd need additional parsing libraries
    // For now, return an error suggesting JSON format
    else {
      return res.status(400).json({ 
        error: 'For now, only JSON template files are supported. Please convert your DOC/DOCX/PDF to JSON format first.' 
      });
    }
    
    // Validate and normalize the template
    if (!templateData.name || !templateData.questions) {
      return res.status(400).json({ error: 'Invalid template format: name and questions required' });
    }
    
    const data = readTemplates();
    const tpl = {
      id: 'tpl-' + uuidv4().slice(0, 8),
      name: templateData.name,
      standard: templateData.standard || '',
      description: templateData.description || '',
      requiresComponent: !!templateData.requiresComponent,
      componentType: templateData.componentType || '',
      questions: Array.isArray(templateData.questions) ? templateData.questions : [templateData.questions],
      ...(templateData.items ? {
        items: templateData.items,
        version: templateData.version || 2,
        scoringEnabled: !!templateData.scoringEnabled
      } : {}),
      createdAt: new Date().toISOString()
    };

    data.templates.push(tpl);
    writeTemplates(data);
    
    // Clean up uploaded file
    fs.unlinkSync(req.file.path);
    
    res.json({ success: true, template: tpl });
  } catch (err) {
    // Clean up uploaded file on error
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Failed to parse template file: ' + err.message });
  }
});

app.put('/api/templates/:id', requirePermission('edit_templates'), (req, res) => {
  const data = readTemplates();
  const idx = data.templates.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.templates[idx] = { ...data.templates[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  writeTemplates(data);
  res.json({ success: true, template: data.templates[idx] });
});

// ── Template source documents (upload for AI to turn into a template) ──
const templateSourceStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMPLATE_SOURCES_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_').slice(0, 80);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${stamp}__${safe}`);
  }
});
const templateSourceUpload = multer({ storage: templateSourceStorage, limits: { fileSize: 40 * 1024 * 1024 } });

app.use('/template-sources', express.static(TEMPLATE_SOURCES_DIR));

app.get('/api/template-sources', (req, res) => {
  const files = fs.readdirSync(TEMPLATE_SOURCES_DIR)
    .map(f => { const s = fs.statSync(path.join(TEMPLATE_SOURCES_DIR, f)); return { filename: f, size: s.size, uploadedAt: s.mtime }; })
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json({ files });
});

app.post('/api/template-sources', templateSourceUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    success: true,
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    serverPath: path.join(TEMPLATE_SOURCES_DIR, req.file.filename),
    url: '/template-sources/' + encodeURIComponent(req.file.filename)
  });
});

app.delete('/api/template-sources/:filename', (req, res) => {
  const safe = path.basename(req.params.filename);
  const p = path.join(TEMPLATE_SOURCES_DIR, safe);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  try { fs.unlinkSync(p); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/templates/media — upload an image or PDF to attach to a question
app.post('/api/templates/media', templateMediaUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const kind = req.file.mimetype === 'application/pdf' ? 'pdf' : 'image';
  res.json({
    success: true,
    filename: req.file.filename,
    url: '/template-media/' + req.file.filename,
    kind,
    originalName: req.file.originalname,
    size: req.file.size
  });
});

// DELETE /api/templates/media/:filename — delete an uploaded asset
app.delete('/api/templates/media/:filename', (req, res) => {
  const safe = path.basename(req.params.filename);
  const p = path.join(TEMPLATE_MEDIA_DIR, safe);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  try { fs.unlinkSync(p); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/templates/:id', requirePermission('edit_templates'), (req, res) => {
  const data = readTemplates();
  const idx = data.templates.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.templates.splice(idx, 1);
  writeTemplates(data);
  res.json({ success: true });
});

// ── Answer Sets (reusable multichoice option libraries) ────────────
function readAnswerSets() {
  if (!fs.existsSync(ANSWER_SETS_FILE)) return { sets: [] };
  try { return JSON.parse(fs.readFileSync(ANSWER_SETS_FILE, 'utf8')); }
  catch { return { sets: [] }; }
}
function writeAnswerSets(data) {
  fs.writeFileSync(ANSWER_SETS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

app.get('/api/answer-sets', (req, res) => res.json(readAnswerSets()));

app.post('/api/answer-sets', (req, res) => {
  const { name, options } = req.body;
  if (!name || !Array.isArray(options)) return res.status(400).json({ error: 'name and options required' });
  const data = readAnswerSets();
  const set = {
    id: uuidv4(),
    name,
    options: options.map(o => ({ id: o.id || uuidv4(), label: o.label || '', flagFail: !!o.flagFail, ...(o.score !== undefined ? { score: o.score } : {}) })),
    createdAt: new Date().toISOString()
  };
  data.sets.push(set);
  writeAnswerSets(data);
  res.json({ success: true, set });
});

app.put('/api/answer-sets/:id', (req, res) => {
  const data = readAnswerSets();
  const idx = data.sets.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const { name, options } = req.body;
  if (name !== undefined) data.sets[idx].name = name;
  if (Array.isArray(options)) {
    data.sets[idx].options = options.map(o => ({ id: o.id || uuidv4(), label: o.label || '', flagFail: !!o.flagFail, ...(o.score !== undefined ? { score: o.score } : {}) }));
  }
  data.sets[idx].updatedAt = new Date().toISOString();
  writeAnswerSets(data);
  res.json({ success: true, set: data.sets[idx] });
});

app.delete('/api/answer-sets/:id', (req, res) => {
  const data = readAnswerSets();
  const idx = data.sets.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.sets.splice(idx, 1);
  writeAnswerSets(data);
  res.json({ success: true });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// POST /api/inspection
// GET /wr — work request entry page
app.get('/wr', (req, res) => res.sendFile(path.join(__dirname, 'wr.html')));
app.get('/rect.html', (req, res) => res.sendFile(path.join(__dirname, 'rect.html')));

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

// PATCH /api/inspection/:id/archive — archive/unarchive inspection
app.patch('/api/inspection/:id/archive', (req, res) => {
  const inspections = readInspections();
  const idx = inspections.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  if (req.body.archived) {
    inspections[idx].archived = true;
    inspections[idx].archivedAt = new Date().toISOString();
  } else {
    delete inspections[idx].archived;
    delete inspections[idx].archivedAt;
  }
  writeInspections(inspections);
  res.json({ success: true });
});

// DELETE /api/inspection/:id — permanently delete (only if already archived)
app.delete('/api/inspection/:id', (req, res) => {
  const inspections = readInspections();
  const idx = inspections.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  if (!inspections[idx].archived) {
    return res.status(400).json({ error: 'must be archived before permanent deletion' });
  }
  inspections.splice(idx, 1);
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

// ── Component Types API ────────────────────────────
app.post('/api/lists/componentType', requireRole('admin'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const lists = readLists();
  if (!lists.componentTypes.find(t => t.name === name)) {
    lists.componentTypes.push({ name, fields: [] });
    lists.componentTypes.sort((a, b) => a.name.localeCompare(b.name));
    writeLists(lists);
  }
  res.json({ success: true, componentTypes: lists.componentTypes });
});

app.delete('/api/lists/componentType', requireRole('admin'), (req, res) => {
  const name = (req.body.name || '').trim();
  const lists = readLists();
  lists.componentTypes = lists.componentTypes.filter(t => t.name !== name);
  writeLists(lists);
  res.json({ success: true, componentTypes: lists.componentTypes });
});

// Update the custom-fields schema on a component type
app.put('/api/lists/componentType/fields', requireRole('admin'), (req, res) => {
  const { name, fields } = req.body;
  if (!name || !Array.isArray(fields)) return res.status(400).json({ error: 'name and fields[] required' });
  const lists = readLists();
  const t = lists.componentTypes.find(t => t.name === name);
  if (!t) return res.status(404).json({ error: 'not found' });
  t.fields = fields.filter(f => f && f.key && f.label).map(f => ({
    key: String(f.key).replace(/[^\w]+/g, '_').toLowerCase(),
    label: String(f.label).slice(0, 100),
    type: ['text', 'number', 'date', 'select'].includes(f.type) ? f.type : 'text',
    ...(f.type === 'select' && Array.isArray(f.options) ? { options: f.options.map(String) } : {})
  }));
  writeLists(lists);
  res.json({ success: true, componentType: t });
});

// ── Asset Import API ──────────────────────────────────
app.post('/api/import/assets', (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries array required' });
  const lists = readLists();
  let locCount = 0, macCount = 0, compCount = 0;
  entries.forEach(({ location, machine, component }) => {
    if (!location) return;
    let loc = lists.locations.find(l => l.name === location);
    if (!loc) {
      loc = { name: location, machines: [] };
      lists.locations.push(loc);
      locCount++;
    }
    if (machine) {
      let mac = loc.machines.find(m => (typeof m === 'string' ? m : m.name) === machine);
      if (!mac) {
        mac = { name: machine, guards: [] };
        loc.machines.push(mac);
        macCount++;
      } else if (typeof mac === 'string') {
        const idx = loc.machines.indexOf(mac);
        mac = { name: mac, guards: [] };
        loc.machines[idx] = mac;
      }
      if (component && !mac.guards.includes(component)) {
        mac.guards.push(component);
        compCount++;
      }
    }
  });
  lists.locations.sort((a, b) => a.name.localeCompare(b.name));
  writeLists(lists);
  res.json({ success: true, locations: lists.locations, stats: { locations: locCount, machines: macCount, components: compCount } });
});

// ── Asset Database API ─────────────────────────────────
// Summary of all asset metadata — used by the assets list to show main photos + status
app.get('/api/assets/meta-summary', (req, res) => {
  const assets = readAssets();
  const out = {};
  Object.keys(assets).forEach(k => {
    const a = assets[k];
    out[k] = {
      status: a.status || 'active',
      photo: (a.photos && a.photos[0]) ? a.photos[0].filename : null,
      componentType: a.componentType || ''
    };
  });
  res.json(out);
});

// Get metadata for a specific asset (enriched with last inspection + overdue flag)
app.get('/api/asset/meta', (req, res) => {
  const { location, machine, component } = req.query;
  const key = assetKey(location, machine, component);
  const assets = readAssets();
  const meta = assets[key] || { description: '', notes: '', status: 'active', photos: [], documents: [] };
  // Enrich with last inspection timestamp
  try {
    const inspections = readInspections()
      .filter(i => !i.archived)
      .filter(i => (!location || i.location === location) && (!machine || i.machine === machine) && (!component || i.guardId === component))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    if (inspections.length) meta.lastInspectedAt = inspections[0].timestamp;
    if (meta.schedule && meta.schedule.intervalDays && meta.lastInspectedAt) {
      const d = new Date(meta.lastInspectedAt);
      d.setDate(d.getDate() + parseInt(meta.schedule.intervalDays, 10));
      meta.schedule.nextDueDate = d.toISOString().slice(0, 10);
      meta.schedule.isOverdue = new Date(meta.schedule.nextDueDate) < new Date();
      const ms = new Date(meta.schedule.nextDueDate) - new Date();
      meta.schedule.daysUntilDue = Math.round(ms / 86400000);
    }
  } catch {}
  res.json(meta);
});

// Save metadata for a specific asset
app.post('/api/asset/meta', (req, res) => {
  const { location, machine, component, description, notes, status, componentType, customFields, schedule } = req.body;
  const key = assetKey(location, machine, component);
  const assets = readAssets();
  if (!assets[key]) assets[key] = { description: '', notes: '', status: 'active', photos: [], documents: [], createdAt: new Date().toISOString() };
  if (description !== undefined) assets[key].description = description;
  if (notes !== undefined) assets[key].notes = notes;
  if (status !== undefined) assets[key].status = status;
  if (componentType !== undefined) assets[key].componentType = componentType;
  if (customFields !== undefined) assets[key].customFields = customFields;
  if (schedule !== undefined) assets[key].schedule = schedule;
  // Auto-compute nextDue from lastInspected + intervalDays
  if (assets[key].schedule && assets[key].schedule.intervalDays) {
    const last = assets[key].schedule.lastInspectedAt || assets[key].createdAt;
    const d = new Date(last);
    d.setDate(d.getDate() + parseInt(assets[key].schedule.intervalDays, 10));
    assets[key].schedule.nextDueDate = d.toISOString().slice(0, 10);
  }
  assets[key].updatedAt = new Date().toISOString();
  writeAssets(assets);
  res.json({ success: true, meta: assets[key] });
});

// QR code for an asset (PNG)
const QRCode = require('qrcode');
app.get('/api/asset/qr', async (req, res) => {
  try {
    const { location, machine, component, url } = req.query;
    const target = url || `/?asset=${encodeURIComponent(location || '')}|${encodeURIComponent(machine || '')}|${encodeURIComponent(component || '')}`;
    const absolute = target.startsWith('http') ? target : `${req.protocol}://${req.get('host')}${target}`;
    res.setHeader('Content-Type', 'image/png');
    await QRCode.toFileStream(res, absolute, { width: 400, margin: 1, errorCorrectionLevel: 'M' });
  } catch (e) { res.status(500).send(e.message); }
});

// Upload photo to an asset
app.post('/api/asset/photo', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const key = assetKey(req.body.location, req.body.machine, req.body.component);
  const assets = readAssets();
  if (!assets[key]) assets[key] = { description: '', notes: '', status: 'active', photos: [], documents: [], createdAt: new Date().toISOString() };
  assets[key].photos.push({ filename: req.file.filename, originalName: req.file.originalname, uploadedAt: new Date().toISOString() });
  writeAssets(assets);
  res.json({ success: true, photo: req.file.filename, meta: assets[key] });
});

// Delete photo from asset
app.delete('/api/asset/photo', (req, res) => {
  const key = assetKey(req.body.location, req.body.machine, req.body.component);
  const assets = readAssets();
  if (assets[key]) {
    assets[key].photos = (assets[key].photos || []).filter(p => p.filename !== req.body.filename);
    writeAssets(assets);
  }
  res.json({ success: true });
});

// Upload document to an asset
const docUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DOCS_DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.post('/api/asset/document', docUpload.single('document'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const key = assetKey(req.body.location, req.body.machine, req.body.component);
  const assets = readAssets();
  if (!assets[key]) assets[key] = { description: '', notes: '', status: 'active', photos: [], documents: [], createdAt: new Date().toISOString() };
  assets[key].documents.push({ filename: req.file.filename, originalName: req.file.originalname, size: req.file.size, uploadedAt: new Date().toISOString() });
  writeAssets(assets);
  res.json({ success: true, document: req.file.filename, meta: assets[key] });
});

// Delete document from asset
app.delete('/api/asset/document', (req, res) => {
  const key = assetKey(req.body.location, req.body.machine, req.body.component);
  const assets = readAssets();
  if (assets[key]) {
    assets[key].documents = (assets[key].documents || []).filter(d => d.filename !== req.body.filename);
    writeAssets(assets);
  }
  // Try to delete the file
  try { fs.unlinkSync(path.join(DOCS_DIR, req.body.filename)); } catch {}
  res.json({ success: true });
});

// Serve documents
app.use('/documents', express.static(DOCS_DIR));

// ── Asset CSV import / export ─────────────────────────────
function csvParse(text) {
  const rows = [];
  let cur = [''], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { cur[cur.length - 1] += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else cur[cur.length - 1] += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') cur.push('');
      else if (c === '\r') {}
      else if (c === '\n') { rows.push(cur); cur = ['']; }
      else cur[cur.length - 1] += c;
    }
  }
  if (cur.length > 1 || cur[0]) rows.push(cur);
  return rows;
}
function csvStringify(rows) {
  return rows.map(r => r.map(v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
}

// GET /api/assets/export.csv — full register dump
app.get('/api/assets/export.csv', (req, res) => {
  const assets = readAssets();
  const header = ['location', 'machine', 'component', 'componentType', 'status', 'description', 'notes',
    'frequencyDays', 'nextDueDate', 'lastInspectedAt', 'customFields'];
  const rows = [header];
  Object.keys(assets).forEach(k => {
    const [loc, mac, comp] = k.split('::');
    const a = assets[k];
    rows.push([
      loc, mac, comp,
      a.componentType || '',
      a.status || 'active',
      a.description || '',
      a.notes || '',
      a.schedule?.intervalDays || '',
      a.schedule?.nextDueDate || '',
      a.lastInspectedAt || '',
      a.customFields ? JSON.stringify(a.customFields) : ''
    ]);
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="assets.csv"');
  res.send(csvStringify(rows));
});

// POST /api/assets/import-csv — accept CSV text in body { csv: "..." }
app.post('/api/assets/import-csv', (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'csv body required' });
  const rows = csvParse(csv).filter(r => r.some(c => (c || '').trim()));
  if (rows.length < 2) return res.status(400).json({ error: 'need header + at least one row' });
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iLoc = col('location'), iMac = col('machine'), iComp = col('component');
  if (iLoc < 0 || iMac < 0 || iComp < 0) return res.status(400).json({ error: 'header must include location, machine, component' });
  const lists = readLists();
  const assets = readAssets();
  let newLoc = 0, newMac = 0, newComp = 0, updated = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const location = (r[iLoc] || '').trim();
    const machine = (r[iMac] || '').trim();
    const component = (r[iComp] || '').trim();
    if (!location || !machine || !component) continue;
    // Ensure location/machine/guard exist
    let loc = lists.locations.find(l => l.name === location);
    if (!loc) { loc = { name: location, machines: [] }; lists.locations.push(loc); newLoc++; }
    let mac = loc.machines.find(m => m.name === machine);
    if (!mac) { mac = { name: machine, guards: [] }; loc.machines.push(mac); newMac++; }
    if (!mac.guards.includes(component)) { mac.guards.push(component); newComp++; }
    // Upsert asset meta
    const key = assetKey(location, machine, component);
    const existing = assets[key] || { photos: [], documents: [], createdAt: new Date().toISOString() };
    const get = (name) => { const idx = col(name); return idx >= 0 ? (r[idx] || '').trim() : ''; };
    const ct = get('componenttype'); if (ct) existing.componentType = ct;
    const st = get('status'); if (st) existing.status = st;
    const desc = get('description'); if (desc) existing.description = desc;
    const notes = get('notes'); if (notes) existing.notes = notes;
    const freq = parseInt(get('frequencydays'), 10);
    if (freq) existing.schedule = { ...(existing.schedule || {}), intervalDays: freq };
    const cf = get('customfields');
    if (cf) { try { existing.customFields = { ...(existing.customFields || {}), ...JSON.parse(cf) }; } catch {} }
    // Also support bare custom-field columns — anything not in the known set becomes a customField
    const known = new Set(['location','machine','component','componenttype','status','description','notes','frequencydays','nextduedate','lastinspectedat','customfields']);
    header.forEach((h, idx) => {
      if (!known.has(h) && (r[idx] || '').trim()) {
        if (!existing.customFields) existing.customFields = {};
        existing.customFields[h] = r[idx].trim();
      }
    });
    existing.updatedAt = new Date().toISOString();
    assets[key] = existing;
    updated++;
  }
  writeLists(lists);
  writeAssets(assets);
  res.json({ success: true, stats: { rows: rows.length - 1, updated, newLocations: newLoc, newMachines: newMac, newComponents: newComp } });
});

// ── Dashboard KPIs ────────────────────────────────────────
app.get('/api/dashboard/kpis', (req, res) => {
  const assets = readAssets();
  const inspections = readInspections().filter(i => !i.archived);
  const now = new Date(), thirtyDaysAgo = new Date(now - 30 * 86400000);

  // Build latest-inspection lookup per component
  const latestByKey = {};
  inspections.forEach(i => {
    const k = [i.location || '', i.machine || '', i.guardId || ''].join('::');
    if (!latestByKey[k] || new Date(i.timestamp) > new Date(latestByKey[k].timestamp)) latestByKey[k] = i;
  });

  let overdueCount = 0;
  const overdueAssets = [];
  Object.keys(assets).forEach(k => {
    const a = assets[k];
    if (a.status === 'decommissioned') return;
    const interval = a.schedule?.intervalDays;
    if (!interval) return;
    const last = latestByKey[k]?.timestamp || a.createdAt;
    const due = new Date(last); due.setDate(due.getDate() + parseInt(interval, 10));
    if (due < now) {
      overdueCount++;
      const [loc, mac, comp] = k.split('::');
      overdueAssets.push({ location: loc, machine: mac, component: comp, nextDue: due.toISOString().slice(0, 10), lastInspectedAt: last });
    }
  });
  overdueAssets.sort((a, b) => new Date(a.nextDue) - new Date(b.nextDue));

  const recent = inspections.filter(i => new Date(i.timestamp) >= thirtyDaysAgo);
  const failures30 = recent.filter(i => i.result === 'FAIL').length;
  const passes30 = recent.filter(i => i.result === 'PASS').length;

  // Top failing components
  const failCounts = {};
  inspections.filter(i => i.result === 'FAIL').forEach(i => {
    const k = [i.location || '', i.machine || '', i.guardId || ''].join('::');
    failCounts[k] = (failCounts[k] || 0) + 1;
  });
  const topFailing = Object.entries(failCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, count]) => {
      const [loc, mac, comp] = k.split('::');
      return { location: loc, machine: mac, component: comp, count };
    });

  res.json({
    totalAssets: Object.keys(assets).length,
    activeAssets: Object.values(assets).filter(a => (a.status || 'active') === 'active').length,
    overdueCount,
    overdueAssets: overdueAssets.slice(0, 10),
    failures30,
    passes30,
    recentInspections: recent.length,
    topFailing
  });
});

// Get inspection history for an asset
app.get('/api/asset/history', (req, res) => {
  const { location, machine, component } = req.query;
  const inspections = readInspections();
  const filtered = inspections.filter(r => {
    if (location && r.location !== location) return false;
    if (machine && r.machine !== machine) return false;
    if (component && r.guardId !== component && r.componentId !== component) return false;
    return true;
  });
  res.json(filtered);
});

// ── Rectifications API ───────────────────────────────
app.get('/api/rectifications', (req, res) => {
  res.json(readRects());
});

app.get('/api/rectifications/:id', (req, res) => {
  const rects = readRects();
  const rect = rects.find(i => i.id === req.params.id);
  if (!rect) return res.status(404).json({ error: 'Not found' });
  res.json(rect);
});

app.post('/api/rectifications', (req, res) => {
  const rects = readRects();
  const id = nextRectId(rects);
  const rect = {
    id,
    inspectionId: req.body.inspectionId || null,
    templateName: req.body.templateName || '',
    title: req.body.title || 'Untitled Rectification',
    description: req.body.description || '',
    location: req.body.location || '',
    machine: req.body.machine || '',
    component: req.body.component || '',
    status: 'open',
    priority: req.body.priority || 'medium',
    assignedTo: req.body.assignedTo || null,
    createdBy: req.body.createdBy || '',
    createdAt: new Date().toISOString(),
    dueDate: req.body.dueDate || null,
    resolvedAt: null,
    workOrderNumber: '',
    photos: req.body.photos || [],
    lineItems: req.body.lineItems || [],
    findings: req.body.findings || {},
    comments: [],
    history: [{ action: 'created', by: req.body.createdBy || 'System', at: new Date().toISOString() }]
  };
  rects.unshift(rect);
  writeRects(rects);
  res.json({ success: true, rect });
});

app.patch('/api/rectifications/:id', (req, res) => {
  const rects = readRects();
  const idx = rects.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const rect = rects[idx];
  const changes = req.body;
  const by = changes._updatedBy || 'System';
  delete changes._updatedBy;

  // Track status changes in history
  if (changes.status && changes.status !== rect.status) {
    rect.history.push({ action: 'status_changed', from: rect.status, to: changes.status, by, at: new Date().toISOString() });
    if (changes.status === 'resolved' || changes.status === 'closed') {
      rect.resolvedAt = new Date().toISOString();
    }
  }
  if (changes.assignedTo && (!rect.assignedTo || changes.assignedTo.email !== rect.assignedTo.email)) {
    rect.history.push({ action: 'assigned', to: changes.assignedTo.name, by, at: new Date().toISOString() });
  }
  if (changes.priority && changes.priority !== rect.priority) {
    rect.history.push({ action: 'priority_changed', from: rect.priority, to: changes.priority, by, at: new Date().toISOString() });
  }

  Object.assign(rect, changes);
  rect.updatedAt = new Date().toISOString();
  writeRects(rects);
  res.json({ success: true, rect });
});

app.post('/api/rectifications/:id/comment', (req, res) => {
  const rects = readRects();
  const rect = rects.find(i => i.id === req.params.id);
  if (!rect) return res.status(404).json({ error: 'Not found' });
  const comment = {
    id: uuidv4().slice(0, 8),
    author: req.body.author || 'Unknown',
    text: req.body.text || '',
    timestamp: new Date().toISOString()
  };
  rect.comments.push(comment);
  rect.history.push({ action: 'comment_added', by: comment.author, at: comment.timestamp });
  rect.updatedAt = new Date().toISOString();
  writeRects(rects);
  res.json({ success: true, comment, rect });
});

app.post('/api/rectifications/:id/photo', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const rects = readRects();
  const rect = rects.find(i => i.id === req.params.id);
  if (!rect) return res.status(404).json({ error: 'Not found' });
  rect.photos.push({ filename: req.file.filename, originalName: req.file.originalname, uploadedAt: new Date().toISOString() });
  rect.updatedAt = new Date().toISOString();
  writeRects(rects);
  res.json({ success: true, photo: req.file.filename, rect });
});

app.delete('/api/rectifications/:id', (req, res) => {
  let rects = readRects();
  rects = rects.filter(i => i.id !== req.params.id);
  writeRects(rects);
  res.json({ success: true });
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
  const { inspectionId, plannerEmail, plannerName, rectId } = req.body;
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
        <p style="margin-bottom:16px;">Raise a work request in your maintenance system to rectify the identified defects. Use the links below to update the rectification status.</p>
        ${rectId ? `<p style="margin-bottom:16px;"><a href="${cfg.externalUrl}/rect.html?id=${rectId}" style="display:inline-block;background:#e05c3a;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;">⚠️ View Rectification ${rectId}</a></p>` : ''}
        <p style="margin-bottom:24px;"><a href="${cfg.externalUrl}/wr?id=${insp.id}" style="display:inline-block;background:#ff9800;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;">&#128295; Input Work Request Number</a></p>
        <p style="font-size:12px;color:#888;">Use the rectification link to update status, enter work order number and completion date to close out the work.<br><br>This email was sent from the Auditor inspection app.</p>
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


