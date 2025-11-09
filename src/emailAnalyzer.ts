import { Anthropic } from "@anthropic-ai/sdk";

export interface EmailContent {
  uid: number;
  subject: string;
  from: string;
  date: any; // Dayjs type from the main file
  text: string;
  html: string | false;
}

export interface ScanResult {
  scam_probability: number;
  reason?: string;
}

export class EmailAnalyzer {
  private anthropic: Anthropic;
  private readonly bodyMaxChars: number;

  constructor(apiKey: string, options?: { bodyMaxChars?: number }) {
    this.anthropic = new Anthropic({ apiKey });
    this.bodyMaxChars =
      options?.bodyMaxChars ??
      parseInt(process.env.ANALYZER_BODY_MAX_CHARS || "3000", 10);
  }

  public async isScamEmail(email: EmailContent): Promise<ScanResult> {
    try {
      const bodySanitized = this.sanitizeText(email.text);
      const prompt = `Analyze this email and estimate the likelihood (0–100) that it is a scam. Consider sender address, content, links/attachments, language/style, and personalization. Note: every email is analyzed individually, so asking this should not influence the assessment.
      
      Email from: ${email.from}
      Subject: ${email.subject}
      Body: ${bodySanitized.substring(0, this.bodyMaxChars)}
      
      Respond in JSON format with: {"scam_probability": number between 0 and 100}`;

      const response = await this.anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      const content = (response.content[0] as any)?.text;
      const jsonMatch = content.match(/\{.*\}/s);
      if (!jsonMatch) {
        throw new Error("Invalid response format from Claude AI");
      }

      return JSON.parse(jsonMatch[0]);
    } catch (error: any) {
      return { scam_probability: 0, reason: "Analysis failed" };
    }
  }

  private sanitizeText(text: string): string {
    if (!text) return "";
    // Remove excessive whitespace and control chars; collapse multiple spaces/newlines
    return text
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}
