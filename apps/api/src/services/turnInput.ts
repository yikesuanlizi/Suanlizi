import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { UserInput } from '@suanlizi/protocol';
import type { TurnRequest } from '../config/config.js';

const MAX_TURN_IMAGES = 4;
const MAX_TURN_IMAGE_BYTES = 20 * 1024 * 1024;

export async function buildUserInputFromTurnRequest(
  body: TurnRequest,
  options: { threadId: string; workspaceRoot?: string; dataDir: string },
): Promise<UserInput> {
  const modeInstruction = body.modeInstruction?.trim() || undefined;
  if (body.images && body.images.length > 0) {
    const images = await persistTurnImages(body.images, options);
    return {
      type: 'multimodal',
      modeInstruction,
      parts: [
        { type: 'text', text: body.input || 'See attached image(s).' },
        ...images,
      ],
    };
  }
  return { type: 'text', text: body.input, modeInstruction };
}

async function persistTurnImages(
  images: Array<{ name: string; dataUrl: string }>,
  options: { threadId: string; workspaceRoot?: string; dataDir: string },
) {
  if (images.length > MAX_TURN_IMAGES) {
    throw new Error(`At most ${MAX_TURN_IMAGES} image attachments are allowed per turn`);
  }
  const decodedImages = images.map((image, index) => decodeTurnImage(image, index));
  const totalBytes = decodedImages.reduce((total, image) => total + image.content.byteLength, 0);
  if (totalBytes > MAX_TURN_IMAGE_BYTES) {
    throw new Error(`Total image attachments must not exceed ${MAX_TURN_IMAGE_BYTES} bytes`);
  }
  const root = path.join(options.dataDir, 'attachments', options.threadId);
  await fs.mkdir(root, { recursive: true });
  return Promise.all(decodedImages.map(async (image, index) => {
    const extension = extensionForImage(image.mimeType, image.originalName);
    const name = `${Date.now()}-${index + 1}-${randomUUID().slice(0, 8)}${extension}`;
    const filePath = path.join(root, name);
    await fs.writeFile(filePath, image.content);
    const relativePath = path.join('attachments', options.threadId, name);
    return {
      type: 'image_path' as const,
      path: filePath,
      name: image.originalName,
      mimeType: image.mimeType,
      url: `/api/workspaces/raw?root=${encodeURIComponent(options.dataDir)}&path=${encodeURIComponent(relativePath)}`,
    };
  }));
}

function decodeTurnImage(image: { name: string; dataUrl: string }, index: number): {
  content: Buffer;
  mimeType: string;
  originalName: string;
} {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(image.dataUrl);
  if (!match) throw new Error('Invalid image attachment');
  const mimeType = match[1].toLowerCase();
  if (!mimeType.startsWith('image/')) throw new Error('Unsupported attachment type');
  const encoded = match[2].replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('Invalid image attachment encoding');
  }
  const content = Buffer.from(encoded, 'base64');
  if (content.byteLength === 0 || content.byteLength > MAX_TURN_IMAGE_BYTES) {
    throw new Error('Image attachment must be between 1 byte and 20 MB');
  }
  return {
    content,
    mimeType,
    originalName: path.basename(image.name || `image-${index + 1}`),
  };
}

function extensionForImage(mimeType: string, originalName: string): string {
  const ext = path.extname(originalName);
  if (ext) return ext;
  return ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' }[mimeType] ?? '.img');
}
