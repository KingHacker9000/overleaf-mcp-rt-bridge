const READ_ONLY = new Set([
  'overleaf_list_hosts',
  'overleaf_list_projects',
  'overleaf_get_project_tree',
  'overleaf_read_doc',
  'overleaf_read_doc_range',
  'overleaf_read_file',
  'overleaf_check_changes',
  'overleaf_list_comments',
]);

const DESTRUCTIVE = new Set([
  'overleaf_delete_entity',
]);

export function toolAllowed(name, allowedTools, deniedTools) {
  if (deniedTools.has(name)) return false;
  if (allowedTools.size > 0 && !allowedTools.has(name)) return false;
  return true;
}

export function normalizeJsonSchema(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonSchema);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'required' && Array.isArray(child) && child.length === 0) {
      continue;
    }
    normalized[key] = normalizeJsonSchema(child);
  }
  return normalized;
}

export function annotateTool(tool) {
  const readOnly = READ_ONLY.has(tool.name);
  return {
    ...tool,
    inputSchema: normalizeJsonSchema(tool.inputSchema),
    annotations: {
      ...(tool.annotations ?? {}),
      readOnlyHint: readOnly,
      destructiveHint: DESTRUCTIVE.has(tool.name),
      idempotentHint: readOnly,
      openWorldHint: true,
    },
  };
}
