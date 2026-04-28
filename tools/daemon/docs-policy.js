const fs = require('fs');

const REQUIRED_README_PATTERNS = [
  ['native daemon policy', /(?:native daemon|네이티브 데몬)/i],
  ['source launcher', /node\s+tools\/start-runtime\.js/],
  ['foreground option', /--foreground/],
  ['legacy foreground alias', /--forground/],
  ['windows packaged stop command', /BuilderGate\.exe\s+stop/],
  ['non-windows packaged stop command', /buildergate\s+stop/],
  ['source stop command', /node\s+stop\.js/],
  ['runtime config file', /config\.json5/],
  ['packaged output path', /dist\/bin/],
  ['TOTP QR guidance', /\bQR\b/],
  ['daemon TOTP preflight timing', /(?:detach\s+전|before\s+detach|parent\s+detach)/i],
  ['reset password option', /--reset-password/],
  ['bootstrap allowlist option', /--bootstrap-allow-ip/],
  ['help option', /--help/],
  ['manual health target', /https:\/\/localhost:2002\/health/],
];

const FORBIDDEN_README_PATTERNS = [
  ['pm2 token', /\bpm2\b/i],
  ['pm2 start command', /pm2\s+start/i],
  ['pm2 stop command', /pm2\s+stop/i],
  ['pm2 delete command', /pm2\s+delete/i],
  ['global pm2 install command', /npm\s+install\s+-g\s+pm2/i],
];

function collectReadmePolicyErrors(content) {
  const errors = [];

  for (const [label, pattern] of REQUIRED_README_PATTERNS) {
    if (!pattern.test(content)) {
      errors.push(`required pattern missing: ${label}`);
    }
  }

  for (const [label, pattern] of FORBIDDEN_README_PATTERNS) {
    if (pattern.test(content)) {
      errors.push(`forbidden pattern found: ${label}`);
    }
  }

  return errors;
}

function validateReadmeContent(content, label = 'README.md') {
  const errors = collectReadmePolicyErrors(content);
  if (errors.length > 0) {
    throw new Error(`${label} native daemon docs policy failed:\n- ${errors.join('\n- ')}`);
  }
}

function validateReadmeFile(filePath, label = filePath) {
  validateReadmeContent(fs.readFileSync(filePath, 'utf8'), label);
}

module.exports = {
  FORBIDDEN_README_PATTERNS,
  REQUIRED_README_PATTERNS,
  collectReadmePolicyErrors,
  validateReadmeContent,
  validateReadmeFile,
};
