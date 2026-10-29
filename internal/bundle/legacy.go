package bundle

import (
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"strings"

	assets "github.com/pocketcontext-labs/pocketcontext"
	"github.com/pocketcontext-labs/pocketcontext/internal/pocketcontext/sqliteuri"
)

// legacyMigrations are the schema migrations of releases before the
// single-user schema. A database that recorded any of them, or that holds
// tables only those releases created, is refused.
var legacyMigrations = []string{
	"1790300000_users.js",
	"1790300100_knowledge.js",
	"1790300200_google_jit.js",
	"1790500000_search.js",
	"1790700000_home.js",
	"1791400000_properties.js",
	"1791500000_spaces.js",
	"1792700000_project_policy.js",
	"1792700100_space_management.js",
}

var legacyTables = []string{"space_members", "user_directory", "project_policy"}

// ErrEarlierRelease reports a database this release does not open.
var ErrEarlierRelease = errors.New("unsupported database")

// checkDatabase refuses a working copy created by an earlier (or unknown)
// release before PocketBase opens it, so no migration ever touches it. It only
// reads the working copy in the private cache (query-only, like a snapshot,
// because a WAL file without its -shm cannot be opened read-only); the synced
// file is never opened.
func checkDatabase(db, synced string) error {
	u := sqliteuri.File(db)
	conn, err := sql.Open("sqlite3", u.String())
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.SetMaxOpenConns(1)
	if _, err := conn.Exec("PRAGMA query_only = 1"); err != nil {
		return fmt.Errorf("reading %s: %w", synced, err)
	}
	tables := map[string]bool{}
	rows, err := conn.Query("SELECT name FROM sqlite_master WHERE type = 'table'")
	if err != nil {
		return fmt.Errorf("reading %s: %w", synced, err)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		tables[name] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	earlier := fmt.Errorf("%w: %s was created by an earlier PocketContext release (multi-account spaces); this release does not open databases from earlier releases and leaves the file unchanged. "+
		"Keep using the earlier release for it, or start a new project with `pocketcontext init --db NEW_PATH` and ingest the sources again", ErrEarlierRelease, synced)
	for _, t := range legacyTables {
		if tables[t] {
			return earlier
		}
	}
	if !tables["_migrations"] {
		return nil // an empty database; PocketBase creates the schema
	}
	known := map[string]bool{}
	entries, err := fs.ReadDir(assets.Assets, "pb_migrations")
	if err != nil {
		return err
	}
	for _, e := range entries {
		known[e.Name()] = true
	}
	legacy := map[string]bool{}
	for _, name := range legacyMigrations {
		legacy[name] = true
	}
	applied, err := conn.Query("SELECT file FROM _migrations")
	if err != nil {
		return fmt.Errorf("reading %s: %w", synced, err)
	}
	defer applied.Close()
	for applied.Next() {
		var file string
		if err := applied.Scan(&file); err != nil {
			return err
		}
		switch {
		case legacy[file]:
			return earlier
		case strings.HasSuffix(file, ".js") && !known[path.Base(file)]:
			return fmt.Errorf("%w: %s was created by a different PocketContext release (unknown schema migration %s); this release leaves the file unchanged. Use the release that created it",
				ErrEarlierRelease, synced, file)
		}
	}
	return applied.Err()
}
