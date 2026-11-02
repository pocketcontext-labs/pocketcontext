package bundle

import (
	"database/sql"
	"errors"
	"fmt"
	"io/fs"

	"ganigeorgiev.com/pocketbase/pocketbase/core"

	assets "github.com/pocketcontext-labs/pocketcontext"
	"github.com/pocketcontext-labs/pocketcontext/internal/pocketcontext/sqliteuri"
)

// DatabaseFormat identifies the storage contract independently of the executable
// release. Format 1 is the single-user schema introduced in 0.11.0. Its existing
// migration ledger identifies it; opening it does not add a format marker or
// require a data migration. A future format must introduce a new migration so
// releases that do not know it refuse the database before bootstrap.
const DatabaseFormat = 1

// databaseMigrationCount reads the private working copy before bootstrap. System
// migrations run during bootstrap, before the application migration lifecycle.
func databaseMigrationCount(db string) (int, error) {
	u := sqliteuri.File(db)
	conn, err := sql.Open("sqlite3", u.String())
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	conn.SetMaxOpenConns(1)
	if _, err := conn.Exec("PRAGMA query_only = 1"); err != nil {
		return 0, err
	}
	var exists int
	if err := conn.QueryRow("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '_migrations'").Scan(&exists); err != nil {
		return 0, err
	}
	if exists == 0 {
		return 0, nil
	}
	var count int
	err = conn.QueryRow("SELECT count(*) FROM _migrations").Scan(&count)
	return count, err
}

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
	// PocketBase migrations can change the storage contract too. Only checking
	// JavaScript migrations would allow an older binary to open a database that
	// a newer PocketBase has changed. Inspect the actual compiled registries.
	for _, list := range []*core.MigrationsList{&core.SystemMigrations, &core.AppMigrations} {
		for _, migration := range list.Items() {
			known[migration.File] = true
		}
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
		case !known[file]:
			return fmt.Errorf("%w: %s was created by a different PocketContext release (unknown schema migration %s); this release leaves the file unchanged. Use the release that created it",
				ErrEarlierRelease, synced, file)
		}
	}
	return applied.Err()
}
