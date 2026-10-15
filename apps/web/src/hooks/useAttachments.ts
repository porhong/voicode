import { useCallback, useEffect, useRef, useState } from 'react';
import { LIMITS } from '@voicecode/protocol';
import { api, ApiError } from '../lib/api';
import { ImageError, prepareImage } from '../lib/image';

export interface PendingImage {
  key: number;
  /** A local preview (blob: URL), shown before and while uploading. */
  preview: string;
  status: 'uploading' | 'ready' | 'error';
  /** The agent's id once uploaded. */
  id?: string;
  error?: string;
}

function uploadError(err: unknown): string {
  if (err instanceof ImageError) return err.message;
  if (err instanceof ApiError) {
    if (err.status === 413) return 'This image is too large.';
    if (err.status === 415) return 'Only PNG, JPEG, GIF and WebP images can be sent.';
    if (err.status === 401) return 'This phone is no longer paired.';
    if (err.status === 429) return 'Too many images at once; wait a moment.';
  }
  return 'Upload failed. Check the connection and try again.';
}

/**
 * Images picked for the next prompt. Each one is shrunk and uploaded as soon as it is
 * picked, so sending is instant; the prompt carries only the ids the agent returned.
 */
export function useAttachments() {
  const [items, setItems] = useState<PendingImage[]>([]);
  const nextKey = useRef(1);
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });

  const update = (key: number, patch: Partial<PendingImage>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const add = useCallback((files: FileList | File[]) => {
    const room = LIMITS.maxAttachments - itemsRef.current.length;
    for (const file of [...files].slice(0, Math.max(0, room))) {
      const key = nextKey.current++;
      const preview = URL.createObjectURL(file);
      setItems((list) => [...list, { key, preview, status: 'uploading' }]);
      void (async () => {
        try {
          const blob = await prepareImage(file);
          const { id } = await api.uploadAttachment(blob);
          update(key, { status: 'ready', id });
        } catch (err) {
          update(key, { status: 'error', error: uploadError(err) });
        }
      })();
    }
  }, []);

  const remove = useCallback((key: number) => {
    setItems((list) => {
      const gone = list.find((i) => i.key === key);
      if (gone) URL.revokeObjectURL(gone.preview);
      return list.filter((i) => i.key !== key);
    });
  }, []);

  const clear = useCallback(() => {
    for (const item of itemsRef.current) URL.revokeObjectURL(item.preview);
    setItems([]);
  }, []);

  useEffect(
    () => () => {
      for (const item of itemsRef.current) URL.revokeObjectURL(item.preview);
    },
    [],
  );

  return {
    items,
    add,
    remove,
    clear,
    /** Ids of the uploaded images, in the order they were picked. */
    readyIds: items.flatMap((i) => (i.status === 'ready' && i.id ? [i.id] : [])),
    uploading: items.some((i) => i.status === 'uploading'),
    full: items.length >= LIMITS.maxAttachments,
  };
}
