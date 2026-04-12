# Auditor App

Generic audit tool with template-based inspections, PDF reports, email notifications and work request tracking.

## Features

- Custom audit templates (questions, YES/NO/N/A, findings with photos)
- Location → Equipment → Component hierarchy
- Auto-named components (Type-Location-Equip-001)
- PDF reports with reference photos and finding photos
- Email failed inspections to planners (SMTP)
- Work request number tracking
- Status workflow: FAIL → WR Raised → Rectified
- Dashboard with clickable stat cards
- Archive system

## Requirements

- Node.js 18+
- npm

## Quick Start

```bash
# Install dependencies
npm install

# Start server (default port 3103)
node server.js
```

Open `http://localhost:3103` in your browser.

## Configuration

### Change Port
Edit `server.js` line 1: `const PORT = 3103;`

### Email (SMTP)
Go to **Setup → Email Server** in the app to configure SMTP settings.

### External URL (for WR email links)
In Setup → Email Server, set the **External URL** field to your public hostname, e.g.:
`http://yourdomain.com:3103`

## Data Files (auto-created on first run)

| File | Contents |
|------|----------|
| `inspections.json` | All inspection records |
| `lists.json` | Locations, equipment, components, inspectors, planners |
| `templates.json` | Audit templates |
| `archive.json` | Archived records |
| `emailConfig.json` | SMTP configuration |
| `photos/` | Uploaded photos |

## Deploy on a New Server

```bash
# Clone or copy the app folder
git clone <repo> auditor-app
cd auditor-app

# Install
npm install

# Run
node server.js

# Or with PM2 (recommended for production)
npm install -g pm2
pm2 start server.js --name auditor
pm2 save
pm2 startup
```

## Port Forwarding

If behind a router, forward the port (default 3103) to this machine's local IP.

## Built-in Templates

- **Machine Guard Audit** — AS/NZS 4024.1601:2014 (10 questions)
- **Gridmesh Inspection** — AS 1657-2018 (10 questions)

Add more templates via the app's Templates screen.
