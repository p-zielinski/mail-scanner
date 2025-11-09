import * as imaps from "imap-simple";
import * as dotenv from "dotenv";
import dayjs, { Dayjs } from "dayjs";
import { simpleParser } from "mailparser";
import { EmailAnalyzer, EmailContent } from "./emailAnalyzer";
import {
  fetchEmailsBatch,
  getImapConfig,
  getTotalMessages,
  moveToSpamFolder,
  validateEnvVars,
} from "./emailUtils";
import * as fs from "fs";
import * as path from "path";

const AUTHORIZATION_FAILED_KEY = "AUTHENTICATIONFAILED";

dotenv.config();

export class EmailWatcher {
  private connection: imaps.ImapSimple | null = null;
  private isWatching = false;
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private readonly initialReconnectDelay = 1000; // 1 second
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private emailAnalyzer: EmailAnalyzer;
  private readonly scamThreshold: number;
  private readonly label?: string;
  private readonly imapOptions?: imaps.ImapSimpleOptions;
  private readonly configPath?: string;
  private readonly accountUser?: string;
  private emailsAnalyzedUntil?: Dayjs | null;
  private isBackfilling = false;

  constructor(options?: {
    imapOptions?: imaps.ImapSimpleOptions;
    label?: string;
    scamThreshold?: number;
    anthropicApiKey?: string;
    configPath?: string;
    accountUser?: string;
    emailsAnalyzedUntil?: string | null;
  }) {
    // If no explicit IMAP options are provided, fall back to env validation and config
    if (!options?.imapOptions) {
      validateEnvVars();
    }
    this.imapOptions = options?.imapOptions;
    this.label = options?.label;
    this.scamThreshold = parseFloat(
      String(options?.scamThreshold ?? process.env.SCAM_THRESHOLD ?? "80"),
    ); // percentage
    const apiKey = options?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY!;
    this.emailAnalyzer = new EmailAnalyzer(apiKey);
    this.configPath = options?.configPath;
    this.accountUser = options?.accountUser;
    this.emailsAnalyzedUntil = options?.emailsAnalyzedUntil
      ? dayjs(options.emailsAnalyzedUntil)
      : null;
  }

  public async startWatching(): Promise<void> {
    if (this.isWatching) {
      console.log(
        `Already watching for new emails${this.label ? ` [${this.label}]` : ""}`,
      );
      return;
    }

    try {
      await this.connect();
      this.isWatching = true;
      console.log(
        `Mail watcher is now active and listening for new emails${
          this.label ? ` [${this.label}]` : ""
        }`,
      );
    } catch (error: any) {
      this.isWatching = false;
      if (error?.textCode === AUTHORIZATION_FAILED_KEY) {
        console.log(
          `Invalid credentials${this.label ? ` [${this.label}]` : ""}`,
        );
        await this.stopWatching();
        return;
      }
      console.error(
        `Failed to start watching emails${this.label ? ` [${this.label}]` : ""}:`,
        error,
      );
      this.scheduleReconnection();
    }
  }

  private async connect(): Promise<void> {
    try {
      console.log(
        `Connecting to IMAP server${this.label ? ` [${this.label}]` : ""}...`,
      );
      const options = this.imapOptions ?? getImapConfig();
      this.connection = await imaps.connect(options);

      // Set up error and close handlers before any operations
      this.setupConnectionHandlers();

      await this.connection.openBox("INBOX");
      console.log(
        `Connected to IMAP server and opened INBOX${
          this.label ? ` [${this.label}]` : ""
        }`,
      );
      // Start periodic NOOP keepalive to prevent server-side idle timeouts
      this.startKeepAlive();
      this.reconnectAttempts = 0; // Reset reconnect attempts on successful connection
    } catch (error) {
      throw error;
    }
  }

  private setupConnectionHandlers(): void {
    if (!this.connection) return;

    // Handle new emails
    this.connection.imap.on("mail", async (numberOfEmails: number) => {
      if (!this.connection) {
        return;
      }
      const totalMessages = await getTotalMessages(this.connection);
      if (totalMessages === numberOfEmails) {
        console.log(
          `Initial messages count received ${numberOfEmails}; starting historical backfill${
            this.label ? ` [${this.label}]` : ""
          }`,
        );
        // Trigger a historical backfill scan when the initial event fires
        try {
          if (!this.isBackfilling) {
            this.isBackfilling = true;
            const lowerBound: Dayjs = this.emailsAnalyzedUntil ?? dayjs(0);
            console.log(
              `Backfill lower bound: ${lowerBound.isValid() ? lowerBound.toISOString() : "(invalid date)"}`,
            );
            await this.processHistoricalEmails(lowerBound);
            await this.updateAnalyzedUntil(dayjs());
          }
        } catch (err) {
          console.error(
            `Error during historical backfill${this.label ? ` [${this.label}]` : ""}:`,
            err,
          );
        } finally {
          this.isBackfilling = false;
        }
        return;
      }

      console.log(
        `New ${numberOfEmails} email${numberOfEmails > 1 ? "s" : ""} received${
          this.label ? ` [${this.label}]` : ""
        }`,
      );
      try {
        await this.onNewMails(totalMessages, numberOfEmails);
        // Update analyzed-until to "now" after handling new mail(s)
        await this.updateAnalyzedUntil(dayjs());
      } catch (error) {
        console.error(
          `Error processing new emails${this.label ? ` [${this.label}]` : ""}:`,
          error,
        );
      }
    });

    // Handle connection errors
    this.connection.imap.on("error", (error: Error) => {
      console.error(
        `IMAP error${this.label ? ` [${this.label}]` : ""}:`,
        error,
      );
      this.handleConnectionError();
    });

    // Handle connection close
    this.connection.imap.on("close", (hadError: boolean) => {
      console.log(
        `IMAP connection closed ${hadError ? "with error" : "normally"}${this.label ? ` [${this.label}]` : ""}`,
      );
      if (hadError) {
        this.handleConnectionError();
      }
    });
  }

  private handleConnectionError(): void {
    if (this.isReconnecting) return;
    this.cleanupConnection();
    this.scheduleReconnection();
  }

  private cleanupConnection(): void {
    if (this.connection) {
      try {
        // Remove all listeners to prevent memory leaks
        this.connection.imap.removeAllListeners();
        // End the connection if it's still open
        if (this.connection.imap.state !== "disconnected") {
          this.connection.end();
        }
      } catch (error) {
        console.error("Error cleaning up connection:", error);
      }
      this.connection = null;
    }
    this.stopKeepAlive();
  }

  private startKeepAlive(): void {
    this.stopKeepAlive(); // ensure no duplicate timers
    if (!this.connection) return;
    // Yahoo/Gmail may close IDLE after ~29 min; re-opening INBOX every 60s helps keep session active
    this.keepAliveTimer = setInterval(async () => {
      try {
        if (this.connection && this.connection.imap.state === "authenticated") {
          // Lightweight keepalive: re-open INBOX (no-op if already open)
          await this.connection.openBox("INBOX");
        }
      } catch (e) {
        console.warn(
          `Keepalive openBox failed${this.label ? ` [${this.label}]` : ""}:`,
          (e as any)?.message || e,
        );
        // Trigger reconnection path on failure
        this.handleConnectionError();
      }
    }, 60 * 1000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private scheduleReconnection(): void {
    if (
      this.isReconnecting ||
      this.reconnectAttempts >= this.maxReconnectAttempts
    ) {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        console.error(
          `Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.${
            this.label ? ` [${this.label}]` : ""
          }`,
        );
      }
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    // Exponential backoff with jitter
    const delay = Math.min(
      this.initialReconnectDelay * Math.pow(2, this.reconnectAttempts - 1) +
        Math.random() * 1000, // Add jitter
      30000, // Max 30 seconds
    );

    console.log(
      `Attempting to reconnect in ${Math.round(delay / 1000)} seconds (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...${this.label ? ` [${this.label}]` : ""}`,
    );

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        this.isReconnecting = false;
        console.log(
          `Successfully reconnected to IMAP server${
            this.label ? ` [${this.label}]` : ""
          }`,
        );
      } catch (error) {
        console.error(
          `Reconnection attempt failed${this.label ? ` [${this.label}]` : ""}:`,
          error,
        );
        this.isReconnecting = false;
        this.scheduleReconnection(); // Try again
      }
    }, delay);
  }

  public stopWatching(): Promise<void> {
    return new Promise((resolve) => {
      this.isWatching = false;

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      this.cleanupConnection();
      resolve();
    });
  }

  private async onNewMails(
    totalMessages: number,
    numberOfEmails: number,
  ): Promise<void> {
    if (!this.connection) return;

    const emails = await fetchEmailsBatch(
      this.connection,
      totalMessages - numberOfEmails + 1,
      totalMessages,
    );

    for (const email of emails) {
      console.log(
        `Analyzing email: ${email.subject}${this.label ? ` [${this.label}]` : ""}`,
      );
      const result = await this.emailAnalyzer.isScamEmail(email);

      if (result.scam_probability >= this.scamThreshold) {
        console.log(
          `❗ Potential scam detected (${result.scam_probability.toFixed(1)}%): ${email.subject}`,
        );
        await moveToSpamFolder(this.connection, email.uid);
      } else {
        console.log(`✅ Legitimate email: ${email.subject}`);
      }
    }
  }

  private async processHistoricalEmails(lowerBound: Dayjs): Promise<void> {
    if (!this.connection) return;
    await this.connection.openBox("INBOX");

    const sinceDate = this.formatImapDate(lowerBound.toDate());
    const searchCriteria: any[] = ["ALL", ["SINCE", sinceDate]];
    const fetchOptions = {
      bodies: ["HEADER", "TEXT", ""],
      markSeen: false,
      struct: true,
      sort: [["date", "DESC"]],
    };

    console.log(
      `Searching messages with criteria: SINCE ${sinceDate}${
        this.label ? ` [${this.label}]` : ""
      }`,
    );

    const messages = await this.connection.search(searchCriteria, fetchOptions);
    console.log(
      `Found ${messages.length} messages to analyze since ${sinceDate}${
        this.label ? ` [${this.label}]` : ""
      }`,
    );

    for (const message of messages) {
      try {
        const all = message.parts.find((part: any) => part.which === "");
        if (!all) continue;

        const parsed = await simpleParser(all.body);
        const emailDate: Dayjs = dayjs(parsed.date || new Date());

        const email: EmailContent = {
          uid: message.attributes.uid,
          subject: parsed.subject || "(No subject)",
          from: parsed.from?.text || "Unknown sender",
          date: emailDate,
          text: parsed.text || "",
          html: parsed.html || false,
        };

        // Skip messages older than the configured analysis lower bound (emailsAnalyzedUntil)
        // This can happen if the server returns items outside of the requested SINCE window.
        if (emailDate.isBefore(lowerBound)) {
          console.log(
            `Skipping email dated ${emailDate.toISOString()} (subject: "${email.subject}") because it is older than lower bound ${lowerBound.toISOString()}${
              this.label ? ` [${this.label}]` : ""
            }`,
          );
          continue;
        }

        console.log(
          `Analyzing email: ${email.subject}${this.label ? ` [${this.label}]` : ""}`,
        );
        const result = await this.emailAnalyzer.isScamEmail(email);
        if (result.scam_probability >= this.scamThreshold) {
          console.log(
            `❗ Potential scam detected (${result.scam_probability.toFixed(1)}%): ${email.subject}`,
          );
          await moveToSpamFolder(this.connection, email.uid);
        } else {
          console.log(`✅ Legitimate email: ${email.subject}`);
        }
      } catch (err) {
        console.error(
          "Error parsing or processing a message in backfill:",
          err,
        );
      }
    }
  }

  private formatImapDate(date: Date): string {
    const day = String(date.getDate()).padStart(2, "0");
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const mon = months[date.getMonth()];
    const year = date.getFullYear();
    return `${day}-${mon}-${year}`;
  }

  private async updateAnalyzedUntil(date: Dayjs): Promise<void> {
    try {
      if (!this.configPath) return;
      const resolved = path.resolve(this.configPath);
      const raw = fs.readFileSync(resolved, "utf-8");
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return;
      const idx = data.findIndex(
        (acc: any) =>
          (this.accountUser && acc.user === this.accountUser) ||
          (this.label && acc.label === this.label),
      );
      if (idx === -1) return;
      data[idx].emailsAnalyzedUntil = date.toISOString();
      fs.writeFileSync(resolved, JSON.stringify(data, null, 2) + "\n", "utf-8");
      this.emailsAnalyzedUntil = date;
    } catch (e) {
      console.error("Failed to update emailsAnalyzedUntil in config:", e);
    }
  }
}

// Helper function to start the watcher
export async function startEmailWatcher(): Promise<EmailWatcher> {
  const watcher = new EmailWatcher();
  await watcher.startWatching();

  // Handle process termination
  const stopWatching = () => {
    watcher.stopWatching();
  };

  process.on("SIGINT", stopWatching);
  process.on("SIGTERM", stopWatching);

  return watcher;
}

// Types and helpers to support multi-account configs
type AccountConfig = {
  label?: string;
  user: string;
  password: string;
  host: string;
  port?: number;
  tls?: boolean;
  tlsOptions?: any;
  scamThreshold?: number;
  emailsAnalyzedUntil?: string | null;
};

function asImapOptions(acc: AccountConfig): imaps.ImapSimpleOptions {
  return {
    imap: {
      user: acc.user,
      password: acc.password,
      host: acc.host,
      port: acc.port ?? parseInt(process.env.IMAP_PORT || "993"),
      tls: acc.tls ?? process.env.IMAP_TLS !== "false",
      tlsOptions: acc.tlsOptions ?? { rejectUnauthorized: false },
      authTimeout: 30000,
    },
  };
}

export function loadAccountsFromFile(configPath: string): AccountConfig[] {
  const resolved = path.resolve(configPath);
  const content = fs.readFileSync(resolved, "utf-8");
  const data = JSON.parse(content);
  if (!Array.isArray(data)) {
    throw new Error("Accounts config must be an array of account objects");
  }
  // Basic validation
  data.forEach((acc, idx) => {
    const required = ["user", "password", "host"] as const;
    for (const key of required) {
      if (!acc[key]) {
        throw new Error(
          `Account at index ${idx} is missing required field: ${key}`,
        );
      }
    }
  });
  return data as AccountConfig[];
}

export async function startEmailWatchersFromConfig(
  configPath?: string,
): Promise<EmailWatcher[]> {
  const pathToUse = configPath || process.env.ACCOUNTS_CONFIG_PATH;
  if (!pathToUse) {
    throw new Error("ACCOUNTS_CONFIG_PATH is not set");
  }

  const accounts = loadAccountsFromFile(pathToUse);
  const apiKey = process.env.ANTHROPIC_API_KEY!;

  const watchers: EmailWatcher[] = [];
  for (const acc of accounts) {
    const watcher = new EmailWatcher({
      imapOptions: asImapOptions(acc),
      label: acc.label || acc.user,
      scamThreshold: acc.scamThreshold,
      anthropicApiKey: apiKey,
      configPath: pathToUse,
      accountUser: acc.user,
      emailsAnalyzedUntil: acc.emailsAnalyzedUntil ?? null,
    });
    await watcher.startWatching();
    watchers.push(watcher);
  }

  const stopAll = () => {
    watchers.forEach((w) => w.stopWatching());
  };

  process.on("SIGINT", stopAll);
  process.on("SIGTERM", stopAll);

  return watchers;
}

// Start the watcher if this file is run directly
if (require.main === module) {
  // Prefer multi-account start if ACCOUNTS_CONFIG_PATH is set; otherwise single account
  const watcher = startEmailWatchersFromConfig();

  // Handle process termination signals
  const shutdown = async () => {
    console.log("\nShutting down gracefully...");
    if (watcher instanceof Promise) {
      const w: any = await watcher;
      if (Array.isArray(w)) {
        await Promise.all(w.map((x) => x.stopWatching())).catch(() => void 0);
      } else if (w) {
        await w.stopWatching();
      }
    }
    process.exit(0);
  };

  // Handle different termination signals
  process.on("SIGINT", shutdown); // Ctrl+C
  process.on("SIGTERM", shutdown); // kill command
  process.on("SIGQUIT", shutdown); // Keyboard quit
}
