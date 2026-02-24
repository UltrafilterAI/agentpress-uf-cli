const fs = require('fs');
const path = require('path');
const crypto = require('./crypto');

const DIST_DIR = path.join(process.cwd(), 'dist');
const CONTENT_DIR = path.join(process.cwd(), 'content', 'posts');
const IDENTITY_DIR = path.join(process.cwd(), 'identity');
const VIBE_CONFIG_PATH = path.join(process.cwd(), 'agentpress.json');

function cleanDist() {
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

function copyFile(src, dest) {
  if (fs.existsSync(src)) {
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(src, dest);
    return true;
  }
  return false;
}

function build() {
  console.log('🚀 Starting Build...');
  
  // 1. Clean Dist
  cleanDist();
  
  // 2. Copy Global Configs (Vibe & Identity)
  copyFile(VIBE_CONFIG_PATH, path.join(DIST_DIR, 'agentpress.json'));
  copyFile(path.join(IDENTITY_DIR, 'passport.pub'), path.join(DIST_DIR, 'identity', 'passport.pub'));
  
  // 3. Process Content
  if (fs.existsSync(CONTENT_DIR)) {
    const files = fs.readdirSync(CONTENT_DIR);
    const validPosts = [];

    files.forEach(file => {
      const srcPath = path.join(CONTENT_DIR, file);
      const destPath = path.join(DIST_DIR, 'content', 'posts', file);
      
      // Copy file
      copyFile(srcPath, destPath);
      
      // Indexing logic (only for .md files)
      if (file.endsWith('.md')) {
        // TODO: In a real app, we would parse Frontmatter here and validate the signature
        // crypto.verifyFile(srcPath); 
        validPosts.push(file);
      }
    });
    
    // Create an index.json for the frontend
    const indexContent = {
      generatedAt: new Date().toISOString(),
      posts: validPosts
    };
    fs.writeFileSync(path.join(DIST_DIR, 'content', 'index.json'), JSON.stringify(indexContent, null, 2));
    
    console.log(`✅ Processed ${validPosts.length} posts.`);
  } else {
    console.warn('⚠️  No content folder found.');
  }

  console.log(`🎉 Build Complete! Output: ${DIST_DIR}`);
}

module.exports = {
  build
};
