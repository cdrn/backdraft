import type { Episode } from "./derive/episodes.js";

// Same bot + chat as the main backdraft alerter (TG_BOT_TOKEN / TG_CHAT_ID).
// Kept separate because the delta process runs in its own container.
export class DeltaAlert {
  private botToken: string;
  private chatId: string;
  private apiBase: string;

  constructor() {
    this.botToken = process.env.TG_BOT_TOKEN || "";
    this.chatId = process.env.TG_CHAT_ID || "";
    this.apiBase = `https://api.telegram.org/bot${this.botToken}`;
  }

  get enabled(): boolean {
    return this.botToken !== "" && this.chatId !== "";
  }

  private async send(text: string) {
    if (!this.enabled) return;
    try {
      await fetch(`${this.apiBase}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
    } catch (err) {
      console.error("[delta:telegram] Failed to send alert:", err);
    }
  }

  async alertOpen(ep: Episode) {
    await this.send(
      [
        `📈 <b>Delta episode OPEN — ${ep.route}</b>`,
        ``,
        `<b>Net:</b> +${ep.peakBps.toFixed(2)} bps`,
        `<b>Best size:</b> $${ep.peakSize.toLocaleString()}`,
        `<b>Est:</b> $${ep.peakUsd.toFixed(2)}/trip`,
      ].join("\n"),
    );
  }

  async alertClose(ep: Episode, ts: number) {
    const durMin = (ts - ep.openedTs) / 60_000;
    await this.send(
      [
        `📉 <b>Delta episode closed — ${ep.route}</b>`,
        ``,
        `<b>Duration:</b> ${durMin >= 60 ? `${(durMin / 60).toFixed(1)} h` : `${Math.max(1, Math.round(durMin))} min`}`,
        `<b>Peak:</b> +${ep.peakBps.toFixed(2)} bps · $${ep.peakUsd.toFixed(2)}/trip @ $${ep.peakSize.toLocaleString()}`,
      ].join("\n"),
    );
  }
}
