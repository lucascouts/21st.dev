# systemd user units — weekly dependency check

These units run `scripts/dep-check.sh` once a week and leave the report in the
journal. They are **versioned but not installed automatically**: nothing in this
repository writes to your systemd configuration. Installing is an explicit act,
performed by you, with the two commands below.

Everything runs in the **user** scope (`systemctl --user`). No root, no
credentials, no hosted service.

## Install

Run from the root of your clone:

```bash
# 1. Bind the units to *this* clone (the units ship a default for ~/21st.dev).
mkdir -p ~/.config/systemd/user/dep-check.service.d
printf '[Service]\nWorkingDirectory=%s\n' "$PWD" \
  > ~/.config/systemd/user/dep-check.service.d/repo-path.conf

# 2. Install and start.
systemctl --user link "$PWD/contrib/systemd/dep-check.service" "$PWD/contrib/systemd/dep-check.timer"
systemctl --user enable --now dep-check.timer
```

Step 1 is the only per-machine step. `link` keeps the units *in the repository* —
systemd only symlinks to them — so a `git pull` that updates a unit updates what
is installed, while your `repo-path.conf` override survives untouched.

If your clone happens to live at `~/21st.dev`, step 1 is redundant but harmless.

`systemctl --user edit dep-check.service` is the interactive equivalent of
step 1; it writes to the same drop-in directory.

## Verify the installation

```bash
systemctl --user cat dep-check.service     # shows the unit + your drop-in
systemctl --user list-timers dep-check.timer
systemctl --user start dep-check.service   # run once now, without waiting a week
```

## Read a report

Output goes to the journal only — there is no log file, no email, no desktop
notification, and no webhook.

```bash
journalctl --user -u dep-check.service            # all runs
journalctl --user -u dep-check.service -n 50      # the latest run
journalctl --user -u dep-check.service --since "1 week ago"
```

## Exit codes

The unit turns the script's verdict into a unit state:

| Exit | Meaning | `systemctl --user status` |
|------|---------|---------------------------|
| 0 | Clean and current | success |
| 1 | Updates or vulnerabilities found | **failed** |
| 2 | The check could not see everything | **failed** |

Exit `1` is a real failure of the unit, not a routine outcome. The check reports
through two channels — the JSON in the journal and the exit status — and the
unit used to declare `1` successful, which switched the second channel off: a
week with an available update looked exactly like a clean week. Something needs
doing, so the unit says so.

Expect this unit to be red often. After a findings run it stays listed in
`systemctl --user --failed` until the next run clears it, or until you run:

```bash
systemctl --user reset-failed dep-check.service
```

The timer keeps firing on schedule regardless of the failed state, so a red unit
never blocks the next check. The remedy is almost always `bun update`.

Exit `2` means coverage was partial — a scanner was missing or errored, or the
freshness half could not complete — so the tree is not certified clean. An
offline run lands here: unknown is not clean.

## Schedule

`OnCalendar=weekly` normalizes to `Mon *-*-* 00:00:00`, plus a random delay of up
to one hour. Weekly matches the 604800-second release-age cooldown in
`bunfig.toml`. `Persistent=true` means a run missed while the machine was off
fires once the user manager comes back.

## Uninstall

```bash
systemctl --user disable --now dep-check.timer
systemctl --user clean --what=state dep-check.timer   # drops the Persistent= timestamp
rm -rf ~/.config/systemd/user/dep-check.service.d
```
