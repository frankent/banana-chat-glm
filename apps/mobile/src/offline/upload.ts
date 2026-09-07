import { File, UploadTask, UploadType } from 'expo-file-system';

/** expo-file-system-backed deps for the outbox sender (TASK-MOB-006). */

export async function fileExists(localPath: string): Promise<boolean> {
  try {
    const file = new File(localPath);
    return file.exists;
  } catch {
    return false;
  }
}

export async function uploadFile(
  localPath: string,
  putUrl: string,
  headers: Record<string, string>,
): Promise<number> {
  const task = new UploadTask(new File(localPath), putUrl, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers,
  });
  const result = await task.uploadAsync();
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`upload failed with status ${result.status}`);
  }
  return result.body.length;
}
