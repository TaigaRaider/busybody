# token-auth-legacy

The system as it stood **before passwords existed**, kept so that nothing from
that era is lost when password auth replaced it.

Password auth was adopted in the commit after this branch's tip. Under that
change the token stopped being something a human types: it is now issued by the
server on `POST /auth/login` and only ever rides on requests as a bearer
credential. The token-paste sign-in that existed at this branch's tip was
removed.

## Why this branch exists

The pre-password database contained **9 `anon-*` placeholder users**. These
were created by the legacy migration (`server/scripts/migrate.mjs`) to carry
the authorship of notes that predate real accounts: each distinct legacy uuid
became one `anon-<12-char-prefix>` user with the display name "Archived
author".

They were never accounts. Nobody chose that handle, nobody held a credential,
and under the new password rules they can never authenticate at all. They exist
purely so the notes keep an attributable author instead of becoming orphans.

Four notes lost even that, because `users.color` is UNIQUE and three legacy
authors shared `#e06c75`; `INSERT OR IGNORE` kept only the first, leaving
"Football" and three "Poop" notes with a NULL author.

## The data

`pre-password-data.json` is a snapshot of production taken at the time of the
change: every user row and every note, including `history`, `space_id` and the
author mapping.

`token_hash` is deliberately **not** included. It is a secret hash with no
recovery value, and committing one to a git repository is exactly the kind of
thing that should not happen.

The live database is the source of truth. This snapshot is the safety net — if
a future migration damages the data, this file can rebuild it.