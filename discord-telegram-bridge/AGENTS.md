<!-- Purpose: Immutable bridge-specific engineering rules for discord-telegram-bridge. -->

# discord-telegram-bridge

## Package purpose

This package lets Kimaki (from the `cli` package) run on Telegram with minimal
behavior differences. The adapter translates Discord Gateway and REST semantics
to Telegram Bot APIs so Kimaki can keep the same runtime model.

## Concept mapping

- Discord `guild` maps to Telegram `chat` (supergroup).
- Discord channels map to Telegram chat (1:1, each project = one chat).
- Discord threads map to Telegram supergroup topics (`message_thread_id`).
- Discord slash commands map to Telegram bot commands (`setMyCommands`).
- Discord button/select components map to Telegram InlineKeyboardMarkup.
- Discord message content uses markdown; Telegram uses HTML.

## Canonical references

- Bridge behavior follows the same patterns as `discord-slack-bridge/`.
- Telegram Bot API docs: https://core.telegram.org/bots/api
- Gateway session manager is shared from `discord-slack-bridge/src/gateway-session-manager.ts`.

## Non-negotiable typing rules

- Do not use `as` assertions/casts in bridge source code.
- Prefer `discord-api-types/v10` enums and protocol types for Discord shapes.
- Keep inbound payload boundary normalization in `server.ts`:
  - parse as `unknown`
  - validate/narrow at runtime
  - pass normalized typed objects downstream

## Telegram-specific constraints

- `callback_data` max 64 bytes (Discord custom_id allows 100 chars).
  Use compact encoding: `dtb:{type}:{customId}:{value}`.
- Message text max 4096 chars (Discord 2000 chars, so outbound is fine;
  inbound Telegram messages may need splitting).
- `sendChatAction` typing pulse lasts ~5 seconds; must refresh periodically.
- File uploads are single-step `sendDocument`/`sendPhoto` with multipart.
- Bot commands registered via `setMyCommands` (global, not per-chat).
- No role system; use `getChatMember` for admin checks.

## Validation rules

- After bridge changes, always run:
  - `cd discord-telegram-bridge && pnpm typecheck && pnpm test --run`
  - `cd cli && pnpm tsc`
