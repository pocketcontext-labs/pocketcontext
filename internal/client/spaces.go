package client

import (
	"strings"
)

const settingsID = "projectsettings"

// Spaces lists every space with its archived flag and whether it is the default.
func (c *Client) Spaces() ([]map[string]any, error) {
	rows, err := c.Rows(`SELECT s.id, s.name, s.archived, s.id = t.default_space AS "default" FROM spaces s, settings t ORDER BY s.name, s.id LIMIT 500`)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		row["archived"], row["default"] = truthy(row["archived"]), truthy(row["default"])
	}
	return rows, nil
}

func spaceName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 200 {
		return "", fail(2, "a space name has 1-200 characters")
	}
	return name, nil
}

func spaceView(data any) map[string]any {
	return map[string]any{"id": dig(data, "id"), "name": dig(data, "name"), "archived": truthy(dig(data, "archived")), "revision": dig(data, "revision")}
}

// CreateSpace returns the one space with exactly this name, or creates it.
// Several spaces with the name are an error that lists their IDs.
func (c *Client) CreateSpace(name string) (map[string]any, error) {
	name, err := spaceName(name)
	if err != nil {
		return nil, err
	}
	rows, err := c.Rows("SELECT id, name, archived, revision FROM spaces WHERE name = " + literal(name) + " ORDER BY id LIMIT 100")
	if err != nil {
		return nil, err
	}
	switch len(rows) {
	case 0:
	case 1:
		out := spaceView(rows[0])
		out["created"] = false
		return out, nil
	default:
		return nil, fail(2, "%d spaces are named %q (%s); rename one with `pocketcontext rename-space ID NAME`", len(rows), name, spaceIDs(rows))
	}
	data, err := c.Must("POST", records("spaces"), map[string]any{"name": name})
	if err != nil {
		return nil, err
	}
	out := spaceView(data)
	out["created"] = true
	return out, nil
}

// UpdateSpace renames, archives or restores one space at its current revision.
func (c *Client) UpdateSpace(ref string, fields map[string]any) (map[string]any, error) {
	if name, ok := fields["name"].(string); ok {
		var err error
		if fields["name"], err = spaceName(name); err != nil {
			return nil, err
		}
	}
	space, err := c.ResolveSpace(ref)
	if err != nil {
		return nil, err
	}
	fields["expected_revision"] = space["revision"]
	data, err := c.Must("PATCH", records("spaces", space["id"].(string)), fields)
	if err != nil {
		return nil, err
	}
	return spaceView(data), nil
}

// DefaultSpace returns the project's default space.
func (c *Client) DefaultSpace() (map[string]any, error) {
	data, err := c.Must("GET", "/api/spaces/default", nil)
	if err != nil {
		return nil, err
	}
	out := spaceView(data)
	out["default"] = true
	return out, nil
}

// SetDefaultSpace makes one unarchived space the project's default.
func (c *Client) SetDefaultSpace(ref string) (map[string]any, error) {
	space, err := c.ResolveSpace(ref)
	if err != nil {
		return nil, err
	}
	current, err := c.Must("GET", "/api/spaces/default", nil)
	if err != nil {
		return nil, err
	}
	if _, err := c.Must("PATCH", records("settings", settingsID), map[string]any{
		"default_space": space["id"], "expected_revision": dig(current, "settings_revision")}); err != nil {
		return nil, err
	}
	out := spaceView(space)
	out["default"] = true
	return out, nil
}
