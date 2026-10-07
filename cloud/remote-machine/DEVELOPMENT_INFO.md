# Remote UI development

The remote devbox is enrolled in the Tailscale network. You can serve a development UI on the devbox and open it directly from a browser on another tailnet device; no public port forwarding or Terraform firewall change is needed. This was verified by serving a test page on port 3000 and connecting to it from a laptop over Tailscale.

## Direct access over Tailscale

Start the app on the devbox, binding it to all interfaces rather than only `localhost`:

```sh
vite --host
# Next.js:
next dev -H 0.0.0.0
```

Then browse from a tailnet-connected device to `http://remote-devbox:<port>` or `http://<tailscale-ip>:<port>`. For example, `http://remote-devbox:3000`.

Binding to `0.0.0.0` lets the service accept connections arriving on the Tailscale interface. The Hetzner firewall permits public inbound TCP port 22 only, so development ports are not exposed through the public IP by this configuration. Keep the service reachable only over Tailscale; do not add public firewall rules for development ports.

If the connection times out, confirm the devbox is online in Tailscale and check the tailnet access policy for `tag:devbox`. The policy must allow your device to reach the relevant TCP port. The devbox uses `--accept-dns=false`, which affects name resolution on the devbox itself; use its Tailscale IP there if a tailnet name does not resolve. On your laptop, use the MagicDNS name or the Tailscale IP.

## Browser and app behavior

HTML, JavaScript, CSS, images, and source maps are fetched through the same tailnet connection as the initial page. Hot-reload WebSockets also work when the dev server exposes them on that reachable port. Common issues to check:

- **Host validation:** Some dev servers reject requests whose `Host` header is not `localhost`. Add the devbox MagicDNS name (or Tailscale IP) to the framework's allowed-host setting if the server returns `403`. For Vite, configure `server.allowedHosts` with the specific name you use.
- **URLs pointing at `localhost`:** In browser code, `localhost` means the laptop or phone, not the devbox. Prefer relative API URLs with a development-server proxy, or configure the client to use the devbox's tailnet name/IP. If the API uses another port, configure CORS for the UI's origin as needed.
- **Name resolution:** If the MagicDNS name works in `curl` but not the browser, the browser may be using secure DNS/DoH that bypasses the system resolver. Try the Tailscale IP or the full `*.ts.net` name.
- **HTTPS-only browser features:** Plain HTTP on a Tailscale IP is generally not a secure browser context. If the app needs features such as service workers, camera access, or some cryptographic APIs, use HTTPS.

## Optional: Tailscale Serve

For a service that should remain bound to `localhost`, or when HTTPS is needed, Tailscale Serve can proxy it to the tailnet:

```sh
tailscale serve --bg 3000
tailscale serve status
tailscale serve off
```

Serve's HTTPS URL uses the device's `*.ts.net` name. HTTPS certificates and MagicDNS must be enabled for the tailnet. Keep this tailnet-only; do not use Tailscale Funnel to publish development services publicly.
