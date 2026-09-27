# Disclaimer & acceptable use

## Not affiliated with WhatsApp

This project is **not affiliated, associated, authorized, endorsed by, or in any way officially connected with WhatsApp LLC, Meta Platforms, Inc., or any of their subsidiaries or affiliates.** "WhatsApp" and related names and marks are trademarks of their respective owners and are used here only to describe what the software connects to.

This software is **not** the official WhatsApp Business Platform / Cloud API. It connects through [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial, reverse-engineered WhatsApp Web client, and runs it on Cloudflare Workers with patches.

## Use at your own risk

- Unofficial clients break WhatsApp's Terms of Service. **WhatsApp can temporarily or permanently ban any number linked to this software**, even when you follow every guideline here. Nothing in this project makes a number "ban-proof".
- WhatsApp can change its protocol at any time, and the app may stop working without notice.
- You are responsible for your deployment: your Cloudflare account, costs, data, backups, security, and compliance with the laws that apply to you (for example GDPR, local anti-spam and telemarketing rules, and consent requirements for storing customer conversations).
- The software is provided **"as is"**, without warranty of any kind (see [LICENSE](./LICENSE)). The authors and contributors are **not liable** for banned numbers, lost messages or data, business losses, or any other damage from using it.

## Do not spam

The maintainers do not condone, and this project is not built for:

- **Unsolicited bulk or marketing messages**, or cold outreach to people who never gave you their number or agreed to hear from you.
- Messaging scraped, bought or rented number lists.
- **Stalkerware** or monitoring someone's conversations without their knowledge.
- Harassment, scams, phishing, or impersonating another person or business.
- Getting around WhatsApp's limits or spam detection (proxy/IP rotation, device-fingerprint spoofing, randomizing text to avoid detection, rotating burner numbers).

The broadcast and outbound limits in this app (contact-list-only broadcasts, recipient ceilings, warm-up caps, per-contact cooldowns, random delays, STOP handling, circuit breakers, new-chat caps) are there to protect your recipients and your number. **Do not remove or weaken them to send more.** Pull requests that add detection-evasion features will be closed.

## Recommended use

- Replying to customers who message you, and running a shared support or sales inbox for your team.
- Occasional updates to contacts who **explicitly opted in**, with an easy way to opt out.
- Link a real, established number that's in normal use, not a brand-new SIM that starts messaging right away.

For marketing, notifications at scale, or anything bulk, use the official **[WhatsApp Business Platform](https://business.whatsapp.com/products/business-platform)**.

By deploying or using this software you accept these terms and take full responsibility for how you use it.
