# Reliable scheduling (external trigger)

GitHub's built-in `schedule:` cron is best-effort and, for a 15-minute interval
on a free public repo, is heavily throttled — it often drops most runs. The
`schedule:` block is left in as a free backup, but the dependable trigger is an
external cron service hitting the GitHub API's `workflow_dispatch` every 15 min.

Verified endpoint (returns **HTTP 204** on success, queuing a run):

```
POST https://api.github.com/repos/nickpellant/booksy-availability-monitor/actions/workflows/monitor.yml/dispatches
```

## 1. Create a fine-grained PAT (scoped to just this repo)

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained
tokens → Generate new token**:

- **Resource owner:** nickpellant
- **Repository access:** Only select repositories → `booksy-availability-monitor`
- **Permissions → Repository permissions → Actions: Read and write**
  (Metadata: Read is added automatically.)
- **Expiration:** your call (e.g. 90 days — note the renewal date; the trigger
  stops when it expires).
- Generate, copy the token.

This token can *only* trigger workflows on this one repo — minimal blast radius.

## 2. Configure cron-job.org

[console.cron-job.org](https://console.cron-job.org) → **Create cronjob**:

- **Title:** booksy monitor trigger
- **URL:**
  `https://api.github.com/repos/nickpellant/booksy-availability-monitor/actions/workflows/monitor.yml/dispatches`
- **Schedule:** every 15 minutes (`*/15`)
- **Request method:** `POST`
- **Advanced → Headers:**
  - `Authorization: Bearer <YOUR_PAT>`
  - `Accept: application/vnd.github+json`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `Content-Type: application/json`
- **Request body:** `{"ref":"main"}`
- Save & enable.

cron-job.org treats the `204 No Content` response as success. Its execution log
shows each trigger; the actual run appears under the repo's **Actions** tab as a
`workflow_dispatch` event.

## Test

In cron-job.org, use **Run now** (or **Test run**). Expect a `204`, and a new run
in GitHub Actions within seconds. If you get `401`/`403`, the PAT is wrong,
expired, or missing **Actions: write**; `404` usually means the repo path or
workflow filename in the URL is off.

## Notes

- With no automated commits landing on the repo, GitHub auto-disables the
  built-in `schedule:` after 60 days of repo inactivity. The external trigger is
  unaffected by that — it uses `workflow_dispatch`, which never auto-disables.
- Keep the PAT only in cron-job.org. It is never committed here.
