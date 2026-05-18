# Local HTTPS Setup for WindsurfAPI

This guide sets up an HTTPS reverse proxy so that clients requiring HTTPS (e.g., Claude for PowerPoint plugin) can connect to WindsurfAPI.

## Prerequisites

- **Node.js** v18+
- **WindsurfAPI** running on `http://localhost:3003`
- **macOS** (instructions use Homebrew; adapt for Linux)

## Step 1: Install mkcert

```bash
brew install mkcert
```

## Step 2: Install the local CA

```bash
sudo mkcert -install
```

This adds a locally-trusted root CA to your system keychain.

## Step 3: Generate certificates

Replace `YOUR_LAN_IP` with your actual LAN IP (find it with `ipconfig getifaddr en0`):

```bash
cd /path/to/WindsurfAPI
mkcert localhost 127.0.0.1 YOUR_LAN_IP
```

Example:

```bash
mkcert localhost 127.0.0.1 192.168.50.7
```

This creates two files (e.g., `localhost+2.pem` and `localhost+2-key.pem`). These are gitignored.

## Step 4: Update the proxy cert path

Edit `https-proxy.js` and update the cert/key filenames to match the generated files:

```js
key: readFileSync('./localhost+2-key.pem'),
cert: readFileSync('./localhost+2.pem'),
```

## Step 5: Start the HTTPS proxy

```bash
node https-proxy.js
```

Output:

```
HTTPS proxy (HTTP/2 + HTTP/1.1) on https://0.0.0.0:3443 → http://127.0.0.1:3003
  Local:   https://localhost:3443
  LAN:     https://192.168.50.7:3443
```

## Step 6: Configure your client

| Client | Base URL |
|---|---|
| Same machine | `https://localhost:3443` |
| Other PC on same Wi-Fi | `https://YOUR_LAN_IP:3443` |

## Accessing from another PC

The other PC needs to trust your local CA:

1. Find your CA cert:
   ```bash
   mkcert -CAROOT
   ```
2. Copy `rootCA.pem` from that folder to the other PC.
3. Install it in the other PC's trust store:
   - **Windows**: Double-click → Install Certificate → Local Machine → Trusted Root Certification Authorities
   - **macOS**: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain rootCA.pem`

## Troubleshooting

### macOS Firewall blocks LAN access

Turn off the firewall or allow Node:

**System Settings → Network → Firewall → Off**

### Plugin says "Unable to connect"

- Ensure WindsurfAPI is running on port 3003: `curl http://localhost:3003/health`
- Ensure the HTTPS proxy is running on port 3443: `curl https://localhost:3443/health`
- Check the proxy terminal for request logs

### Custom ports

```bash
HTTPS_PORT=8443 TARGET_PORT=3003 node https-proxy.js
```

## Environment Variables (optional)

Add to your `.env` for cascade reuse optimization (single-user Claude Code):

```env
CASCADE_REUSE_BY_CALLER=1
CASCADE_POOL_MAX=1
```
