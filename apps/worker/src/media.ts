// Downloads WhatsApp media (images, videos, voice notes, documents,
// stickers) via Baileys and stores it in R2 -- D1 only ever holds the
// object key + mime + lightweight metadata (see MediaMeta in
// @workspace/db), never the bytes themselves.
import { downloadMediaMessage  } from "@whiskeysockets/baileys";
import type {WASocket} from "@whiskeysockets/baileys";
import type { MediaMeta } from "@workspace/db";
import type { Env } from "./index";
import type { IncomingType } from "./db/sync";
import { scopedLogger } from "./logger";

const log = scopedLogger("media");

const MIME_EXT: Record<string, string | undefined> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/ogg; codecs=opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
};

function extFor(mime: string | undefined, fallback: string): string {
  if (!mime) return fallback;
  // split() can return fewer parts than TS's non-null index type implies.
  const subtype = mime.split("/")[1] as string | undefined;
  return MIME_EXT[mime] ?? subtype?.split(";")[0] ?? fallback;
}

/** Pulls whatever per-type extras Baileys attaches to the raw message content. */
function extractMediaMeta(content: any, type: IncomingType): MediaMeta {
  switch (type) {
    case "image": {
      const m = content.imageMessage;
      return { width: m?.width, height: m?.height };
    }
    case "video": {
      const m = content.videoMessage;
      return { width: m?.width, height: m?.height, durationSeconds: m?.seconds };
    }
    case "audio": {
      const m = content.audioMessage;
      return { durationSeconds: m?.seconds, ptt: !!m?.ptt };
    }
    case "document": {
      const m = content.documentMessage;
      return { fileName: m?.fileName, fileSizeBytes: m?.fileLength ? Number(m.fileLength) : undefined };
    }
    case "sticker": {
      const m = content.stickerMessage;
      return { width: m?.width, height: m?.height, isAnimated: !!m?.isAnimated };
    }
    default:
      return {};
  }
}

/**
 * Downloads and stores one media message. Best-effort: WhatsApp media
 * expires from its CDN and re-uploads can still fail (e.g. the sender went
 * offline), so a failure here just means the message is saved without
 * media rather than the whole sync failing.
 */
export async function downloadAndStoreMedia(
  sock: WASocket,
  env: Env,
  workspaceId: string,
  waSessionId: string,
  waMessageId: string,
  msg: any,
  type: IncomingType,
): Promise<{ mediaKey: string; mediaMime: string; mediaMeta: MediaMeta } | null> {
  if (type === "text") return null;
  const content = msg?.message;
  if (!content) return null;

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger: console as any, reuploadRequest: sock.updateMediaMessage },
    ));

    const CONTENT_KEY: Record<string, string> = {
      image: "imageMessage",
      video: "videoMessage",
      audio: "audioMessage",
      document: "documentMessage",
      sticker: "stickerMessage",
    };
    const typedMessage = content[CONTENT_KEY[type]];
    const mime: string = typedMessage?.mimetype ?? "application/octet-stream";
    const ext = extFor(mime, type);
    const mediaKey = `${workspaceId}/${waSessionId}/${waMessageId}.${ext}`;

    await env.MEDIA.put(mediaKey, buffer, { httpMetadata: { contentType: mime } });

    return { mediaKey, mediaMime: mime, mediaMeta: extractMediaMeta(content, type) };
  } catch (err: any) {
    log.error({ err, waMessageId, type }, "downloadAndStoreMedia failed");
    return null;
  }
}

/**
 * Stores media WE are sending (an attachment picked in the composer) into
 * R2 under the same key scheme as incoming media, using the bytes we
 * already have in hand rather than re-downloading from WhatsApp's CDN
 * (there's nothing to re-download -- we're the sender). Used right after
 * a successful sendMessage() so the outbound bubble renders the same way
 * an inbound one would.
 */
export async function storeOutgoingMedia(
  env: Env,
  workspaceId: string,
  waSessionId: string,
  waMessageId: string,
  buffer: ArrayBuffer,
  mime: string,
  type: Exclude<IncomingType, "text">,
  fileName?: string,
): Promise<{ mediaKey: string; mediaMime: string; mediaMeta: MediaMeta }> {
  const ext = extFor(mime, type);
  const mediaKey = `${workspaceId}/${waSessionId}/${waMessageId}.${ext}`;
  await env.MEDIA.put(mediaKey, buffer, { httpMetadata: { contentType: mime } });

  const mediaMeta: MediaMeta =
    type === "document"
      ? { fileName, fileSizeBytes: buffer.byteLength }
      : type === "audio"
        ? { ptt: false }
        : {};

  return { mediaKey, mediaMime: mime, mediaMeta };
}

/** image/video/audio/document from a mime type -- same bucket Baileys' own content shape needs. */
export function mediaTypeFromMime(mime: string): "image" | "video" | "audio" | "document" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Stores a standalone media asset (a template's attachment, uploaded from
 * the templates settings UI before any message references it) under its
 * own key, not tied to any one WhatsApp message. Every message later sent
 * from that template points at this same R2 object -- see
 * `/send-template` in whatsapp-session.ts -- rather than each send
 * re-uploading or copying the bytes.
 */
export async function storeLibraryMedia(
  env: Env,
  workspaceId: string,
  buffer: ArrayBuffer,
  mime: string,
): Promise<{ mediaKey: string; mediaMime: string; mediaType: "image" | "video" | "audio" | "document" }> {
  const type = mediaTypeFromMime(mime);
  const ext = extFor(mime, type);
  const mediaKey = `${workspaceId}/templates/${crypto.randomUUID()}.${ext}`;
  await env.MEDIA.put(mediaKey, buffer, { httpMetadata: { contentType: mime } });
  return { mediaKey, mediaMime: mime, mediaType: type };
}
