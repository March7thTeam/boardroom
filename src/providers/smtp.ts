import { connect } from "cloudflare:sockets";
import type { EmailMessage, SmtpConfig } from "./email";

const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${bytesToBase64(encoder.encode(value))}?=`;
}

function encodeBody(value: string): string {
  const base64 = bytesToBase64(encoder.encode(value));
  return base64.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function mailbox(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match?.[1] ?? value).trim();
}

function normalizeCrlf(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

function buildMessage(config: SmtpConfig, message: EmailMessage): string {
  const headers = [
    `From: ${config.from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${config.host}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  if (config.replyTo) headers.push(`Reply-To: ${config.replyTo}`);
  const body = encodeBody(normalizeCrlf(message.text));
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

export async function sendSmtp(config: SmtpConfig, message: EmailMessage): Promise<void> {
  const socket = connect(
    { hostname: config.host, port: config.port },
    {
      secureTransport: config.secure === "on" ? "on" : config.secure === "starttls" ? "starttls" : "off",
      allowHalfOpen: false,
    },
  );

  let current = socket;
  let writer = current.writable.getWriter();
  let reader = current.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const readLine = async (): Promise<string> => {
    for (;;) {
      const newline = buffer.indexOf("\r\n");
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        return line;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("SMTP connection closed");
      buffer += decoder.decode(value, { stream: true });
    }
  };

  const readResponse = async (): Promise<number> => {
    for (;;) {
      const line = await readLine();
      const code = Number(line.slice(0, 3));
      if (!Number.isInteger(code)) throw new Error(`invalid SMTP response: ${line}`);
      if (line[3] === " ") return code;
      if (line[3] !== "-") return code;
    }
  };

  const sendLine = async (line: string): Promise<void> => {
    await writer.write(encoder.encode(`${line}\r\n`));
  };

  const expect = async (expected: number[], step: string): Promise<number> => {
    const code = await readResponse();
    if (!expected.includes(code)) {
      throw new Error(`SMTP ${step} failed with ${code}`);
    }
    return code;
  };

  const doSend = async (): Promise<void> => {
    await expect([220], "greeting");
    await sendLine("EHLO boardroom.local");
    await expect([250], "EHLO");

    if (config.secure === "starttls") {
      await sendLine("STARTTLS");
      await expect([220], "STARTTLS");
      current = current.startTls({ expectedServerHostname: config.host });
      writer = current.writable.getWriter();
      reader = current.readable.getReader();
      buffer = "";
      await sendLine("EHLO boardroom.local");
      await expect([250], "EHLO after STARTTLS");
    }

    if (config.user && config.password) {
      await sendLine("AUTH LOGIN");
      await expect([334], "AUTH LOGIN");
      await sendLine(bytesToBase64(encoder.encode(config.user)));
      await expect([334], "AUTH username");
      await sendLine(bytesToBase64(encoder.encode(config.password)));
      await expect([235], "AUTH password");
    }

    await sendLine(`MAIL FROM:<${mailbox(config.from)}>`);
    await expect([250], "MAIL FROM");
    await sendLine(`RCPT TO:<${mailbox(message.to)}>`);
    await expect([250, 251], "RCPT TO");
    await sendLine("DATA");
    await expect([354], "DATA");

    const data = buildMessage(config, message).replace(/\r\n\./g, "\r\n..");
    await writer.write(encoder.encode(`${data}.\r\n`));
    await expect([250], "message body");

    await sendLine("QUIT");
    // Some servers close immediately; a missing 221 is not a send failure.
    try {
      await expect([221], "QUIT");
    } catch {
      // ignore
    }
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("SMTP timeout")), 15_000);
  });

  try {
    await Promise.race([doSend(), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
    try {
      writer.releaseLock();
    } catch {
      // ignore
    }
    await current.close().catch(() => undefined);
  }
}
