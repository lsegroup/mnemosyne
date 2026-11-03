Mnemosyne - self-hosted AI team memory
======================================

This is a release of Mnemosyne for a Linux server (amd64 or arm64) with systemd.
Open source under the Apache License 2.0 (LICENSE, NOTICE). Source: https://github.com/lsegroup/mnemosyne

What you need on the server
  - Node.js 20 or newer (with npm), git, curl
  - root (sudo)

Install
  unzip mnemosyne_<version>.zip
  cd mnemosyne_<version>
  sudo ./install.sh                                    # then open http://localhost:40001/mnemosyne/admin/
  sudo ./install.sh --public-url https://mnemosyne.example.com --listen 127.0.0.1:40001
  ./install.sh --help                                  # every option

The script checks the binaries against bin/SHA256SUMS, installs the server in /opt/mnemosyne and the admin program in
/usr/local/bin, creates the notes repository in /var/lib/mnemosyne, writes /etc/mnemosyne.env ONCE (a random secret and the
built-in admin account; the password is printed at the end), installs and starts the systemd unit "mnemosyne".

Upgrade
  Unpack the newer release and run ./install.sh again. Your settings (/etc/mnemosyne.env) and your data are kept.

Put a reverse proxy with TLS in front
  The program listens on 127.0.0.1:40001 by default. Let nginx, Caddy or your load balancer send https://<your host>/mnemosyne/ to it.

Then
  1. Admin -> LLM: add your AI provider and its API key, choose a model per job (text, images).
  2. Connect an AI assistant to <public url>/mnemosyne/mcp (MCP over HTTP).
  3. Sign people in to the documentation portal with GitLab: see docs/self-hosting.md (MNEMOSYNE_GITLAB_*).

Free and licensed
  Free for up to 5 people; the Audit tab shows the last 10 records; administrators sign in with the built-in account.
  A licence key (Admin -> License) lifts the limit and adds the whole Audit history and GitLab sign-in for the admin area.
  https://lumanet.info/mnemosyne

Uninstall
  sudo systemctl disable --now mnemosyne; sudo rm /etc/systemd/system/mnemosyne.service /usr/local/bin/mnemosyne-admin
  sudo rm -r /opt/mnemosyne   (your notes in /var/lib/mnemosyne and /etc/mnemosyne.env stay until you delete them)
