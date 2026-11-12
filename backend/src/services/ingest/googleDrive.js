import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { truncate } from '../../lib/text.js';
import { isAllowedUpload, extensionOf, parseFile } from './parsers.js';

const API = 'https://www.googleapis.com/drive/v3';
const MAX_FILES = 20;
const MAX_DOC_CHARS = 40_000;

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

export function parseDriveRef(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new AppError(400, 'invalid_drive_ref', 'A Google Drive folder ID or URL is required');
  const fromUrl = raw.match(/folders\/([A-Za-z0-9_-]+)/);
  const value = fromUrl ? fromUrl[1] : raw;
  if (!/^[A-Za-z0-9_-]{10,}$/.test(value)) {
    throw new AppError(400, 'invalid_drive_ref', 'Could not read a Drive folder ID from the reference');
  }
  return value;
}

function accessToken() {
  const token = env.googleDriveToken;
  if (!token) {
    throw new AppError(
      501,
      'drive_not_configured',
      'Google Drive ingestion requires GOOGLE_DRIVE_ACCESS_TOKEN (an OAuth access token with drive.readonly scope). The full OAuth consent flow is planned for the next round.',
    );
  }
  return token;
}

async function driveFetch(path) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${accessToken()}` },
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    throw new AppError(502, 'drive_unreachable', `Could not reach Google Drive: ${error.message}`);
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new AppError(401, 'drive_unauthorized', 'The Drive access token is invalid or expired');
    }
    if (response.status === 403) {
      throw new AppError(403, 'drive_forbidden', 'The Drive token cannot read this folder');
    }
    if (response.status === 404) {
      throw new AppError(404, 'drive_not_found', 'Drive folder or file not found');
    }
    throw new AppError(502, 'drive_error', `Google Drive API returned ${response.status}`);
  }
  return response;
}

async function folderName(folderId) {
  try {
    const response = await driveFetch(`/files/${folderId}?fields=name`);
    const data = await response.json();
    return data.name || 'Google Drive folder';
  } catch {
    return 'Google Drive folder';
  }
}

async function listFiles(folderId) {
  const query = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const fields = encodeURIComponent('files(id,name,mimeType,size,modifiedTime,webViewLink,owners)');
  const response = await driveFetch(
    `/files?q=${query}&fields=${fields}&pageSize=${MAX_FILES}&orderBy=modifiedTime desc`,
  );
  const data = await response.json();
  return (data.files || []).slice(0, MAX_FILES);
}

async function exportText(file) {
  if (file.mimeType === GOOGLE_DOC_MIME) {
    const response = await driveFetch(`/files/${file.id}/export?mimeType=text/plain`);
    return { text: await response.text(), warnings: [] };
  }
  if (file.mimeType === GOOGLE_SHEET_MIME) {
    const response = await driveFetch(`/files/${file.id}/export?mimeType=text/csv`);
    return { text: await response.text(), warnings: [] };
  }
  if (file.mimeType.startsWith('application/vnd.google-apps')) {
    return null;
  }

  const extension = extensionOf(file.name);
  if (!isAllowedUpload(file.name)) return null;

  const response = await driveFetch(`/files/${file.id}?alt=media`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return parseFile({ buffer, filename: file.name });
}

export async function collectDriveDocuments(ref) {
  const folderId = parseDriveRef(ref);
  const name = await folderName(folderId);
  const files = await listFiles(folderId);
  const documents = [];

  for (const file of files) {
    try {
      const parsed = await exportText(file);
      if (!parsed) continue;
      const text = truncate(parsed.text, MAX_DOC_CHARS);
      if (text.trim().length < 20) continue;
      documents.push({
        kind: 'drive_file',
        title: file.name,
        path: file.name,
        mime: file.mimeType,
        size: Number(file.size || text.length),
        author: file.owners?.[0]?.displayName || null,
        occurredAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
        locator: { url: file.webViewLink, externalId: file.id },
        rawText: text,
        parseWarnings: parsed.warnings || [],
        meta: { folderId, folderName: name },
      });
    } catch (error) {
      if (error.status === 401) throw error;
    }
  }

  return documents;
}
