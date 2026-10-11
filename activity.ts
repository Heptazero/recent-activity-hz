export type ActivityKind = 'opened' | 'created' | 'modified';
export type DateGroup = 'today' | 'yesterday' | 'week' | 'month' | 'older';

export interface ActivityFile {
  path: string;
  basename: string;
  openedAt?: number;
  createdAt?: number;
  modifiedAt?: number;
}

export function isVisibleVaultPath(path: string): boolean {
  return path.split('/').every((part) => part.length > 0 && !part.startsWith('.'));
}

export function extensionForPath(path: string): string {
  const name = path.split('/').pop() ?? '';
  if (name.toLowerCase().endsWith('.excalidraw.md')) return 'canvas';
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
  return extension === 'excalidraw' ? 'canvas' : extension;
}

export function extensionLabel(extension: string): string {
  if (extension === 'canvas') return '.CANVAS / .EXCALIDRAW';
  return extension ? `.${extension.toUpperCase()}` : '无后缀';
}

const extensionPriority = (extension: string): number =>
  extension === 'md' ? 0 : extension === 'pdf' ? 1 : extension === '' ? 3 : 2;

const compareExtensions = (a: string, b: string): number =>
  extensionPriority(a) - extensionPriority(b) || a.localeCompare(b);

export function collectVisibleExtensions(paths: Iterable<string>): string[] {
  const extensions = new Set<string>();
  for (const path of paths) {
    if (isVisibleVaultPath(path)) extensions.add(extensionForPath(path));
  }
  return [...extensions].sort(compareExtensions);
}

export async function listVisibleFiles(
  list: (folder: string) => Promise<{ files: string[]; folders: string[] }>,
): Promise<string[]> {
  const paths: string[] = [];
  const folders = [''];
  while (folders.length > 0) {
    const folder = folders.pop() ?? '';
    const listed = await list(folder);
    paths.push(...listed.files.filter(isVisibleVaultPath));
    folders.push(...listed.folders.filter(isVisibleVaultPath));
  }
  return paths;
}

export function countVisibleExtensions(paths: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    if (!isVisibleVaultPath(path)) continue;
    const extension = extensionForPath(path);
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  return new Map([...counts].sort(([a], [b]) => compareExtensions(a, b)));
}

export function latestActivity(file: ActivityFile): { at: number; kind: ActivityKind | null } {
  // Template plugins commonly create a blank file and immediately fill it.
  // Treat that short follow-up write as part of the creation.
  if (file.createdAt && file.modifiedAt &&
      file.modifiedAt >= file.createdAt && file.modifiedAt - file.createdAt <= 120_000 &&
      (file.openedAt ?? 0) < file.modifiedAt) {
    return { at: file.modifiedAt, kind: 'created' };
  }
  const candidates: { at: number; kind: ActivityKind }[] = [
    { at: file.openedAt ?? 0, kind: 'opened' },
    { at: file.createdAt ?? 0, kind: 'created' },
    { at: file.modifiedAt ?? 0, kind: 'modified' },
  ];
  const latest = candidates.reduce((best, next) => next.at > best.at ? next : best);
  return { at: latest.at, kind: latest.at > 0 ? latest.kind : null };
}

export function dateGroupFor(at: number, now = Date.now()): DateGroup {
  if (!at || at > now + 60_000) return 'older';
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = (daysAgo: number): number => {
    const day = new Date(today);
    day.setDate(day.getDate() - daysAgo);
    return day.getTime();
  };
  if (at >= start(0)) return 'today';
  if (at >= start(1)) return 'yesterday';
  if (at >= start(6)) return 'week';
  if (at >= start(29)) return 'month';
  return 'older';
}

export function backfillTimes(
  stat: { ctime: number; mtime: number },
  options: {
    now: number;
    threshold: number;
    dismissedAt: number;
    trackCreated: boolean;
    trackModified: boolean;
  },
): { createdAt: number; modifiedAt: number } {
  const eligible = (at: number): boolean =>
    at > options.threshold && at > options.dismissedAt && at <= options.now + 60_000;
  return {
    createdAt: options.trackCreated && eligible(stat.ctime) ? stat.ctime : 0,
    modifiedAt: options.trackModified && eligible(stat.mtime) ? stat.mtime : 0,
  };
}
