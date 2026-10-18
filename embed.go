// Package wikicontextbundle embeds the application files that the single
// wikicontext binary unpacks into its private cache before serving.
package wikicontextbundle

import "embed"

// Assets holds the hooks, migrations, SQL configuration and built reader.
// Build the reader (ui/dist) before compiling.
//
//go:embed pb_hooks pb_migrations pocketcontext.json ui/dist
var Assets embed.FS

// Skill is the agent skill template that `wikicontext skill` installs with this
// computer's absolute paths.
//
//go:embed skills/wikicontext
var Skill embed.FS
