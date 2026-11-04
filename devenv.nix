{ config, lib, pkgs, ... }:
let
  # Keep these aligned with go.mod and ui/package.json. The input is locked in
  # devenv.lock; pnpm's tarball is pinned independently of nixpkgs updates.
  go = pkgs.go_1_27;
  node = pkgs.nodejs_24;
  pnpm = pkgs.pnpm_10.override {
    version = "10.33.2";
    hash = "sha512-qQ+vb+6rca1sblf5Tg/hoS9dzCLNdU20CulZPraj4LaxLjVAIYuzeuCDQEsfLObbKkEh6XmCm0r/lLmfSdoc+A==";
    nodejs-slim = node;
  };
in
{
  packages = assert lib.assertMsg (go.version == "1.27.3") "Update the Go pin deliberately alongside go.mod"; [
    go
    node
    pnpm
    pkgs.stdenv.cc
    pkgs.pkg-config
    pkgs.gnumake
    pkgs.git
    pkgs.python3
    pkgs.curl
    pkgs.jq
    pkgs.caddy
    pkgs.cloudflared
  ];

  env.CGO_ENABLED = "1";
  env.GOTOOLCHAIN = "local";

  scripts.pc-dev-build = {
    description = "Build the embedded reader and native PocketContext executable";
    exec = ''
      set -euo pipefail
      cd ${lib.escapeShellArg config.devenv.root}
      make ui
      make build
    '';
  };
  scripts.pc-dev = {
    description = "Run reader hot reload against an explicitly initialized development database";
    exec = ''
      set -euo pipefail
      cd ${lib.escapeShellArg config.devenv.root}
      exec node scripts/dev.mjs "$@"
    '';
  };

  # Entering the shell does not install application dependencies, initialize a
  # database, start listeners, enable a tunnel, or configure a model provider.
  enterShell = ''
    printf '%s\n' 'PocketContext development: pc-dev-build, then pc-dev --db /absolute/path/to/dev/pocketcontext.db'
  '';
}
