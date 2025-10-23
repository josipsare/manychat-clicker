# Automation Button Clicks - Update Summary

## What Changed

Added **TWO-STEP** automation button sequence after sending the message successfully.

### New Functions Added

1. **`clickAutomationTimerButton(page)`** - Lines 381-430
   - Finds and clicks the **automation countdown timer button** (the one with orange pause icon showing time like "00:16:10")
   - Uses multiple selectors:
     - `data-onboarding-id="pause-automation-section"`
     - Button containing time format: `\d{2}:\d{2}:\d{2}`
     - Buttons near "Automations" text
   - Returns `true` if button found and clicked, `false` otherwise

2. **`clickResumeAutomationsButton(page)`** - Lines 432-490
   - Finds and clicks **"Resume automations"** button in the dropdown menu that appears
   - Waits 1500ms for dropdown to appear after clicking timer button
   - Tries multiple strategies:
     - `getByRole('button', { name: 'Resume automations' })`
     - Text-based exact matches for "Resume automations"
     - Buttons with play icon or Resume text in dropdown menus
   - Returns `true` if button found and clicked, `false` otherwise

### Modified Function

**`handlePress({ chatId, message })`** - Lines 553-575
- After sending the message successfully, now performs a **TWO-STEP sequence**:
  1. Waits 1200ms for message to send
  2. **Step 1**: Clicks the automation timer button (with orange pause icon)
  3. Waits 800ms for dropdown to appear
  4. **Step 2**: Clicks "Resume automations" in the dropdown menu
  5. Waits 1000ms for automation to resume
  6. Returns success

### Complete Flow with Timing

1. ✅ Send message to Instagram
2. ⏸️ Wait **2000ms** (2 seconds) - ensure message is fully sent
3. ⏸️ Wait **2000ms** (2 seconds) - stabilize before automation sequence
4. ✅ Click automation timer button (orange pause icon)
5. ⏸️ Wait **3000ms** (3 seconds) - ensure dropdown menu appears
6. ⏸️ Wait **500ms** - ensure dropdown is fully rendered
7. ✅ Click "Resume automations" from dropdown
8. ⏸️ Wait **2000ms** (2 seconds) - ensure automation resumes
9. ✅ Return success

**Total delay time**: ~9.5 seconds between sending message and completing automation sequence

### Behavior

- **Non-breaking**: If either button is not found, the function logs a warning but continues
- **Graceful**: Both button clicks are optional and won't fail the entire request
- **Logged**: All actions are logged with clear messages (✅ for success, ⚠️ for not found)
- **Timed**: Includes small delays between actions for UI transitions

## Testing

The current `/press` endpoint will now automatically perform all three actions:
1. Type and send message
2. Click pause automation button
3. Click first button in list

Example test:
```powershell
$body = @{chatId="1054056495"; message="Test with automation buttons"} | ConvertTo-Json
Invoke-WebRequest -Uri "http://localhost:3000/press" -Method POST -Body $body -ContentType "application/json" -Headers @{Authorization="Bearer pablonicotinepouches"}
```

## No Breaking Changes

✅ All existing functionality preserved
✅ Login process unchanged
✅ Message sending unchanged
✅ Error handling unchanged
✅ All existing endpoints work the same

---

## API Changes - Dynamic Page ID

The `/press` endpoint now requires `pageId` in the request body.

### New Request Format

```json
{
  "chatId": "1054056495",
  "message": "Your message here",
  "pageId": "fb2860983"
}
```

### Example Request

```powershell
$body = @{
  chatId = "1054056495"
  message = "Hello from API!"
  pageId = "fb2860983"
} | ConvertTo-Json

Invoke-WebRequest -Uri "http://localhost:3000/press" `
  -Method POST `
  -Body $body `
  -ContentType "application/json" `
  -Headers @{Authorization="Bearer pablonicotinepouches"}
```

### Switching Accounts

To login with a different ManyChat account:

```powershell
.\clear-session-and-login.ps1
```

This script will:
1. Stop all running processes
2. Clear the old session data
3. Open a browser for you to login with your new account
4. Save the new session

