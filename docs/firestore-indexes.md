# Firestore Composite Indexes

This project uses composite Firestore indexes for multi-field queries. Because this Firestore project is shared with other projects, **do not deploy `firestore.indexes.json` via the CLI** — it will overwrite all existing indexes. Instead, create each index manually in the Firebase Console.

---

## How to add an index manually

1. Go to the [Firebase Console](https://console.firebase.google.com)
2. Select your project
3. Navigate to **Firestore Database → Indexes → Composite**
4. Click **Create index**
5. Fill in the fields as described below
6. Click **Create** — the index builds in the background (usually 1–2 minutes)

---

## Required indexes

### Reconnect detection — `CaptivePortal_Users`

Used by `POST /create-user` to detect whether a user has connected to the same access point before.

| Setting | Value |
|---|---|
| Collection | `CaptivePortal_Users` |
| Field 1 | `email` — Ascending |
| Field 2 | `captivePortalAccessPointId` — Ascending |
| Query scope | Collection |

Without this index, the reconnect query will fail in production with:
```
FAILED_PRECONDITION: The query requires an index
```

> The local Firestore emulator does not enforce index requirements, so the query will appear to work in development without it.

---

## Single-field indexes (auto-managed)

Firestore automatically creates single-field indexes for every field on write. You do not need to add these manually unless you have disabled them via field overrides.

---

## Checking index status

After triggering the first reconnect-detection query in production, check:

**Firebase Console → Firestore → Indexes**

If the index is missing, Firebase will show an error link in the console logs that takes you directly to the pre-filled index creation form.
