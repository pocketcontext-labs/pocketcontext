package client

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/pocketcontext-labs/pocketcontext/internal/bundle"
	"github.com/pocketcontext-labs/pocketcontext/internal/profiles"
)

func binaryVersion(path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	b, err := exec.CommandContext(ctx, path, "--version").Output()
	if err != nil {
		return "", fmt.Errorf("check binary %s: %w", path, err)
	}
	fields := strings.Fields(string(b))
	if len(fields) < 2 || fields[0] != "pocketcontext" {
		return "", errors.New("binary is not PocketContext")
	}
	return fields[1], nil
}
func profileTarget(db, url string) (*bundle.Instance, string, error) {
	if db != "" {
		p, err := bundle.Resolve(db)
		if err != nil {
			return nil, "", err
		}
		i, err := bundle.Health(p)
		if err != nil {
			return nil, p.DB, err
		}
		if i.Instance != p.Config.Instance || i.Key != p.Key {
			return nil, p.DB, errors.New("server identity differs from this database")
		}
		return i, p.DB, nil
	}
	base, err := normalizeURL(url)
	if err != nil {
		return nil, "", err
	}
	i, err := probe(base)
	return i, base, err
}
func newProfile(name, db, url, binary, skill string) (profiles.Entry, error) {
	var e profiles.Entry
	i, target, err := profileTarget(db, url)
	if err != nil {
		return e, err
	}
	if binary == "" {
		binary, err = os.Executable()
		if err != nil {
			return e, err
		}
	}
	binary, err = filepath.Abs(binary)
	if err != nil {
		return e, err
	}
	if resolved, er := filepath.EvalSymlinks(binary); er == nil {
		binary = resolved
	}
	version, err := binaryVersion(binary)
	if err != nil {
		return e, err
	}
	if name == "" {
		name = i.Name
	}
	if name == "" && db != "" {
		name = filepath.Base(filepath.Dir(target))
	}
	if name == "" {
		return e, errors.New("server has no name; pass a profile name")
	}
	if skill == "" {
		skill, err = profiles.SkillDir(i.Instance)
	} else {
		skill, err = filepath.Abs(skill)
	}
	if err != nil {
		return e, err
	}
	e = profiles.Entry{ID: profiles.ID(i.Instance), Name: name, Instance: i.Instance, ServerName: i.Name, Binary: binary, Version: version, ServerVersion: i.Version, Skill: skill}
	if db != "" {
		e.DB = target
	} else {
		e.URL = target
	}
	if err := checkProfileServer(e, i); err != nil {
		return e, err
	}
	return e, profiles.Validate(e)
}
func checkProfile(e profiles.Entry) error {
	v, err := binaryVersion(e.Binary)
	if err != nil {
		return err
	}
	if v != e.Version {
		return fmt.Errorf("profile %q binary changed from %s to %s; regenerate its skill and update registration", e.Name, e.Version, v)
	}
	if _, err := os.Stat(filepath.Join(e.Skill, "SKILL.md")); err != nil {
		return fmt.Errorf("profile %q skill is missing: %w", e.Name, err)
	}
	i, _, err := profileTarget(e.DB, e.URL)
	if err != nil {
		return err
	}
	if i.Instance != e.Instance {
		return fmt.Errorf("profile %q reaches a different project; refusing access", e.Name)
	}
	if i.Name != e.ServerName {
		return fmt.Errorf("profile %q server name changed; use profile update to reconcile explicitly", e.Name)
	}
	return checkProfileServer(e, i)
}

// checkProfileServer compares the selected profile, not the verifier binary: a
// current router must still be able to verify a healthy legacy project.
func checkProfileServer(e profiles.Entry, i *bundle.Instance) error {
	if i.Version != e.Version {
		return fmt.Errorf("profile %q binary version %s differs from running server %s; stop and restart with the selected release", e.Name, e.Version, i.Version)
	}
	if e.ServerVersion != "" && i.Version != e.ServerVersion {
		return fmt.Errorf("profile %q server changed from %s to %s; regenerate its skill and reconcile registration", e.Name, e.ServerVersion, i.Version)
	}
	return nil
}

// checkRegisteredTarget verifies any registration for this endpoint before domain operations.
func checkRegisteredTarget(db, url string) error {
	r, err := profiles.Read()
	if err != nil {
		return err
	}
	for _, e := range r.Profiles {
		if (db != "" && e.DB == db) || (db == "" && url != "" && e.URL == url) {
			return checkProfile(e)
		}
	}
	return nil
}
func runProfile(a *args, pretty bool) error {
	if len(a.pos) == 0 {
		return fail(2, "profile add|update|list|remove|default|check|repair [NAME]")
	}
	sub := a.pos[0]
	name := ""
	if len(a.pos) > 1 {
		name = a.pos[1]
	}
	if len(a.pos) > 2 {
		return fail(2, "too many profile arguments")
	}
	switch sub {
	case "list":
		r, err := profiles.Read()
		if err != nil {
			return err
		}
		rows := []map[string]any{}
		for _, e := range r.Profiles {
			i, _, err := profileTarget(e.DB, e.URL)
			row := map[string]any{"profile": e, "reachable": err == nil, "default": r.Default == e.Name}
			if err != nil {
				row["problem"] = err.Error()
			} else if i.Instance != e.Instance || i.Name != e.ServerName {
				row["problem"] = "project identity or name differs"
			}
			rows = append(rows, row)
		}
		path, _ := profiles.Path()
		Print(map[string]any{"format": r.Format, "registry": path, "default": r.Default, "profiles": rows}, pretty)
		return nil
	case "remove":
		if name == "" {
			return fail(2, "profile remove NAME")
		}
		if err := profiles.Remove(name); err != nil {
			return err
		}
		Print(map[string]any{"removed": name, "dataRemoved": false}, pretty)
		return nil
	case "default":
		if name == "" {
			r, err := profiles.Read()
			if err != nil {
				return err
			}
			Print(map[string]any{"default": r.Default}, pretty)
			return nil
		}
		if name == "none" {
			name = ""
		}
		if err := profiles.Default(name); err != nil {
			return err
		}
		Print(map[string]any{"default": name}, pretty)
		return nil
	case "check":
		r, err := profiles.Read()
		if err != nil {
			return err
		}
		e, err := r.Find(name)
		if err != nil {
			return err
		}
		if err := checkProfile(e); err != nil {
			return err
		}
		Print(map[string]any{"profile": e, "verified": true}, pretty)
		return nil
	case "repair":
		return installRouters(a.flags["agent"], pretty)
	case "add", "update":
		db, url := a.flags["db"], a.flags["url"]
		binary, skill := a.flags["binary"], a.flags["skill-dir"]
		var old *profiles.Entry
		if sub == "update" {
			r, err := profiles.Read()
			if err != nil {
				return err
			}
			e, err := r.Find(name)
			if err != nil {
				return err
			}
			old = &e
			if db == "" && url == "" {
				db, url = e.DB, e.URL
			}
			if binary == "" {
				binary = e.Binary
			}
			if skill == "" {
				skill = e.Skill
			}
			if a.flags["name"] != "" {
				name = a.flags["name"]
			}
		}
		if db != "" && url != "" {
			return fail(2, "choose --db or --url")
		}
		if db == "" && url == "" {
			p, err := bundle.Resolve("")
			if err != nil {
				return err
			}
			db = p.DB
		}
		e, err := newProfile(name, db, url, binary, skill)
		if err != nil {
			return err
		}
		if old != nil && old.Instance != e.Instance {
			return fail(2, "profile update cannot adopt another project; remove and add explicitly")
		}
		if _, err := os.Stat(filepath.Join(e.Skill, "SKILL.md")); err != nil {
			return fail(2, "skill is missing; run the project's skill command or pass --skill-dir for a legacy skill")
		}
		if err := profiles.Put(e, sub == "update"); err != nil {
			return err
		}
		Print(e, pretty)
		return nil
	default:
		return fail(2, "unknown profile operation %q", sub)
	}
}
