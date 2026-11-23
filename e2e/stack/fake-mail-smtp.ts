import type { AddressInfo, Server } from 'node:net';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';

import { TEST_IMAP_CERT, TEST_IMAP_KEY } from '../../packages/core/src/channels/testing/test-cert';

/**
 * Server SMTP TIRUAN ber-TLS langsung (SSL/TLS, sertifikat tes SAN `localhost`) untuk modul Email di
 * stack E2E (Fase 9B): EHLO, AUTH PLAIN/LOGIN, MAIL FROM, RCPT TO, DATA, RSET, NOOP, QUIT. Email yang
 * diterima disimpan di memori (amplop + MIME mentah) supaya tes bisa memastikan email BENAR-BENAR
 * sampai di SMTP tujuan. Hanya mendengarkan 127.0.0.1; tidak pernah meneruskan ke mana pun.
 */

export interface FakeSmtpMessage {
  from: string;
  to: string[];
  raw: string;
  receivedAt: string;
}

export interface FakeMailSmtpServer {
  port: number;
  messages: FakeSmtpMessage[];
  close(): Promise<void>;
}

const MAX_MESSAGE_BYTES = 30 * 1024 * 1024;

function address(argument: string): string {
  const match = /<([^>]*)>/.exec(argument);
  return (match?.[1] ?? argument.split(':').slice(1).join(':')).trim().toLowerCase();
}

export async function startFakeMailSmtp(options: {
  username: string;
  password: string;
}): Promise<FakeMailSmtpServer> {
  const messages: FakeSmtpMessage[] = [];
  const sockets = new Set<TLSSocket>();

  const handle = (socket: TLSSocket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = '';
    let authed = false;
    let mode: 'command' | 'data' | 'auth-plain' | 'auth-login-user' | 'auth-login-pass' = 'command';
    let loginUser = '';
    let from: string | null = null;
    let to: string[] = [];
    let data: string[] = [];
    let dataBytes = 0;
    const write = (line: string) => socket.write(`${line}\r\n`);
    const reset = () => {
      from = null;
      to = [];
      data = [];
      dataBytes = 0;
    };
    const checkCredentials = (user: string, pass: string) => {
      if (user === options.username && pass === options.password) {
        authed = true;
        write('235 2.7.0 Autentikasi berhasil');
      } else {
        write('535 5.7.8 Username atau password salah');
      }
      mode = 'command';
    };
    write('220 localhost ESMTP Fake Mail SMTP siap');
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (mode === 'data') {
          if (line === '.') {
            messages.push({
              from: from ?? '',
              to,
              raw: Buffer.from(data.join('\r\n'), 'latin1').toString('utf8'),
              receivedAt: new Date().toISOString(),
            });
            write('250 2.0.0 OK diterima');
            reset();
            mode = 'command';
          } else {
            dataBytes += line.length + 2;
            if (dataBytes <= MAX_MESSAGE_BYTES)
              data.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        if (mode === 'auth-plain') {
          const [, user = '', pass = ''] = Buffer.from(line, 'base64').toString('utf8').split('\0');
          checkCredentials(user, pass);
          continue;
        }
        if (mode === 'auth-login-user') {
          loginUser = Buffer.from(line, 'base64').toString('utf8');
          mode = 'auth-login-pass';
          write('334 UGFzc3dvcmQ6');
          continue;
        }
        if (mode === 'auth-login-pass') {
          checkCredentials(loginUser, Buffer.from(line, 'base64').toString('utf8'));
          continue;
        }
        const [verbRaw = '', ...rest] = line.split(' ');
        const verb = verbRaw.toUpperCase();
        const argument = rest.join(' ');
        switch (verb) {
          case 'EHLO':
          case 'HELO':
            socket.write(
              '250-localhost halo\r\n250-AUTH PLAIN LOGIN\r\n250-SIZE 31457280\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n',
            );
            break;
          case 'AUTH': {
            const [mechanism = '', initial] = argument.split(' ');
            if (mechanism.toUpperCase() === 'PLAIN') {
              if (initial) {
                const [, user = '', pass = ''] = Buffer.from(initial, 'base64')
                  .toString('utf8')
                  .split('\0');
                checkCredentials(user, pass);
              } else {
                mode = 'auth-plain';
                write('334 ');
              }
            } else if (mechanism.toUpperCase() === 'LOGIN') {
              if (initial) {
                loginUser = Buffer.from(initial, 'base64').toString('utf8');
                mode = 'auth-login-pass';
                write('334 UGFzc3dvcmQ6');
              } else {
                mode = 'auth-login-user';
                write('334 VXNlcm5hbWU6');
              }
            } else {
              write('504 5.5.4 Mekanisme tidak didukung');
            }
            break;
          }
          case 'MAIL':
            if (!authed) {
              write('530 5.7.0 Login dulu');
              break;
            }
            reset();
            from = address(argument);
            write('250 2.1.0 OK');
            break;
          case 'RCPT':
            if (!authed || from === null) {
              write('503 5.5.1 MAIL dulu');
              break;
            }
            to.push(address(argument));
            write('250 2.1.5 OK');
            break;
          case 'DATA':
            if (to.length === 0) {
              write('503 5.5.1 RCPT dulu');
              break;
            }
            mode = 'data';
            write('354 Akhiri dengan <CRLF>.<CRLF>');
            break;
          case 'RSET':
            reset();
            write('250 2.0.0 OK');
            break;
          case 'NOOP':
            write('250 2.0.0 OK');
            break;
          case 'QUIT':
            write('221 2.0.0 Sampai jumpa');
            socket.end();
            break;
          default:
            write('502 5.5.2 Perintah tidak dikenal');
        }
      }
    });
  };

  const server: Server = createTlsServer({ cert: TEST_IMAP_CERT, key: TEST_IMAP_KEY }, handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
