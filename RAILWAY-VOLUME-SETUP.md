# Railway Volume Setup (Recommended)

## Why Use Volumes?
- ✅ Persistent storage that survives deployments
- ✅ Faster than uploading each time
- ✅ More secure (not in git)
- ✅ Easier to manage

## Setup Steps:

### 1. Add Volume in Railway Dashboard
1. Go to your Railway project
2. Click on your service
3. Go to **"Settings"** tab
4. Scroll to **"Volumes"** section
5. Click **"+ New Volume"**
6. Set mount path: `/data`
7. Click **"Add"**

### 2. Update Environment Variable
In Railway **Variables** tab, change:
```
USER_DATA_DIR=/data/user-data
```

### 3. Upload User Data (One Time)
After volume is created, run:
```powershell
.\upload-direct.ps1
```

This uploads once, and your data persists across deployments!

## Benefits:
- 🚀 Faster deployments (no need to re-upload)
- 💾 Data persists across restarts
- 🔒 More secure
- 📦 No bloated git repo

