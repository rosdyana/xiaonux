// Which disk image to boot, given which overlays hold data.
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0

/** The overlay directory suffix for a disk manifest: one exact base image. */
export const overlayId = (manifest: string) => manifest.replace(/^disk-|\.json$/g, '').slice(0, 16);

/**
 * current: boot.json `disk`; previous: boot.json `previous`, newest first;
 * hasData: overlay id -> holds the user's changes.
 * A returning user's files stay with the image they were written against, so
 * the current image is used unless only an older one holds them.
 */
export function pickDisk(current: string, previous: string[], hasData: (id: string) => boolean):
  { manifest: string; isCurrent: boolean } {
  if (hasData(overlayId(current))) return { manifest: current, isCurrent: true };
  const older = previous.find((m) => hasData(overlayId(m)));
  if (older !== undefined) return { manifest: older, isCurrent: false };
  return { manifest: current, isCurrent: true };
}
