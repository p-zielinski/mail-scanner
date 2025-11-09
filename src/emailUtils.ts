import * as imaps from "imap-simple";
import { simpleParser } from "mailparser";
import { ImapSimpleOptions } from "imap-simple";
import dayjs, { Dayjs } from "dayjs";
import { EmailContent } from "./emailAnalyzer";

export const validateEnvVars = (): void => {
  const requiredEnvVars = ["ACCOUNTS_CONFIG_PATH", "ANTHROPIC_API_KEY"];

  const missingVars = requiredEnvVars.filter(
    (varName) => !process.env[varName],
  );
  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVars.join(", ")}`,
    );
  }
};

export const getImapConfig = (): ImapSimpleOptions => ({
  imap: {
    user: process.env.YAHOO_EMAIL!,
    password: process.env.YAHOO_APP_PASSWORD!,
    host: process.env.IMAP_HOST!,
    port: parseInt(process.env.IMAP_PORT || "993"),
    tls: process.env.IMAP_TLS !== "false",
    tlsOptions: { rejectUnauthorized: false },
    authTimeout: 30000,
  },
});

export const moveToSpamFolder = async (
  connection: imaps.ImapSimple,
  uid: number,
): Promise<void> => {
  try {
    // Find a proper Spam/Junk mailbox across providers
    const boxes = await connection.getBoxes();

    // Recursively flatten mailbox tree into full-path names
    const flattenBoxes = (tree: any, prefix = ""): string[] => {
      const names: string[] = [];
      for (const [name, node] of Object.entries<any>(tree)) {
        const full = prefix ? `${prefix}/${name}` : name;
        names.push(full);
        if (node && node.children) {
          names.push(...flattenBoxes(node.children, full));
        }
        // Some servers use `boxes` instead of `children`
        if (node && node.boxes) {
          names.push(...flattenBoxes(node.boxes, full));
        }
      }
      return names;
    };

    const allBoxes = flattenBoxes(boxes);
    const lowerToOriginal = new Map(allBoxes.map((n) => [n.toLowerCase(), n]));

    const candidates = ["spam", "junk", "junk e-mail", "bulk", "[gmail]/spam"];

    let target: string | undefined;
    for (const cand of candidates) {
      // prefer exact case-insensitive full match
      const exact = lowerToOriginal.get(cand.toLowerCase());
      if (exact) {
        target = exact;
        break;
      }
      // else try to match by trailing segment (e.g., any path ending with /Spam)
      const found = allBoxes.find((b) =>
        b.toLowerCase().endsWith(`/${cand.toLowerCase()}`),
      );
      if (found) {
        target = found;
        break;
      }
    }

    if (!target) {
      // As a last resort, create a standard "Spam" mailbox
      await connection.addBox("Spam").catch(() => void 0);
      target = "Spam";
    }

    await connection.moveMessage(uid.toString(), target);
    console.log(`Moved message ${uid} to Spam folder: ${target}`);
  } catch (error) {
    console.error(`Error moving message ${uid} to Spam folder:`, error);
    throw error;
  }
};

export const getTotalMessages = async (
  connection: imaps.ImapSimple,
): Promise<number> => {
  const box = await connection.openBox("INBOX");
  return (box as any)?.messages?.total || 0;
};

export const fetchEmailsBatch = async (
  connection: imaps.ImapSimple,
  startSeq: number,
  endSeq: number,
): Promise<EmailContent[]> => {
  await connection.openBox("INBOX");

  const searchCriteria = [`${startSeq}:${endSeq}`];
  const fetchOptions = {
    bodies: ["HEADER", "TEXT", ""],
    markSeen: false,
    struct: true,
    sort: [["date", "DESC"]],
  };

  console.log("Searching for emails");
  const messages = await connection.search(searchCriteria, fetchOptions);

  const emails: EmailContent[] = [];

  for (const message of messages) {
    try {
      const all = message.parts.find((part: any) => part.which === "");
      if (!all) continue;

      const parsed = await simpleParser(all.body);
      const emailDate: Dayjs = dayjs(parsed.date || new Date());

      emails.push({
        uid: message.attributes.uid,
        subject: parsed.subject || "(No subject)",
        from: parsed.from?.text || "Unknown sender",
        date: emailDate,
        text: parsed.text || "",
        html: parsed.html || false,
      });
    } catch (error: any) {
      console.error(`Error parsing email: ${error?.message}`);
    }
  }

  return emails;
};
