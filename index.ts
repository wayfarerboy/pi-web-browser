import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type Browser, type Page, chromium } from "playwright";

const NAV_TIMEOUT_MS = 20_000;

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-gpu"],
    });
  }
  return browser;
}

function cleanText(raw: string, maxLen = 30_000): string {
  // Collapse whitespace, drop blank lines
  const lines = raw
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let text = lines.join("\n");
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + `\n\n[...truncated ${raw.length - maxLen} bytes]`;
  }
  return text;
}

async function extractPage(page: Page): Promise<{ title: string; text: string; url: string }> {
  const title = await page.title();
  const url = page.url();
  const text = await page.evaluate(() => {
    // Remove script, style, nav, footer, header noise
    for (const el of document.querySelectorAll(
      "script, style, nav, footer, header, noscript, [role='navigation']",
    )) {
      el.remove();
    }
    return document.body?.innerText ?? "";
  });
  return { title, url, text };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_browse",
    label: "Web Browse",
    description:
      "Open a URL in a real Chromium browser, wait for JavaScript to render, and extract the visible page text. " +
      "Use this to read web pages, documentation, and API references — especially Single Page Apps " +
      "that curl cannot render. Also supports taking screenshots.",
    promptSnippet: "Browse a web page in a real Chromium browser and extract rendered text",
    promptGuidelines: [
      "Use web_browse to read web pages and documentation from primary sources. Prefer it over " +
        "curl for any page that requires JavaScript (React, Docusaurus, SPAs). For API endpoints " +
        "that return JSON, use curl instead.",
      "When researching a topic, browse the official docs first — not a secondary write-up.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Full URL to navigate to (https://...)" }),
      screenshot: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Take a full-page screenshot (adds ~1-2MB image to result)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const { url, screenshot = false } = params;

      onUpdate?.({
        content: [{ type: "text", text: `Navigating to ${url}…` }],
      });

      const browser = await getBrowser();
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) PiCodingAgent/1.0",
      });
      const page = await context.newPage();

      try {
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), NAV_TIMEOUT_MS);

        // Wire external abort signal
        const onAbort = () => timeoutController.abort();
        signal?.addEventListener("abort", onAbort, { once: true });

        await page.goto(url, {
          waitUntil: "networkidle",
          timeout: NAV_TIMEOUT_MS,
        });

        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);

        onUpdate?.({
          content: [{ type: "text", text: "Page loaded. Extracting content…" }],
        });

        const { title, text, url: finalUrl } = await extractPage(page);

        const blocks: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; mediaType: string; data: string } }> = [];

        blocks.push({
          type: "text",
          text: `## ${title}\n${finalUrl}\n\n${cleanText(text)}`,
        });

        if (screenshot) {
          const buf = await page.screenshot({ fullPage: true, type: "png" });
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              mediaType: "image/png",
              data: buf.toString("base64"),
            },
          });
          blocks[0].text += "\n\n*(Full-page screenshot attached below)*";
        }

        return {
          content: blocks,
          details: { title, url: finalUrl, textLength: text.length, screenshot },
        };
      } finally {
        await context.close();
      }
    },
  });

  pi.on("session_shutdown", async () => {
    if (browser) {
      await browser.close();
      browser = null;
    }
  });
}
