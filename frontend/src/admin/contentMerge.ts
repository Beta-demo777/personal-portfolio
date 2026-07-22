import type { SiteContent } from '../content';

interface NodeMergeResult {
  content: unknown;
  localResolution: unknown;
  conflicts: string[];
}

export interface SiteContentMergeResult {
  content: SiteContent;
  localResolution: SiteContent;
  conflicts: string[];
}

function valuesEqual(left: unknown, right: unknown) {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIdObjectArray(value: unknown[]): value is Array<Record<string, unknown> & { id: string }> {
  const ids = value.map((item) => isRecord(item) && typeof item.id === 'string' ? item.id : null);
  return ids.every((id): id is string => id !== null) && new Set(ids).size === ids.length;
}

function childPath(parent: string, key: string) {
  return parent ? `${parent}.${key}` : key;
}

function insertMissingIds(result: string[], source: string[], selectedIds: Set<string>) {
  const sourceIds = source.filter((id) => selectedIds.has(id));

  sourceIds.forEach((id, sourceIndex) => {
    if (result.includes(id)) return;

    const previousId = sourceIds.slice(0, sourceIndex).reverse().find((candidate) => result.includes(candidate));
    if (previousId) {
      result.splice(result.indexOf(previousId) + 1, 0, id);
      return;
    }

    const nextId = sourceIds.slice(sourceIndex + 1).find((candidate) => result.includes(candidate));
    if (nextId) {
      result.splice(result.indexOf(nextId), 0, id);
      return;
    }

    result.push(id);
  });
}

function completeIdOrder(
  primary: string[],
  fallback: string[],
  base: string[],
  selectedIds: Set<string>,
) {
  const result = primary.filter((id) => selectedIds.has(id));
  insertMissingIds(result, fallback, selectedIds);
  insertMissingIds(result, base, selectedIds);
  return result;
}

function mergeIdOrder(
  base: string[],
  local: string[],
  server: string[],
  selected: string[],
  path: string,
): { content: string[]; localResolution: string[]; conflicts: string[] } {
  const selectedIds = new Set(selected);
  const localIds = new Set(local);
  const serverIds = new Set(server);
  const comparableIds = new Set(base.filter((id) => (
    selectedIds.has(id) && localIds.has(id) && serverIds.has(id)
  )));
  const comparableBase = base.filter((id) => comparableIds.has(id));
  const comparableLocal = local.filter((id) => comparableIds.has(id));
  const comparableServer = server.filter((id) => comparableIds.has(id));

  let contentPrimary = server;
  let contentFallback = local;
  let localResolutionPrimary = server;
  let localResolutionFallback = local;
  const conflicts: string[] = [];

  if (valuesEqual(comparableLocal, comparableServer)) {
    // Both sides retain the same relative order. Membership changes are merged separately.
  } else if (valuesEqual(comparableLocal, comparableBase)) {
    // Only the server reordered the shared members.
  } else if (valuesEqual(comparableServer, comparableBase)) {
    contentPrimary = local;
    contentFallback = server;
    localResolutionPrimary = local;
    localResolutionFallback = server;
  } else {
    localResolutionPrimary = local;
    localResolutionFallback = server;
    conflicts.push(`${path}.$order`);
  }

  return {
    content: completeIdOrder(contentPrimary, contentFallback, base, selectedIds),
    localResolution: completeIdOrder(
      localResolutionPrimary,
      localResolutionFallback,
      base,
      selectedIds,
    ),
    conflicts,
  };
}

function mergeIdEntry(
  base: Record<string, unknown> | undefined,
  local: Record<string, unknown> | undefined,
  server: Record<string, unknown> | undefined,
  path: string,
): NodeMergeResult {
  if (!base) {
    if (!local) return { content: server, localResolution: server, conflicts: [] };
    if (!server) return { content: local, localResolution: local, conflicts: [] };
    return mergeNode({}, local, server, path);
  }

  if (!local && !server) return { content: undefined, localResolution: undefined, conflicts: [] };

  if (!local) {
    if (valuesEqual(base, server)) {
      return { content: undefined, localResolution: undefined, conflicts: [] };
    }
    return { content: server, localResolution: undefined, conflicts: [path] };
  }

  if (!server) {
    if (valuesEqual(base, local)) {
      return { content: undefined, localResolution: undefined, conflicts: [] };
    }
    return { content: undefined, localResolution: local, conflicts: [path] };
  }

  return mergeNode(base, local, server, path);
}

function mergeIdArrays(base: unknown[], local: unknown[], server: unknown[], path: string): NodeMergeResult | null {
  if (!isIdObjectArray(base) || !isIdObjectArray(local) || !isIdObjectArray(server)) return null;
  const baseById = new Map(base.map((item) => [item.id, item]));
  const localById = new Map(local.map((item) => [item.id, item]));
  const serverById = new Map(server.map((item) => [item.id, item]));
  const allIds = Array.from(new Set([
    ...server.map((item) => item.id),
    ...local.map((item) => item.id),
    ...base.map((item) => item.id),
  ]));
  const contentById = new Map<string, unknown>();
  const localResolutionById = new Map<string, unknown>();
  const conflicts: string[] = [];

  allIds.forEach((id) => {
    const result = mergeIdEntry(
      baseById.get(id),
      localById.get(id),
      serverById.get(id),
      `${path}[id=${id}]`,
    );
    if (result.content !== undefined) contentById.set(id, result.content);
    if (result.localResolution !== undefined) localResolutionById.set(id, result.localResolution);
    conflicts.push(...result.conflicts);
  });

  const baseOrder = base.map((item) => item.id);
  const localOrder = local.map((item) => item.id);
  const serverOrder = server.map((item) => item.id);
  const contentOrder = mergeIdOrder(
    baseOrder,
    localOrder,
    serverOrder,
    Array.from(contentById.keys()),
    path,
  );
  const localResolutionOrder = mergeIdOrder(
    baseOrder,
    localOrder,
    serverOrder,
    Array.from(localResolutionById.keys()),
    path,
  );
  conflicts.push(...contentOrder.conflicts, ...localResolutionOrder.conflicts);
  return {
    content: contentOrder.content.flatMap((id) => contentById.has(id) ? [contentById.get(id)] : []),
    localResolution: localResolutionOrder.localResolution.flatMap((id) => (
      localResolutionById.has(id) ? [localResolutionById.get(id)] : []
    )),
    conflicts,
  };
}

function mergeNode(base: unknown, local: unknown, server: unknown, path: string): NodeMergeResult {
  if (valuesEqual(local, server)) return { content: local, localResolution: local, conflicts: [] };
  if (valuesEqual(local, base)) return { content: server, localResolution: server, conflicts: [] };
  if (valuesEqual(server, base)) return { content: local, localResolution: local, conflicts: [] };

  if (isRecord(base) && isRecord(local) && isRecord(server)) {
    const content: Record<string, unknown> = {};
    const localResolution: Record<string, unknown> = {};
    const conflicts: string[] = [];
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(server)]);
    keys.forEach((key) => {
      const result = mergeNode(base[key], local[key], server[key], childPath(path, key));
      if (result.content !== undefined) content[key] = result.content;
      if (result.localResolution !== undefined) localResolution[key] = result.localResolution;
      conflicts.push(...result.conflicts);
    });
    return { content, localResolution, conflicts };
  }

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(server)) {
    const result = mergeIdArrays(base, local, server, path);
    if (result) return result;
  }

  return {
    content: server,
    localResolution: local,
    conflicts: [path || '内容根节点'],
  };
}

export function mergeSiteContentVersions(
  base: SiteContent,
  local: SiteContent,
  server: SiteContent,
): SiteContentMergeResult {
  const result = mergeNode(base, local, server, '');
  return {
    content: result.content as SiteContent,
    localResolution: result.localResolution as SiteContent,
    conflicts: Array.from(new Set(result.conflicts)),
  };
}
