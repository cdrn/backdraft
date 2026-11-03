import type { Episode } from "./derive/episodes.js";

// Same bot/chat as the other seismographs (TG_BOT_TOKEN / TG_CHAT_ID).
export class SpreadAlert {
  private botToken = process.env.TG_BOT_TOKEN || "";
  private chatId = process.env.TG_CHAT_ID || "";

  get enabled(): boolean {
    return this.botToken !== "" && this.chatId !== "";
  }

  private async send(text: string) {
    if (!this.enabled) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
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
      console.error("[spread:telegram] failed:", err);
    }
  }

  async alertOpen(ep: Episode) {
    await this.send(
      [
        `⚡ <b>Spread OPEN — ${ep.route}</b>`,
        ``,
        `<b>Net:</b> +${ep.peakBps.toFixed(1)} bps`,
        `<b>Best size:</b> $${ep.peakSize.toLocaleString()}`,
        `<b>Est:</b> $${ep.peakUsd.toFixed(2)}/clip`,
      ].join("\n"),
    );
  }

  async alertClose(ep: Episode, ts: number) {
    const sec = Math.round((ts - ep.openedTs) / 1000);
    await this.send(
      [
        `· <b>Spread closed — ${ep.route}</b>`,
        ``,
        `<b>Lasted:</b> ${sec >= 120 ? `${(sec / 60).toFixed(1)} min` : `${sec}s`}`,
        `<b>Peak:</b> +${ep.peakBps.toFixed(1)} bps · $${ep.peakUsd.toFixed(2)}/clip @ $${ep.peakSize.toLocaleString()}`,
      ].join("\n"),
    );
  }
}
