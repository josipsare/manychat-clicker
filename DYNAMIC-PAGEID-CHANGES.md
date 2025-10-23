# Dynamic Page ID Implementation - Summary

## Overview

The ManyChat Clicker now supports dynamic page IDs, allowing you to send messages to different ManyChat pages without changing environment variables. This enables multi-account support in a single API instance.

## Changes Made

### 1. Code Changes (`server.js`)

#### Removed Static MC_PAGE_ID
- **Line 10-14**: Removed `MC_PAGE_ID` from environment variable destructuring
- The `MC_PAGE_ID` in `.env` is no longer used by the application

#### Updated Functions
- **`openChat(page, chatId, pageId)`** (Line 232): Now accepts `pageId` as third parameter
- **`handlePress({ chatId, message, pageId })`** (Line 491): Now requires `pageId` in parameters
- **`/press` endpoint** (Line 1070): Now extracts and validates `pageId` from request body

#### Validation
- All three fields (`chatId`, `message`, `pageId`) are now required
- Proper error messages returned if any field is missing

### 2. New Script: `clear-session-and-login.ps1`

A PowerShell script that automates the process of switching ManyChat accounts:

**What it does:**
1. Stops all running processes (node.exe, cloudflared.exe)
2. Deletes the `data/user-data` directory completely
3. Launches `manual-login.js` for fresh login
4. Saves the new session

**Usage:**
```powershell
.\clear-session-and-login.ps1
```

### 3. Documentation Updates

Updated `CHANGES-AUTOMATION-BUTTONS.md` with:
- New API request format showing `pageId` parameter
- Example PowerShell requests
- Instructions for switching accounts

## Breaking Changes

⚠️ **IMPORTANT**: This is a breaking change for existing API consumers.

**Old Request Format:**
```json
{
  "chatId": "1054056495",
  "message": "Hello!"
}
```

**New Request Format:**
```json
{
  "chatId": "1054056495",
  "message": "Hello!",
  "pageId": "fb2860983"
}
```

## Migration Guide

### For Existing Users

1. **Update your API calls** to include the `pageId` field
2. **Find your Page ID**: It's in your ManyChat URL when you're on the dashboard
   - Example: `https://app.manychat.com/fb2860983/dashboard`
   - Your Page ID is: `fb2860983`

### Example Requests

#### PowerShell
```powershell
$body = @{
  chatId = "1054056495"
  message = "Test message"
  pageId = "fb2860983"
} | ConvertTo-Json

Invoke-WebRequest -Uri "http://localhost:3000/press" `
  -Method POST `
  -Body $body `
  -ContentType "application/json" `
  -Headers @{Authorization="Bearer pablonicotinepouches"}
```

#### cURL
```bash
curl -X POST http://localhost:3000/press \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pablonicotinepouches" \
  -d '{
    "chatId": "1054056495",
    "message": "Test message",
    "pageId": "fb2860983"
  }'
```

#### JavaScript
```javascript
const response = await fetch('http://localhost:3000/press', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer pablonicotinepouches'
  },
  body: JSON.stringify({
    chatId: '1054056495',
    message: 'Test message',
    pageId: 'fb2860983'
  })
});
```

## Benefits

✅ **Multi-Account Support**: Can send messages to different ManyChat pages
✅ **Flexibility**: No need to restart server to change pages
✅ **Scalability**: Single API instance can serve multiple pages/accounts
✅ **Dynamic Routing**: Each request specifies its own destination

## Testing

After implementing these changes, test with:

```powershell
# Test with your page ID
$body = @{
  chatId = "YOUR_CHAT_ID"
  message = "Testing dynamic pageId"
  pageId = "YOUR_PAGE_ID"
} | ConvertTo-Json

Invoke-WebRequest -Uri "http://localhost:3000/press" `
  -Method POST `
  -Body $body `
  -ContentType "application/json" `
  -Headers @{Authorization="Bearer pablonicotinepouches"}
```

## Switching Accounts

To login with a different ManyChat account:

```powershell
.\clear-session-and-login.ps1
```

This will:
1. Clear your current session
2. Open a browser
3. Allow you to login with a different account
4. Save the new session

**Note**: The session will work with any page ID you have access to with that account.

## Files Modified

- `server.js` - Made `pageId` dynamic in all relevant functions
- `clear-session-and-login.ps1` - NEW: Script to switch accounts
- `CHANGES-AUTOMATION-BUTTONS.md` - Added API documentation

## Rollback Instructions

If you need to rollback to the old behavior:

1. Revert `server.js` changes and restore `MC_PAGE_ID` constant
2. Update API calls to remove `pageId` parameter
3. Use the previous version from git history

---

**Implementation Complete!** 🎉

All changes have been successfully implemented. The API now supports dynamic page IDs for maximum flexibility.



