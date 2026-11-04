# Configuration

All devices use the same reader interface and source tree. Deployment-specific values belong in **`.env.local`**, copied from [`.env.example`](.env.example), and excluded from Git. Never put a pairing token in a tracked file. Environment variables from the shell/service take precedence. Vite also supports mode-specific ignored files such as `.env.debug.local` and `.env.release.local`; existing installations can keep those overrides. `npm run start:web` reads `.env.local`, then optional `.env.web.local` overrides.

## G2 reader without a desktop

`npm ci`, `npm run build`, and `npm run pack` produce a release with no preconfigured desktop. Import files on the phone. Speech weights download on first setup, then remain in the device cache. Reading does not require an AI account or desktop service. Clearing the host app's data can clear its saved library/models.

## Optional Ask connection

Configure **Settings → Ask** using an Even Terminal endpoint/pairing token or a supported direct API endpoint/key/model. Desktop session support uses the configured server and its available providers; custom library features require the [extensions](integrations/even-terminal/README.md).

An installed Even package has a build-time network allowlist. Add exact origins before packaging, for example:

```dotenv
PAGEBORNE_RELEASE_ASK_ORIGINS=https://your-terminal.example,https://your-api.example
```

Paths, pairing links, query strings and credentials are rejected in this list. Changing an installed app's destination requires rebuilding with that origin allowed; entering a new endpoint in Settings cannot expand the package permissions. Speech download origins are added separately from the pinned model manifests. Prefer HTTPS; supported local/Tailscale HTTP endpoints still require the relevant device network access.

The release does **not** read `PAGEBORNE_DEBUG_TERMINAL_STATE`, select your server or embed its token. Its Settings connection remains user-configured.

## Private debug build

Keep the origin and token-file path in `.env.local`:

```dotenv
PAGEBORNE_DEBUG_ASK_ORIGINS=https://your-terminal.example
PAGEBORNE_DEBUG_TERMINAL_STATE=/absolute/path/to/terminal/.state/pairing.json
PAGEBORNE_DEBUG_TERMINAL_AGENT=claude
```

`npm run pack:debug` reads that pairing JSON at build time. With multiple origins, also set `PAGEBORNE_DEBUG_TERMINAL_URL` to the intended server. This explicit debug shortcut embeds a secret, so only install that artifact on your own devices. Omitting the state-file setting leaves manual connection settings available. Diagnostics are enabled only in debug builds.

`PAGEBORNE_DEBUG_TERMINAL_PREVIOUS_URLS` can preserve links when the **same** server changes address. Do not use it to conflate unrelated servers. Public/private builds use the same reader, speech engine and integration code; there is no separate private source fork.

## Desktop/mobile hosting

Browser hosting uses the same reading view as the glasses app, with a shared Terminal library. Install the library and reader-state extensions on your own server, plus conversation sync if you want complete shared chat history. Keep library links and state with that Terminal instance. The web companion does not supply Claude/Codex session ownership by itself.

Add to `.env.local`:

```dotenv
PAGEBORNE_WEB_UPSTREAM=http://127.0.0.1:3456
PAGEBORNE_WEB_TOKEN_FILE=/absolute/path/to/terminal/.state/token
PAGEBORNE_WEB_AUTH=tailscale
PAGEBORNE_WEB_AGENT=claude
PAGEBORNE_WEB_PORT=3463
```

`PAGEBORNE_WEB_TOKEN_FILE` contains a plain token, not the pairing JSON used by private debug builds. Alternatively set `EVEN_TERMINAL_STATE_DIR` to the directory containing `token`. No neighboring checkout, machine name or tailnet IP is assumed. `PAGEBORNE_WEB_AGENT` is `claude` or `codex`, the default for new chats; existing histories stay attached to their provider.

```sh
npm run build:web
npm run start:web
# In another terminal, when ready to expose it to your private tailnet:
tailscale serve --bg --https=443 http://127.0.0.1:3463
```

The companion always listens on **127.0.0.1**. Tailscale mode detects this desktop's DNS name and owner login from `tailscale status --json`. To use explicit identity settings, set both `PAGEBORNE_WEB_HOSTNAME` (hostname only) and `PAGEBORNE_WEB_ALLOWED_LOGIN`. These identify the permitted Tailscale Serve user; they do not create authentication for an arbitrary proxy. Tailscale Serve must supply the identity headers. Do not enable public Funnel or forward this listener through a generic public proxy. If Serve is already configured, review its routes before replacing one.

The browser receives a temporary companion credential, not the upstream Terminal token. HTML/configuration are uncached; successful hashed assets are privately cached. HTTPS permits browser microphone access. For desktop-only testing, `PAGEBORNE_WEB_AUTH=local` permits direct loopback requests without Tailscale and rejects forwarded requests. It is not a remote deployment mode.

Run `npm run start:web -- --help` for settings. If a service runs `node server/web-cli.js` directly, it must supply its environment or use Node's `--env-file=/absolute/path/to/.env.local`; npm loads the file for you.

## Updating and preserving data

Models, local reading state and shared desktop histories are independent of build output. Retain the Terminal state directory, pairing token, library and native session stores. Each device keeps its own model cache and local positions; shared conversation links live under the library's `.pageborne/reader-state/` directory, scoped to the Terminal instance.

For a running web deployment, build into a staging directory and copy new hashed assets while retaining older ones before replacing `index.html`. This lets already-open tabs finish loading their version. Restart the companion for server-code/configuration changes. No updates or service restarts are performed by `release:export`.

## Optional AI bridge

`npm run ai -- init` creates a protected config under `~/.config/pageborne-ai/` with an API-key provider default. Edit its provider, base URL, model and key; use `npm run ai -- serve`. The legacy ChatGPT account adapter additionally requires `PAGEBORNE_EXPERIMENTAL_CHATGPT=1` and has not been validated against a live account for this release. See [compatibility](COMPATIBILITY.md).
