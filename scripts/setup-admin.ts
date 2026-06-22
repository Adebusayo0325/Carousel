// scripts/setup-admin.ts
// Run ONCE to generate all secrets and write them to .env
// Usage: npx tsx scripts/setup-admin.ts

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');
const examplePath = path.join(__dirname, '..', '.env.example');

function randomHex(bytes: number) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomBase64(bytes: number) {
  return crypto.randomBytes(bytes).toString('base64url');
}

async function main() {
  console.log('\n🔧  ApexMint Pro — Admin Setup\n');

  if (fs.existsSync(envPath)) {
    console.log('⚠️  .env already exists. Only missing values will be added.\n');
  }

  // Read existing .env or example
  const base = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8')
    : fs.readFileSync(examplePath, 'utf8');

  const generated: Record<string, string> = {};

  const fill = (key: string, value: string) => {
    if (!base.includes(`${key}=`) || base.includes(`${key}="<`)) {
      generated[key] = value;
    }
  };

  fill('VAULT_MASTER_KEY', randomHex(32));
  fill('SESSION_SECRET', randomHex(48));
  fill('ARGON2_PEPPER', randomHex(32));
  fill('ADMIN_TOKEN', randomBase64(32));

  if (Object.keys(generated).length === 0) {
    console.log('✅  All secrets already set in .env.\n');
    return;
  }

  // Append generated values
  let content = base;
  for (const [key, value] of Object.entries(generated)) {
    // Replace placeholder lines
    const placeholder = new RegExp(`^${key}=.*$`, 'm');
    if (placeholder.test(content)) {
      content = content.replace(placeholder, `${key}="${value}"`);
    } else {
      content += `\n${key}="${value}"`;
    }
  }

  fs.writeFileSync(envPath, content);

  console.log('✅  Generated and saved to .env:\n');
  for (const [key, value] of Object.entries(generated)) {
    console.log(`   ${key}: ${value.slice(0, 8)}... (${value.length} chars)`);
  }

  console.log(`
⚠️  IMPORTANT:
   • Back up VAULT_MASTER_KEY and ARGON2_PEPPER securely.
     Losing them makes all encrypted wallets and access keys unrecoverable.
   • In production, move secrets to a secrets manager (AWS Secrets Manager,
     Doppler, HashiCorp Vault) and remove them from .env.
   • ADMIN_TOKEN controls key generation — treat it like a root password.

Next steps:
   1. Fill in your RPC URLs in .env (RPC_1, RPC_8453, etc.)
   2. docker compose up -d postgres redis
   3. npm run db:migrate
   4. npm run dev:api && npm run dev:worker
   5. apexmint generate-key --tier PREMIUM --days 30
`);
}

main().catch(console.error);
