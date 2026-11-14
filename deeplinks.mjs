// One-click install links for MCP clients that support them (Cursor, VS Code).
// The config launches the server via npx from GitHub and enables WB_AUTO_SYNC=1,
// so a fresh user gets a working server without installing anything.
// The token cannot be embedded safely: it is a placeholder the user replaces.

export const TOKEN_PLACEHOLDER = 'PASTE_YOUR_WB_API_TOKEN';

export function makeNpxConfig({ owner, repo }) {
  return {
    command: 'npx',
    args: ['-y', '-p', `github:${owner}/${repo}`, 'wb-mcp'],
    env: { WB_AUTO_SYNC: '1', WB_API_TOKEN: TOKEN_PLACEHOLDER },
  };
}

export function makeDeeplinks({ owner, repo }) {
  const config = makeNpxConfig({ owner, repo });
  const json = JSON.stringify(config);
  const base64 = Buffer.from(json, 'utf8').toString('base64');
  const cursor = `https://cursor.com/install-mcp?name=wb&config=${encodeURIComponent(base64)}`;
  const vscode = `vscode:mcp/install?${encodeURIComponent(json)}`;
  return { config, cursor, vscode };
}

// Decodes a deeplink back into the config — used by tests and doctor.
export function parseDeeplink(link) {
  if (link.startsWith('https://cursor.com/install-mcp?')) {
    const params = new URL(link).searchParams;
    const base64 = params.get('config');
    if (!base64) throw new Error('cursor link has no config');
    return { client: 'cursor', name: params.get('name'), config: JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) };
  }
  if (link.startsWith('vscode:mcp/install?')) {
    const query = link.slice('vscode:mcp/install?'.length);
    return { client: 'vscode', config: JSON.parse(decodeURIComponent(query)) };
  }
  throw new Error(`unknown deeplink: ${link.slice(0, 40)}`);
}
