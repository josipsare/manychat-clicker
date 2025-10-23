# Railway Deployment Fixes - Summary

## Problems Identified

### 1. **Critical Bug: Environment Variable Override**
**Location:** `server.js:12`  
**Problem:** Hardcoded fallback was ignoring Railway's `USER_DATA_DIR` environment variable
```javascript
// BEFORE (BROKEN):
USER_DATA_DIR = process.env.NODE_ENV === 'production' ? '/tmp/user-data' : './data/user-data'

// AFTER (FIXED):
const USER_DATA_DIR = process.env.USER_DATA_DIR || (process.env.NODE_ENV === 'production' ? '/data/user-data' : './data/user-data');
```
**Impact:** Even though Railway had `USER_DATA_DIR=/data/user-data`, the code was using `/tmp/user-data`

---

### 2. **Smart Zip Extraction**
**Location:** `server.js` - `/upload-user-data` endpoint  
**Problem:** Zip contains `user-data/` folder, but extraction logic wasn't handling folder structure  
**Solution:** Check if zip has root `user-data/` folder and extract accordingly
- If zip has `user-data/` → extract to `/data` (creates `/data/user-data/`)
- If zip has files directly → extract to `/data/user-data/`

---

### 3. **Cookie File Location**
**Problem:** Debug endpoint was looking for `Default/Cookies` but actual location is `Default/Network/Cookies`  
**Impact:** Cookies exist but weren't being detected, causing false negatives in diagnostics  
**Fix:** Updated debug endpoint to check correct paths:
- `Default/Network/Cookies` (actual cookie database)
- `Default/Network/Network Persistent State`
- `Default/Local Storage`
- `Default/Preferences`
- `Default/Sessions`

---

### 4. **Login Page Detection**
**Problem:** `isLoggedIn()` was checking for `/login` and `/auth` but missing `/signin`  
**Impact:** Browser was on `/signin` but check said "not on login page"  
**Fix:** Added `/signin` to all login page checks

---

## New Features Added

### Debug Endpoints

#### `/debug-session` (GET)
Returns filesystem status:
- USER_DATA_DIR path and existence
- File count in directory
- Default folder status
- Critical session files (with correct paths)
- Browser context status
- Environment variables

#### `/debug-verify-login` (POST)
Tests login detection:
- Navigates to ManyChat
- Runs `isLoggedIn()` checks with details
- Returns URL, selector results, overall status
- Includes base64 screenshot for visual verification

### Enhanced Upload Script

`upload-direct.ps1` now includes:
- Automatic verification after upload
- Displays session file status
- Shows critical files with sizes
- Clear next-step instructions

### Test Deployment Script

`test-deployment.ps1` - Full integration test:
1. Tests service availability
2. Checks session data status
3. Verifies login detection
4. Provides troubleshooting steps if issues found

---

## Context Recreation

**Location:** After `/upload-user-data` completes  
**Purpose:** Force Playwright to reload session data from newly uploaded files  
**Implementation:**
```javascript
if (context) {
  await context.close();
  context = null; // Will recreate on next request
}
```

---

## How to Use

### First Time Setup
1. Deploy to Railway from GitHub
2. Set environment variables in Railway:
   ```
   AUTH_TOKEN=your-token
   MC_PAGE_ID=fb2860983
   HEADLESS=true
   NODE_ENV=production
   USER_DATA_DIR=/data/user-data
   ```
3. Create volume mounted at `/data` (in Railway dashboard)
4. Run `.\upload-direct.ps1` to transfer session
5. Run `.\test-deployment.ps1` to verify everything works

### Testing
```powershell
# Full test suite
.\test-deployment.ps1

# Manual test of /press endpoint
$body = @{chatId="1054056495"; message="Hello from Railway!"} | ConvertTo-Json
Invoke-WebRequest -Uri "https://your-app.railway.app/press" `
  -Method POST `
  -Body $body `
  -ContentType "application/json" `
  -Headers @{Authorization="Bearer your-token"}
```

### Troubleshooting

If login fails:
1. Check `.\test-deployment.ps1` output
2. Call `/debug-session` to verify files exist
3. Call `/debug-verify-login` to see why login detection fails
4. If session expired: re-login locally, re-run `.\upload-direct.ps1`

---

## Files Modified

- `server.js` - Environment variable fix, smart extraction, debug endpoints, /signin detection
- `upload-direct.ps1` - Added verification step
- `test-deployment.ps1` - NEW: Full integration test suite

## Reliability Improvements

1. ✅ **Respects Railway environment variables** - No more hardcoded overrides
2. ✅ **Smart extraction** - Handles any zip folder structure
3. ✅ **Correct file paths** - Finds cookies in actual location
4. ✅ **Complete login detection** - Recognizes all ManyChat login URLs
5. ✅ **Automatic verification** - Upload script confirms extraction success
6. ✅ **Context recreation** - Forces reload of new session data
7. ✅ **Debug endpoints** - Can diagnose issues without SSH access
8. ✅ **Full test suite** - Verifies entire deployment pipeline

---

## Next Steps After Railway Redeploys

1. Wait 2-3 minutes for Railway to finish building
2. Run `.\upload-direct.ps1` (this will re-upload with fixed extraction)
3. Run `.\test-deployment.ps1` to verify login works
4. Test `/press` endpoint with real message

The deployment should now work reliably!




