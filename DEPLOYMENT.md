# ManyChat Clicker - Deployment Guide

## 🚀 Quick Deploy to Railway (Recommended)

### Step 1: Prepare Your Repository
1. Push your code to GitHub
2. Make sure all files are committed

### Step 2: Deploy to Railway
1. Go to [railway.app](https://railway.app)
2. Sign up/Login with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your repository
5. Railway will automatically detect it's a Node.js app

### Step 3: Set Environment Variables
In Railway dashboard, go to Variables tab and add:

```
AUTH_TOKEN=your-secure-token-here
MC_PAGE_ID=fb2860983
HEADLESS=true
NODE_ENV=production
```

### Step 4: Deploy
1. Click "Deploy"
2. Wait for deployment to complete
3. Get your app URL (e.g., `https://your-app.railway.app`)

### Step 5: Complete Login
1. Visit: `https://your-app.railway.app/init-login`
2. Complete ManyChat login
3. Verify: `https://your-app.railway.app/confirm-login`

### Step 6: Test Your API
```bash
curl -X POST https://your-app.railway.app/press \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secure-token-here" \
  -d '{"chatId":"YOUR_CHAT_ID","message":"Hello from deployed API!"}'
```

## 🌐 Alternative Deployment Options

### Render (Free Tier)
1. Connect GitHub repo at [render.com](https://render.com)
2. Set environment variables
3. Deploy

### Heroku
1. Install Heroku CLI
2. `heroku create your-app-name`
3. `git push heroku main`

### DigitalOcean App Platform
1. Connect GitHub repo
2. Set environment variables
3. Deploy

## 🔧 Production Considerations

### Security
- Use a strong AUTH_TOKEN
- Consider rate limiting
- Monitor usage

### Monitoring
- Set up logging
- Monitor errors
- Track performance

### Scaling
- Consider multiple instances
- Use load balancer
- Monitor resource usage

## 📞 Usage Examples

### JavaScript/Node.js
```javascript
const response = await fetch('https://your-app.railway.app/press', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer your-token'
  },
  body: JSON.stringify({
    chatId: '123456789',
    message: 'Hello from JavaScript!'
  })
});
```

### Python
```python
import requests

response = requests.post(
    'https://your-app.railway.app/press',
    headers={
        'Content-Type': 'application/json',
        'Authorization': 'Bearer your-token'
    },
    json={
        'chatId': '123456789',
        'message': 'Hello from Python!'
    }
)
```

### PHP
```php
$data = [
    'chatId' => '123456789',
    'message' => 'Hello from PHP!'
];

$options = [
    'http' => [
        'header' => "Content-Type: application/json\r\nAuthorization: Bearer your-token\r\n",
        'method' => 'POST',
        'content' => json_encode($data)
    ]
];

$response = file_get_contents('https://your-app.railway.app/press', false, stream_context_create($options));
```
