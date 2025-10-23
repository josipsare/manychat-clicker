# 🏆 ManyChat Clicker - Production Deployment on Vultr

## ✅ Why Vultr for Production

**Reliability Features:**
- ⭐ **99.99% Uptime SLA** - Industry-leading reliability
- ⚡ **Enterprise Hardware** - NVMe SSDs, redundant networking
- 🌍 **17 Global Locations** - Choose closest to you
- 💪 **24/7 Support** - Live chat + ticket system
- 🔄 **Automatic Backups** - Optional ($2/month)
- 📊 **Real-time Monitoring** - Built-in dashboard
- 🚀 **Better Performance** - Faster than Contabo/cheap providers

**Cost: $24/month (2 vCPU, 4GB RAM, 80GB SSD)**

---

## 🚀 Complete Setup Guide (30 Minutes)

### Step 1: Create Vultr Account & Deploy Server

1. **Go to [Vultr.com](https://vultr.com)** and sign up
2. **Add Payment Method** (Credit card or PayPal)
3. **Click "Deploy New Server" (+ icon)**
4. **Configure Server:**

   **Choose Server:**
   - Select: **Cloud Compute - Shared CPU**
   
   **Server Location:**
   - Choose closest to you (e.g., "New York", "Los Angeles", "Frankfurt")
   - Lower latency = better performance
   
   **Server Image:**
   - **Operating System:** Windows
   - **Version:** Windows Server 2022 Standard (x64)
   
   **Server Size:**
   - Select: **2 CPU / 4GB RAM / 80GB SSD** - $24/month
   - (This is perfect for your needs)
   
   **Additional Features:**
   - ✅ **Enable Auto Backups** ($2/month) - HIGHLY RECOMMENDED for production
   - ✅ **Enable IPv4**
   - ❌ Skip IPv6 (not needed)
   - ❌ Skip Private Networking (not needed)
   
   **Server Hostname & Label:**
   - Hostname: `manychat-production`
   - Label: `ManyChat Clicker Production`

5. **Click "Deploy Now"**

**Wait 5-10 minutes** for provisioning. You'll get an email when ready.

---

### Step 2: Get Your Server Credentials

1. Go to **Vultr Dashboard** → **Products** → Click your new server
2. You'll see:
   - **IP Address:** `123.45.67.89` (example)
   - **Username:** `Administrator`
   - **Password:** Click the eye icon to reveal
3. **Copy these to a secure place** (password manager)

---

### Step 3: Connect via Remote Desktop (RDP)

#### **On Windows PC:**
1. Press `Win + R`
2. Type: `mstsc`
3. Enter IP address
4. Click "Connect"
5. Login:
   - Username: `Administrator`
   - Password: (from Vultr dashboard)
6. Click "Yes" to certificate warning
7. Choose "No" for discovery prompt

#### **On Mac:**
1. Install [Microsoft Remote Desktop](https://apps.apple.com/app/microsoft-remote-desktop/id1295203466)
2. Click "Add PC"
3. Enter IP, username, password
4. Connect

---

### Step 4: Initial Windows Server Setup

Once connected via RDP:

#### **A. Disable IE Enhanced Security (CRITICAL)**
1. **Server Manager** opens automatically (if not, click Start → Server Manager)
2. Click **Local Server** in left sidebar
3. Find **IE Enhanced Security Configuration**
4. Click **On** next to it
5. Set BOTH Administrators and Users to **Off**
6. Click **OK**

#### **B. Install Chrome**
1. Open **Internet Explorer** (yes, really!)
2. Go to: `https://www.google.com/chrome`
3. Click "Download Chrome"
4. Accept terms, download
5. Run installer
6. Set as default browser when asked

#### **C. Install Node.js**
1. Open **Chrome**
2. Go to: `https://nodejs.org`
3. Download **LTS version** (left button, currently 20.x)
4. Run installer:
   - Accept all defaults
   - ✅ Check "Automatically install necessary tools"
5. Click "Install"
6. Restart if prompted (not usually needed)

#### **D. Verify Node.js Installation**
1. Click **Start** → Type `powershell` → Right-click → **Run as Administrator**
2. Type: `node --version`
3. Should show: `v20.x.x`
4. Type: `npm --version`
5. Should show: `10.x.x`

**✅ If you see version numbers, Node.js is installed correctly!**

---

### Step 5: Transfer Your Code to Server

#### **Option A: Via GitHub (Recommended)**

**On your local PC:**
```powershell
# Make sure code is committed
git add .
git commit -m "Production ready"
git push origin main
```

**On Vultr Server (in PowerShell as Administrator):**
```powershell
# Navigate to C drive
cd C:\

# Clone your repository
git clone https://github.com/YOUR_USERNAME/manychat-clicker.git

# Navigate into project
cd manychat-clicker

# Install dependencies
npm install
```

#### **Option B: Via Direct File Transfer**

**On your local PC:**
1. Zip your project folder (exclude `node_modules` and `data`)
2. Upload to Google Drive / Dropbox / WeTransfer
3. Get shareable link

**On Vultr Server:**
1. Open Chrome
2. Download the zip from your link
3. Extract to `C:\manychat-clicker`
4. Open PowerShell as Administrator:
   ```powershell
   cd C:\manychat-clicker
   npm install
   ```

---

### Step 6: Install Cloudflare Tunnel

**On Vultr Server (in PowerShell):**

```powershell
# Navigate to project
cd C:\manychat-clicker

# Download Cloudflare Tunnel
Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "cloudflared.exe"

# Verify it works
.\cloudflared.exe version
```

You should see version info like `cloudflared version 2024.x.x`

---

### Step 7: Setup Environment Variables

**On Vultr Server:**

1. Create `.env` file (if not in your repo):
   ```powershell
   notepad .env
   ```

2. Add this content:
   ```
   AUTH_TOKEN=pablonicotinepouches
   HEADLESS=false
   PORT=3000
   ```

3. Save and close (Ctrl+S, then close Notepad)

---

### Step 8: First-Time ManyChat Login

**This is a ONE-TIME setup:**

```powershell
# Make sure you're in project directory
cd C:\manychat-clicker

# Run manual login script
node manual-login.js
```

**A Chrome window will open:**
1. Complete ManyChat login
2. Solve any CAPTCHA if needed
3. Wait until you see the dashboard
4. Go back to PowerShell
5. Press **ENTER**

**✅ Session is now saved!**

---

### Step 9: Start Production Server

**On Vultr Server:**

```powershell
# Run the production startup script
.\start-production.ps1
```

**You should see:**
- Two minimized PowerShell windows in taskbar
- Messages showing server started
- Instructions to check tunnel window

**Click the Tunnel window** and look for:
```
Your quick Tunnel has been created! Visit it at:
https://your-random-name.trycloudflare.com
```

**🎉 This is your public API URL!**

---

### Step 10: Test Your Production API

**From your local PC or any device:**

```powershell
$body = @{
  chatId = "1054056495"
  message = "Testing production server!"
  pageId = "YOUR_PAGE_ID"
} | ConvertTo-Json

Invoke-WebRequest -Uri "https://your-random-name.trycloudflare.com/press" `
  -Method POST `
  -Body $body `
  -ContentType "application/json" `
  -Headers @{Authorization="Bearer pablonicotinepouches"}
```

**✅ If successful, you'll get a JSON response with `"ok": true`**

---

### Step 11: Setup Auto-Restart (CRITICAL for Production)

This ensures your server restarts automatically if Windows updates or reboots.

**On Vultr Server:**

1. Click **Start** → Type `task scheduler` → Open **Task Scheduler**

2. Click **Create Task** (right sidebar, NOT "Create Basic Task")

3. **General Tab:**
   - Name: `ManyChat Clicker Startup`
   - Description: `Auto-start ManyChat Clicker on boot`
   - Security options:
     - ✅ **Run whether user is logged on or not**
     - ✅ **Run with highest privileges**
     - ❌ Do not store password
   - Configure for: **Windows Server 2022**

4. **Triggers Tab:**
   - Click **New**
   - Begin the task: **At startup**
   - Delay task for: **1 minute**
   - ✅ **Enabled**
   - Click **OK**

5. **Actions Tab:**
   - Click **New**
   - Action: **Start a program**
   - Program/script: `powershell.exe`
   - Add arguments: `-ExecutionPolicy Bypass -File C:\manychat-clicker\start-production.ps1`
   - Start in: `C:\manychat-clicker`
   - Click **OK**

6. **Conditions Tab:**
   - ❌ **Uncheck** "Start the task only if the computer is on AC power"
   - ✅ **Check** "Wake the computer to run this task"

7. **Settings Tab:**
   - ✅ **Allow task to be run on demand**
   - ✅ **Run task as soon as possible after a scheduled start is missed**
   - ❌ **Uncheck** "Stop the task if it runs longer than"
   - If running task does not end: **Do not start a new instance**

8. Click **OK**

9. **Enter your Administrator password** when prompted

10. **Test it:**
    ```powershell
    # Stop current services
    taskkill /IM node.exe /F
    taskkill /IM cloudflared.exe /F
    
    # Wait 5 seconds
    Start-Sleep -Seconds 5
    
    # Right-click the task → Run
    ```

**✅ Services should start automatically!**

---

## 🎯 Your Production Setup is Complete!

### What You Have Now:

- ✅ **24/7 Operation** - Runs without your PC
- ✅ **Public HTTPS API** - Accessible from anywhere
- ✅ **Auto-Restart** - Survives Windows updates
- ✅ **99.99% Uptime** - Enterprise reliability
- ✅ **Same Code** - Zero modifications needed
- ✅ **Easy Maintenance** - RDP access anytime

---

## 📋 Daily Operations

### **Checking Status:**
Just RDP in and check the minimized windows in taskbar.

### **Restarting Services:**
```powershell
cd C:\manychat-clicker
.\start-production.ps1
```

### **Changing ManyChat Accounts:**
```powershell
cd C:\manychat-clicker
.\clear-session-and-login.ps1
```

### **Updating Code:**
```powershell
cd C:\manychat-clicker
git pull
npm install
.\start-production.ps1
```

### **Viewing Logs:**
Click the minimized PowerShell windows to see real-time logs.

---

## 🔧 Troubleshooting

### **"Can't connect via RDP"**
- Check if server is running in Vultr dashboard
- Try restarting server from Vultr dashboard
- Check firewall rules (RDP port 3389 should be open)

### **"Browser won't open"**
- Make sure `HEADLESS=false` in `.env`
- Check if Chrome is installed
- Run `node manual-login.js` again

### **"API not responding"**
1. RDP into server
2. Check if processes are running:
   ```powershell
   tasklist | findstr "node.exe cloudflared.exe"
   ```
3. If not running, restart:
   ```powershell
   .\start-production.ps1
   ```

### **"Session expired"**
```powershell
cd C:\manychat-clicker
.\clear-session-and-login.ps1
.\start-production.ps1
```

### **"Tunnel URL changed"**
This is normal with free Cloudflare tunnels. Check the tunnel window for the new URL.

**For a permanent URL:** Use Cloudflare Zero Trust (free, but requires domain)

---

## 💰 Cost Breakdown

| Item | Monthly Cost | Annual Cost |
|------|--------------|-------------|
| Vultr Windows VPS (2 CPU, 4GB RAM) | $24 | $288 |
| Auto Backups (Recommended) | $2 | $24 |
| Cloudflare Tunnel | FREE | FREE |
| Node.js / Chrome | FREE | FREE |
| **TOTAL** | **$26/month** | **$312/year** |

**Compare to:**
- Keeping your PC on 24/7: ~$15-30/month electricity + wear
- Contabo (cheaper but less reliable): $7.50/month
- Managed solutions: $100+/month

---

## 🚀 Performance Optimization (Optional)

### **1. Use Static Tunnel URL (Free)**

Instead of the random Cloudflare URL that changes:

1. Create free Cloudflare account
2. Add your domain
3. Create named tunnel (free)
4. Get permanent URL like `api.yourdomain.com`

[Guide here](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/tunnel-guide/)

### **2. Monitor Uptime**

Use free services to ping your API every 5 minutes:
- [UptimeRobot](https://uptimerobot.com) - Free
- [Pingdom](https://www.pingdom.com) - Free tier
- [StatusCake](https://www.statuscake.com) - Free tier

---

## 🎉 You're Ready for Production!

Your ManyChat Clicker is now:
- ✅ Running 24/7 on enterprise hardware
- ✅ Accessible via public HTTPS API
- ✅ Auto-restarting on server reboot
- ✅ Easy to maintain and monitor
- ✅ Using the EXACT same code as local

**No code changes needed. Everything just works!**

---

## 📞 Need Help?

- **Vultr Support:** Live chat in dashboard
- **Server Issues:** Check Vultr status page
- **Code Issues:** Check PowerShell logs in minimized windows

**Your production deployment is solid and reliable!** 🚀

