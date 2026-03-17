export function getServerApiKeySecretStorageKey(serverId: string): string {
  return `protokoll.apiKey.server.${serverId}`;
}

export function hasSameOrigin(leftUrl: string, rightUrl: string): boolean {
  try {
    return new URL(leftUrl).origin === new URL(rightUrl).origin;
  } catch {
    return false;
  }
}

export function appendScopedApiKeyHeaders(
  headers: Record<string, string | number>,
  apiKey: string | undefined,
  requestUrl: string,
  profileUrl: string
): Record<string, string | number> {
  const trimmed = apiKey?.trim();
  if (!trimmed) {
    return headers;
  }
  if (!hasSameOrigin(requestUrl, profileUrl)) {
    return headers;
  }
  return {
    ...headers,
    Authorization: `Bearer ${trimmed}`,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    'X-API-Key': trimmed,
  };
}

