# GitHub Upload Method (Not Recommended)

## ⚠️ Warnings:
- Your session data will be public if repo is public
- Makes repo 14MB larger
- Git will be slower
- Must re-commit every time session expires

## If You Still Want This:

### 1. Add to .gitignore exceptions
Remove `data/` from .gitignore or create exception:
```bash
# In .gitignore, replace:
data/
# With:
data/
!data/user-data/
```

### 2. Commit user-data
```powershell
git add data/user-data/
git commit -m "Add user-data for Railway deployment"
git push origin main
```

### 3. Update Dockerfile
```dockerfile
# Add this line to copy user-data
COPY data/user-data /data/user-data
```

### 4. Update server.js
Change USER_DATA_DIR to:
```javascript
USER_DATA_DIR = process.env.NODE_ENV === 'production' ? '/data/user-data' : './data/user-data'
```

## Better Alternative:
Use the upload script (30 sec - 2 min) or Railway volumes (recommended)

