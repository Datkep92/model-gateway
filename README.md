# Model Gateway

A small Node.js gateway that aggregates multiple OpenAI/Anthropic provider keys and exposes one base URL + one master API key for other apps.

## Run

```bash
node server.js
```

Open http://localhost:8787/admin and enter the master key printed on startup.

## Configure

- Add providers (base URL + one or more API keys).
- The gateway fetches model lists and aggregates them at `GET /v1/models`.
- Chat completions are proxied to `/v1/chat/completions` with automatic key rotation on 429/402/403.

## Use in another app

- Base URL: `http://localhost:8787/v1`
- API key: the master key

## Build an .exe

This project has no native dependencies. To make a Windows/macOS/Linux executable, use `pkg` or `nexe` on a machine with Node:

```bash
npm i -g pkg
pkg server.js --targets node18-win-x64 --output model-gateway.exe
```

Note: build must be done on a platform that supports the target toolchain.
