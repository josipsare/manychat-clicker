# 🚀 Simple Cloud Deployment Guide

## ✅ Your User Data is Ready!

- **Backup created**: `user-data-backup.zip` (14MB)
- **Local server**: Working perfectly ✅
- **Session data**: Extracted and ready ✅

## 📋 Step-by-Step Deployment

### Step 1: Deploy to Railway

1. **Go to [railway.app](https://railway.app)**
2. **Sign up/Login** with GitHub
3. **Click "New Project" → "Deploy from GitHub repo"**
4. **Select**: `josipsare/manychat-clicker`
5. **Click "Deploy"**

### Step 2: Set Environment Variables

In Railway dashboard → **Variables** tab:

```
AUTH_TOKEN=your-super-secure-token-here
MC_PAGE_ID=fb2860983
HEADLESS=true
NODE_ENV=production
USER_DATA_DIR=/tmp/user-data
```

### Step 3: Upload User Data

1. **Go to Railway dashboard → Files tab**
2. **Upload**: `user-data-backup.zip`
3. **Extract to**: `/tmp/user-data/`
4. **Wait for deployment to complete**

### Step 4: Test Your API

Once deployed, test with:

```bash
curl -X POST https://your-app.railway.app/press \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{"chatId":"1054056495","message":"Hello from cloud!"}'
```

## 🎯 What You'll Get

- ✅ **Public HTTPS API** accessible from anywhere
- ✅ **Same login session** as your local server
- ✅ **Automatic scaling** and 99.9% uptime
- ✅ **Free tier** (500 hours/month)

## 🔧 Alternative: Manual File Upload

If Railway doesn't support file uploads:

1. **Use a cloud storage service** (Google Drive, Dropbox, etc.)
2. **Upload** `user-data-backup.zip`
3. **Get the download link**
4. **Add to your deployment** as a build step

## 📞 Support

If you need help:
- Check Railway logs for errors
- Verify environment variables are set
- Ensure user-data is extracted to `/tmp/user-data/`

**Ready to deploy!** 🚀
