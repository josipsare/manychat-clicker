import fs from 'fs';
import path from 'path';

// Simple script to extract session data from local user-data
async function extractSessionData() {
  try {
    console.log('Extracting session data from local user-data...');
    
    // Read the cookies file
    const cookiesPath = path.join('./data/user-data/Default', 'Cookies');
    const cookiesExist = fs.existsSync(cookiesPath);
    
    // Read the preferences file (contains session info)
    const prefsPath = path.join('./data/user-data/Default', 'Preferences');
    const prefsExist = fs.existsSync(prefsPath);
    
    // Read the local state file
    const localStatePath = path.join('./data/user-data', 'Local State');
    const localStateExist = fs.existsSync(localStatePath);
    
    console.log('Files found:');
    console.log('- Cookies:', cookiesExist ? 'YES' : 'NO');
    console.log('- Preferences:', prefsExist ? 'YES' : 'NO');
    console.log('- Local State:', localStateExist ? 'YES' : 'NO');
    
    // Create a simple session data object
    const sessionData = {
      cookies: cookiesExist ? 'EXISTS' : null,
      preferences: prefsExist ? 'EXISTS' : null,
      localState: localStateExist ? 'EXISTS' : null,
      userDataDir: './data/user-data',
      timestamp: new Date().toISOString()
    };
    
    // Save to file
    fs.writeFileSync('./session-data.json', JSON.stringify(sessionData, null, 2));
    console.log('Session data extracted to session-data.json');
    
    return sessionData;
  } catch (error) {
    console.error('Error extracting session data:', error);
    return null;
  }
}

// Run the extraction
extractSessionData();
