import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { truncate } from '../../lib/text.js';
import { isAllowedUpload, extensionOf, parseFile } from './parsers.js';

const API = 'https://www.googleapis.com/drive/v3';
const MAX_FILES = 200;
const MAX_FOLDERS = 50;
const MAX_FOLDER_DEPTH = 5;
const PAGE_SIZE = 100;
const MAX_DOWNLOAD_BYTES = env.maxUploadMb * 1024 * 1024;

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';

export function assertFolderAllowed(folderId) {
  if (env.driveAllowedFolders.length === 0) {
    throw new AppError(
      403,
      'connector_not_configured',
      'Google Drive ingestion is not configured on this deployment. Set DRIVE_ALLOWED_FOLDERS to list the folders that may be connected.',
    );
  }
  if (!env.driveAllowedFolders.includes(folderId)) {
    throw new AppError(
      403,
      'drive_folder_not_allowlisted',
      'This Drive folder is not on the DRIVE_ALLOWED_FOLDERS allowlist',
    );
  }
}

export function parseDriveRef(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new AppError(400, 'invalid_drive_ref', 'A Google Drive folder ID or URL is required');
  const fromUrl = raw.match(/folders\/([A-Za-z0-9_-]+)/);
  const value = fromUrl ? fromUrl[1] : raw;
  if (!/^[A-Za-z0-9_-]{10,}$/.test(value)) {
    throw new AppError(400, 'invalid_drive_ref', 'Could not read a Drive folder ID from the reference');
  }
  assertFolderAllowed(value);
  return value;
}

const hasRefreshFlow = () =>
  Boolean(
    env.googleDriveClientId && env.googleDriveClientSecret && env.googleDriveRefreshToken,
  );

let cachedToken = null;
let tokenExpiresAt = 0;

async function refreshedToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) return cachedToken;

  const body = new URLSearchParams({
    client_id: env.googleDriveClientId,
    client_secret: env.googleDriveClientSecret,
    refresh_token: env.googleDriveRefreshToken,
    grant_type: 'refresh_token',
  });
  let response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new AppError(
      502,
      'drive_unreachable',
      `Could not reach Google to refresh the Drive token: ${error.message}`,
    );
  }
  if (!response.ok) {
    // Google returns 400 invalid_grant for a revoked or expired refresh token.
    throw new AppError(
      401,
      'drive_token_refresh_failed',
      'Google rejected the Drive refresh token. Re-authorize the connector and update GOOGLE_DRIVE_REFRESH_TOKEN.',
    );
  }
  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (Number(data.expires_in) || 3_600) * 1_000;
  return cachedToken;
}

async function accessToken() {
  if (hasRefreshFlow()) return refreshedToken();
  const token = env.googleDriveToken;
  if (!token) {
    throw new AppError(
      501,
      'drive_not_configured',
      'Google Drive ingestion requires GOOGLE_DRIVE_ACCESS_TOKEN, or GOOGLE_DRIVE_CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN for automatic renewal. The full OAuth consent flow is planned for the next round.',
    );
  }
  return token;
}

async function driveFetch(path, { retry = true } = {}) {
  // Reading the token before the try block keeps "not configured" (501) from
  // being reported as "unreachable" (502) by the catch below.
  const token = await accessToken();
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    throw new AppError(502, 'drive_unreachable', `Could not reach Google Drive: ${error.message}`);
  }
  if (response.status === 401 && retry && hasRefreshFlow()) {
    // The access token expired between renewal and use; renew once and retry.
    cachedToken = null;
    tokenExpiresAt = 0;
    return driveFetch(path, { retry: false });
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new AppError(401, 'drive_unauthorized', 'The Drive access token is invalid or expired');
    }
    if (response.status === 403 || response.status === 429) {
      let reason = '';
      try {
        const data = await response.json();
        reason = data?.error?.errors?.[0]?.reason || data?.error?.status || '';
      } catch {
        reason = '';
      }
      const quota = response.status === 429 || /rateLimit|quota/i.test(reason);
      if (!quota) {
        throw new AppError(
          403,
          'drive_forbidden',
          'The Drive token cannot read this folder or file. Check that it still has access.',
        );
      }
      throw new AppError(
        429,
        'drive_rate_limited',
        'Google Drive quota reached. The next sync will retry automatically.',
      );
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

async function listFiles(folderId, { limit = MAX_FILES } = {}) {
  const files = [];
  let pageToken;
  for (;;) {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,owners)',
      pageSize: String(PAGE_SIZE),
      orderBy: 'modifiedTime desc',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await driveFetch(`/files?${params.toString()}`);
    const data = await response.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
    if (!pageToken || files.length >= limit) break;
  }
  return { files, truncated: Boolean(pageToken) };
}

async function exportText(file) {
  if (file.mimeType === GOOGLE_DOC_MIME) {
    const response = await driveFetch(`/files/${file.id}/export?mimeType=text/plain`);
    const text = await response.text();
    // Google Docs text goes through the same normaliser as uploads so both
    // paths produce identical records.
    return parseFile({
      buffer: Buffer.from(text, 'utf8'),
      filename: `${file.name || 'google-document'}.txt`,
    });
  }
  if (file.mimeType === GOOGLE_SHEET_MIME) {
    const response = await driveFetch(`/files/${file.id}/export?mimeType=text/csv`);
    const text = await response.text();
    const parsed = await parseFile({
      buffer: Buffer.from(text, 'utf8'),
      filename: `${file.name || 'google-sheet'}.csv`,
    });
    // Drive's CSV export only contains the first sheet.
    parsed.warnings = [...(parsed.warnings || []), 'Only the first sheet of this Google Sheet was exported'];
    return parsed;
  }
  if (file.mimeType.startsWith('application/vnd.google-apps')) {
    return null;
  }

  const extension = extensionOf(file.name);
  if (!isAllowedUpload(file.name)) return null;

  // `size` is the size before download, so an oversized file is skipped
  // without spending bandwidth or memory on it.
  if (Number(file.size) > MAX_DOWNLOAD_BYTES) {
    throw new AppError(
      413,
      'drive_file_too_large',
      `${file.name} is larger than the ${env.maxUploadMb} MB ingestion limit`,
    );
  }

  const response = await driveFetch(`/files/${file.id}?alt=media`);
  const declaredBytes = Number(response.headers.get('content-length') || 0);
  if (declaredBytes > MAX_DOWNLOAD_BYTES) {
    throw new AppError(
      413,
      'drive_file_too_large',
      `${file.name} is larger than the ${env.maxUploadMb} MB ingestion limit`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return parseFile({ buffer, filename: file.name });
}

export async function collectDriveDocuments(ref) {
  const folderId = parseDriveRef(ref);
  const name = await folderName(folderId);

  const notes = [];
  const documents = [];
  const queue = [{ id: folderId, depth: 0 }];
  const visited = new Set();
  let filesSeen = 0;
  let truncated = false;

  while (queue.length > 0 && visited.size < MAX_FOLDERS) {
    const folder = queue.shift();
    if (visited.has(folder.id)) continue;
    visited.add(folder.id);

    const listing = await listFiles(folder.id, { limit: MAX_FILES });
    if (listing.truncated) truncated = true;

    for (const entry of listing.files) {
      if (entry.mimeType === GOOGLE_FOLDER_MIME) {
        if (folder.depth + 1 < MAX_FOLDER_DEPTH) {
          queue.push({ id: entry.id, depth: folder.depth + 1 });
        } else {
          notes.push(`Folder "${entry.name}" was not opened: nested folders are read ${MAX_FOLDER_DEPTH} levels deep`);
        }
        continue;
      }
      if (filesSeen >= MAX_FILES) {
        truncated = true;
        continue;
      }
      filesSeen += 1;

      try {
        const parsed = await exportText(entry);
        if (!parsed) continue;
        const fullText = String(parsed.text ?? '');
        const maxChars = env.maxDocumentChars;
        const text = truncate(fullText, maxChars);
        if (text.trim().length < 20) {
          notes.push(`${entry.name} was skipped: the exported text was too short to analyse`);
          continue;
        }
        const parseWarnings = [...(parsed.warnings || [])];
        if (fullText.length > maxChars) {
          parseWarnings.push(
            `Truncated from ${fullText.length.toLocaleString('en-US')} to ${maxChars.toLocaleString('en-US')} characters`,
          );
        }
        documents.push({
          kind: 'drive_file',
          title: entry.name,
          path: entry.name,
          mime: entry.mimeType,
          size: Number(entry.size || text.length),
          author: entry.owners?.[0]?.displayName || null,
          occurredAt: entry.modifiedTime ? new Date(entry.modifiedTime) : null,
          locator: { url: entry.webViewLink, externalId: entry.id },
          rawText: text,
          parseWarnings,
          meta: { folderId, folderName: name },
        });
      } catch (error) {
        if (error.status === 401) throw error;
        // Every per-file failure is reported on the source, so a user sees
        // why a document is missing instead of silently receiving fewer.
        notes.push(`${entry.name} was skipped: ${error.message}`);
      }
    }
  }

  if (visited.size >= MAX_FOLDERS) {
    notes.push(`Only the first ${MAX_FOLDERS} folders were read`);
  }
  if (truncated) {
    notes.push(`Only the ${MAX_FILES} most recently modified files were ingested`);
  }
  if (documents.length > 0 && notes.length > 0) {
    documents[0].parseWarnings = [...(documents[0].parseWarnings || []), ...notes];
  }

  return documents;
}
