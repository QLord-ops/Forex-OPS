/**
 * Offline generator for production login secrets: `npm run auth:secrets -w @ops/api`.
 *
 * Asks for the password without echoing it and prints only the scrypt hash and a
 * fresh SESSION_SECRET. Nothing is written to disk or sent anywhere.
 */
import { randomBytes } from 'node:crypto';
import { hashDispatcherPassword } from '../services/dispatcher-auth.js';

const MIN_LENGTH = 12;

function readHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return new Promise((resolve) => {
      let data = '';
      input.setEncoding('utf8');
      input.on('data', (chunk) => { data += chunk; });
      input.on('end', () => resolve(data.split(/\r?\n/)[0] ?? ''));
    });
  }
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          input.setRawMode(false);
          input.pause();
          input.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          input.setRawMode(false);
          reject(new Error('Отменено.'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on('data', onData);
  });
}

async function main() {
  const role = process.argv.includes('--dispatcher') ? 'DISPATCHER' : 'ADMIN';
  const password = await readHidden(`Новый пароль ${role === 'ADMIN' ? 'администратора' : 'диспетчера'}: `);
  if (password.length < MIN_LENGTH) {
    console.error(`Пароль должен быть не короче ${MIN_LENGTH} символов.`);
    process.exitCode = 1;
    return;
  }
  if (process.stdin.isTTY) {
    const repeat = await readHidden('Повторите пароль: ');
    if (repeat !== password) {
      console.error('Пароли не совпадают.');
      process.exitCode = 1;
      return;
    }
  }
  console.log('\nВставьте в секреты production API (не в git, не в чат, не в VITE_*):\n');
  console.log(`${role}_PASSWORD_HASH=${hashDispatcherPassword(password)}`);
  if (!process.argv.includes('--no-session-secret')) console.log(`SESSION_SECRET=${randomBytes(48).toString('base64url')}`);
  console.log('\nНовый SESSION_SECRET завершит все текущие сессии — это нормально при первом запуске.');
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
