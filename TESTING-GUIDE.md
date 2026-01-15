# Testing Guide for Automation Followup Feature

## Prerequisites

1. **Server Running**: Make sure your server is running
   ```powershell
   node server.js
   # or
   npm start
   ```

2. **Environment Variables**: Ensure you have:
   - `AUTH_TOKEN` set (for authentication)
   - `HEADLESS=false` for visual testing (optional, but recommended for first test)
   - Valid ManyChat session (logged in)

3. **Test Data Ready**:
   - A valid `chatId` (Instagram chat ID)
   - A valid `pageId` (ManyChat page ID)
   - An automation name that exists in your ManyChat account (for automation type)

## Testing Methods

### Method 1: Using PowerShell (Invoke-RestMethod)

#### Test Text Followup (Existing Functionality)

```powershell
$headers = @{
    "Authorization" = "Bearer YOUR_AUTH_TOKEN_HERE"
    "Content-Type" = "application/json"
}

$body = @{
    type = "text"
    chatId = "YOUR_CHAT_ID_HERE"
    message = "Hello, this is a test message!"
    pageId = "YOUR_PAGE_ID_HERE"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "http://localhost:3000/press" -Method POST -Headers $headers -Body $body
$response
```

#### Test Automation Followup (New Functionality)

```powershell
$headers = @{
    "Authorization" = "Bearer YOUR_AUTH_TOKEN_HERE"
    "Content-Type" = "application/json"
}

$body = @{
    type = "automation"
    chatId = "YOUR_CHAT_ID_HERE"
    automation_name = "gray_followup"  # Replace with your actual automation name
    pageId = "YOUR_PAGE_ID_HERE"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "http://localhost:3000/press" -Method POST -Headers $headers -Body $body
$response
```

### Method 2: Using cURL (if available)

#### Test Text Followup

```bash
curl -X POST http://localhost:3000/press \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "text",
    "chatId": "YOUR_CHAT_ID_HERE",
    "message": "Hello, this is a test message!",
    "pageId": "YOUR_PAGE_ID_HERE"
  }'
```

#### Test Automation Followup

```bash
curl -X POST http://localhost:3000/press \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "automation",
    "chatId": "YOUR_CHAT_ID_HERE",
    "automation_name": "gray_followup",
    "pageId": "YOUR_PAGE_ID_HERE"
  }'
```

### Method 3: Using Postman or Insomnia

1. **Method**: POST
2. **URL**: `http://localhost:3000/press`
3. **Headers**:
   - `Authorization: Bearer YOUR_AUTH_TOKEN_HERE`
   - `Content-Type: application/json`
4. **Body** (JSON):

**For Text Type:**
```json
{
  "type": "text",
  "chatId": "YOUR_CHAT_ID_HERE",
  "message": "Hello, this is a test message!",
  "pageId": "YOUR_PAGE_ID_HERE"
}
```

**For Automation Type:**
```json
{
  "type": "automation",
  "chatId": "YOUR_CHAT_ID_HERE",
  "automation_name": "gray_followup",
  "pageId": "YOUR_PAGE_ID_HERE"
}
```

## Test Scenarios

### ✅ Test 1: Text Followup (Verify Existing Functionality Still Works)

**Expected Behavior:**
- Opens chat
- Types message character by character (with randomized delays)
- Clicks "Send to Instagram"
- Performs automation timer sequence (pause/resume)
- Returns: `{ "ok": true, "chatId": "...", "message": "Message sent and automation sequence completed" }`

**What to Watch:**
- Browser should type the message naturally
- Message should be sent successfully
- Automation timer button should be clicked
- Resume automations should be clicked

### ✅ Test 2: Automation Followup (New Feature)

**Expected Behavior:**
- Opens chat
- Clicks "Automation" button
- Types automation name in search field
- Selects the matching automation from results
- Clicks "Pick This Automation"
- Returns: `{ "ok": true, "chatId": "...", "message": "Automation 'gray_followup' selected and triggered successfully" }`

**What to Watch:**
- Automation button should be clicked
- Search modal should appear
- Automation name should be typed
- Correct automation should be selected
- "Pick This Automation" button should be clicked
- Modal should close
- **NO automation timer sequence should run**

### ❌ Test 3: Error Handling - Missing Type

```json
{
  "chatId": "123",
  "message": "test",
  "pageId": "456"
}
```

**Expected**: `400 Bad Request` with error: `"Field "type" is required and must be either "text" or "automation"`

### ❌ Test 4: Error Handling - Invalid Type

```json
{
  "type": "invalid",
  "chatId": "123",
  "message": "test",
  "pageId": "456"
}
```

**Expected**: `400 Bad Request` with error about invalid type

### ❌ Test 5: Error Handling - Missing Fields for Text Type

```json
{
  "type": "text",
  "chatId": "123"
}
```

**Expected**: `400 Bad Request` with error: `"For type "text", all fields required: chatId, message, and pageId"`

### ❌ Test 6: Error Handling - Missing Fields for Automation Type

```json
{
  "type": "automation",
  "chatId": "123"
}
```

**Expected**: `400 Bad Request` with error: `"For type "automation", all fields required: chatId, automation_name, and pageId"`

### ❌ Test 7: Error Handling - Automation Not Found

```json
{
  "type": "automation",
  "chatId": "YOUR_CHAT_ID_HERE",
  "automation_name": "nonexistent_automation_12345",
  "pageId": "YOUR_PAGE_ID_HERE"
}
```

**Expected**: `500 Internal Server Error` with error: `"Automation "nonexistent_automation_12345" not found in search results. Check screenshot for debugging."`

**Note**: Check `./data/automation-not-found-error.png` for screenshot

### ❌ Test 8: Error Handling - Empty Automation Name

```json
{
  "type": "automation",
  "chatId": "123",
  "automation_name": "   ",
  "pageId": "456"
}
```

**Expected**: `400 Bad Request` with error: `"automation_name cannot be empty"`

## Visual Testing (Recommended for First Test)

For the first automation test, run with `HEADLESS=false` to see what's happening:

```powershell
$env:HEADLESS = "false"
node server.js
```

Then make your API call. You'll see:
1. Browser window opening
2. Navigation to ManyChat
3. Opening the chat
4. Clicking Automation button
5. Search modal appearing
6. Typing automation name
7. Selecting automation
8. Clicking "Pick This Automation"
9. Modal closing

## Debugging Tips

### Check Server Logs

Watch the console output for detailed step-by-step progress:
```
=== Starting automation followup flow ===
Step 1: Clicking Automation button...
Looking for "Automation" button...
Trying automation button selector 1/14, found 1 elements
Found and clicking automation button with selector 1
...
```

### Check Screenshots on Error

If something fails, check these files in `./data/`:
- `automation-button-error.png` - Automation button not found
- `automation-not-found-error.png` - Automation name not found in search
- `pick-automation-button-error.png` - "Pick This Automation" button not found
- `automation-flow-error.png` - General automation flow error
- `handle-press-error.png` - General error in handlePress

### Common Issues

1. **"Automation button not found"**
   - Make sure you're on the chat page
   - Check if the button is visible (might need to scroll)
   - Verify you're logged into ManyChat

2. **"Automation not found in search results"**
   - Verify the automation name is **exactly** as it appears in ManyChat (case-sensitive)
   - Check for typos or extra spaces
   - Make sure the automation exists and is published

3. **"Pick This Automation button not found"**
   - Make sure an automation was selected first
   - Wait a bit longer for the preview to load
   - Check if the button is visible in the preview section

## Quick Test Script

Save this as `test-automation.ps1`:

```powershell
# Configuration
$AUTH_TOKEN = "YOUR_AUTH_TOKEN_HERE"
$CHAT_ID = "YOUR_CHAT_ID_HERE"
$PAGE_ID = "YOUR_PAGE_ID_HERE"
$AUTOMATION_NAME = "gray_followup"  # Change this to your automation name
$BASE_URL = "http://localhost:3000"

# Test Automation Followup
Write-Host "Testing Automation Followup..." -ForegroundColor Cyan

$headers = @{
    "Authorization" = "Bearer $AUTH_TOKEN"
    "Content-Type" = "application/json"
}

$body = @{
    type = "automation"
    chatId = $CHAT_ID
    automation_name = $AUTOMATION_NAME
    pageId = $PAGE_ID
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "$BASE_URL/press" -Method POST -Headers $headers -Body $body
    Write-Host "✅ Success!" -ForegroundColor Green
    Write-Host ($response | ConvertTo-Json -Depth 10)
} catch {
    Write-Host "❌ Error!" -ForegroundColor Red
    Write-Host $_.Exception.Message
    if ($_.ErrorDetails.Message) {
        Write-Host $_.ErrorDetails.Message
    }
}
```

Run it:
```powershell
.\test-automation.ps1
```

## Success Criteria

✅ **Text Followup Test Passes If:**
- Message is sent successfully
- Automation timer sequence completes
- Returns success response

✅ **Automation Followup Test Passes If:**
- Automation button is clicked
- Search modal appears
- Automation is found and selected
- "Pick This Automation" is clicked
- Returns success response
- **No automation timer sequence runs**

