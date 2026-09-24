# Discord Deno Relay

Small Deno relay used by the Rocket League Discord tracker when the Hugging Face
Space cannot connect directly to Discord.

It proxies only two things:

- `/p/<secret>/api/...` -> `https://discord.com/api/...`
- `/p/<secret>/gateway?...` -> `wss://gateway.discord.gg/?...`

The Discord bot token is **not stored here**. The relay forwards Discord's normal
`Authorization` header in memory.

## Deno Deploy setup

1. Push this repository to GitHub.
2. In the current Deno Deploy dashboard (`console.deno.com`), create an app and
   choose this GitHub repository.
3. Set the entrypoint to `main.ts` if Deno does not detect it automatically.
4. Add an application environment variable named `RELAY_SECRET` and mark it as a
   **secret**. Use a long random value, for example one produced by:

   ```bash
   python -c "import secrets; print(secrets.token_hex(32))"
   ```

5. Deploy. Copy the production HTTPS URL shown by Deno Deploy.

## Tests

Open the root URL. Expected:

```json
{"ok":true,"service":"discord-deno-relay","secret_configured":true,"runtime":"deno"}
```

Then open `/test-discord`. A healthy relay should return status 200 and a body
containing Discord's Gateway URL.

Do not commit `RELAY_SECRET`, a Discord token, or a `.env` file.
