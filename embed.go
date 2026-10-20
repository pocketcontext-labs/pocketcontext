// Package assets embeds the application files that the single
// pocketcontext binary unpacks into its private cache before serving.
package assets

import "embed"

// Assets holds the hooks, migrations, SQL configuration and built reader.
// Build the reader (ui/dist) before compiling.
//
//go:embed pb_hooks pb_migrations server.json ui/dist
var Assets embed.FS

// Skill is the agent skill template that `pocketcontext skill` installs with this
// computer's absolute paths.
//
//go:embed skills/pocketcontext
var Skill embed.FS
