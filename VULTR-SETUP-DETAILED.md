# ManyChat Clicker – Detailed Vultr Setup (Copy-Paste Deployment)

This guide assumes you **copy-paste** `server.js` and other project files onto a Vultr server (no Git). It covers both **Windows Server** and **Ubuntu**. Use the section that matches your Vultr image.

---

## Part A: What to Copy to the Server

### Required files (must be on the server)

| File or folder | Purpose |
|----------------|--------|
| `server.js` | Main application (Node.js + Express + Playwright) |
| `package.json` | Dependencies (express, playwright, dotenv, p-queue, adm-zip) |
| `.env.example` | Template for environment variables (you will rename/copy to `.env`) |
| `manual-login.js` | One-time ManyChat login (saves session into `data/user-data`) |
| `data` (folder) | Create an **empty** folder `data/user-data` on the server. Do **not** copy your local `data/user-data` contents unless you want to reuse your existing ManyChat session (see note below). |

### Optional but recommended (for production)

| File or folder | Purpose |
|----------------|--------|
| `start-production.ps1` | Windows: starts Node + Cloudflare tunnel (minimized windows) |
| `setup-tunnel.ps1` | Windows: one-time setup for **named** Cloudflare tunnel (e.g. manychat-followupsv2.setty.ai) |

### Do NOT copy

- `node_modules` (you will run `npm install` on the server)
- `.git` (not needed for copy-paste deploy)
- Any `*.png` under `data/` (error screenshots; safe to omit)

### Optional: Reuse existing ManyChat session

If you already have a working login on your PC and want the **same** session on Vultr:

1. On your **local PC**: zip the contents of `data/user-data` (the whole folder, so the zip contains a `user-data` folder with subfolders like `Default`, `Local State`, etc.).
2. On the **server**: create `data` and place the zip there (e.g. `data/user-data-backup.zip`).
3. Later in the guide you’ll use the app’s **upload session** feature (or manually extract the zip into `data/user-data`) so the server uses that profile.  
If you don’t do this, you’ll do a **fresh ManyChat login** on the server (manual-login.js or `/init-login`).

---

## Part B: Create the Vultr Server

1. Log in to [vultr.com](https://vultr.com) → **Deploy New Server**.
2. **Server type:** Cloud Compute – Shared CPU (or similar).
3. **Location:** Choose a region close to you or your users.
4. **Image:**
   - **Option 1 – Windows:** Windows Server 2022.  
     - Size: at least **2 vCPU / 4 GB RAM** (e.g. $24/mo).  
     - You’ll use **RDP** and run PowerShell scripts.
   - **Option 2 – Linux:** Ubuntu 22.04 LTS.  
     - Same size. You’ll use **SSH** and run Node with **PM2**.
5. **Hostname:** e.g. `manychat-clicker`.
6. Deploy and wait until the server is **Running**. Note:
   - **IP address**
   - **Password** (show via the eye icon in the Vultr dashboard).

---

# Path 1: Windows Server on Vultr

Use this if you chose **Windows Server 2022**.

---

## 1. Connect to the server (RDP)

- **From Windows:** `Win + R` → `mstsc` → enter the server **IP** → Connect.  
  Login: user `Administrator`, password from Vultr.
- **From Mac:** Install “Microsoft Remote Desktop” → Add PC with that IP, then connect with the same credentials.

---

## 2. Initial Windows setup (one time)

### 2.1 Disable IE Enhanced Security

- Open **Server Manager** → **Local Server** → **IE Enhanced Security Configuration** → set to **Off** for Administrators and Users.

### 2.2 Install Node.js (LTS)

1. In the server, open a browser and go to [https://nodejs.org](https://nodejs.org).
2. Download the **LTS** version (e.g. 20.x), run the installer.
3. Use default options; if it offers “Automatically install necessary tools”, leave it checked.
4. **Close and reopen PowerShell** (or RDP session) so `node` and `npm` are in PATH.
5. Verify:
   ```powershell
   node --version
   npm --version
   ```
   You should see e.g. `v20.x.x` and `10.x.x`.

---

## 3. Create the project folder and copy files

### 3.1 Create folder

```powershell
mkdir C:\manychat-clicker
cd C:\manychat-clicker
```

### 3.2 Copy your files into `C:\manychat-clicker`

Copy from your PC into this folder (via RDP copy-paste, or zip + upload + extract):

- `server.js`
- `package.json`
- `.env.example` (you’ll rename to `.env` and edit)
- `manual-login.js`
- `start-production.ps1` (recommended)
- `setup-tunnel.ps1` (recommended if you use a named Cloudflare tunnel)

### 3.3 Create data directory for browser profile

```powershell
mkdir C:\manychat-clicker\data
mkdir C:\manychat-clicker\data\user-data
```

(If you brought a zip of `user-data`, extract it so that `C:\manychat-clicker\data\user-data` contains folders like `Default` and file `Local State`; otherwise leave `user-data` empty for a fresh login.)

---

## 4. Install dependencies and Playwright browsers

```powershell
cd C:\manychat-clicker
npm install
npx playwright install chromium
```

If `playwright install` asks to install system dependencies, accept. This installs Chromium so the app can drive the browser.

---

## 5. Configure environment (.env)

```powershell
copy .env.example .env
notepad .env
```

Edit `.env` so it has at least:

```env
AUTH_TOKEN=your-secret-token-here
PORT=3000
USER_DATA_DIR=C:\manychat-clicker\data\user-data
HEADLESS=false
USE_SINGLE_CONTEXT=true
SINGLE_CONTEXT_MAX_TABS=4
```

- **AUTH_TOKEN:** Pick a long random string; callers must send `Authorization: Bearer your-secret-token-here` to use the API.
- **USER_DATA_DIR:** Must match where you created the profile folder (`C:\manychat-clicker\data\user-data`).
- **HEADLESS=false:** So ManyChat sees a real browser (recommended on Windows with a visible session).
- Save and close Notepad.

---

## 6. First-time ManyChat login (if you didn’t bring a session)

If `data/user-data` is empty or you want to log in again:

```powershell
cd C:\manychat-clicker
node manual-login.js
```

A Chrome window will open. Log in to ManyChat, wait until you see the dashboard, then go back to the PowerShell window and press **Enter**. The session is saved in `data/user-data`.

---

## 7. Cloudflare Tunnel (named tunnel – your permanent URL)

You said you have a **named Cloudflare tunnel** already. On the **Vultr Windows** server you need `cloudflared` and the tunnel config.

### 7.1 Download cloudflared (Windows)

```powershell
cd C:\manychat-clicker
Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "cloudflared.exe"
.\cloudflared.exe version
```

### 7.2 One-time tunnel setup (if not already done)

If the tunnel is **already** set up (e.g. from another machine), you only need the **credentials and config** on this server:

- Copy the JSON credentials file (from the machine where you ran `cloudflared tunnel create`) into `%USERPROFILE%\.cloudflared\` (e.g. `C:\Users\Administrator\.cloudflared\`).
- Ensure `%USERPROFILE%\.cloudflared\config.yml` exists and points to `http://localhost:3000` for your hostname (e.g. manychat-followupsv2.setty.ai). Example:

```yaml
tunnel: manychat-clicker
credentials-file: C:\Users\Administrator\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: manychat-followupsv2.setty.ai
    service: http://localhost:3000
  - service: http_status:404
```

If you **haven’t** created the tunnel yet, run the script (adjust domain inside if needed):

```powershell
cd C:\manychat-clicker
.\setup-tunnel.ps1
```

Follow the prompts (Cloudflare login in browser, create tunnel, route DNS). The script creates the config for `manychat-followupsv2.setty.ai` → `http://localhost:3000`.

---

## 8. Start the app and tunnel (Windows)

```powershell
cd C:\manychat-clicker
.\start-production.ps1
```

This will:

1. Kill any existing `node.exe` and `cloudflared.exe`.
2. Set `HEADLESS=false` in the environment and in `.env`.
3. Start **Node** in a **minimized** PowerShell window (server on port 3000).
4. Start **cloudflared** (named tunnel if config exists, otherwise quick tunnel).

Keep both windows running (you can minimize them). Your API will be at:

- **Named tunnel:** `https://manychat-followupsv2.setty.ai` (or whatever hostname you set in `.cloudflared\config.yml`).

---

## 9. Test the API (from your PC or Postman)

```powershell
$body = @{
  type   = "text"
  chatId = "YOUR_CHAT_ID"
  message = "Test from Vultr"
  pageId  = "YOUR_PAGE_ID"
} | ConvertTo-Json

Invoke-WebRequest -Uri "https://manychat-followupsv2.setty.ai/press" `
  -Method POST `
  -Body $body `
  -ContentType "application/json" `
  -Headers @{ Authorization = "Bearer your-secret-token-here" }
```

Use the same `AUTH_TOKEN` you put in `.env`. If you get a JSON response with `"ok": true`, the server and tunnel are working.

---

## 10. Auto-start after reboot (Windows – Task Scheduler)

So the app and tunnel start after a server reboot:

1. **Task Scheduler** → **Create Task** (not “Create Basic Task”).
2. **General:** Name e.g. “ManyChat Clicker Startup”. Run with highest privileges. “Run whether user is logged on or not” (optional; if you use “only when user is logged on”, you must stay logged in for the task to run).
3. **Triggers:** New → **At startup** → Delay task for **1 minute** → OK.
4. **Actions:** New → **Start a program**  
   - Program: `powershell.exe`  
   - Arguments: `-ExecutionPolicy Bypass -File C:\manychat-clicker\start-production.ps1`  
   - Start in: `C:\manychat-clicker`  
   → OK.
5. **Conditions:** Uncheck “Start the task only if the computer is on AC power”.
6. **Settings:** “Allow task to be run on demand”; “If running task does not end: Do not start a new instance”.
7. OK and enter the Administrator password if prompted.

After a reboot, wait 1–2 minutes and check that the minimized Node and cloudflared windows are running and that the API URL responds.

---

# Path 2: Ubuntu on Vultr

Use this if you chose **Ubuntu 22.04**.

---

## 1. Connect to the server (SSH)

From your PC (PowerShell or terminal):

```bash
ssh root@YOUR_SERVER_IP
```

Use the password from Vultr (or your SSH key). Optionally create a non-root user; the steps below use `root` and paths under `/opt/manychat-clicker`.

---

## 2. Install Node.js (LTS) and PM2

```bash
apt update && apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version
npm --version
npm install -g pm2
```

---

## 3. Create project directory and copy files

```bash
mkdir -p /opt/manychat-clicker
cd /opt/manychat-clicker
```

Copy your project files into `/opt/manychat-clicker` (e.g. from your PC with `scp`):

```bash
# From your PC (run in PowerShell or another terminal, not on Vultr):
scp server.js package.json .env.example manual-login.js root@YOUR_SERVER_IP:/opt/manychat-clicker/
```

Then on the server:

```bash
mkdir -p /opt/manychat-clicker/data/user-data
cd /opt/manychat-clicker
npm install
npx playwright install chromium
npx playwright install-deps
```

---

## 4. Configure .env (Ubuntu)

```bash
cd /opt/manychat-clicker
cp .env.example .env
nano .env
```

Set at least:

```env
AUTH_TOKEN=your-secret-token-here
PORT=3000
NODE_ENV=production
USER_DATA_DIR=/opt/manychat-clicker/data/user-data
HEADLESS=true
USE_SINGLE_CONTEXT=true
SINGLE_CONTEXT_MAX_TABS=4
```

On Linux the app defaults to `USER_DATA_DIR=/data/user-data` when `NODE_ENV=production`; by setting `USER_DATA_DIR=/opt/manychat-clicker/data/user-data` you keep everything under one folder. Save (Ctrl+O, Enter) and exit (Ctrl+X).

---

## 5. First-time ManyChat login (Ubuntu – headless or with virtual display)

- **Option A – Upload session from Windows:** If you already did a login on your PC, zip `data/user-data` and use the app’s upload endpoint (or extract the zip into `/opt/manychat-clicker/data/user-data`) so you don’t need to log in on the server.
- **Option B – Login on server with visible browser:** Install a virtual display and run manual login once:

  ```bash
  apt install -y xvfb
  cd /opt/manychat-clicker
  HEADLESS=false xvfb-run --auto-servernum node manual-login.js
  ```
  Follow the prompts; the browser runs in a virtual display so you can’t see it, but the session is saved. If the app supports `/init-login` with a tunnel URL, you can also log in by visiting that URL in your local browser (if you’ve implemented that flow).

- **Option C – Headless only:** If you only ever use `HEADLESS=true`, you must have a valid session in `data/user-data` (e.g. copied from another machine or from Option A/B once).

---

## 6. Cloudflare Tunnel (Ubuntu)

```bash
cd /opt/manychat-clicker
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O cloudflared
chmod +x cloudflared
./cloudflared version
```

One-time login and tunnel creation (replace hostname if different):

```bash
./cloudflared tunnel login
./cloudflared tunnel create manychat-clicker
./cloudflared tunnel route dns manychat-clicker manychat-followupsv2.setty.ai
```

Create config (replace `TUNNEL_ID` with the ID from `cloudflared tunnel list`):

```bash
mkdir -p ~/.cloudflared
nano ~/.cloudflared/config.yml
```

Content (fix path to the JSON file in `~/.cloudflared/`):

```yaml
tunnel: manychat-clicker
credentials-file: /root/.cloudflared/TUNNEL_ID.json
ingress:
  - hostname: manychat-followupsv2.setty.ai
    service: http://localhost:3000
  - service: http_status:404
```

Save and exit.

---

## 7. Start app and tunnel with PM2 (Ubuntu)

```bash
cd /opt/manychat-clicker
pm2 start server.js --name manychat
pm2 start "/opt/manychat-clicker/cloudflared tunnel run manychat-clicker" --name tunnel
pm2 save
pm2 startup
```

Run the command that `pm2 startup` prints (e.g. `sudo env PATH=... pm2 startup systemd -u root --hp /root`) so the process restarts on reboot. Your API is at `https://manychat-followupsv2.setty.ai`.

---

## 8. Test the API (Ubuntu path)

Same as Windows: POST to `https://manychat-followupsv2.setty.ai/press` with `type`, `chatId`, `message`, `pageId` and `Authorization: Bearer your-secret-token-here`.

---

## Quick reference – files you must have on the server

| OS      | App directory              | User data directory                          | .env `USER_DATA_DIR`                    |
|---------|----------------------------|----------------------------------------------|-----------------------------------------|
| Windows | `C:\manychat-clicker`      | `C:\manychat-clicker\data\user-data`         | `C:\manychat-clicker\data\user-data`    |
| Ubuntu  | `/opt/manychat-clicker`    | `/opt/manychat-clicker/data/user-data`       | `/opt/manychat-clicker/data/user-data`  |

---

## Troubleshooting

- **“Not logged in” / session errors:** Ensure `data/user-data` exists and either (a) you ran `manual-login.js` (or `/init-login`) on this server, or (b) you copied/uploaded a valid ManyChat session into `data/user-data`.
- **Playwright “Executable doesn’t exist”:** Run `npx playwright install chromium` (and on Linux `npx playwright install-deps`) in the project directory.
- **Tunnel not connecting:** Check `~/.cloudflared/config.yml` (Linux) or `%USERPROFILE%\.cloudflared\config.yml` (Windows); hostname must match your domain and `service` must be `http://localhost:3000`.
- **401 Unauthorized:** The `Authorization: Bearer <token>` header must match `AUTH_TOKEN` in `.env`.

Once this is done, you have the app running on Vultr with your named Cloudflare tunnel; you only need to copy `server.js` and the other relevant files as listed at the top.
