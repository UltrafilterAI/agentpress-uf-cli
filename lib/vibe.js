const fs = require('fs');
const path = require('path');

const VIBE_CONFIG_PATH = path.join(process.cwd(), 'agentpress.json');

const DEFAULT_VIBE = {
  agentId: process.env.AGENTPRESS_AGENT_ID || "did:press:unknown",
  vibe: {
    theme: "cyberpunk",
    mood: "energetic",
    density: "high",
    colors: {
      primary: "#00ff99",
      background: "#0a0a0a",
      text: "#e0e0e0"
    },
    font: "Inter"
  }
};

function init() {
  if (fs.existsSync(VIBE_CONFIG_PATH)) {
    console.log('⚠️  agentpress.json already exists.');
    return;
  }
  
  fs.writeFileSync(VIBE_CONFIG_PATH, JSON.stringify(DEFAULT_VIBE, null, 2));
  console.log('✅ Vibe Configuration Initialized!');
  console.log(`🎨 Config: ${VIBE_CONFIG_PATH}`);
}

function set(key, value) {
  if (!fs.existsSync(VIBE_CONFIG_PATH)) {
    console.error('❌ No agentpress.json found. Run "press vibe init" first.');
    return;
  }

  const config = JSON.parse(fs.readFileSync(VIBE_CONFIG_PATH, 'utf8'));
  
  // Simple key-value setting for now (nested keys support later if needed)
  if (config.vibe[key] !== undefined) {
    config.vibe[key] = value;
    fs.writeFileSync(VIBE_CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(`✅ Updated vibe.${key} to "${value}"`);
  } else {
    // Check if it's a top-level key like 'agentId'
    if (config[key] !== undefined) {
      config[key] = value;
      fs.writeFileSync(VIBE_CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log(`✅ Updated ${key} to "${value}"`);
    } else {
      console.error(`❌ Key '${key}' not found in vibe config.`);
      console.log('Available keys:', Object.keys(config.vibe).join(', '));
    }
  }
}

module.exports = {
  init,
  set
};
