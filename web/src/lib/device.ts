import { Capacitor } from '@capacitor/core';

export const isNative = Capacitor.isNativePlatform();

/** Read text from the clipboard (asks permission in browsers). */
export async function readClipboard(): Promise<string> {
  if (isNative) {
    const { Clipboard } = await import('@capacitor/clipboard');
    const r = await Clipboard.read();
    return r.value || '';
  }
  if (!navigator.clipboard?.readText) throw new Error('Clipboard not available');
  return navigator.clipboard.readText();
}

/**
 * Save a finished file onto this device.
 * Browser: the server sends it as an attachment → the browser's normal download.
 * Android app: written to Documents/VideoFlow.
 */
export async function saveToDevice(url: string, fileName: string, onProgress?: (p: number) => void): Promise<string | null> {
  if (!isNative) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return null;
  }
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  try {
    const perm = await Filesystem.checkPermissions();
    if (perm.publicStorage !== 'granted') await Filesystem.requestPermissions();
  } catch { /* not needed on newer Android */ }
  let handle: { remove: () => Promise<void> } | undefined;
  if (onProgress) {
    handle = await Filesystem.addListener('progress', (p) => {
      if (p.contentLength) onProgress(Math.round((p.bytes / p.contentLength) * 100));
    });
  }
  try {
    await Filesystem.downloadFile({
      url, path: `VideoFlow/${fileName}`, directory: Directory.Documents, recursive: true, progress: Boolean(onProgress),
    });
  } finally {
    await handle?.remove();
  }
  return `Documents/VideoFlow/${fileName}`;
}
