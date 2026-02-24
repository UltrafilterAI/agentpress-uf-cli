const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');
const matter = require('gray-matter');

const IDENTITY_DIR = path.join(process.cwd(), 'identity');
const PRIVATE_KEY_PATH = path.join(IDENTITY_DIR, 'passport');
const PUBLIC_KEY_PATH = path.join(IDENTITY_DIR, 'passport.pub');

function getKeys() {
  if (!fs.existsSync(PRIVATE_KEY_PATH) || !fs.existsSync(PUBLIC_KEY_PATH)) {
    throw new Error('Identity not found. Run "press identity init" first.');
  }

  const secretKeyBase64 = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8').trim();
  const publicKeyBase64 = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8').trim();

  return {
    secretKey: naclUtil.decodeBase64(secretKeyBase64),
    publicKey: publicKeyBase64
  };
}

function signFile(filePath) {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`❌ Error: File not found at ${absolutePath}`);
    return;
  }

  try {
    const keys = getKeys();
    const content = fs.readFileSync(absolutePath, 'utf8');
    
    // Different handling for JSON vs Markdown
    const isJson = absolutePath.endsWith('.json');
    let dataToSign;

    if (isJson) {
      // For JSON, we sign the content MINUS the signature field if it exists
      // But for simplicity in this MVP, we'll sign the stringified content excluding the signature key
      // Or better: We assume the file is the payload.
      // Strategy: Read JSON, set signature to null, stringify, then sign.
      const jsonContent = JSON.parse(content);
      jsonContent.signature = null; // Nullify before signing
      dataToSign = JSON.stringify(jsonContent); 
      
      // Sign
      const signature = signString(dataToSign, keys.secretKey);
      
      // Update file
      jsonContent.signature = signature;
      fs.writeFileSync(absolutePath, JSON.stringify(jsonContent, null, 2));
      console.log(`✅ Signed JSON: ${path.basename(filePath)}`);
      console.log(`🔏 Signature: ${signature.substring(0, 20)}...`);
      
    } else if (absolutePath.endsWith('.md')) {
      // For Markdown with Frontmatter
      const file = matter.read(absolutePath);
      
      // We sign the BODY content + non-signature frontmatter
      // Strategy: Get content, remove signature from data, reconstruct canonical string to sign
      const dataCopy = { ...file.data };
      delete dataCopy.signature;
      
      // Canonical payload: JSON(frontmatter) + \n---\n + content
      // Actually, simplest is to sign the content body string. 
      // Spec: "Sign the entire post content excluding the signature line".
      
      // Let's sign the 'content' body for now to prove provenance of the text.
      // Improving: Sign a canonical representation of header+body.
      const payload = JSON.stringify(dataCopy) + '\n' + file.content;
      
      const signature = signString(payload, keys.secretKey);
      
      // Update file
      file.data.signature = signature;
      const updatedContent = matter.stringify(file.content, file.data);
      fs.writeFileSync(absolutePath, updatedContent);
      
      console.log(`✅ Signed Markdown: ${path.basename(filePath)}`);
      console.log(`🔏 Signature: ${signature.substring(0, 20)}...`);
    } else {
      console.error('❌ Unsupported file type. Only .md and .json supported.');
    }

  } catch (error) {
    console.error(`❌ Signing failed: ${error.message}`);
  }
}

function signString(text, secretKey) {
  const msgUint8 = naclUtil.decodeUTF8(text);
  const signature = nacl.sign.detached(msgUint8, secretKey);
  return naclUtil.encodeBase64(signature);
}

module.exports = {
  signFile
};
