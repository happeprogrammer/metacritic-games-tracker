// Prints a scrypt hash for a password (for VIEWER_PASS_HASH / ADMIN_PASS_HASH). Usage: node scripts/hash-password.js <password>
import { hashPassword } from '../src/auth.js';

const password = process.argv[2];
if (!password || password.length < 8) {
  console.error('Usage: node scripts/hash-password.js <password of at least 8 characters>');
  process.exit(1);
}
console.log(hashPassword(password));
