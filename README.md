# DeWEB Index — GitHub Actions

Reads BSC SiteRegistry `FileSet` logs and produces `public/site-index.json`.

## Publish

1. Create an empty GitHub repository (public is easiest for Pages).
2. Upload this folder's contents.
3. Repository Settings -> Pages -> Source: GitHub Actions.
4. Actions -> DeWEB index -> Run workflow.
5. Index URL:

```
https://<user>.github.io/<repo>/site-index.json
```

6. App Center:

```
https://1-2-399.tapekit.org/?index=https://<user>.github.io/<repo>/site-index.json
```

## How it works

- CPU map is persisted in `data/state.json`;
- cursor advances by `SCAN_WINDOW` blocks each run;
- `FileSet` logs -> containers -> `token()` -> names;
- no private key, read-only public RPC;
- cron runs every 15 minutes.

For X Layer, change workflow:

```yaml
CHAINS: bsc,xlayer
```

Full history backfill happens progressively. To jump, set `FROM_BLOCK` in the workflow env.
